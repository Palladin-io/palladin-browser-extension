#!/usr/bin/env python3
"""Real Safari/Web/Identity with a random encrypted Entry username as key proof.
Requires owner-enabled Safari automation. Never changes local Safari settings.
No session/key injection, screenshots, clipboard, eval or secret-bearing reports.
"""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import socketserver
import subprocess
import tempfile
import threading
import time
import urllib.request
from urllib.parse import urlsplit

from safari_webdriver import SafariWebDriver, SafariPopup, SafariDriverError
from shared_unlock_identity_steps import register_and_login_web, create_encrypted_entry, wait_web_unlocked

if not __debug__: raise RuntimeError('Evidence assertions require Python without optimization')
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--web-source', required=True, type=Path)
parser.add_argument('--prepare-only', action='store_true')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
web_source = args.web_source.resolve()
out = repo / 'test-results/shared-unlock-safari-identity'
out.mkdir(parents=True, exist_ok=True)
extension = repo / 'dist/safari'
fixture = out / 'fixture'
api_url, web_origin = 'http://127.0.0.1:55083', 'http://127.0.0.1:5173'
email = 'cvt583-' + secrets.token_hex(8) + '@example.test'
password, entry_password, username = ('Synthetic!' + secrets.token_urlsafe(24) for unused in range(3))
checks, messages, services = [], [], []
browser = popup = None
stage = 'prepare-fixture'
web_dist = None
headers = {}


def artifact_hash(directory):
    digest = hashlib.sha256()
    for path in sorted(directory.rglob('*')):
        if path.is_file():
            digest.update(path.relative_to(directory).as_posix().encode())
            digest.update(b'\0'); digest.update(path.read_bytes()); digest.update(b'\0')
    return digest.hexdigest()


provenance = {'webHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=web_source, text=True).strip(),
    'extensionHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip(),
    'webWorkingTreeDirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=web_source, text=True).strip()),
    'extensionWorkingTreeDirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=repo, text=True).strip()),
    'osVersion': platform.mac_ver()[0], 'architecture': platform.machine(),
    'distribution': 'temporary-instrumented-product-resources',
    'instrumentation': ['test display name', 'private test control page', 'wrapper imports unchanged product worker', 'fixed Popup-own-realm close function'],
    'entryProof': 'random encrypted username compared in actual native Popup and reopened Web; password autofill not tested',
    'popupAutomation': 'native getViews Popup DOM and product React handlers; not trusted-input/idle evidence',
    'emailDelivery': 'RAM-only loopback SES-v2 fixture'}


def set_stage(value):
    global stage
    stage = value
    print('Stage: ' + value, flush=True)


def write_evidence(name, extra):
    (out / (name + '.json')).write_text(json.dumps({'checks': checks, 'provenance': provenance,
        'observedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'fullMatrix': False, **extra}, indent=2))


def prepare_fixture():
    manifest = json.loads((extension / 'manifest.json').read_text())
    worker = manifest['background']['service_worker']
    assert manifest['background'].get('type') == 'module'
    assert 'http://127.0.0.1/*' in manifest.get('host_permissions', [])
    names = ['cvt583-identity.html', 'cvt583-identity.js', 'cvt583-identity-background.js', 'cvt583-popup-close.js']
    assert all(not (extension / name).exists() for name in names)
    provenance['extensionArtifactSha256'] = artifact_hash(extension)
    if fixture.exists(): shutil.rmtree(fixture)
    shutil.copytree(extension, fixture)
    manifest['name'] = 'Synthetic shared unlock boundary'
    manifest['background']['service_worker'] = names[2]
    (fixture / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    (fixture / names[2]).write_text('import ' + json.dumps('./' + worker) + ';\n' + '''
void (async () => {
  const url = browser.runtime.getURL('cvt583-identity.html');
  const tabs = await browser.tabs.query({});
  if (!tabs.some(tab => tab.url === url)) await browser.tabs.create({ url, active: false });
})();
''')
    (fixture / names[0]).write_text('''<!doctype html><title>Shared unlock test controls</title>
<button id="grant">Grant loopback access</button><pre id="grant-result">pending</pre>
<button id="open-popup">Open native Popup</button>
<script src="cvt583-identity.js"></script>''')
    (fixture / names[1]).write_text('''
document.getElementById('grant').addEventListener('click', async () => {
  let granted = false;
  try { granted = await browser.permissions.request({ origins: ['http://127.0.0.1/*'] }); } catch { }
  document.getElementById('grant-result').textContent = granted ? 'granted' : 'denied';
});
document.getElementById('open-popup').addEventListener('click', () => {
  void browser.action.openPopup().catch(() => undefined);
});
''')
    popup_document = fixture / 'src/popup/index.html'
    popup_html = popup_document.read_text()
    assert popup_html.count('</body>') == 1
    popup_document.write_text(popup_html.replace('</body>', '<script src="/cvt583-popup-close.js"></script></body>'))
    (fixture / names[3]).write_text('globalThis.syntheticClosePopup = () => setTimeout(() => window.close(), 0);\n')
    provenance['fixtureSha256'] = artifact_hash(fixture)


class LoopbackServer(ThreadingHTTPServer):
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)


class WebHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = (web_dist / urlsplit(self.path).path.lstrip('/')).resolve()
        if not path.is_relative_to(web_dist): self.send_error(403); return
        if not path.is_file(): path = web_dist / 'index.html'
        self.send_response(200)
        self.send_header('Content-Type', mimetypes.guess_type(path)[0] or 'application/octet-stream')
        for name, value in headers.items(): self.send_header(name, value)
        self.send_header('Cache-Control', 'no-store')
        self.end_headers(); self.wfile.write(path.read_bytes())

    def log_message(self, *unused): pass


class MailHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            assert self.path == '/v2/email/outbound-emails'
            size = int(self.headers.get('Content-Length', 0)); assert 0 < size <= 262144
            message = json.loads(self.rfile.read(size))
            assert message['Destination']['ToAddresses'] == [email]
            assert isinstance(message['Content']['Simple']['Body']['Html']['Data'], str)
            if len(messages) < 10: messages.append(message)
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'MessageId': secrets.token_hex(16)}).encode())
        except Exception:
            self.send_response(400); self.end_headers()

    def log_message(self, *unused): pass


def verify_url():
    found = re.search(r'http://127\.0\.0\.1:5173/verify-email\?token=[^"\\\s<]+', json.dumps(messages))
    return found[0] if found else None


def build_web(destination, extension_id):
    # Explicit empty values override ignored Vite files. Keep private Web assets
    # in a temporary directory, outside retained extension evidence/artifacts.
    env = {name: value for name, value in os.environ.items() if not name.startswith('VITE_')}
    for name in re.findall(r'^(VITE_[A-Z0-9_]+)=', (web_source / '.env.example').read_text(), re.MULTILINE):
        env[name] = ''
    env.update(VITE_API_URL=api_url, VITE_SIGNALR_HUB_URL=api_url + '/hubs/notifications',
        # Web currently requires this value even for password-only login.
        # A synthetic non-working ID avoids any real OAuth project configuration.
        VITE_GOOGLE_CLIENT_ID='synthetic-cvt583-test.apps.googleusercontent.com',
        VITE_PUBLIC_ASSET_URL='http://127.0.0.1:54583/palladin-local-public-assets',
        VITE_SHARED_UNLOCK_SAFARI_EXTENSION_ID=extension_id)
    with (out / 'web-build.log').open('w') as log:
        result = subprocess.run(['npm', 'run', 'build', '--', '--outDir', str(destination)],
            cwd=web_source, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=180)
    assert result.returncode == 0, 'Web build failed'


scratch = tempfile.TemporaryDirectory(prefix='cvt583-safari-private-web-')
try:
    prepare_fixture()
    if args.prepare_only:
        write_evidence('prepared', {'status': 'prepared-only', 'identityOrKeysUsed': False})
        print('Prepared Safari Identity fixture; no browser, account or key was used.')
        raise SystemExit(0)
    for name in ['report.json', 'failure.json']: (out / name).unlink(missing_ok=True)
    stage = 'isolated-api-health'
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(api_url + '/api/health', timeout=3) as response:
        assert response.status == 200
    stage = 'safari-session-owner-automation-prerequisite'
    browser = SafariWebDriver(out / 'driver.log')
    provenance['browserVersion'] = browser.capabilities['browserVersion']
    web_handle = browser.request('GET', '/window')
    stage = 'install-real-safari-product'
    extension_id = browser.install(fixture)
    provenance['browserInstalledExtensionId'] = extension_id
    stage = 'find-private-control-page'
    def find_control():
        for handle in browser.request('GET', '/window/handles'):
            if handle == web_handle: continue
            browser.request('POST', '/window', {'handle': handle})
            url = browser.request('GET', '/url')
            if url.startswith('safari-web-extension://') and url.endswith('/cvt583-identity.html'): return handle
        return None
    diagnostic_handle = browser.wait(find_control, 'installed control page')
    stage = 'verify-native-installed-extension-identity'
    assert browser.script('return browser.runtime.id') == extension_id
    stage = 'read-native-popup-url'
    popup_url = browser.script("return browser.runtime.getURL('src/popup/index.html')")
    popup = SafariPopup(browser.request, diagnostic_handle, popup_url)
    stage = 'native-loopback-permission'
    browser.click('#grant')
    browser.wait(lambda: browser.script("return document.getElementById('grant-result').textContent === 'granted'"), 'owner loopback permission')
    checks.append('native-installed-product-identity-and-loopback-permission')
    stage = 'build-web-with-browser-owned-safari-id'
    # macOS may spell the temporary root through /var -> /private/var.
    # Compare canonical paths on both sides of the traversal boundary.
    web_dist = (Path(scratch.name) / 'dist').resolve()
    build_web(web_dist, extension_id)
    provenance['webArtifactSha256'] = artifact_hash(web_dist)
    for line in (web_dist / '_headers').read_text().splitlines():
        if line.startswith('  ') and ':' in line:
            name, value = line.strip().split(':', 1); headers[name] = value.strip()
    assert 'Content-Security-Policy' in headers and '__PALLADIN_' not in headers['Content-Security-Policy']
    provenance['webCspDelivered'] = True
    for port, handler in [(5173, WebHandler), (55084, MailHandler)]:
        service = LoopbackServer(('127.0.0.1', port), handler)
        threading.Thread(target=service.serve_forever, daemon=True).start(); services.append(service)
    browser.request('POST', '/window', {'handle': web_handle})
    stage = 'deterministic-web-ui-language'
    browser.request('POST', '/url', {'url': web_origin + '/register'})
    browser.script("localStorage.setItem('palladin-lang', 'en')")
    register_and_login_web(browser, web_origin, email, password, verify_url, set_stage, checks.append)
    stage = 'extension-automatic-unlock'
    popup.show()
    if popup.has_text('Continue to Palladin'): popup.click_button('Continue to Palladin')
    popup.wait_text('Unlocked'); checks.append('actual-extension-automatic-unlock')
    popup.wait_text('No entries yet'); checks.append('extension-empty-snapshot-before-entry-creation')
    browser.request('POST', '/window', {'handle': web_handle})
    vault_id, entry_id = create_encrypted_entry(browser, entry_password, set_stage, checks.append, username=username)
    stage = 'native-extension-entry-decryption'
    assert popup.decrypted_username_matches(username)
    checks.append('actual-extension-random-encrypted-username-decrypted')
    stage = 'web-manual-lock-propagates'
    browser.request('POST', '/window', {'handle': web_handle}); browser.click_button('Lock')
    popup.show(); popup.wait_button('Unlock'); checks.append('web-manual-lock-propagated-to-extension')
    stage = 'web-fresh-manual-unlock'
    browser.request('POST', '/window', {'handle': web_handle})
    browser.fill('#unlock-password', password); browser.click_button('Unlock'); wait_web_unlocked(browser)
    popup.show(); popup.wait_text('Unlocked')
    assert popup.decrypted_username_matches(username)
    checks.append('extension-decrypts-after-fresh-manual-web-unlock')
    stage = 'extension-survives-web-close'
    browser.request('POST', '/window', {'handle': web_handle}); browser.request('DELETE', '/window')
    assert popup.decrypted_username_matches(username)
    checks.append('extension-decrypts-after-web-close')
    stage = 'reopened-web-automatic-unlock'
    web_handle = browser.request('POST', '/window/new', {'type': 'tab'})['handle']
    browser.request('POST', '/window', {'handle': web_handle})
    browser.request('POST', '/url', {'url': web_origin + '/unlock'}); wait_web_unlocked(browser)
    browser.request('POST', '/url', {'url': web_origin + '/vaults/' + vault_id + '/entries/' + entry_id})
    browser.wait(lambda: browser.script('''return document.body.innerText.includes(arguments[0])
      || [...document.querySelectorAll('input')].some(input => input.value === arguments[0])''', username), 'reopened Web decrypts Entry')
    checks.append('reopened-web-automatically-unlocked-and-entry-decrypted')
    stage = 'extension-manual-lock-propagates'
    popup.show(); popup.click_button('Lock')
    browser.request('POST', '/window', {'handle': web_handle}); browser.element('#unlock-password')
    checks.append('extension-manual-lock-propagated-to-web')
    stage = 'manual-unlock-before-shared-logout'
    browser.fill('#unlock-password', password); browser.click_button('Unlock'); wait_web_unlocked(browser)
    popup.show(); popup.wait_text('Unlocked')
    stage = 'extension-logout-propagates'
    popup.click_button('Sign out')
    browser.request('POST', '/window', {'handle': web_handle}); browser.element('#login-email')
    checks.append('extension-logout-propagated-to-web')
    write_evidence('report', {'status': 'partial-pass', 'entryDecryptionVerified': True,
        'passwordAutofillVerified': False, 'backgroundRestartVerified': False})
    print('PARTIAL: ' + str(len(checks)) + ' Safari Identity/Entry checks PASS; full matrix remains required.')
except Exception as error:
    web_ui = None
    if browser:
        try:
            browser.request('POST', '/window', {'handle': web_handle})
            web_ui = browser.script('''return {
              registration: !!document.querySelector('#register-email'),
              login: !!document.querySelector('#login-email'),
              unlock: !!document.querySelector('#unlock-password'),
              recovery: !!document.querySelector('ol.ph-no-capture'),
              englishContinue: [...document.querySelectorAll('button')].some(b => b.innerText.trim() === 'Continue'),
              enabledSubmit: !!document.querySelector('button[type="submit"]:not(:disabled)')
            }''')
        except Exception: web_ui = {'unavailable': True}
    write_evidence('failure', {'stage': stage, 'errorType': type(error).__name__,
        'webUi': web_ui,
        'webdriverError': error.kind if isinstance(error, SafariDriverError) else None,
        'popupStage': popup.last_stage if popup else None,
        'popupDismissal': popup.last_dismissal if popup else None})
    print('FAIL at ' + stage + '; value-free failure.json recorded.')
    raise SystemExit(1) from None
finally:
    if browser:
        browser.close()
        (out / 'cleanup.json').write_text(json.dumps(browser.cleanup, indent=2))
    for service in services: service.shutdown(); service.server_close()
    messages.clear()
    scratch.cleanup()
