#!/usr/bin/env python3
# Synthetic, disposable-profile research harness. Never loads a Palladin account.
# Python 3 standard library only; Firefox and geckodriver are explicit local inputs.
import argparse, base64, hashlib, io, json, os, pathlib, platform, socket, subprocess, threading, time, urllib.request, zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parents[2] / 'test-results/shared-unlock-firefox-boundary'
ROOT.mkdir(parents=True, exist_ok=True)
(ROOT / 'report.json').unlink(missing_ok=True)
if not __debug__:
    raise RuntimeError('Run this evidence probe without Python optimization; assertions are mandatory')
parser = argparse.ArgumentParser(description='Synthetic Firefox resource-identity probe; no MK handoff or feature acceptance.')
parser.add_argument('--firefox', default=os.environ.get('PALLADIN_FIREFOX_BINARY'))
parser.add_argument('--geckodriver', default=os.environ.get('PALLADIN_GECKODRIVER_BINARY'))
args = parser.parse_args()
for label, value in [('firefox', args.firefox), ('geckodriver', args.geckodriver)]:
    if not value or not pathlib.Path(value).is_file():
        parser.error('--' + label + ' must name an installed executable; no default/user browser profile is used')
with socket.socket() as reservation:
    reservation.bind(('127.0.0.1', 0))
    driver_port = reservation.getsockname()[1]
driver_log = (ROOT / 'driver.log').open('w')
driver = subprocess.Popen([args.geckodriver, '--host', '127.0.0.1', '--port', str(driver_port), '--log', 'error'],
                          stdout=driver_log, stderr=subprocess.STDOUT)
EXPECTED = 'shared-unlock-probe@palladin-test.invalid'
OTHER = 'other-probe@palladin-test.invalid'
PAGE = b'''<!doctype html><meta charset="utf-8"><title>Synthetic extension boundary probe</title><script>
window.observations = [];
window.addEventListener('message', async e => {
  if (e.data?.tag !== 'palladin-synthetic-probe') return;
  if (e.data.kind === 'candidate') {
    const u = new URL(e.data.url);
    const candidate = {claimedId:e.data.claimedId, candidateUrl:e.data.url, eventOrigin:e.origin};
    const frame = document.createElement('iframe');
    frame.src = u.protocol + '//' + u.host + '/probe.html';
    document.body.append(frame);
    window.observations.push(candidate);
    try {
      const response = await fetch(u.protocol + '//' + u.host + '/manifest.json', {credentials:'omit', redirect:'error', cache:'no-store'});
      const manifest = await response.json();
      candidate.fetch = {status:response.status, url:response.url, redirected:response.redirected, type:response.type,
        actualId:manifest.browser_specific_settings?.gecko?.id};
      candidate.accepted = candidate.fetch.actualId === 'shared-unlock-probe@palladin-test.invalid';
    } catch(error) { candidate.fetchError = String(error); }
  } else if (e.data.kind === 'frame') {
    window.observations.push({kind:'frame', origin:e.origin, sourceMatches:[...document.querySelectorAll('iframe')].some(f=>f.contentWindow===e.source), data:e.data});
  }
});
</script><body>Only synthetic data.</body>'''

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(PAGE)
    def log_message(self, *args): pass

server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'

def request(method,path,body=None):
    raw=None if body is None else json.dumps(body).encode()
    req=urllib.request.Request(f'http://127.0.0.1:{driver_port}'+path,data=raw,method=method,headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=60) as response: return json.load(response)['value']
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error

manifest_base={'manifest_version':3,'name':'Palladin synthetic boundary probe','version':'0.0.1',
  'background':{'scripts':['background.js']},
  'permissions':['webRequest','webRequestBlocking','webRequestFilterResponse','declarativeNetRequest','webNavigation'],
  'host_permissions':['<all_urls>'],
  'content_scripts':[{'matches':['http://127.0.0.1/*'],'js':['content.js'],'run_at':'document_end'}],
  'web_accessible_resources':[{'resources':['manifest.json','probe.html','probe.js','fake-manifest.json','sw.js'], 'matches':['http://127.0.0.1/*']}]}

background='''const state={webRequestRegistration:null, observed:[], dnr:null};
browser.runtime.onMessage.addListener((raw,sender) => raw?.kind === 'state' ? (async()=>({ ...state,
 sender:{id:sender.id,url:sender.url,origin:sender.origin,frameId:sender.frameId,documentId:sender.documentId,
 tab:sender.tab?{id:sender.tab.id,incognito:sender.tab.incognito,url:sender.tab.url}:null},
 frames:sender.tab?await browser.webNavigation.getAllFrames({tabId:sender.tab.id}):null }))() : undefined);
try { browser.webRequest.onBeforeRequest.addListener(d=>{state.observed.push(d.url); return {redirectUrl:browser.runtime.getURL('fake-manifest.json')};},
 {urls:[browser.runtime.getURL('manifest.json')]}, ['blocking']); state.webRequestRegistration='registered'; }
catch(e){state.webRequestRegistration=String(e);}
try { browser.declarativeNetRequest.updateDynamicRules({addRules:[{id:1,priority:1,
 action:{type:'redirect',redirect:{extensionPath:'/fake-manifest.json'}},condition:{urlFilter:browser.runtime.getURL('manifest.json')}}]})
 .then(()=>state.dnr='registered',e=>state.dnr=String(e)); } catch(e) {state.dnr=String(e);}
'''
content=f'''window.postMessage({{tag:'palladin-synthetic-probe',kind:'candidate',url:browser.runtime.getURL(browser.runtime.id === {json.dumps(EXPECTED)} ? 'manifest.json' : 'fake-manifest.json'),claimedId:{json.dumps(EXPECTED)}}}, location.origin);'''
frame=f'''(async()=>{{
let sw;
try{{ await navigator.serviceWorker.register('sw.js',{{scope:'/'}}); sw='registered'; }}catch(e){{sw=String(e);}}
const state=await browser.runtime.sendMessage({{kind:'state'}});
parent.postMessage({{tag:'palladin-synthetic-probe',kind:'frame',sw,state,actualOwnId:browser.runtime.id}}, {json.dumps(origin)});
}})();'''

def fixture(case):
    id = case['id']
    manifest=dict(manifest_base)
    manifest['browser_specific_settings']={'gecko':{'id':id,'data_collection_permissions':{'required':['none']}}}
    if case.get('alias'):
        manifest['applications']={'gecko':{'id':case['alias']}}
    raw_manifest=json.dumps(manifest)
    if case.get('duplicate_settings_first'):
        raw_manifest='{"browser_specific_settings":'+json.dumps({'gecko':{'id':case['duplicate_settings_first']}})+','+raw_manifest[1:]
    if case.get('duplicate_id_first'):
        raw_manifest=raw_manifest.replace('"id": '+json.dumps(id), '"id": '+json.dumps(case['duplicate_id_first'])+', "id": '+json.dumps(id), 1)
    data={'manifest.json':raw_manifest,'background.js':background,'content.js':content,
      'probe.html':'<!doctype html><script src="probe.js"></script>', 'probe.js':frame,
      'fake-manifest.json':json.dumps({'browser_specific_settings':{'gecko':{'id':EXPECTED}}}),
      'sw.js':"self.addEventListener('fetch',e=>e.respondWith(new Response("+json.dumps(json.dumps({'browser_specific_settings':{'gecko':{'id':EXPECTED}}}))+")));"}
    archive=io.BytesIO()
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
        if case.get('duplicate_zip_first'):
            first=dict(manifest)
            first['browser_specific_settings']={'gecko':{'id':case['duplicate_zip_first'],'data_collection_permissions':{'required':['none']}}}
            z.writestr('manifest.json',json.dumps(first))
        for name,value in data.items(): z.writestr(name,value)
    (ROOT / (case['name']+'.xpi')).write_bytes(archive.getvalue())
    return base64.b64encode(archive.getvalue()).decode()

session=None
try:
    deadline = time.monotonic() + 15
    while True:
        if driver.poll() is not None:
            raise RuntimeError('The task-owned geckodriver exited before startup')
        try:
            request('GET', '/status')
            break
        except urllib.error.URLError:
            if time.monotonic() >= deadline:
                raise RuntimeError('Task-owned geckodriver startup timed out')
            time.sleep(.1)
    created=request('POST','/session',{'capabilities':{'alwaysMatch':{'browserName':'firefox','moz:firefoxOptions':{
      'binary':str(pathlib.Path(args.firefox).resolve()),'args':['-headless'],
      'prefs':{'browser.shell.checkDefaultBrowser':False,'datareporting.healthreport.uploadEnabled':False,'toolkit.telemetry.enabled':False}}}}})
    session=created['sessionId']; root='/session/'+session
    result={'browserVersion':created['capabilities']['browserVersion'],'platformName':created['capabilities']['platformName'],'architecture':platform.machine(),'osVersion':platform.mac_ver()[0] or platform.release(),'pythonVersion':platform.python_version(),'geckodriverVersion':created['capabilities'].get('moz:geckodriverVersion'),'checkedAtUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'scope':'Synthetic Firefox manifest-resource candidate only; not browser-identity approval, no shared unlock or MK','cases':[]}
    cases=[
      {'name':'expected','id':EXPECTED},
      {'name':'other','id':OTHER},
      {'name':'alias-expected-canonical-other','id':OTHER,'alias':EXPECTED},
      {'name':'alias-other-canonical-expected','id':EXPECTED,'alias':OTHER},
      {'name':'duplicate-settings-expected-first','id':OTHER,'duplicate_settings_first':EXPECTED},
      {'name':'duplicate-settings-other-first','id':EXPECTED,'duplicate_settings_first':OTHER},
      {'name':'duplicate-id-expected-first','id':OTHER,'duplicate_id_first':EXPECTED},
      {'name':'duplicate-id-other-first','id':EXPECTED,'duplicate_id_first':OTHER},
      {'name':'duplicate-zip-expected-first','id':OTHER,'duplicate_zip_first':EXPECTED},
      {'name':'duplicate-zip-other-first','id':EXPECTED,'duplicate_zip_first':OTHER},
    ]
    for case in cases:
        id=case['id']
        addon=fixture(case)
        try:
            installed=request('POST',root+'/moz/addon/install',{'addon':addon,'temporary':True})
        except RuntimeError as error:
            if not case.get('duplicate_zip_first') or 'Could not install add-on' not in str(error): raise
            # A rejected ambiguous package establishes no identity. Never count
            # an installation failure as a positive supported runtime route.
            result['cases'].append({'name':case['name'],'installation':'rejected','accepted':False})
            continue
        request('POST',root+'/url',{'url':origin+'/'+id})
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            observations=request('POST',root+'/execute/sync',{'script':'return window.observations','args':[]})
            if observations and any(x.get('kind')=='frame' for x in observations) and any('fetch' in x or 'fetchError' in x for x in observations): break
            time.sleep(.2)
        # Repeat the fetch after the frame has attempted to install interception.
        fetched=request('POST',root+'/execute/async',{'script':"const done=arguments[arguments.length-1]; const item=window.observations.find(x=>x.candidateUrl); fetch(item.fetch.url,{credentials:'omit',redirect:'error',cache:'no-store'}).then(async r=>done({url:r.url,body:await r.json()}),e=>done({error:String(e)}));",'args':[]})
        candidate=next(x for x in observations if 'candidateUrl' in x)
        frame_observation=next(x for x in observations if x.get('kind')=='frame')
        if not case.get('duplicate_zip_first'): assert installed == id
        assert installed in [EXPECTED,OTHER]
        assert candidate['claimedId'] == EXPECTED
        assert candidate['fetch']['actualId'] == installed
        assert candidate['accepted'] == (installed == EXPECTED)
        assert candidate['fetch']['redirected'] is False
        assert candidate['fetch']['status'] == 200
        assert candidate['fetch']['url'] == frame_observation['origin'] + '/manifest.json'
        assert frame_observation['origin'].startswith('moz-extension://') and frame_observation['sourceMatches']
        assert frame_observation['data']['actualOwnId'] == installed
        assert frame_observation['data']['state']['webRequestRegistration'] == 'registered'
        assert frame_observation['data']['state']['dnr'] == 'registered'
        assert frame_observation['data']['state']['observed'] == []
        assert frame_observation['data']['sw'] != 'registered'
        assert fetched['body']['browser_specific_settings']['gecko']['id'] == installed
        assert fetched['url'] == candidate['fetch']['url']
        request('POST',root+'/url',{'url':origin.replace('127.0.0.1','localhost')+'/unlisted-origin'})
        denied=request('POST',root+'/execute/async',{'script':"const done=arguments[arguments.length-1]; fetch(arguments[0],{credentials:'omit',redirect:'error',cache:'no-store'}).then(r=>done({denied:false,status:r.status}),e=>done({denied:true,errorName:e.name}));",'args':[candidate['fetch']['url']]})
        assert denied['denied'] is True
        result['cases'].append({'name':case['name'],'requestedId':id,'browserInstalledId':installed,'observations':observations,'afterInterceptionAttempt':fetched,'unlistedOrigin':denied})
        request('POST',root+'/moz/addon/uninstall',{'id':installed})
        request('POST',root+'/url',{'url':origin+'/after-uninstall'})
        removed=request('POST',root+'/execute/async',{'script':"const done=arguments[arguments.length-1]; fetch(arguments[0],{credentials:'omit',redirect:'error',cache:'no-store'}).then(r=>done({denied:false,status:r.status}),e=>done({denied:true,errorName:e.name}));",'args':[candidate['fetch']['url']]})
        assert removed['denied'] is True
        result['cases'][-1]['afterUninstall']=removed
    result['fixtureSha256']={case['name']+'.xpi':hashlib.sha256((ROOT/(case['name']+'.xpi')).read_bytes()).hexdigest() for case in cases}
    (ROOT/'report.json').write_text(json.dumps(result,indent=2)+'\n')
    print(f"Firefox {result['browserVersion']} on {result['platformName']}/{result['architecture']}: synthetic positive and wrong-ID/resource/interception cases PASS. This does not approve the candidate identity boundary or shared unlock.")
finally:
    if session:
        try: request('DELETE','/session/'+session)
        except Exception: pass
    server.shutdown()
    server.server_close()
    driver.terminate()
    try: driver.wait(timeout=10)
    except subprocess.TimeoutExpired:
        driver.kill()
        driver.wait(timeout=10)
    driver_log.close()
