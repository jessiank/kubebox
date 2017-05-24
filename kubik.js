'use strict';
// TODO: display uncaught exception in a popup
// TODO: handle current namespace deletion nicely

const blessed  = require('blessed'),
      contrib  = require('blessed-contrib'),
      crypto   = require('crypto'),
      delay    = require('./lib/util').delay,
      moment   = require('moment'),
      duration = require('moment-duration-format'),
      task     = require('./lib/task'),
      fs       = require('fs'),
      get      = require('./lib/http-then').get,
      os       = require('os'),
      path     = require('path'),
      URI      = require('urijs'),
      yaml     = require('js-yaml');

const screen = blessed.screen({
  ignoreLocked: ['q', 'C-c']
});
screen.key(['q', 'C-c'], (ch, key) => process.exit(0));
screen.key(['l', 'C-l'], (ch, key) => {
  authenticate()
        .then(dashboard)
        .catch(error => console.error(error.stack));
})

const session = {
  apis         : [],
  cancellations: new task.Cancellations(),
  namespace    : 'default',
  namespaces   : {},
  pod          : null,
  pods         : {},
  get openshift() {
    return this.apis.some(path => path === '/oapi' || path === '/oapi/v1');
  }
};

const kube_config = getKubeConfig(process.argv[2] || process.env.KUBERNETES_MASTER);
// TODO: do not set a default namespace as it can lead to permissions issues
// CLI option > Kube config context > Display namespaces list
session.namespace = kube_config.context.namespace || 'default';
const master_api  = getMasterApi(kube_config);

// TODO: support client access information provided as CLI options
// TODO: better context disambiguation workflow
// see:
// - http://kubernetes.io/docs/user-guide/accessing-the-cluster/
// - http://kubernetes.io/docs/user-guide/kubeconfig-file/
function getKubeConfig(master) {
  // TODO: check if the file exists and can be read first
  const kube = yaml.safeLoad(fs.readFileSync(path.join(os.homedir(), '.kube/config'), 'utf8'));
  let cluster, context, current, user;
  if (!master) {
    // TODO: error exit in case no current context is set
    current = kube['current-context'];
    context = kube.contexts.find(item => item.name === current).context;
    cluster = kube.clusters.find(item => item.name === context.cluster).cluster;
  } else {
    const uri    = URI(master);
    let clusters = kube.clusters.filter(item => URI(item.cluster.server).hostname() === uri.hostname());
    if (clusters.length > 1) {
      clusters = clusters.filter(item => {
        const server = URI(item.cluster.server);
        return server.protocol() === uri.protocol() && server.port() === uri.port();
      });
    }
    if (clusters.length === 1) {
      context = (kube.contexts.find(item => item.context.cluster === clusters[0].name) || {}).context || {};
      cluster = clusters[0].cluster;
    } else {
      cluster = {server: master};
      context = {};
    }
  }
  user = (kube.users.find(user => user.name === context.user) || {}).user || {};
  return {cluster, context, user};
}

function getMasterApi(kube_config) {
  const {cluster, user}              = kube_config;
  const {protocol, hostname, port}   = URI.parse(cluster.server);
  const master_api                   = {
    protocol: protocol + ':', hostname, port,
    headers : {
      'Accept': 'application/json, text/plain, */*'
    },
    get url() {
      return this.protocol + '//' + this.hostname + ':' + this.port;
    }
  };
  if (user['client-certificate']) {
    master_api.cert = fs.readFileSync(user['client-certificate']);
  }
  if (user['client-certificate-data']) {
    master_api.cert = Buffer.from(user['client-certificate-data'], 'base64');
  }
  if (user['client-key']) {
    master_api.key = fs.readFileSync(user['client-key']);
  }
  if (user['client-key-data']) {
    master_api.key = Buffer.from(user['client-key-data'], 'base64');
  }
  if (user.token) {
    master_api.headers['Authorization'] = `Bearer ${user.token}`;
  }
  if (cluster['insecure-skip-tls-verify']) {
    master_api.rejectUnauthorized = cluster['insecure-skip-tls-verify'];
  } else {
    // by default set to false for openshift
    // TODO: add Openshift certificate as trusted.   
    master_api.rejectUnauthorized = false;
  }
  if (cluster['certificate-authority']) {
    master_api.ca = fs.readFileSync(cluster['certificate-authority']);
  }
  if (cluster['certificate-authority-data']) {
    master_api.ca = Buffer.from(cluster['certificate-authority-data'], 'base64');
  }
  return master_api;
}

const get_apis = () => Object.assign({
  path  : '/',
  method: 'GET'
}, master_api);

// https://docs.openshift.org/latest/architecture/additional_concepts/authentication.html
// https://github.com/openshift/openshift-docs/issues/707
const oauth_authorize = ({username, password}) => { 
    delete master_api.headers['Authorization'];
    return merge({
      path   : '/oauth/authorize?client_id=openshift-challenging-client&response_type=token',
      method : 'GET',
      auth   : `${username}:${password}`,
      headers: {
        'X-Csrf-Token' : '1'
      }
    }, master_api);
};

const get_namespaces = () => Object.assign({
  path  : '/api/v1/namespaces',
  method: 'GET'
}, master_api);

const get_projects = () => Object.assign({
  path  : '/oapi/v1/projects',
  method: 'GET'
}, master_api);

const get_pods = (namespace) => Object.assign({
  path  : `/api/v1/namespaces/${namespace}/pods`,
  method: 'GET'
}, master_api);

const get_pod = (namespace, name) => Object.assign({
  path  : `/api/v1/namespaces/${namespace}/pods/${name}`,
  method: 'GET'
}, master_api);

const watch_pods = (namespace, resourceVersion) => merge({
  path   : `/api/v1/namespaces/${namespace}/pods?watch=true&resourceVersion=${resourceVersion}`,
  method : 'GET',
  headers: {
    // https://tools.ietf.org/html/rfc6455
    Origin                 : master_api.url,
    Connection             : 'Upgrade',
    Upgrade                : 'websocket',
    'Sec-WebSocket-Key'    : crypto.createHash('SHA1').digest('base64'),
    'Sec-WebSocket-Version': 13
  }
}, master_api);

const follow_log = (namespace, name, sinceTime) => merge({
  // we may want to adapt the amount of lines based on the widget height
  path   : `/api/v1/namespaces/${namespace}/pods/${name}/log?follow=true&tailLines=25&timestamps=true` + (sinceTime ? `&sinceTime=${sinceTime}` : ''),
  method : 'GET',
  headers: {
    // https://tools.ietf.org/html/rfc6455
    Connection             : 'Upgrade',
    Upgrade                : 'WebSocket',
    'Sec-WebSocket-Key'    : crypto.createHash('SHA1').digest('base64'),
    'Sec-WebSocket-Version': 13
  }
}, master_api);

// TODO: move into a separate module
function merge(target, source) {
  return Object.keys(source).reduce((target, key) => {
    const prop = source[key];
    if (typeof target[key] === 'undefined') {
      target[key] = source[key];
    } else if (typeof target[key] === 'object') {
      merge(target[key], prop);
    }
    return target;
  }, target);
}

const grid = new contrib.grid({rows: 12, cols: 12, screen: screen});

const pods_table = grid.set(0, 0, 6, 6, blessed.listtable, {
  border       : 'line',
  align        : 'left',
  keys         : true,
  tags         : true,
  shrink       : false,
  noCellBorders: true,
  // FIXME: margin isn't incremented for child list in scrollable list table
  scrollbar    : {
    ch   : ' ',
    style: {bg: 'white'},
    track: {
      style: {bg: 'black'}
    }
  },
  style        : {
    border: {fg: 'white'},
    header: {fg: 'blue', bold: true},
    cell  : {fg: 'white', selected: {bg: 'blue'}}
  }
});

pods_table.on('select', (item, i) => {
  // empty table!
  if (i === 0) return;
  // FIXME: logs resources are not available for pods in non running state
  const name = session.pods.items[i - 1].metadata.name;
  if (name === session.pod)
    return;
  session.cancellations.run('dashboard.logs');
  session.pod = name;
  // just to update the table with the new selection
  setTableData(session.pods);
  // and reset the logs widget label until the log request succeeds
  pod_log.setLabel('Logs');
  pod_log.logLines = [];
  pod_log.setItems([]);
  screen.render();

  const logger = function*(sinceTime) {
    let log, timestamp;
    try {
      while (log = yield) {
        // skip empty data frame payload on connect!
        if (log.length === 0) continue;
        log       = log.toString('utf8');
        const i   = log.indexOf(' ');
        timestamp = log.substring(0, i);
        const msg = log.substring(i + 1);
        // avoid scanning the whole buffer if the timestamp differs from the since time
        if (!timestamp.startsWith(sinceTime) || !pod_log.logLines.includes(msg))
          pod_log.log(msg);
      }
    } catch (e) {
      // HTTP chunked transfer-encoding / streaming requests abort on timeout instead of being ended.
      // WebSocket upgraded requests end when timed out on OpenShift.
    }
    // wait 1s and retry the pod log follow request from the latest timestamp if any
    delay(1000)
      .then(() => get(get_pod(session.namespace, name)))
      .then(response => JSON.parse(response.body.toString('utf8')))
      .then(pod => {
        // TODO: checks should be done at the level of the container (like CrashLoopBackOff)
        // check if the pod is not terminated (otherwise the connection closes)
        if (pod.status.phase !== 'Running') return;
        // check if the pod is not terminating
        if (pod.metadata.deletionTimestamp) {
          pod_log.setLabel(`Logs {grey-fg}[${name}]{/grey-fg} {red-fg}TERMINATING{/red-fg}`);
        } else {
          // TODO: max number of retries window
          // re-follow log from the latest timestamp received
          const {promise, cancellation} = get(follow_log(session.namespace, name, timestamp), timestamp
            ? function*() {
              // sub-second info from the 'sinceTime' parameter are not taken into account
              // so just strip the info and add a 'startsWith' check to avoid duplicates
              yield* logger(timestamp.substring(0, timestamp.indexOf('.')));
            }
            : logger);
          session.cancellations.add('dashboard.logs', cancellation);
          return promise.then(() => debug.log(`Following log for pod ${session.pod} ...`));
        }
      })
      .catch(error => {
        // the pod might have already been deleted?
        if (!error.response || error.response.statusCode !== 404)
          console.error(error.stack);
      });
  };

  // FIXME: deal with multi-containers pod
  const {promise, cancellation} = get(follow_log(session.namespace, name), logger);
  session.cancellations.add('dashboard.logs', cancellation);
  promise
    .then(() => debug.log(`Following log for pod ${session.pod} ...`))
    .then(() => pod_log.setLabel(`Logs {grey-fg}[${name}]{/grey-fg}`))
    .then(() => screen.render())
    .catch(error => console.error(error.stack));
});
// work-around for https://github.com/chjj/blessed/issues/175
pods_table.on('remove', () => pods_table.removeLabel());
pods_table.on('prerender', () => pods_table.setLabel('Pods'));

function setTableData(pods) {
  const selected = pods_table.selected;
  pods_table.setData(pods.items.reduce((data, pod) => {
    data.push([
      pod.metadata.name === session.pod ? `{blue-fg}${pod.metadata.name}{/blue-fg}` : pod.metadata.name,
      // TODO: be more fine grained for the status
      // TODO: add a visual hint depending on the status
      pod.status.phase,
      // FIXME: negative duration is displayed when pod starts as clocks may not be synced
      formatDuration(moment.duration(moment().diff(moment(pod.status.startTime))))
    ]);
    return data;
  }, [['NAME', 'STATUS', 'AGE']]));
  pods_table.select(selected);
}

function formatDuration(duration) {
  if (duration.years() > 0)
    return duration.format('y[y] M[M]');
  else if (duration.months() > 0)
    return duration.format('M[M] d[d]');
  else if (duration.days() > 0)
    return duration.format('d[d] h[h]');
  else if (duration.hours() > 0)
    return duration.format('h[h] m[m]');
  else if (duration.minutes() > 0)
    return duration.format('m[m] s[s]');
  else
    return duration.format('s[s]');
}

// TODO: enable user scrolling
const pod_log = grid.set(6, 0, 6, 12, contrib.log, {
  border      : 'line',
  align       : 'left',
  label       : 'Logs',
  tags        : true,
  style       : {
    border: {fg: 'white'}
  },
  bufferLength: 50
});

// TODO: enable user scrolling and add timestamps
const debug = grid.set(0, 0, 12, 12, contrib.log, {
  label       : 'Logs',
  style       : {
    fg    : 'white',
    border: {fg: 'white'}
  },
  bufferLength: 100
});

// TODO: display a list table with some high level info about the namespaces
const namespaces_list = blessed.list({
  top      : 'center',
  left     : 'center',
  width    : '50%',
  height   : '50%',
  label    : 'Namespaces',
  keys     : true,
  tags     : true,
  border   : {type: 'line'},
  scrollbar: {
    ch   : ' ',
    style: {bg: 'white'},
    track: {
      style: {bg: 'black'}
    }
  },
  style    : {
    fg      : 'white',
    border  : {fg: 'white'},
    selected: {bg: 'blue'}
  }
});
namespaces_list.on('cancel', () => {
  namespaces_list.detach();
  screen.render();
});
namespaces_list.on('select', (item, i) => {
  namespaces_list.detach();
  screen.render();
  const namespace = session.namespaces.items[i].metadata.name;
  if (namespace === session.namespace)
    return;
  // cancel current running tasks and open requests
  debug.log(`Cancelling background tasks for namespace ${session.namespace}`);
  session.cancellations.run('dashboard');
  // reset dashboard widgets
  pods_table.clearItems();
  pod_log.setLabel('Logs');
  pod_log.logLines = [];
  pod_log.setItems([]);
  // switch dashboard to new namespace
  session.namespace = namespace;
  session.pod       = null;
  debug.log(`Switching to namespace ${session.namespace}`);
  screen.render();
  dashboard().catch(error => console.error(error.stack));
});

// FIXME: the namespace selection handle should only be active
// when the connection is established to the cluster
screen.key(['n'], () => {
  screen.append(namespaces_list);
  namespaces_list.clearItems();
  namespaces_list.focus();
  screen.render();
  // TODO: watch for namespace changes when the selection list is open
  // and avoid 'n' key to trigger another request
  get(session.openshift ? get_projects() : get_namespaces())
    .then(response => JSON.parse(response.body.toString('utf8')))
    // TODO: display a message in case the user has access to no namespaces
    .then(namespaces => session.namespaces = namespaces)
    .then(namespaces => namespaces_list.setItems(namespaces.items.reduce((data, namespace) => {
      data.push(namespace.metadata.name === session.namespace ?
        `{blue-fg}${namespace.metadata.name}{/blue-fg}` : namespace.metadata.name);
      return data;
    }, [])))
    .then(() => screen.render())
    .catch(error => console.error(error.stack));
});

const carousel = new contrib.carousel(
  [
    screen => {
      // TODO: restore selection if any
      screen.append(pods_table);
      screen.append(pod_log);
      pod_log.setScrollPerc(100);
      pods_table.focus();
    },
    screen => {
      screen.append(debug);
      debug.setScrollPerc(100);
    }
  ],
  {
    screen      : screen,
    interval    : 0,
    controlKeys : true
  }
);
carousel.start();

// TODO: log more about client access workflow and info
get(get_apis())
  .then(response => session.apis = JSON.parse(response.body.toString('utf8')).paths)
  .catch(error => debug.log(`Unable to retrieve available APIs: ${error.message}`))
  .then(dashboard)
  .catch(error => {
    // FIXME: only fallback to manual authentication for anonymous user
    if ((error.response && (error.response.statusCode === 403 || error.response.statusCode === 401))) {
      // fallback to manual authentication
      authenticate()
        .then(dashboard)
        .catch(error => console.error(error.stack));
    } else {
      console.error(error.stack);
    }
    // TODO: better error management
  });

function authenticate() {
  if (session.openshift) {
    // try retrieving an OAuth access token from the OpenShift OAuth server
    return getCrendentials()
      .then(credentials => get(oauth_authorize(credentials)))
      .then(response => response.headers.location.match(/access_token=([^&]+)/)[1])
      .then(token => master_api.headers['Authorization'] = `Bearer ${token}`)
      .catch(error => {
        if (error.response && error.response.statusCode === 401) {
          debug.log(`Authentication required for ${master_api.url} (openshift)`);
          return authenticate();
        } else {
          throw error;
        }
      });
  } else {
    throw Error(`No authentication available for: ${master_api.url}`);
  }
}

function dashboard() {
  return get(get_pods(session.namespace))
    .then(response => {
      session.pods       = JSON.parse(response.body.toString('utf8'));
      session.pods.items = session.pods.items || [];
    })
    .then(() => setTableData(session.pods))
    .then(() => debug.log(`Watching for pods changes in namespace ${session.namespace} ...`))
    .then(() => screen.render())
    .then(() => {
      const id = setInterval(refreshPodAges, 1000);
      session.cancellations.add('dashboard.refreshPodAges', () => clearInterval(id));
    })
    .then(() => {
      const {promise, cancellation} = get(watch_pods(session.namespace, session.pods.metadata.resourceVersion), updatePodTable);
      session.cancellations.add('dashboard', cancellation);
      return promise;
    });
}

function* updatePodTable() {
  const index = object => session.pods.items.findIndex(pod => pod.metadata.uid === object.metadata.uid);
  let change;
  try {
    while (change = yield) {
      change = JSON.parse(change);
      switch (change.type) {
        case 'ADDED':
          session.pods.items.push(change.object);
          break;
        case 'MODIFIED':
          session.pods.items[index(change.object)] = change.object;
          break;
        case 'DELETED':
          session.pods.items.splice(index(change.object), 1);
          if (change.object.metadata.name === session.pod) {
            // check if that's the selected pod and clean the selection
            pod_log.setLabel(`Logs {grey-fg}[${session.pod}]{/grey-fg} {red-fg}DELETED{/red-fg}`);
            session.pod = null;
          }
          break;
      }
      setTableData(session.pods);
      screen.render();
    }
  } catch (e) {
    // HTTP chunked transfer-encoding / streaming watch requests abort on timeout when the 'timeoutSeconds'
    // request parameter is greater than the '--min-request-timeout' server API option,
    // otherwise the connections just end normally (http://kubernetes.io/docs/admin/kube-apiserver/).
    // WebSocket upgraded watch requests (idle?) end when timed out on Kubernetes.
  }
  // retry the pods list watch request
  session.cancellations.run('dashboard.refreshPodAges');
  dashboard().catch(error => console.error(error.stack));
}

function refreshPodAges() {
  session.pods.items.forEach(pod => moment(pod.status.startTime).add(1, 's').toISOString());
  // we may want to avoid recreating the whole table data
  setTableData(session.pods);
  screen.render();
}

function getCrendentials() {
  return new Promise(function(fulfill, reject) {
    screen.saveFocus();
    screen.grabKeys = true;
    const { form, username, password } = promptCrendentials();
    screen.append(form);
    form.focusNext();
    screen.render();
    form.on('submit', data => {
      screen.remove(form);
      screen.restoreFocus();
      screen.grabKeys = false;
      screen.render();
      fulfill({ username: username(), password: password() });
    });
  });
}

function promptCrendentials() {
  const form = blessed.form({
    mouse  : true,
    keys   : true,
    vi     : true,
    left   : 'center',
    top    : 'center',
    width  : 40,
    height : 6,
    shrink : 'never',
    border : {
      type : 'line'
    }
  });

  form.on('element keypress', (el, ch, key) => {
    if (key.name === 'enter') {
      form.submit();
    }
  });

  blessed.text({
    parent  : form,
    left    : 1,
    top     : 1,
    align   : 'left',
    content : 'username:'
  });

  const username = blessed.textbox({
    parent       : form,
    inputOnFocus : true,
    mouse        : true,
    keys         : true,
    height       : 1,
    width        : 10,
    left         : 11,
    top          : 1
  });
  // retain key grabbing as text areas reset it after input reading
  username.on('blur', () => screen.grabKeys = true);

  blessed.text({
    parent  : form,
    mouse   : true,
    keys    : true,
    left    : 1,
    top     : 2,
    align   : 'left',
    content : 'password:'
  });

  const password = blessed.textbox({
    parent       : form,
    inputOnFocus : true,
    mouse        : true,
    keys         : true,
    height       : 1,
    width        : 20,
    left         : 11,
    censor       : true,
    top          : 2
  });
  // retain key grabbing as text areas reset it after input reading
  password.on('blur', () => screen.grabKeys = true);

  const login = blessed.button({
    parent  : form,
    mouse   : true,
    keys    : true,
    shrink  : true,
    padding : {
      left  : 1,
      right : 1
    },
    left    : 29,
    top     : 3,
    content : 'Log In',
    style   : {
      focus : {
        bg  : 'grey'
      }
    }
  });
  login.on('press', () => form.submit());

  return {
    form,
    username : () => username.content,
    password : () => password.value
  };
}
