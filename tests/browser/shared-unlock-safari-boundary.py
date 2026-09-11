#!/usr/bin/env python3
"""Synthetic native Safari recipient/document observations; never Identity or MK acceptance."""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import shutil
import socketserver
import subprocess
import threading
import time
import urllib.error
import urllib.request
import urllib.parse

parser = argparse.ArgumentParser()
parser.add_argument('--driver-url', default='http://127.0.0.1:55187')
parser.add_argument('--prepare-only', action='store_true')
parser.add_argument('--product-extension', type=Path)
parser.add_argument('--ci-screenshot-on-failure', action='store_true')
parser.add_argument('--ci-grant-fixture-access', action='store_true')
parser.add_argument('--background-kind', choices=['classic-worker', 'module-worker', 'document'], default='module-worker')
args = parser.parse_args()
if args.ci_screenshot_on_failure or args.ci_grant_fixture_access:
    assert os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted', 'Native CI diagnostics only on disposable GitHub-hosted runners'
assert args.driver_url == 'http://127.0.0.1:55187', 'Task-owned local SafariDriver only'
out = Path('test-results/shared-unlock-safari-product-channel' if args.product_extension else 'test-results/shared-unlock-safari-boundary').resolve()
fixture = out / 'fixture'
if args.product_extension:
    assert args.background_kind == 'module-worker', 'Product uses its built module worker'
    assert args.product_extension.resolve() == Path('dist/safari').resolve(), 'Only the task-built Safari artifact is allowed'
    if fixture.exists(): shutil.rmtree(fixture)
    shutil.copytree(args.product_extension, fixture)
fixture.mkdir(parents=True, exist_ok=True)
origin = 'http://127.0.0.1:55189'
background = {'service_worker': 'background.js'}
if args.background_kind == 'module-worker':
    background['type'] = 'module'
elif args.background_kind == 'document':
    background = {'scripts': ['background.js'], 'persistent': False}
manifest = {'manifest_version': 3, 'name': 'Synthetic shared unlock boundary', 'version': '1.0.0',
    # Safari rejects a port in a host permission (native run34631412243).
    # The fixture binds only port55189; all sender assertions retain exact URLs.
    'permissions': ['webNavigation', 'scripting'], 'host_permissions': ['http://127.0.0.1/*'],
    'externally_connectable': {'matches': ['http://127.0.0.1/*']},
    'background': background,
    'browser_specific_settings': {'safari': {'strict_min_version': '16.4'}}}
(fixture / 'manifest.json').write_text(json.dumps(manifest, indent=2))
(fixture / 'background.js').write_text('''
let disconnected = 0;
globalThis.syntheticProductDiagnostic = { importState: 'diagnostics-ready', errors: [] };
function captureSyntheticWorkerError(error, event) {
  const state = globalThis.syntheticProductDiagnostic;
  if (state.errors.length >= 5) return;
  const frames = (String(error?.stack || '').match(/[A-Za-z0-9._-]+\\.js:\\d+:\\d+/g) || []).slice(0, 5);
  if (!frames.length && event?.filename) {
    const file = String(event.filename).split('/').at(-1);
    if (/^[A-Za-z0-9._-]+\\.js$/.test(file)) frames.push(file + ':' + event.lineno + ':' + event.colno);
  }
  state.errors.push({ name: ['Error', 'TypeError', 'SyntaxError', 'ReferenceError'].includes(error?.name) ? error.name : 'other', frames });
}
self.addEventListener('error', event => captureSyntheticWorkerError(event.error, event));
self.addEventListener('unhandledrejection', event => captureSyntheticWorkerError(event.reason));
// A temporary WebDriver installation did not reliably expose the onInstalled
// page. Open this synthetic diagnostic from background startup instead, without
// stealing focus or depending on a one-shot installation event.
void (async () => {
  const url = browser.runtime.getURL('diagnostics.html');
  const tabs = await browser.tabs.query({});
  if (!tabs.some(tab => tab.url === url)) await browser.tabs.create({ url, active: false });
})();
browser.runtime.onConnect.addListener(port => {
  if (port.name === 'synthetic-internal-probe') {
    const events = { external: browser.runtime.onConnectExternal,
      beforeNavigate: browser.webNavigation.onBeforeNavigate, committed: browser.webNavigation.onCommitted,
      errorOccurred: browser.webNavigation.onErrorOccurred, tabReplaced: browser.webNavigation.onTabReplaced,
      tabRemoved: browser.tabs.onRemoved };
    port.postMessage({ workerListenerReady: true, product: globalThis.syntheticProductDiagnostic,
      lifecycleEvents: Object.fromEntries(Object.entries(events).map(([name, event]) =>
      [name, typeof event?.addListener === 'function' && typeof event?.removeListener === 'function'])) });
  }
});
function scope(value) {
  if (!value) return null;
  const result = {};
  for (const name of ['id', 'url', 'origin', 'frameId', 'parentFrameId', 'documentId', 'parentDocumentId', 'documentLifecycle', 'incognito', 'status', 'frameType', 'errorOccurred', 'discarded', 'frozen', 'pendingUrl']) {
    if (value[name] !== undefined) result[name] = value[name];
  }
  return result;
}
browser.runtime.onConnectExternal.addListener(port => {
  port.onDisconnect.addListener(() => { disconnected += 1; });
  port.onMessage.addListener(async message => {
    if (message?.type !== 'probe') return;
    const sender = port.sender;
    let currentTab = null, currentFrame = null, frameError = false;
    try { currentTab = await browser.tabs.get(sender.tab.id); } catch { /* reported as absent */ }
    try { currentFrame = await browser.webNavigation.getFrame({ tabId: sender.tab.id, frameId: sender.frameId }); }
    catch { frameError = true; }
    try { port.postMessage({ type: 'observation', runtimeId: browser.runtime.id,
      runtimeOrigin: browser.runtime.getURL(''), sender: scope(sender), senderTab: scope(sender?.tab),
      currentTab: scope(currentTab), currentFrame: scope(currentFrame), frameError, disconnected }); }
    catch { /* navigation closed the synthetic Port */ }
  });
  port.postMessage({ type: 'connected', runtimeId: browser.runtime.id,
    runtimeOrigin: browser.runtime.getURL(''), sender: scope(port.sender), senderTab: scope(port.sender?.tab) });
});
''')
product_provenance = None
if args.product_extension:
    product_manifest = json.loads((args.product_extension / 'manifest.json').read_text())
    original_worker = product_manifest['background']['service_worker']
    assert product_manifest['background'].get('type') == 'module'
    assert original_worker != 'background.js'
    source_files = sorted(path for path in args.product_extension.rglob('*') if path.is_file())
    for name in ['diagnostics.html', 'diagnostics.js', 'diagnostic-background.js', 'background.js']:
        assert not (args.product_extension / name).exists(), 'Diagnostic filename collides with the product'
    product_provenance = {'sourceHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
        'sourceDirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip()),
        'artifactSha256': hashlib.sha256(b''.join(path.relative_to(args.product_extension).as_posix().encode() + b'\0' + path.read_bytes() for path in source_files)).hexdigest(),
        'diagnosticInstrumentation': ['test display name', 'diagnostic extension page', 'background wrapper imports unchanged product worker']}
    diagnostics = (fixture / 'background.js').read_text().split('function scope(value)', 1)[0]
    (fixture / 'diagnostic-background.js').write_text(diagnostics)
    (fixture / 'background.js').write_text('import "./diagnostic-background.js";\nimport '
        + json.dumps('./' + original_worker) + ';\n'
        + 'globalThis.syntheticProductDiagnostic.importState = "loaded";\n')
    product_manifest['name'] = manifest['name']
    product_manifest['background']['service_worker'] = 'background.js'
    (fixture / 'manifest.json').write_text(json.dumps(product_manifest, indent=2))
(fixture / 'diagnostics.html').write_text('<!doctype html><title>Synthetic extension diagnostics</title><pre id="result">pending</pre><button id="grant">Grant loopback page access</button><pre id="grant-result">pending</pre><script src="diagnostics.js"></script>')
(fixture / 'diagnostics.js').write_text('''
document.getElementById('grant').addEventListener('click', async () => {
  const result = {};
  try {
    result.granted = await browser.permissions.request({ origins: ['http://127.0.0.1/*'] });
    result.permissions = await browser.permissions.getAll();
  } catch (error) { result.error = String(error.message).slice(0, 500); }
  document.getElementById('grant-result').textContent = JSON.stringify(result);
});
(async () => {
  const result = { runtimeId: browser.runtime.id, runtimeOrigin: browser.runtime.getURL('') };
  try { result.permissions = await browser.permissions.getAll(); } catch { result.permissionReadFailed = true; }
  try {
    result.worker = await new Promise((resolve, reject) => {
      const port = browser.runtime.connect({ name: 'synthetic-internal-probe' });
      const timer = setTimeout(() => { port.disconnect(); reject(new Error('Diagnostic timeout')); }, 2000);
      port.onMessage.addListener(message => { clearTimeout(timer); resolve(message); port.disconnect(); });
    });
  } catch { result.workerReadFailed = true; }
  document.getElementById('result').textContent = JSON.stringify(result);
})();
''')
fixture_hash = hashlib.sha256(b''.join((fixture / name).read_bytes()
    for name in ['manifest.json', 'background.js', 'diagnostics.html', 'diagnostics.js'])).hexdigest()
if args.product_extension:
    fixture_hash = hashlib.sha256(b''.join(path.relative_to(fixture).as_posix().encode() + b'\0' + path.read_bytes()
        for path in sorted(fixture.rglob('*')) if path.is_file())).hexdigest()
if args.prepare_only:
    print('Prepared synthetic Safari fixture; no browser or session was started.')
    raise SystemExit(0)

class Site(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'<!doctype html><html><body><h1>Synthetic Safari boundary</h1></body></html>'
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *_):
        pass

class LoopbackServer(http.server.ThreadingHTTPServer):
    def server_bind(self):
        # HTTPServer's default getfqdn() is unnecessary for this literal loopback
        # fixture and can invoke local-network discovery on the macOS runner.
        socketserver.TCPServer.server_bind(self)
        self.server_name = '127.0.0.1'
        self.server_port = self.server_address[1]

# This harness talks only to its literal loopback driver, never a system proxy.
driver_http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def request(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(args.driver_url + path, data=data, method=method,
        headers={'Content-Type': 'application/json'})
    try:
        with driver_http.open(req, timeout=35) as response:
            return json.load(response)['value']
    except urllib.error.HTTPError as error:
        value = json.load(error).get('value', {})
        raise RuntimeError(value.get('error', 'webdriver-error')) from None

session = None
server = None
other_port_server = None
checks = []
observations = {'backgroundKind': args.background_kind, 'product': product_provenance}
stage = 'session'
for name in ['report.json', 'failure.json']:
    (out / name).unlink(missing_ok=True)

def grant_ci_fixture_access():
    try:
        result = subprocess.run(['/usr/bin/osascript', str(Path(__file__).with_name('safari-ci-permission.applescript'))],
            capture_output=True, text=True, timeout=15)
        observations['ciNativePermissionAction'] = {'exitCode': result.returncode, 'result': result.stdout.strip()[:200]}
    except (OSError, subprocess.TimeoutExpired):
        observations['ciNativePermissionAction'] = {'failed': True}

def command(method, path, body=None):
    return request(method, '/session/' + session + path, body)

def navigate(url):
    command('POST', '/url', {'url': url})

def probe(extension_id):
    return command('POST', '/execute/async', {'script': '''
      const id = arguments[0], done = arguments[arguments.length - 1];
      if (typeof globalThis.browser?.runtime?.connect !== 'function') {
        done({ outcome: 'missing-api', browserType: typeof globalThis.browser,
          chromeType: typeof globalThis.chrome, secureContext: globalThis.isSecureContext }); return;
      }
      let finished = false;
      let connected = null;
      const finish = value => { if (!finished) { finished = true; clearTimeout(timer); done(value); } };
      const timer = setTimeout(() => finish({ outcome: 'timeout', connected }), 2500);
      try {
        const port = browser.runtime.connect(id, { name: 'synthetic-boundary' });
        window.syntheticBoundaryPort = port;
        port.onMessage.addListener(message => {
          if (message?.type === 'connected') {
            connected = message;
            port.postMessage({ type: 'probe', claimedOrigin: 'https://wrong.example.test', claimedExtensionId: 'wrong' });
          } else {
            finish({ outcome: 'message', message, connected });
          }
        });
        port.onDisconnect.addListener(() => { void browser.runtime.lastError; finish({ outcome: 'disconnected' }); });
      } catch (error) { finish({ outcome: 'exception', errorName: error.name }); }
    ''', 'args': [extension_id]})


def product_probe(extension_id, variant='valid'):
    return command('POST', '/execute/async', {'script': '''
      const id = arguments[0], variant = arguments[1], done = arguments[arguments.length - 1];
      const protocol = 'palladin.shared-unlock.browser.v1';
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const webNonce = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
      const hello = { type: 'hello', protocol, apiUrl: 'http://localhost:55083', webNonce };
      if (variant === 'wrong-api') hello.apiUrl = 'http://localhost:55085';
      if (variant === 'extra-claim') hello.claimedAccountId = 'synthetic';
      let finished = false, ready = null;
      const finish = value => { if (!finished) { finished = true; clearTimeout(timer); done(value); } };
      const timer = setTimeout(() => finish({ outcome: 'timeout', ready }), 6500);
      try {
        const port = browser.runtime.connect(id, { name: protocol });
        window.syntheticProductPort = port;
        port.onMessage.addListener(message => {
          if (message?.type !== 'ready') return;
          const expected = ['apiUrl', 'channelId', 'documentBinding', 'extensionId', 'protocol', 'type', 'webNonce', 'webOrigin'];
          if (Object.keys(message).sort().join(',') !== expected.sort().join(',')
            || message.webNonce !== webNonce || message.extensionId !== id || message.protocol !== protocol
            || message.apiUrl !== hello.apiUrl || message.webOrigin !== location.origin) {
            finish({ outcome: 'invalid-ready' }); return;
          }
          ready = message;
          if (variant === 'repeat') port.postMessage(hello);
          else finish({ outcome: 'ready', ready });
        });
        port.onDisconnect.addListener(() => { void browser.runtime.lastError; finish({ outcome: 'disconnected', hadReady: ready !== null }); });
        port.postMessage(hello);
      } catch (error) { finish({ outcome: 'exception', errorName: error.name }); }
    ''', 'args': [extension_id, variant]})

def current_product_document(diagnostic_handle, web_handle):
    command('POST', '/window', {'handle': diagnostic_handle})
    result = command('POST', '/execute/async', {'script': '''
      const done = arguments[arguments.length - 1];
      (async () => {
        const worker = await new Promise((resolve, reject) => {
          const port = browser.runtime.connect({ name: 'synthetic-internal-probe' });
          const timer = setTimeout(() => { port.disconnect(); reject(new Error('Diagnostic timeout')); }, 2000);
          port.onMessage.addListener(message => { clearTimeout(timer); resolve(message); port.disconnect(); });
        });
        const tabs = await browser.tabs.query({});
        const tab = tabs.find(tab => tab.url === 'http://127.0.0.1:55189/allowed');
        if (!tab) { done({ missingTab: true, worker }); return; }
        const frame = await browser.webNavigation.getFrame({ tabId: tab.id, frameId: 0 });
        done({ tabId: tab.id, incognito: tab.incognito, url: tab.url, status: tab.status,
          documentId: frame.documentId, frameUrl: frame.url, parentFrameId: frame.parentFrameId, worker });
      })().catch(() => done({ nativeReadFailed: true }));
    ''', 'args': []})
    command('POST', '/window', {'handle': web_handle})
    return result

def run_product_channel(extension_id, diagnostic_handle, web_handle):
    global stage, other_port_server
    extension_id = urllib.parse.unquote(extension_id)
    stage = 'product-channel-ready'
    first = product_probe(extension_id)
    observations['productFirst'] = first
    native = current_product_document(diagnostic_handle, web_handle)
    observations['productNativeDocument'] = native
    assert first['outcome'] == 'ready'
    checks.append('actual-product-bootstrap-and-native-ready')
    assert native['incognito'] is False and native['status'] == 'complete' and native['parentFrameId'] == -1
    assert native['url'] == native['frameUrl'] == origin + '/allowed'
    assert first['ready']['documentBinding'] == str(native['tabId']) + '/' + native['documentId'] + '/' + first['ready']['channelId']
    checks.append('product-ready-bound-to-independent-native-current-document')
    for variant in ['wrong-api', 'extra-claim', 'repeat']:
        stage = 'product-reject-' + variant
        rejected = product_probe(extension_id, variant)
        observations[stage] = rejected
        assert rejected['outcome'] == 'disconnected'
        if variant == 'repeat': assert rejected['hadReady'] is True
        checks.append(stage)
    stage = 'product-same-url-reload'
    command('POST', '/refresh', {})
    second = product_probe(extension_id)
    observations['productAfterReload'] = second
    assert second['outcome'] == 'ready'
    current = current_product_document(diagnostic_handle, web_handle)
    assert current['documentId'] != native['documentId']
    assert second['ready']['documentBinding'] == str(current['tabId']) + '/' + current['documentId'] + '/' + second['ready']['channelId']
    assert second['ready']['channelId'] != first['ready']['channelId']
    checks.append('product-reload-requires-new-native-document-and-channel')
    stage = 'product-wrong-recipient'
    wrong = product_probe('org.example.nonexistent.Extension (AAAAAAAAAA)')
    observations[stage] = wrong
    assert wrong['outcome'] != 'ready'
    checks.append(stage)
    stage = 'product-wrong-port-on-granted-host'
    other_port_server = LoopbackServer(('127.0.0.1', 55190), Site)
    threading.Thread(target=other_port_server.serve_forever, daemon=True).start()
    navigate('http://127.0.0.1:55190/denied')
    wrong_port = product_probe(extension_id)
    observations[stage] = wrong_port
    assert wrong_port['outcome'] == 'disconnected'
    checks.append(stage)
    report = {'status': 'instrumented-product-channel-only', 'checks': checks, 'observations': observations,
        'fixtureSha256': fixture_hash, 'osVersion': platform.mac_ver()[0], 'architecture': platform.machine(),
        'observedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'identityOrKeysUsed': False, 'fullMatrix': False}
    (out / 'report.json').write_text(json.dumps(report, indent=2))
    print('PASS: ' + str(len(checks)) + ' Safari product-channel checks; no Identity/MK/Entry acceptance.')

try:
    created = request('POST', '/session', {'capabilities': {'alwaysMatch': {'browserName': 'safari', 'platformName': 'macOS'}}})
    session = created['sessionId']
    observations['capabilities'] = created['capabilities']
    initial_window = command('GET', '/window')
    command('POST', '/timeouts', {'script': 10000, 'pageLoad': 20000, 'implicit': 0})
    stage = 'install-extension'
    installation = command('POST', '/webextension', {'type': 'path', 'path': str(fixture)})
    observations['installationResult'] = installation
    stage = 'decode-installed-extension'
    # Safari 26.6.2 returns { extension: native_identifier } (CI 34629126061).
    # This is browser-owned installation metadata, never a page-provided ID.
    assert isinstance(installation, dict)
    extension_id = installation.get('extension')
    assert isinstance(extension_id, str) and extension_id
    observations['browserInstalledExtensionId'] = extension_id
    checks.append('browser-installed-synthetic-extension')
    stage = 'internal-fixture-diagnostics'
    diagnostic_handles = []
    for attempt in range(100):
        handles = command('GET', '/window/handles')
        for handle in handles:
            if handle == initial_window:
                continue
            command('POST', '/window', {'handle': handle})
            url = command('GET', '/url')
            if url.startswith('safari-web-extension://') and url.endswith('/diagnostics.html'):
                diagnostic_handles.append(handle)
        # A new window handle can precede navigation away from about:blank.
        # Wait for the actual browser-reported fixture URL, not merely two tabs.
        if diagnostic_handles:
            break
        time.sleep(0.1)
    observations['internalDiagnostics'] = []
    for handle in diagnostic_handles:
        command('POST', '/window', {'handle': handle})
        url = command('GET', '/url')
        if url.startswith('safari-web-extension://') and url.endswith('/diagnostics.html'):
            # Read only the installed fixture page. This is diagnostic data,
            # not an external-Port sender or product document-binding proof.
            result = command('POST', '/execute/async', {'script': '''
              const done = arguments[arguments.length - 1];
              let attempt = 0;
              const check = () => {
                const text = document.getElementById('result')?.textContent;
                if (text && text !== 'pending') { done(text); return; }
                if (++attempt === 40) { done(null); return; }
                setTimeout(check, 100);
              };
              check();
            ''', 'args': []})
            observations['internalDiagnostics'].append({'browserUrl': url, 'result': result})
            button = command('POST', '/element', {'using': 'css selector', 'value': '#grant'})
            stage = 'fixture-native-permission-click'
            if args.ci_grant_fixture_access:
                threading.Thread(target=grant_ci_fixture_access, daemon=True).start()
            command('POST', '/element/' + button['element-6066-11e4-a52e-4f735466cecf'] + '/click', {})
            try:
                alert_text = command('GET', '/alert/text')
                observations['fixturePermissionAlert'] = alert_text
                # Accept only an identified prompt for this declared fixture host.
                if '127.0.0.1' in alert_text:
                    command('POST', '/alert/accept', {})
            except RuntimeError:
                observations['fixturePermissionAlert'] = 'not-a-webdriver-alert'
            grant = command('POST', '/execute/async', {'script': '''
              const done = arguments[arguments.length - 1];
              let attempt = 0;
              const check = () => {
                const text = document.getElementById('grant-result')?.textContent;
                if (text && text !== 'pending') { done(text); return; }
                if (++attempt === 20) { done(null); return; }
                setTimeout(check, 100);
              };
              check();
            ''', 'args': []})
            observations['fixturePermissionRequest'] = grant
            stage = 'fixture-page-access-permission'
            assert grant and json.loads(grant).get('granted') is True
            if not args.product_extension: command('DELETE', '/window')
    assert observations['internalDiagnostics'], 'Installed fixture did not become observable'
    lifecycle = json.loads(observations['internalDiagnostics'][0]['result'])['worker']['lifecycleEvents']
    assert all(lifecycle.get(name) is True for name in ['external', 'beforeNavigate', 'committed', 'errorOccurred', 'tabRemoved']), 'Missing required native lifecycle event'
    checks.append('native-lifecycle-events-available')
    command('POST', '/window', {'handle': initial_window})
    server = LoopbackServer(('127.0.0.1', 55189), Site)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    stage = 'allowed-native-port'
    navigate(origin + '/allowed')
    if args.product_extension:
        run_product_channel(extension_id, diagnostic_handles[0], initial_window)
        raise SystemExit(0)
    first_result = probe(extension_id)
    observations['nativeRecipientProbe'] = first_result
    # Compare only two browser-derived representations. This synthetic probe
    # does not define product recipient configuration or accept page claims.
    decoded_id = urllib.parse.unquote(extension_id)
    if decoded_id != extension_id:
        decoded_result = probe(decoded_id)
        observations['decodedRecipientProbe'] = decoded_result
        if first_result.get('outcome') != 'message' and decoded_result.get('outcome') == 'message':
            extension_id = decoded_id
            first_result = decoded_result
    observations['messagingRecipientId'] = extension_id
    first = first_result.get('message')
    assert first and first['type'] == 'observation'
    observations['first'] = first
    assert first['sender']['url'] == origin + '/allowed'
    assert first['sender']['frameId'] == 0
    checks.append('native-external-port-and-browser-top-frame-sender')
    assert first['senderTab']['incognito'] is False and first['currentTab']['incognito'] is False
    assert first['senderTab']['url'] == origin + '/allowed' and first['currentTab']['url'] == origin + '/allowed'
    assert first['currentTab']['status'] == 'complete'
    checks.append('normal-profile-confirmed-by-native-tab')
    assert isinstance(first['sender'].get('documentId'), str) and first['sender']['documentId']
    assert first['currentFrame']['documentId'] == first['sender']['documentId']
    checks.append('native-current-document-confirmed')
    assert first['sender']['url'] != 'https://wrong.example.test'
    checks.append('payload-claims-do-not-replace-browser-sender')
    stage = 'same-url-reload'
    command('POST', '/refresh', {})
    second_result = probe(extension_id)
    observations['reloadProbe'] = second_result
    second = second_result.get('message')
    assert second and second['sender']['url'] == origin + '/allowed'
    observations['afterReload'] = second
    checks.append('same-url-reload-observed-with-native-metadata')
    assert second['sender']['documentId'] != first['sender']['documentId']
    assert second['currentFrame']['documentId'] == second['sender']['documentId']
    checks.append('same-url-reload-has-new-native-document')
    stage = 'wrong-recipient'
    wrong = probe('org.example.nonexistent.Extension (AAAAAAAAAA)')
    observations['wrongRecipientProbe'] = wrong
    assert wrong.get('outcome') != 'message'
    checks.append('wrong-recipient-has-no-reply')
    stage = 'unlisted-web-origin'
    navigate('http://localhost:55189/denied')
    unlisted = probe(extension_id)
    observations['unlistedOriginProbe'] = unlisted
    assert unlisted.get('outcome') != 'message'
    checks.append('unlisted-web-origin-has-no-reply')
    result = {'status': 'synthetic-observations-only', 'checks': checks, 'observations': observations,
        'fixtureSha256': fixture_hash, 'osVersion': platform.mac_ver()[0], 'architecture': platform.machine(),
        'observedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'identityOrKeysUsed': False, 'fullMatrix': False}
    (out / 'report.json').write_text(json.dumps(result, indent=2))
    print('PASS: ' + str(len(checks)) + ' synthetic Safari observations; not product acceptance.')
except Exception as error:
    if args.ci_screenshot_on_failure:
        try:
            captured = subprocess.run(['/usr/sbin/screencapture', '-x', str(out / 'safari-screen.png')],
                timeout=5, capture_output=True)
            observations['ciScreenshotCaptured'] = captured.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            observations['ciScreenshotCaptured'] = False
    (out / 'failure.json').write_text(json.dumps({'stage': stage, 'checks': checks, 'observations': observations,
        'errorType': type(error).__name__, 'fixtureSha256': fixture_hash,
        'observedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}, indent=2))
    print('FAIL at ' + stage + '; value-free evidence recorded.')
    raise SystemExit(1) from None
finally:
    if session:
        try: request('DELETE', '/session/' + session)
        except Exception: pass
    if server: server.shutdown(); server.server_close()
    if other_port_server: other_port_server.shutdown(); other_port_server.server_close()
