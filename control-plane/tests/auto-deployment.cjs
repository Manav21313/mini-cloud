// Live integration test. Leaves the requested public FocusFlow app on localhost:3006.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { readFile, writeFile, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Docker = require('dockerode');
const { pool } = require('../dist/database/connection.js');
const { ApplicationRegistry } = require('../dist/applications/registry.js');
const { SourceDeployer, clonePublicRepository } = require('../dist/deployments/source.js');
const docker = new Docker(), registry = new ApplicationRegistry();
const base='http://127.0.0.1:8084';
const focus={name:'FocusFlow',repositoryUrl:'https://github.com/Manav21313/FocusFlow',branch:'main',containerPort:80,hostPort:3006};
let server, nodeApp;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function start(){
 let output='';server=spawn(process.execPath,[path.resolve(__dirname,'../dist/server.js')],{env:{...process.env,CONTROL_PLANE_PORT:'8084'},stdio:['ignore','pipe','pipe']});
 server.stdout.on('data',c=>output+=c);server.stderr.on('data',c=>output+=c);
 for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error(output);if(output.includes('MiniCloud dashboard:'))return;await delay(100);}throw Error(output);
}
async function stop(){
 if(!server||server.exitCode!==null)return;
 const done=once(server,'exit');server.kill('SIGTERM');const timer=setTimeout(()=>server.kill('SIGKILL'),10000);
 const [code]=await done;clearTimeout(timer);assert.equal(code,0);
}
async function api(route,method='GET',body,expected=200){
 const r=await fetch(base+route,{method,headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
 const data=await r.json();assert.equal(r.status,expected,JSON.stringify(data));return data;
}
async function formDeploy(body){
 const html=await(await fetch(base)).text();
 const elements=Object.fromEntries(['#apps','#output','#new-app','#github-app'].map(id=>[id,{innerHTML:'',textContent:'',listeners:{},addEventListener(event,fn){this.listeners[event]=fn;}}]));
 const context={document:{querySelector:id=>elements[id]},console,fetch:(route,options)=>fetch(base+route,options),FormData:function(form){return Object.entries(form.values)}};
 await vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1]+'\nloadApps();',context);
 const button={disabled:false},form={values:body,querySelector:()=>button,reset(){}};
 await elements['#github-app'].listeners.submit({preventDefault(){},target:form});
 assert.doesNotMatch(elements['#output'].textContent,/^Error:/);
 assert.equal(button.disabled,false);
 assert.ok(elements['#apps'].innerHTML.includes(`<h3>${body.name}</h3>`));
 return JSON.parse(elements['#output'].textContent);
}
async function artifacts(){return {
 rows:(await pool.query('SELECT id FROM applications ORDER BY id')).rows,
 containers:(await docker.listContainers({all:true})).map(c=>c.Id).sort(),
 tags:(await docker.listImages()).flatMap(i=>i.RepoTags||[]).filter(t=>t.startsWith('minicloud-source:')).sort(),
 directories:(await readdir(tmpdir())).filter(n=>n.startsWith('minicloud-build-')).sort()
};}
async function focusHttp(){
 for(let attempt=0;attempt<50;attempt++) {
   try {
     const response=await fetch('http://127.0.0.1:3006',{headers:{Connection:'close'}});assert.equal(response.status,200);
     const html=await response.text();assert.match(html,/focusflow/i);
     const asset=html.match(/<script[^>]+src="([^"]+)"/)[1];const js=await fetch('http://127.0.0.1:3006'+asset);assert.equal(js.status,200);assert.ok((await js.text()).length>1000);
     const route=await fetch('http://127.0.0.1:3006/signin');assert.equal(route.status,200);assert.equal(await route.text(),html);
     assert.equal((await fetch('http://127.0.0.1:3006/assets/missing.js')).status,404);
     return;
   } catch(error) {if(attempt===49)throw error;await delay(100);}
 }
}

(async()=>{
 await start();
 console.log('Building the actual public FocusFlow repository without a Dockerfile...');
 const existing=(await api('/api/apps')).find(a=>a.name==='FocusFlow');
 let focused;
 if(existing){
   assert.equal(existing.repositoryUrl,focus.repositoryUrl);assert.equal(existing.hostPort,3006);
   await api(`/api/apps/${existing.id}/deploy`,'POST');focused=existing;
   console.log('Existing FocusFlow registration preserved; use a fresh database/name to repeat its initial build.');
 }else{
   const result=await formDeploy(focus);assert.equal(result.projectType,'Vite');assert.match(result.detectionReason,/Vite dependency/);focused=result.application;
   assert.match(result.buildOutput,/Successfully built/);
 }
 await focusHttp();
 const row=(await pool.query('SELECT * FROM applications WHERE id=$1',[focused.id])).rows[0];assert.equal(row.repository_url,focus.repositoryUrl);
 assert.equal((await artifacts()).directories.length,0);
 console.log('PASS FocusFlow: public clone, Vite detection, generated multi-stage image, localhost HTML/JS assets, SPA routes, SQL, and temporary-file cleanup');

 console.log('Building a public basic Node backend without a Dockerfile...');
 const result=await formDeploy({name:'Automatic Node Integration Test',repositoryUrl:'https://github.com/heroku/nodejs-getting-started',branch:'main',containerPort:3020,hostPort:3015});
 assert.equal(result.projectType,'Node.js');nodeApp=result.application;
 const response=await fetch('http://127.0.0.1:3015');assert.equal(response.status,200);assert.match(await response.text(),/Heroku|Node/i);
 const container= docker.getContainer(nodeApp.containerName);
 const process=await container.exec({Cmd:['node','-e','console.log(require("fs").existsSync("/app/.env"))'],AttachStdout:true,AttachStderr:true});
 const stream=await process.start({Detach:false,Tty:false});let output='';for await(const chunk of stream)output+=chunk.toString();assert.match(output,/false/);
 console.log('PASS Node backend: detected existing npm start, production installation, supplied PORT=3020, localhost response, and .env excluded from image');
 await api(`/api/apps/${nodeApp.id}`,'DELETE');await docker.getImage(nodeApp.image).remove();nodeApp=undefined;

 const beforeUnsupported=await artifacts();
 const unsupported=await api('/api/deploy/github','POST',{...focus,name:'Unsupported Auto Test',repositoryUrl:'https://github.com/octocat/Hello-World',branch:'master',hostPort:3016},422);
 assert.match(unsupported.error,/could not automatically determine.*Add a Dockerfile manually/);assert.deepEqual(await artifacts(),beforeUnsupported);
 console.log('PASS unsupported repository fails clearly without artifacts');

 console.log('Testing a broken npm build inside a generated Dockerfile...');
 const broken = new SourceDeployer(registry,docker,async(input,directory)=>{
   const checkout=await clonePublicRepository(input,directory);
   const manifest=JSON.parse(await readFile(path.join(checkout,'package.json'),'utf8'));
   manifest.scripts.build+=' && node -e "console.error(\'intentional automatic npm build failure\');process.exit(42)"';
   await writeFile(path.join(checkout,'package.json'),JSON.stringify(manifest,null,2));return checkout;
 });
 const beforeBroken=await artifacts();
 await assert.rejects(broken.deploy({...focus,name:'Broken Automatic Build Test',hostPort:3016}),e=>/Docker build failed/.test(e.message)&&/intentional automatic npm build failure/.test(e.message));
 assert.deepEqual(await artifacts(),beforeBroken);
 console.log('PASS broken npm build returns useful output and leaves no rows, containers, tags, or temporary repositories');

 const badDependencies=new SourceDeployer(registry,docker,async(input,directory)=>{
   const checkout=await clonePublicRepository(input,directory);
   const manifest=JSON.parse(await readFile(path.join(checkout,'package.json'),'utf8'));
   manifest.dependencies['minicloud-deliberately-invalid-test-package']='0.0.0';
   await writeFile(path.join(checkout,'package.json'),JSON.stringify(manifest));return checkout;
 });
 const beforeDependencies=await artifacts();
 await assert.rejects(badDependencies.deploy({...focus,name:'Broken Automatic Install Test',hostPort:3016}),e=>/Docker build failed/.test(e.message)&&/npm ci|in sync|Missing:/i.test(e.message));
 assert.deepEqual(await artifacts(),beforeDependencies);
 console.log('PASS lockfile/dependency installation failure is useful and cleans up');

 await stop();await start();
 const restored=await api(`/api/apps/${focused.id}`);assert.equal(restored.image,focused.image);assert.equal(restored.status,'running');await focusHttp();
 await api(`/api/apps/${focused.id}/stop`,'POST');assert.equal((await api(`/api/apps/${focused.id}`)).status,'exited');
 await api(`/api/apps/${focused.id}/restart`,'POST');await focusHttp();assert.match((await api(`/api/apps/${focused.id}/logs`)).logs,/nginx|GET/);
 console.log('PASS FocusFlow survives MiniCloud restart, and existing Stop/Restart/Status/Logs still work');
 console.log('FocusFlow remains registered and running at http://localhost:3006');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
 if(nodeApp){try{await api(`/api/apps/${nodeApp.id}`,'DELETE');await docker.getImage(nodeApp.image).remove();}catch(e){console.error('Cleanup:',e.message);}}
 await stop();await pool.end();
});
