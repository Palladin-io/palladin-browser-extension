import net from 'node:net'
import {spawn,execFileSync} from 'node:child_process'
import {readFile,writeFile} from 'node:fs/promises'
// Run inside the documented disposable Linux container with clean cloned
// checkouts and already-built local artifacts under /work. These byte-preserving
// proxies change only loopback reachability; no request/auth/key state is edited.
// The host Docker command/events, not this script, establish the image identity.
const servers=[]
const proxy=async(listenPort,destinationPort,destinationHost,listenHost='127.0.0.1')=>{
 const server=net.createServer(socket=>{
  const upstream=net.createConnection({host:destinationHost,port:destinationPort})
  socket.pipe(upstream);upstream.pipe(socket)
  socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy())
  socket.on('close',()=>upstream.destroy());upstream.on('close',()=>socket.destroy())
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(listenPort,listenHost,resolve)});servers.push(server)
}
let child
try{
 for(const dir of ['/work/extension','/work/web','/work/backend'])execFileSync('git',['config','--global','--add','safe.directory',dir])
 await proxy(55083,55083,'host.docker.internal')
 await proxy(54583,54583,'host.docker.internal')
 await proxy(55085,55084,'127.0.0.1','0.0.0.0')
 const health=await fetch('http://localhost:55083/api/health');if(health.status!==200)throw Error('Own fixture API not healthy')
 const os=await readFile('/etc/os-release','utf8')
 await writeFile('/work/reports/container-environment.json',JSON.stringify({osRelease:os,architecture:process.arch,nodeVersion:process.version,fixture:'byte-preserving TCP loopback proxies to isolated host services; SES host-only published port; no auth/key injection'},null,2)+'\n')
 console.log('PRECHECK: isolated API health200; Linux browser, loopback TCP forwarding, unchanged built artifacts.')
 child=spawn(process.execPath,['tests/browser/shared-unlock-identity-e2e.mjs','--web-source','/work/web','--backend-source','/work/backend','--api-url','http://localhost:55083','--ses-url','http://127.0.0.1:55084',...process.argv.slice(2)],{cwd:'/work/extension',stdio:'inherit'})
 process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code)=>resolve(code??1))})
}catch(error){console.log(JSON.stringify({fixtureFailed:true,errorType:error.name,reason:error.message==='Own fixture API not healthy'?error.message:'fixture startup/child failure'}));process.exitCode=1}
finally{for(const server of servers)server.close();}
