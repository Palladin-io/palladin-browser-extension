#!/usr/bin/env python3
"""Actual built Firefox/Web, isolated Identity and RAM-only SES delivery fixture.
No auth/key injection, clipboard or screenshots. Only value-free evidence persists.
"""
import argparse, hashlib, json, mimetypes, pathlib, platform, re, secrets, subprocess, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from firefox_webdriver import FirefoxWebDriver
from shared_unlock_identity_steps import register_and_login_web, create_encrypted_entry

if not __debug__: raise RuntimeError('Evidence assertions require Python without optimization')
parser = argparse.ArgumentParser(description=__doc__)
for name in ['firefox', 'geckodriver', 'web-source', 'api-url', 'ses-url']: parser.add_argument('--' + name, required=True)
args = parser.parse_args()
for value in [args.api_url, args.ses_url]:
    assert urlsplit(value).hostname in ['localhost', '127.0.0.1'], 'Only isolated loopback services'
repo = pathlib.Path(__file__).resolve().parents[2]
web_source = pathlib.Path(args.web_source).resolve()
web_dist, extension = web_source / 'dist', repo / 'dist/firefox'
out = repo / 'test-results/shared-unlock-firefox-identity'
out.mkdir(parents=True, exist_ok=True)
for name in ['report.json', 'failure.json']: (out / name).unlink(missing_ok=True)
web_origin = 'http://127.0.0.1:5173'
email, password = 'cvt583-' + secrets.token_hex(8) + '@example.test', 'Synthetic!' + secrets.token_urlsafe(24)
entry_password = 'Entry!' + secrets.token_urlsafe(24)
messages, checks = [], []
stage, browser, server, mail_server = 'preflight', None, None, None
started_services = []
headers = {}
for line in (web_dist / '_headers').read_text().splitlines():
    if line.startswith('  ') and ':' in line:
        name, value = line.strip().split(':', 1); headers[name] = value.strip()
assert 'moz-extension:' in headers['Content-Security-Policy'] and '__PALLADIN_' not in headers['Content-Security-Policy']

def artifact_hash(directory):
    digest = hashlib.sha256()
    for path in sorted(directory.rglob('*')):
        if path.is_file():
            digest.update(str(path.relative_to(directory)).encode()); digest.update(b'\0'); digest.update(path.read_bytes()); digest.update(b'\0')
    return digest.hexdigest()

provenance = {'webHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=web_source, text=True).strip(),
    'extensionHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip(),
    'webWorkingTreeDirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=web_source, text=True).strip()),
    'extensionWorkingTreeDirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=repo, text=True).strip()),
    'webArtifactSha256': artifact_hash(web_dist), 'extensionArtifactSha256': artifact_hash(extension),
    'osVersion': platform.mac_ver()[0] or platform.release(), 'architecture': platform.machine(),
    'distribution': 'temporary-product-xpi', 'emailDelivery': 'local-ses-v2-fixture',
    'popupAutomation': 'native Firefox UI and real add-on DevTools target', 'webCspDelivered': True}
provenance['popupButtons'] = 'DOM activation in the real popup; not trusted-input/idle acceptance'
provenance['passwordProof'] = 'real exact-HTTPS-host automatic fill; empty local network fixture; boolean comparison only'
provenance['loginFixture'] = 'BiDi HTTP response; TLS handshake not tested; browser-owned declared optional permission granted only for exact fixture host'

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
            assert email in message['Destination']['ToAddresses']
            assert isinstance(message['Content']['Simple']['Body']['Html']['Data'], str)
            if len(messages) < 10: messages.append(message)
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'MessageId': secrets.token_hex(16)}).encode())
        except Exception:
            self.send_response(400); self.end_headers()
    def log_message(self, *unused): pass

def write_evidence(name, value):
    encoded = json.dumps(value, indent=2) + '\n'
    (out / (name + '.json')).write_text(encoded)
    version = re.sub(r'[^0-9A-Za-z._-]', '_', provenance.get('browserVersion', 'unknown'))
    (out / (name + '.firefox-' + version + '.json')).write_text(encoded)

def set_stage(value):
    global stage
    stage = value

def path(): return urlsplit(browser.request('GET', '/url')).path
def web(): browser.content()
def popup(): browser.native_popup(extension_id)
def web_ready():
    browser.wait(lambda: bool(browser.elements('//a[normalize-space(.)="Vaults"]', 'xpath')), 'unlocked Web')
def verify_url():
    found = re.search(r'http://127\.0\.0\.1:5173/verify-email\?token=[^"\\\s<]+', json.dumps(messages))
    return found[0] if found else None

try:
    with urllib.request.urlopen(args.api_url + '/api/health', timeout=3) as health: assert health.status == 200
    server = ThreadingHTTPServer(('127.0.0.1', 5173), WebHandler)
    mail_server = ThreadingHTTPServer(('127.0.0.1', urlsplit(args.ses_url).port), MailHandler)
    for service in [server, mail_server]:
        threading.Thread(target=service.serve_forever, daemon=True).start(); started_services.append(service)
    browser = FirefoxWebDriver(args.firefox, args.geckodriver, out / 'driver.log')
    extension_id = browser.install(extension)
    assert extension_id == json.loads((extension / 'manifest.json').read_text())['browser_specific_settings']['gecko']['id']
    browser.start_login_fixture(extension_id)
    provenance['browserVersion'] = browser.capabilities['browserVersion']
    provenance['geckodriverVersion'] = browser.capabilities.get('moz:geckodriverVersion')
    register_and_login_web(browser, web_origin, email, password, verify_url, set_stage, checks.append)
    stage = 'extension-native-popup'
    popup()
    stage = 'extension-onboarding'
    if browser.native_has_text('Continue to Palladin'): browser.native_click('Continue to Palladin')
    stage = 'extension-automatic-unlock'
    browser.native_wait_text('Unlocked'); checks.append('actual-extension-automatic-unlock')
    browser.native_wait_text('No entries yet'); checks.append('extension-authoritative-empty-snapshot-before-entry-creation')
    web(); create_encrypted_entry(browser, entry_password, set_stage, checks.append)
    stage = 'live-entry-invalidation'
    popup(); browser.native_wait_text('Synthetic shared unlock proof')
    stage = 'live-entry-password-autofill'
    assert browser.autofill_matches('synthetic-entry-user', entry_password)
    checks.append('live-entry-invalidation-and-decryption-without-relocking')
    stage = 'web-manual-lock-propagates'
    web(); browser.click_button('Lock')
    popup(); browser.native_wait_button('Unlock'); checks.append('web-manual-lock-propagated-to-extension')
    stage = 'web-fresh-manual-unlock'
    web(); browser.fill('#unlock-password', password); browser.click_button('Unlock'); web_ready()
    popup(); browser.native_wait_text('Unlocked')
    assert browser.autofill_matches('synthetic-entry-user', entry_password)
    checks.append('extension-automatically-unlocked-and-decrypted-after-new-manual-authorization')
    stage = 'extension-survives-web-close'
    web(); old = browser.request('GET', '/window')
    spare = browser.request('POST', '/window/new', {'type': 'tab'})['handle']
    browser.request('POST', '/window', {'handle': old}); browser.request('DELETE', '/window')
    browser.request('POST', '/window', {'handle': spare})
    popup(); assert browser.autofill_matches('synthetic-entry-user', entry_password)
    checks.append('extension-entry-decryption-after-web-close')
    stage = 'reopened-web-automatic-unlock'
    web(); browser.request('POST', '/url', {'url': web_origin + '/unlock'}); web_ready()
    checks.append('reopened-web-automatically-unlocked-by-extension')
    stage = 'browser-owned-background-stop'
    browser.stop_background(extension_id)
    checks.append('browser-owned-background-running-to-stopped-observed')
    stage = 'background-restart-and-fresh-handoff'
    popup(); browser.wait_background_running(extension_id)
    checks.append('browser-owned-background-restarted-observed')
    stage = 'restarted-extension-unlocked-surface'
    browser.native_wait_text('Unlocked')
    stage = 'restarted-extension-password-autofill'
    assert browser.autofill_matches('synthetic-entry-user', entry_password)
    checks.append('restarted-extension-automatically-unlocked-and-entry-decrypted')
    stage = 'extension-manual-lock-propagates'
    popup(); browser.native_click('Lock')
    web(); browser.element('#unlock-password'); checks.append('extension-manual-lock-propagated-to-web')
    stage = 'manual-unlock-before-shared-logout'
    browser.fill('#unlock-password', password); browser.click_button('Unlock'); web_ready()
    popup(); browser.native_wait_text('Unlocked')
    stage = 'extension-logout-propagates'
    browser.native_click('Sign out')
    web(); browser.element('#login-email'); checks.append('extension-logout-propagated-to-web')
    write_evidence('report', {'status': 'partial-pass', 'checks': checks, 'provenance': provenance,
        'observedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'entryDecryptionVerified': True,
        'fullMatrix': False, 'backgroundRestartVerified': True})
    print(f'PARTIAL: {len(checks)} real Firefox Identity/Entry checks PASS, including background restart. Full matrix remains required.')
except Exception as error:
    state = None
    popup_state = None
    if browser:
        if hasattr(browser, 'popup_url'):
            try:
                popup_state = browser.native_evaluate('''(async()=>{
                  const t=document.body.innerText;
                  let runtimeStatus='unavailable';
                  try {
                    const response=await chrome.runtime.sendMessage({type:'session/status'});
                    if(response?.ok===true && ['signed-out','locked','unlocked'].includes(response.status)) runtimeStatus=response.status;
                  } catch { }
                  return {runtimeStatus,
                  onboarding:t.includes('Continue to Palladin'),unlocked:t.includes('Unlocked'),
                  signIn:t.includes('Sign in'),unlock:t.includes('Unlock'),retry:t.includes('Try again'),
                  empty:t.includes('No entries yet'),entryVisible:t.includes('Synthetic shared unlock proof'),unreachable:t.includes("Couldn't reach Palladin"),
                  changed:t.includes('Your session changed')};})()''')
            except Exception: pass
        try:
            web()
            state = browser.script('''return {path:location.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi,':id'),
              login:!!document.querySelector('#login-email'),unlock:!!document.querySelector('#unlock-password'),
              vaults:[...document.querySelectorAll('a')].some(e=>e.innerText.trim()==='Vaults'),
              signIn:[...document.querySelectorAll('button')].some(e=>e.innerText.trim()==='Sign in'),
              logout:[...document.querySelectorAll('button')].some(e=>e.getAttribute('aria-label')==='Log out'||e.innerText.trim()==='Log out'),
              loginError:document.body.innerText.includes('Invalid email or password'),
              rateLimited:document.body.innerText.includes('Too many'),
              apiUnavailable:document.body.innerText.includes('Unable to connect')};''')
        except Exception: pass
    write_evidence('failure', {'stage': stage, 'checks': checks, 'errorType': type(error).__name__,
        'state': state, 'popupState': popup_state,
        'autofillObservation': getattr(browser, 'autofill_failure', None),
        'provenance': provenance, 'observedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
    print('FAIL at ' + stage + '; value-free failure.json recorded.')
    raise SystemExit(1) from None
finally:
    if browser: browser.close()
    for service in [server, mail_server]:
        if service:
            if service in started_services: service.shutdown()
            service.server_close()
    messages.clear()
