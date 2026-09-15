#!/usr/bin/env python3
"""Real built Firefox extension channel in a disposable profile. No account or MK.
The synthetic Web fixture uses CSP; this does not replace product Web/Identity E2E.
"""
import argparse, base64, hashlib, io, json, mimetypes, pathlib, platform, socket, subprocess, threading, time, urllib.request, zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if not __debug__:
    raise RuntimeError('Run without Python optimization; evidence assertions are mandatory')
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--firefox', required=True)
parser.add_argument('--geckodriver', required=True)
parser.add_argument('--web-origin', required=True)
parser.add_argument('--api-url', required=True)
parser.add_argument('--web-source', help='Serve this real Web dist with its generated security headers; observe its own provider after bridge removal/reconnect')
args = parser.parse_args()
from urllib.parse import urlsplit
web = urlsplit(args.web_origin)
if web.scheme != 'http' or web.hostname not in ['127.0.0.1', 'localhost'] or not web.port or web.path or web.query or web.fragment:
    parser.error('The fixture requires an explicit loopback Web origin with port')
repo = pathlib.Path(__file__).resolve().parents[2]
artifact = repo / 'dist/firefox'
manifest = json.loads((artifact / 'manifest.json').read_text())
expected_id = manifest['browser_specific_settings']['gecko']['id']
out = repo / 'test-results/shared-unlock-firefox-channel'
out.mkdir(parents=True, exist_ok=True)
(out / 'report.json').unlink(missing_ok=True)
script = r'''
window.channelEvidence = { candidates: 0, ready: null, retired: false, errors: [] };
const expectedId = __EXPECTED_ID__, apiUrl = __API_URL__;
let frame, extensionOrigin, nonce, channel;
window.addEventListener('message', async event => {
  const data = event.data;
  if (event.source === window && event.origin === location.origin && data?.type === 'palladin.shared-unlock.firefox.candidate.v1') {
    window.channelEvidence.candidates++;
    if (frame || !/^moz-extension:\/\/[0-9a-f-]+$/.test(data.origin)) return;
    try {
      const canonical = data.origin + '/manifest.json';
      const response = await fetch(canonical, { credentials: 'omit', redirect: 'error', cache: 'no-store' });
      if (!response.ok || response.redirected || response.url !== canonical) throw Error('canonical resource');
      const manifest = await response.json();
      if (manifest.browser_specific_settings?.gecko?.id !== expectedId) throw Error('wrong canonical ID');
      extensionOrigin = data.origin;
      frame = document.createElement('iframe'); frame.hidden = true;
      frame.src = extensionOrigin + '/src/shared-unlock-bridge/index.html';
      frame.addEventListener('load', () => {
        nonce = 'A'.repeat(43);
        frame.contentWindow.postMessage({ type:'hello', protocol:'palladin.shared-unlock.browser.v1', apiUrl, webNonce:nonce }, extensionOrigin);
      }, { once:true });
      document.body.append(frame);
    } catch (error) { window.channelEvidence.errors.push(error.message); }
    return;
  }
  if (!frame || event.source !== frame.contentWindow || event.origin !== extensionOrigin) return;
  if (data?.type === 'ready') {
    if (data.extensionId !== expectedId || data.webOrigin !== location.origin || data.apiUrl !== apiUrl || data.webNonce !== nonce) {
      window.channelEvidence.errors.push('ready binding'); return;
    }
    channel = data;
    window.channelEvidence.ready = { originVerified: true, sourceVerified: true, idVerified: true,
      documentBindingPresent: typeof data.documentBinding === 'string' && data.documentBinding.endsWith('/'+data.channelId) };
  }
  if (data?.type === 'palladin.shared-unlock.firefox.closed.v1') window.channelEvidence.retired = true;
});
window.sendInvalidSharedUnlock = () => frame.contentWindow.postMessage({ type:'hello', protocol:'palladin.shared-unlock.browser.v1',
 apiUrl, webNonce:nonce }, extensionOrigin);
setInterval(() => { if (!frame) window.postMessage({type:'palladin.shared-unlock.firefox.discover.v1'}, location.origin); }, 600);
'''.replace('__EXPECTED_ID__', json.dumps(expected_id)).replace('__API_URL__', json.dumps(args.api_url))
page = ('<!doctype html><meta charset="utf-8"><title>Palladin synthetic Firefox channel</title><body>Channel only<script>' + script + '</script></body>').encode()
csp_hash = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
web_dist = pathlib.Path(args.web_source).resolve() / 'dist' if args.web_source else None
web_headers = {}
if web_dist:
    for line in (web_dist / '_headers').read_text().splitlines():
        if line.startswith('  ') and ':' in line:
            key, value = line.strip().split(':', 1); web_headers[key] = value.strip()
    assert 'moz-extension:' in web_headers.get('Content-Security-Policy', '')
    assert '__PALLADIN_' not in web_headers.get('Content-Security-Policy', '')

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if web_dist:
            path = (web_dist / urlsplit(self.path).path.lstrip('/')).resolve()
            if not path.is_relative_to(web_dist): self.send_error(403); return
            if not path.is_file(): path = web_dist / 'index.html'
            self.send_response(200)
            self.send_header('Content-Type', mimetypes.guess_type(path)[0] or 'application/octet-stream')
            for key, value in web_headers.items(): self.send_header(key, value)
            self.end_headers(); self.wfile.write(path.read_bytes()); return
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Security-Policy', f"default-src 'self'; script-src 'sha256-{csp_hash}'; connect-src 'self' moz-extension:; frame-src moz-extension:; object-src 'none'; base-uri 'none'")
        self.end_headers(); self.wfile.write(page)
    def log_message(self, *unused): pass

server = ThreadingHTTPServer((web.hostname, web.port), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
with socket.socket() as reservation:
    reservation.bind(('127.0.0.1', 0)); driver_port = reservation.getsockname()[1]
driver_log = (out / 'driver.log').open('w')
driver = subprocess.Popen([args.geckodriver, '--host', '127.0.0.1', '--port', str(driver_port), '--log', 'error'], stdout=driver_log, stderr=subprocess.STDOUT)
def request(method, path, body=None):
    raw = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f'http://127.0.0.1:{driver_port}' + path, data=raw, method=method, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=45) as response: return json.load(response)['value']
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error

session = None
try:
    deadline = time.monotonic() + 15
    while True:
        if driver.poll() is not None: raise RuntimeError('Task-owned geckodriver failed to start')
        try: request('GET', '/status'); break
        except urllib.error.URLError:
            if time.monotonic() >= deadline: raise RuntimeError('Task-owned geckodriver timed out')
            time.sleep(.1)
    created = request('POST', '/session', {'capabilities': {'alwaysMatch': {'browserName': 'firefox', 'moz:firefoxOptions': {
        'binary': str(pathlib.Path(args.firefox).resolve()), 'args': ['-headless'], 'prefs': {
            'browser.shell.checkDefaultBrowser': False, 'datareporting.healthreport.uploadEnabled': False, 'toolkit.telemetry.enabled': False}}}}})
    session = created['sessionId']; root = '/session/' + session
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as zipped:
        for path in sorted(artifact.rglob('*')):
            if path.is_file(): zipped.write(path, path.relative_to(artifact))
    installed = request('POST', root + '/moz/addon/install', {'addon': base64.b64encode(archive.getvalue()).decode(), 'temporary': True})
    assert installed == expected_id
    request('POST', root + '/url', {'url': args.web_origin + ('/login' if web_dist else '/channel')})
    if web_dist:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            present = request('POST', root + '/execute/sync', {'script': "return !!document.querySelector('iframe[src^=\"moz-extension:\"]')", 'args': []})
            if present: break
            time.sleep(.2)
        assert present, 'Product Web did not create its Firefox bridge'
        # Observe public channel metadata only. Removing the first frame exercises
        # the real lifecycle reconnect. No runtime, crypto or auth state is set.
        request('POST', root + '/execute/sync', {'script': '''
          window.channelEvidence = { ready:null, errors:[] };
          window.addEventListener('message', event => {
            if (event.data?.type !== 'ready') return;
            const frame = document.querySelector('iframe[src^="moz-extension:"]');
            if (!frame || event.source !== frame.contentWindow) return;
            const expectedOrigin = frame.src.slice(0, frame.src.indexOf('/', 'moz-extension://'.length));
            window.channelEvidence.ready = { originVerified:event.origin===expectedOrigin,
              sourceVerified:true, idVerified:event.data.extensionId===arguments[0],
              documentBindingPresent:typeof event.data.documentBinding==='string' && event.data.documentBinding.endsWith('/'+event.data.channelId) };
          });
          document.querySelector('iframe[src^="moz-extension:"]').remove();
        ''', 'args': [expected_id]})
    deadline = time.monotonic() + 20
    evidence = None
    while time.monotonic() < deadline:
        evidence = request('POST', root + '/execute/sync', {'script': 'return window.channelEvidence', 'args': []})
        if evidence and (evidence['ready'] or evidence['errors']): break
        time.sleep(.2)
    assert evidence and evidence['ready'] and not evidence['errors'], json.dumps(evidence)
    assert all(evidence['ready'].values())
    retired = None
    if not web_dist:
        request('POST', root + '/execute/sync', {'script': 'window.sendInvalidSharedUnlock()', 'args': []})
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            retired = request('POST', root + '/execute/sync', {'script': 'return window.channelEvidence.retired', 'args': []})
            if retired: break
            time.sleep(.1)
        assert retired, 'Repeated hello did not retire the real bridge'
    result = {'checkedAtUtc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'browserVersion': created['capabilities']['browserVersion'],
        'osVersion': platform.mac_ver()[0] or platform.release(), 'architecture': platform.machine(),
        'scope': ('Built Web and extension channel with delivered Web CSP and real bridge-loss reconnect.' if web_dist else 'Built extension / synthetic Web fixture with CSP.') + ' No Identity, MK or Entry acceptance.',
        'artifactSha256': hashlib.sha256(archive.getvalue()).hexdigest(), 'ready': evidence['ready'], 'invalidHelloRetired': retired}
    if web_dist:
        result['webArtifactSha256'] = {str(path.relative_to(web_dist)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(web_dist.rglob('*')) if path.is_file()}
    (out / 'report.json').write_text(json.dumps(result, indent=2) + '\n')
    print('Built Firefox private bridge: canonical ID, native origin/source and ready PASS. ' + ('Product Web CSP and real bridge-loss reconnect PASS.' if web_dist else 'Repeated-hello retirement PASS.') + ' Identity/MK not exercised.')
finally:
    if session:
        try: request('DELETE', '/session/' + session)
        except Exception: pass
    server.shutdown(); server.server_close(); driver.terminate()
    try: driver.wait(timeout=10)
    except subprocess.TimeoutExpired: driver.kill(); driver.wait(timeout=10)
    driver_log.close()
