"""Task-owned Firefox WebDriver, including native browser UI automation.

Never log WebDriver request/response bodies: tests may type synthetic credentials.
System access is used only to operate Firefox's native extension surface, like
CDP's native-popup control on Chromium. It does not change product permissions,
CSP, crypto, Identity responses or session state. The login fixture separately
grants only its declared optional host through the browser permission store.
"""
import json, pathlib, re, socket, subprocess, tempfile, time, urllib.error, urllib.request, zipfile


class FirefoxWebDriver:
    def __init__(self, firefox, geckodriver, log_file):
        self.session = None
        self.login_fixture = None
        self.profile = tempfile.TemporaryDirectory(prefix='palladin-firefox-identity-')
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0)); self.port = reservation.getsockname()[1]
        self.log = pathlib.Path(log_file).open('w')
        self.driver = subprocess.Popen([geckodriver, '--allow-system-access', '--host', '127.0.0.1',
            '--port', str(self.port), '--log', 'error'], stdout=self.log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 15
            while True:
                if self.driver.poll() is not None: raise RuntimeError('Driver startup failed')
                try: self.request('GET', '/status', session=False); break
                except urllib.error.URLError:
                    if time.monotonic() >= deadline: raise TimeoutError('Driver startup')
                    time.sleep(.1)
            created = self.request('POST', '/session', {'capabilities': {'alwaysMatch': {'browserName': 'firefox', 'webSocketUrl': True,
                'moz:firefoxOptions': {'binary': str(pathlib.Path(firefox).resolve()),
                'args': ['-headless', '-profile', self.profile.name], 'prefs': {
                    'browser.shell.checkDefaultBrowser': False, 'datareporting.healthreport.uploadEnabled': False,
                    'toolkit.telemetry.enabled': False}}}}}, session=False)
            self.session = created['sessionId']
            self.capabilities = created['capabilities']
            self.request('POST', '/timeouts', {'script': 20000, 'pageLoad': 30000, 'implicit': 0})
        except BaseException:
            self.close(); raise

    def request(self, method, path, body=None, session=True):
        if session: path = '/session/' + self.session + path
        raw = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(f'http://127.0.0.1:{self.port}' + path, data=raw,
            method=method, headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=45) as response: return json.load(response)['value']
        except urllib.error.HTTPError as error:
            # Avoid endpoint messages/stack traces/arguments that could contain
            # synthetic secrets or a verification URL. Only protocol error kind.
            try: kind = json.loads(error.read())['value']['error']
            except Exception: kind = 'webdriver error'
            raise RuntimeError(kind) from None

    def install(self, directory):
        # Keep the package available while older Firefox lazily loads scripts.
        archive = pathlib.Path(self.profile.name) / f'addon-{time.monotonic_ns()}.xpi'
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as zipped:
            for path in sorted(pathlib.Path(directory).rglob('*')):
                if path.is_file(): zipped.write(path, path.relative_to(directory))
        return self.request('POST', '/moz/addon/install', {'path': str(archive), 'temporary': True})

    def script(self, script, *args):
        return self.request('POST', '/execute/sync', {'script': script, 'args': args})

    def async_script(self, script, *args):
        return self.request('POST', '/execute/async', {'script': script, 'args': args})

    def wait(self, read, label='condition', seconds=25):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            value = read()
            if value: return value
            time.sleep(.1)
        raise TimeoutError(label)

    def elements(self, selector, using='css selector'):
        return self.request('POST', '/elements', {'using': using, 'value': selector})

    def element(self, selector, using='css selector'):
        return self.wait(lambda: next(iter(self.elements(selector, using)), None), 'element')

    @staticmethod
    def element_id(value):
        return value['element-6066-11e4-a52e-4f735466cecf']

    def click(self, selector, using='css selector'):
        element = self.element(selector, using)
        self.request('POST', '/element/' + self.element_id(element) + '/click', {})

    def fill(self, selector, value):
        element = self.element_id(self.element(selector))
        self.request('POST', '/element/' + element + '/click', {})
        self.request('POST', '/element/' + element + '/clear', {})
        self.request('POST', '/element/' + element + '/value', {'text': value})

    def button(self, name):
        # Names here are static test labels; JSON's double-quoted literal is also
        # an XPath literal for this bounded label vocabulary (no double quotes).
        assert '"' not in name
        fold = "'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'"
        return '//button[translate(normalize-space(.),' + fold + ')=' + json.dumps(name.lower()) + ' or translate(@aria-label,' + fold + ')=' + json.dumps(name.lower()) + ']'

    def click_button(self, name): self.click(self.button(name), 'xpath')

    def context(self, name): self.request('POST', '/moz/context', {'context': name})

    def content(self):
        self.context('content')

    def native_popup(self, extension_id):
        self.context('chrome')
        self.popup_id = extension_id
        self.popup_url = self.script("return WebExtensionPolicy.getByID(arguments[0]).getURL('src/popup/index.html')", extension_id)
        widget = re.sub('[^a-z0-9_-]', '_', extension_id.lower()) + '-browser-action'
        self.script('CustomizableUI.addWidgetToArea(arguments[0],CustomizableUI.AREA_NAVBAR)', widget)
        if not self.script('return [...document.querySelectorAll("browser")].some(e=>e.currentURI?.spec===arguments[0])', self.popup_url):
            self.click('.webextension-browser-action[data-extensionid=' + json.dumps(extension_id) + ']')
        self.wait(lambda: self.script('return [...document.querySelectorAll("browser")].some(e=>e.currentURI?.spec===arguments[0])', self.popup_url), 'native popup')

    def native_evaluate(self, expression):
        self.context('chrome')
        if not self.script('return [...document.querySelectorAll("browser")].some(e=>e.currentURI?.spec===arguments[0])', self.popup_url):
            raise RuntimeError('Native popup closed')
        # Standard Firefox add-on DevTools target. This keeps the real popup
        # principal/sender; Classic/BiDi cannot address its top-level remote
        # browsing context as a tab/frame. No debug target or app is substituted.
        result = self.async_script('''
          const done=arguments[arguments.length-1], id=arguments[0], url=arguments[1], expression=arguments[2];
          (async()=>{
            const {require}=ChromeUtils.importESModule('resource://devtools/shared/loader/Loader.sys.mjs');
            const {CommandsFactory}=require('devtools/shared/commands/commands-factory');
            const commands=await CommandsFactory.forAddon(id);
            try {
              await commands.targetCommand.startListening();
              const targets=commands.targetCommand.getAllTargets(commands.targetCommand.ALL_TYPES).filter(t=>t.url===url);
              if(targets.length!==1) throw Error('Native popup target unavailable');
              const packet=await commands.scriptCommand.execute('(async()=>JSON.stringify('+expression+'))()',
                {selectedTargetFront:targets[0],mapped:{await:true}});
              if(packet.hasException || packet.exception || typeof packet.result!=='string') throw Error('Native observation failed');
              return JSON.parse(packet.result);
            } finally { await commands.destroy(); }
          })().then(value=>done({ok:true,value}),()=>done({ok:false}));
        ''', self.popup_id, self.popup_url, expression)
        if not result['ok']: raise RuntimeError('Native observation failed')
        return result['value']

    def native_has_text(self, text):
        return self.native_evaluate('document.body.innerText.includes(' + json.dumps(text) + ')')

    def native_wait_text(self, text):
        self.wait(lambda: self.native_has_text(text), 'native text')

    def native_wait_button(self, name):
        self.wait(lambda: self.native_evaluate('''[...document.querySelectorAll('button')].some(b=>
          b.getAttribute('aria-label')===NAME || b.innerText.trim()===NAME)'''.replace('NAME', json.dumps(name))), 'native button')

    def native_click(self, name):
        # DOM activation in the actual popup executes its real React callback
        # and native sender. It is intentionally not evidence for isTrusted
        # input/idle renewal, which needs its separate acceptance scenarios.
        self.wait(lambda: self.native_evaluate('''(()=>{
          const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===NAME || b.innerText.trim()===NAME);
          if(!b || b.disabled) return false;
          b.click(); return true;
        })()'''.replace('NAME', json.dumps(name))), 'native button')

    def stop_background(self, extension_id):
        self.context('chrome')
        # The same browser-owned operation as about:debugging's Terminate
        # Background Script. Do not mutate application state or reload Web.
        result = self.async_script('''
          const done=arguments[arguments.length-1], id=arguments[0];
          (async()=>{
            const {ExtensionParent}=ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
            const debug=ExtensionParent.DebugUtils;
            const before=debug.isBackgroundScriptRunning(id);
            await debug.terminateBackgroundScript(id);
            return {before,after:debug.isBackgroundScriptRunning(id)};
          })().then(value=>done({ok:true,value}),()=>done({ok:false}));
        ''', extension_id)
        if not result['ok'] or result['value'] != {'before': True, 'after': False}:
            raise RuntimeError('Background stop was not observed')

    def wait_background_running(self, extension_id):
        self.context('chrome')
        self.wait(lambda: self.script('''
          const {ExtensionParent}=ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
          return ExtensionParent.DebugUtils.isBackgroundScriptRunning(arguments[0])===true;
        ''', extension_id), 'background restart')

    def start_login_fixture(self, extension_id):
        origin = 'https://shared-unlock-login.example.test'
        self.login_fixture = subprocess.Popen(['node', str(pathlib.Path(__file__).with_name('firefox-login-fixture.mjs'))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, text=True)
        self.login_fixture.stdin.write(json.dumps({'webSocketUrl': self.capabilities['webSocketUrl'], 'origin': origin}) + '\n')
        self.login_fixture.stdin.flush()
        # Node bounds connection/setup requests; process exit also ends readline.
        if self.login_fixture.stdout.readline().strip() != 'ready': raise RuntimeError('Login fixture setup failed')
        self.context('chrome')
        result = self.async_script('''
          const done=arguments[arguments.length-1];
          const {ExtensionPermissions}=ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
          ExtensionPermissions.add(arguments[0],{permissions:[],origins:[arguments[1]+'/*']})
            .then(()=>done(true),()=>done(false));
        ''', extension_id, origin)
        if not result: raise RuntimeError('Fixture site permission unavailable')
        self.content()

    def autofill_matches(self, username, password):
        self.content()
        original = self.request('GET', '/window')
        fixture = self.request('POST', '/window/new', {'type': 'tab'})['handle']
        try:
            self.request('POST', '/window', {'handle': fixture})
            self.request('POST', '/url', {'url': 'https://shared-unlock-login.example.test/login'})
            return self.wait(lambda: self.script('''return location.protocol==='https:'
              && document.querySelector('input[name=username]')?.value===arguments[0]
              && document.querySelector('input[name=password]')?.value===arguments[1]
              && window.submitted===false''', username, password), 'actual password autofill') is True
        finally:
            self.request('DELETE', '/window')
            self.request('POST', '/window', {'handle': original})

    def close(self):
        if self.login_fixture:
            self.login_fixture.terminate()
            try: self.login_fixture.wait(timeout=5)
            except subprocess.TimeoutExpired: self.login_fixture.kill(); self.login_fixture.wait(timeout=5)
        if self.session:
            try: self.request('DELETE', '')
            except Exception: pass
            self.session = None
        self.driver.terminate()
        try: self.driver.wait(timeout=10)
        except subprocess.TimeoutExpired: self.driver.kill(); self.driver.wait(timeout=10)
        self.log.close()
        self.profile.cleanup()
