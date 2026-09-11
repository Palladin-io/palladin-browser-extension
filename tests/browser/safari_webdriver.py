"""Safari Classic WebDriver and actual native Popup DOM, without eval or relays.
Never log WebDriver arguments, responses or browser exception messages.
"""
import json
from pathlib import Path
import subprocess
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

from webdriver_actions import WebDriverActions


class SafariDriverError(RuntimeError):
    def __init__(self, kind):
        super().__init__('Safari WebDriver command failed')
        self.kind = kind


class SafariWebDriver(WebDriverActions):
    def __init__(self, log_file):
        self.session = None
        self.log = Path(log_file).open('w')
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            self.port = reservation.getsockname()[1]
        self.driver = subprocess.Popen(['/usr/bin/safaridriver', '-p', str(self.port)],
            stdout=self.log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 10
            while True:
                if self.driver.poll() is not None:
                    raise RuntimeError('Task SafariDriver failed to start')
                try:
                    self.request('GET', '/status', session=False)
                    break
                except urllib.error.URLError:
                    if time.monotonic() >= deadline: raise TimeoutError('SafariDriver startup')
                    time.sleep(.1)
            created = self.request('POST', '/session', {'capabilities': {'alwaysMatch': {
                'browserName': 'safari', 'platformName': 'macOS'}}}, session=False)
            self.session, self.capabilities = created['sessionId'], created['capabilities']
            self.request('POST', '/timeouts', {'script': 10000, 'pageLoad': 30000, 'implicit': 0})
        except BaseException:
            self.close()
            raise

    def request(self, method, path, body=None, session=True):
        if session: path = '/session/' + self.session + path
        request = urllib.request.Request('http://127.0.0.1:' + str(self.port) + path,
            data=None if body is None else json.dumps(body).encode(), method=method,
            headers={'Content-Type': 'application/json'})
        try:
            with self.http.open(request, timeout=45) as response:
                return json.load(response)['value']
        except urllib.error.HTTPError as error:
            try:
                value = json.loads(error.read())['value']
                kind = value['error']
                if kind == 'session not created' and 'allow remote automation' in value.get('message', '').lower():
                    kind = 'remote-automation-disabled'
            except Exception: kind = 'webdriver error'
            allowed = {'session not created', 'invalid session id', 'no such window',
                'no such element', 'stale element reference', 'timeout', 'script timeout',
                'element not interactable', 'element click intercepted', 'unknown error', 'remote-automation-disabled'}
            raise SafariDriverError(kind if kind in allowed else 'webdriver error') from None

    def install(self, directory):
        value = self.request('POST', '/webextension', {'type': 'path', 'path': str(Path(directory).resolve())})
        if not isinstance(value, dict) or not isinstance(value.get('extension'), str):
            raise RuntimeError('Missing browser installation identity')
        return urllib.parse.unquote(value['extension'])

    def close(self):
        if self.session:
            try: self.request('DELETE', '')
            except Exception: pass
            self.session = None
        self.driver.terminate()
        try: self.driver.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.driver.kill()
            self.driver.wait(timeout=5)
        self.log.close()


class SafariPopup(WebDriverActions):
    def __init__(self, request, diagnostic_handle, popup_url):
        self.request = request
        self.diagnostic_handle = diagnostic_handle
        self.popup_url = popup_url
        self.last_stage = 'idle'
        self.last_dismissal = None

    def show(self):
        self.last_stage = 'activate-control-page'
        self.request('POST', '/window', {'handle': self.diagnostic_handle})
        if not self.read('return !!popup'):
            self.last_stage = 'open-native-popup'
            self.click('#open-popup')
            self.last_stage = 'observe-native-popup-open'
            self.wait(lambda: self.read('return !!popup'), 'native Safari Popup')
        self.last_stage = 'native-popup-open'

    def read(self, script, *args):
        # Only access the real browser-owned Popup window. Its private APIs must
        # be called by its own product handlers, not by this tab's JS context.
        return self.script('''
          const expected = arguments[0];
          const popup = browser.extension.getViews({ type: 'popup' })
            .find(view => view.location.href === expected);
          const values = Array.prototype.slice.call(arguments, 1);
        ''' + script, self.popup_url, *args)

    def fresh(self):
        self.last_stage = 'activate-control-page-for-close'
        self.request('POST', '/window', {'handle': self.diagnostic_handle})
        if self.read('return !!popup'):
            self.last_stage = 'dismiss-popup-in-own-realm'
            invoked = self.read('''
              if (typeof popup?.syntheticClosePopup !== 'function') return false;
              popup.syntheticClosePopup(); return true;
            ''')
            self.last_dismissal = 'own-realm-close-requested' if invoked else 'own-realm-close-unavailable'
            if not invoked: raise RuntimeError('Popup close test helper unavailable')
        self.last_stage = 'observe-native-popup-closed'
        self.wait(lambda: self.read('return !popup'), 'native Popup closed')
        self.show()

    def has_text(self, text):
        return self.read('return !!popup && popup.document.body.innerText.includes(values[0])', text)

    def wait_text(self, text):
        self.last_stage = 'wait-native-popup-text'
        self.wait(lambda: self.has_text(text), 'native Popup text')

    def click_button(self, name):
        # This exercises the product's own React callback. DOM activation is
        # deliberately not evidence of trusted input or idle renewal.
        self.wait(lambda: self.read('''
          if (!popup) return false;
          const button = [...popup.document.querySelectorAll('button')].find(button =>
            button.getAttribute('aria-label') === values[0] || button.innerText.trim() === values[0]);
          if (!button || button.disabled) return false;
          button.click(); return true;
        ''', name), 'native Popup button')

    def wait_button(self, name):
        self.last_stage = 'wait-native-popup-button'
        self.wait(lambda: self.read('''return !!popup && [...popup.document.querySelectorAll('button')]
          .some(button => button.getAttribute('aria-label') === values[0] || button.innerText.trim() === values[0])''', name), 'native Popup button')

    def decrypted_username_matches(self, expected):
        # A new React document cannot satisfy key-use proof with an old value
        # retained in the previously expanded row's component state.
        self.fresh()
        self.wait(lambda: self.read('''
          if (!popup) return false;
          const rows = [...popup.document.querySelectorAll('.entry-row')];
          const row = rows.find(row => row.innerText.includes('Synthetic shared unlock proof'));
          const head = row?.querySelector('button.entry-head');
          if (!head) return false;
          if (head.getAttribute('aria-expanded') !== 'true') head.click();
          return row.querySelector('.entry-name')?.textContent === values[0];
        ''', expected), 'actual Entry username decryption')
        return True

    def snapshot(self):
        return self.read('''
          if (!popup) return {present:false};
          const text=popup.document.body?.innerText || '';
          return {present:true,closed:popup.closed,readyState:popup.document.readyState,
            signIn:text.includes('Sign in'),unlocked:text.includes('Unlocked'),
            onboarding:text.includes('Continue to Palladin')};
        ''')
