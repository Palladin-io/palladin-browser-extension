#!/usr/bin/env python3
"""Synthetic Firefox 140-152 document-marker candidate; no accounts or keys.
This is boundary research, not product adapter or shared-unlock acceptance.
"""
import argparse,hashlib,pathlib,json,platform,tempfile,threading,time,zipfile
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from firefox_webdriver import FirefoxWebDriver

if not __debug__: raise RuntimeError('Evidence assertions require Python without optimization')
parser=argparse.ArgumentParser(description=__doc__)
for name in ['firefox','geckodriver']: parser.add_argument('--'+name,required=True)
args=parser.parse_args()
output=pathlib.Path(__file__).resolve().parents[2]/'test-results/shared-unlock-firefox-legacy-document'
output.mkdir(parents=True,exist_ok=True)
for name in ['report.json','failure.json']: (output/name).unlink(missing_ok=True)
stage='startup'
page='''<!doctype html><body><script>window.observations=[];addEventListener('message',e=>{if(e.data?.tag==='probe-origin'){const f=document.createElement('iframe');f.src=e.data.url;document.body.append(f)}else if(e.data?.tag==='probe-observation'){observations.push(e.data.value)}})</script>'''
class H(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(page.encode())
 def log_message(self,*a):pass
server=ThreadingHTTPServer(('127.0.0.1',0),H);threading.Thread(target=server.serve_forever,daemon=True).start()
origin='http://127.0.0.1:'+str(server.server_port)
id='document-authority-probe@palladin-test.invalid'
browser=None
try:
 with tempfile.TemporaryDirectory(prefix='cvt583-firefox-authority-package-') as directory:
  d=pathlib.Path(directory)
  manifest={'manifest_version':3,'name':'Synthetic document authority probe','version':'0.0.1','browser_specific_settings':{'gecko':{'id':id}},'permissions':['webNavigation','scripting'],'host_permissions':['http://127.0.0.1/*'],'background':{'scripts':['background.js']},'content_scripts':[{'matches':['http://127.0.0.1/*'],'js':['content.js'],'run_at':'document_end'}],'web_accessible_resources':[{'resources':['bridge.html','bridge.js'],'matches':['http://127.0.0.1/*']}]}
  files={'manifest.json':json.dumps(manifest),'content.js':'''globalThis.__cvt583IsolatedDocumentMarker=crypto.randomUUID();window.postMessage({tag:'probe-origin',url:browser.runtime.getURL('bridge.html')},location.origin);''','bridge.html':'<!doctype html><script src="bridge.js"></script>','bridge.js':'''(async()=>{const frameId=browser.runtime.getFrameId(window);const own=typeof browser.runtime.getContexts==='function'?await browser.runtime.getContexts({frameIds:[frameId],documentUrls:[location.href]}):[];const bridgeMarker=crypto.randomUUID();browser.runtime.onMessage.addListener(raw=>raw?.kind==='current-bridge'?Promise.resolve({marker:bridgeMarker}):undefined);const value=await browser.runtime.sendMessage({kind:'observe',own,bridgeMarker});parent.postMessage({tag:'probe-observation',value},'*');})();''','background.js':'''browser.runtime.onMessage.addListener((raw,sender)=>raw?.kind==='observe'?(async()=>({claimedContexts:raw.own,bridgeMarker:raw.bridgeMarker,currentBridge:await browser.tabs.sendMessage(sender.tab.id,{kind:'current-bridge'},{frameId:sender.frameId}),sender:{id:sender.id,url:sender.url,origin:sender.origin,frameId:sender.frameId,documentId:sender.documentId,tabId:sender.tab?.id},contexts:await browser.runtime.getContexts({tabIds:[sender.tab.id]}),frames:await browser.webNavigation.getAllFrames({tabId:sender.tab.id}),topMarker:(await browser.scripting.executeScript({target:{tabId:sender.tab.id,frameIds:[0]},world:'ISOLATED',func:()=>globalThis.__cvt583IsolatedDocumentMarker})).map(r=>({frameId:r.frameId,result:r.result,documentId:r.documentId}))}))():undefined);'''}
  for name,value in files.items():(d/name).write_text(value)
  browser=FirefoxWebDriver(args.firefox,args.geckodriver,output/'driver.log')
  assert 140<=int(browser.capabilities['browserVersion'].split('.')[0])<153
  stage='install'
  archive=d/'probe.xpi'
  with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
   for name in files:z.write(d/name,name)
  assert browser.request('POST','/moz/addon/install',{'path':str(archive),'temporary':True})==id
  stage='initial-document'
  browser.request('POST','/url',{'url':origin})
  read=lambda:browser.script('return window.observations.at(-1)??null')
  first=browser.wait(read,'first authority')
  stage='same-url-bridge-reload'
  browser.script('window.observations=[];const f=document.querySelector("iframe");f.src=f.src')
  second=browser.wait(read,'same-url bridge reload')
  stage='page-world-marker-forgery'
  # A page-world expando cannot replace the isolated extension document marker.
  browser.script('window.__cvt583IsolatedDocumentMarker="page-forged-marker";window.observations=[];const f=document.querySelector("iframe");f.src=f.src')
  third=browser.wait(read,'page marker forgery')
  stage='top-reload'
  browser.request('POST','/refresh',{})
  fourth=browser.wait(read,'top reload')
  stage='candidate-assertions'
  def ctx(o):
   assert o['bridgeMarker']==o['currentBridge']['marker']
   return o['bridgeMarker']
  def marker(o):
   assert len(o['topMarker'])==1 and o['topMarker'][0]['frameId']==0
   return o['topMarker'][0]['result']
  assert len({ctx(first),ctx(second),ctx(third),ctx(fourth)})==4
  assert marker(first)==marker(second)==marker(third) and marker(third)!=marker(fourth)
  assert first['sender']['frameId']==second['sender']['frameId']==third['sender']['frameId']
  assert all(not x.get('documentId') for o in [first,second,third,fourth] for x in o['frames'])
  assert all(not o['sender'].get('documentId') for o in [first,second,third,fourth])
  assert all(not o['claimedContexts'] and not o['contexts'] for o in [first,second,third,fourth])
  for o in [first,second,third,fourth]:
   assert o['sender']['id']==id and o['sender']['origin'].startswith('moz-extension://')
   top=next(f for f in o['frames'] if f['frameId']==0)
   bridge=next(f for f in o['frames'] if f['frameId']==o['sender']['frameId'])
   assert top['url'].rstrip('/')==origin and bridge['parentFrameId']==0 and bridge['url']==o['sender']['url']
  assert first['bridgeMarker']!=second['currentBridge']['marker']
  out={'browserVersion':browser.capabilities['browserVersion'],'scope':'synthetic candidate only; no product adapter acceptance','checks':['browser-current-frame-message-returns-own-marker','same-frame-same-URL-reload-changes-marker','old-marker-does-not-match-current-frame-response','isolated-top-marker-stable-across-child-reload','page-world-marker-forgery-does-not-change-isolated-marker','top-reload-changes-isolated-marker','native-document-IDs-absent-on-140'],'getContextsExposesBridge':False,'osVersion':platform.mac_ver()[0] or platform.release(),'architecture':platform.machine(),'geckodriverVersion':browser.capabilities.get('moz:geckodriverVersion'),'fixtureSha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'observedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
  (output/'report.json').write_text(json.dumps(out,indent=2)+'\n')
  print('Firefox '+out['browserVersion']+': 7 synthetic document-authority observations PASS. No product or security acceptance.')
except Exception as error:
 (output/'failure.json').write_text(json.dumps({'stage':stage,'errorType':type(error).__name__})+'\n')
 print('Synthetic legacy document probe failed; value-free failure.json recorded.')
 raise SystemExit(1) from None
finally:
 if browser:browser.close()
 server.shutdown();server.server_close()
