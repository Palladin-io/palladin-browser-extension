import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

// Exercise the actual Python helper's emitted JavaScript against synthetic
// Safari window transitions; no browser, user profile, or credential is used.
const source = JSON.parse(execFileSync('python3', ['-c', `
import sys,json
sys.path.insert(0,'tests/browser')
from safari_webdriver import SafariPopup
def request(method,path,body): return body['script']
print(json.dumps(SafariPopup(request,'synthetic','fixture://popup').read('return popup')))
`], { encoding: 'utf8' })) as string;
const select = (views: object[]) => new Function('browser', `return (function(){${source}}).call(null,'fixture://popup')`)({ extension: { getViews: () => views } });
function popup(focused: boolean, readyState = 'complete') {
  return { closed: false, location: { href: 'fixture://popup' }, document: { readyState, hasFocus: () => focused } };
}
it('prefers the presented focused native popup over its preloaded predecessor', () => {
  const preloaded = popup(false), presented = popup(true);
  expect(select([preloaded, presented])).toBe(presented);
});
it('skips a stale Safari window whose cross-window properties are unavailable', () => {
  const stale = { closed: false, get location() { throw new Error('Synthetic detached view'); } }, presented = popup(true);
  expect(select([stale, presented])).toBe(presented);
});
it('keeps a readable unfocused view visible to close/lifecycle observations', () => {
  const preloaded = popup(false);
  expect(select([preloaded])).toBe(preloaded);
});
it('does not treat another URL or closed view as the native popup', () => {
  expect(select([{ ...popup(true), closed: true }, { ...popup(true), location: { href: 'fixture://other' } }])).toBeUndefined();
});
it('waits for native presentation after opening without repeating the open action', () => {
  const result = JSON.parse(execFileSync('python3', ['-c', `
import sys,json
sys.path.insert(0,'tests/browser')
from safari_webdriver import SafariPopup
class Probe(SafariPopup):
 def __init__(self):
  super().__init__(lambda *args:None,'synthetic','fixture://popup')
  self.reads=0;self.opens=0;self.waits=[]
 def read(self,script,*args):
  self.reads+=1
  return self.reads>1
 def click(self,*args): self.opens+=1
 def wait(self,read,label='condition',seconds=25):
  self.waits.append(label)
  assert read()
p=Probe();p.show();print(json.dumps({'opens':p.opens,'waits':p.waits}))
`], { encoding: 'utf8' })) as { opens: number; waits: string[] };
  expect(result.opens).toBe(1);
  expect(result.waits).toContain('native Popup presentation');
});
