"""Common Classic WebDriver actions. Never log arguments or responses."""
import json, time


class WebDriverActions:
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

