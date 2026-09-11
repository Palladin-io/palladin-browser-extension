#!/usr/bin/env python3
"""Synthetic native Safari recipient/document observations; never Identity or MK acceptance."""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
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
parser.add_argument('--ci-screenshot-on-failure', action='store_true')
parser.add_argument('--background-kind', choices=['classic-worker', 'module-worker', 'document'], default='module-worker')
args = parser.parse_args()
if args.ci_screenshot_on_failure:
    assert os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted', 'Screenshots only on disposable GitHub-hosted runners'
assert args.driver_url == 'http://127.0.0.1:55187', 'Task-owned local SafariDriver only'
out = Path('test-results/shared-unlock-safari-boundary').resolve()
fixture = out / 'fixture'
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
    'permissions': ['tabs', 'webNavigation', 'scripting'], 'host_permissions': ['http://127.0.0.1/*'],
    'externally_connectable': {'matches': ['http://127.0.0.1/*']},
    'background': background,
    'browser_specific_settings': {'safari': {'strict_min_version': '16.4'}}}
(fixture / 'manifest.json').write_text(json.dumps(manifest, indent=2))
(fixture / 'background.js').write_text('''
let disconnected = 0;
browser.runtime.onInstalled.addListener(() => {
  void browser.tabs.create({ url: browser.runtime.getURL('diagnostics.html') });
});
browser.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'synthetic-internal-probe') respond({ workerListenerReady: true });
});
function scope(value) {
  if (!value) return null;
  const result = {};
  for (const name of ['id', 'url', 'origin', 'frameId', 'parentFrameId', 'documentId', 'parentDocumentId', 'documentLifecycle', 'incognito', 'status']) {
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
  try { result.worker = await browser.runtime.sendMessage({ type: 'synthetic-internal-probe' }); } catch { result.workerReadFailed = true; }
  document.getElementById('result').textContent = JSON.stringify(result);
})();
''')
fixture_hash = hashlib.sha256(b''.join((fixture / name).read_bytes()
    for name in ['manifest.json', 'background.js', 'diagnostics.html', 'diagnostics.js'])).hexdigest()
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
checks = []
observations = {'backgroundKind': args.background_kind}
stage = 'session'
for name in ['report.json', 'failure.json']:
    (out / name).unlink(missing_ok=True)

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
    for attempt in range(100):
        handles = command('GET', '/window/handles')
        if len(handles) > 1:
            break
        time.sleep(0.1)
    observations['internalDiagnostics'] = []
    for handle in handles:
        if handle == initial_window:
            continue
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
                if (++attempt === 20) { done(null); return; }
                setTimeout(check, 100);
              };
              check();
            ''', 'args': []})
            observations['internalDiagnostics'].append({'browserUrl': url, 'result': result})
            button = command('POST', '/element', {'using': 'css selector', 'value': '#grant'})
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
            command('DELETE', '/window')
    assert observations['internalDiagnostics'], 'Installed fixture did not become observable'
    command('POST', '/window', {'handle': initial_window})
    server = LoopbackServer(('127.0.0.1', 55189), Site)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    stage = 'allowed-native-port'
    navigate(origin + '/allowed')
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
