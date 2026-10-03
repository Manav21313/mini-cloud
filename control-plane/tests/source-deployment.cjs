// Live GitHub + Docker + PostgreSQL integration test. Uses disposable test apps.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:net');
const { writeFile, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Docker = require('dockerode');
const { pool } = require('../dist/database/connection.js');
const { ApplicationRegistry, RegistryError } = require('../dist/applications/registry.js');
const { SourceDeployer, clonePublicRepository, sourceInput, sourceContainerName } = require('../dist/deployments/source.js');
const docker = new Docker();
const registry = new ApplicationRegistry();
const base = 'http://127.0.0.1:8083';
const good = {name:'V04 GitHub Test',repositoryUrl:'https://github.com/crccheck/docker-hello-world',branch:'master',containerPort:8000,hostPort:3010};
let server, app, ui;
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function api(route, method='GET', body, code=200) {
  const r = await fetch(base+route,{method,headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const value = await r.json();assert.equal(r.status,code,JSON.stringify(value));return value;
}
async function start() {
  let output='';
  server=spawn(process.execPath,[path.resolve(__dirname,'../dist/server.js')],{env:{...process.env,CONTROL_PLANE_PORT:'8083'},stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',chunk=>output+=chunk);server.stderr.on('data',chunk=>output+=chunk);
  for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error(output);if(output.includes('MiniCloud dashboard:'))return;await pause(100);}
  throw Error(output);
}
async function stop() {
  if(!server||server.exitCode!==null)return;
  const done=once(server,'exit');server.kill('SIGTERM');
  const timer=setTimeout(()=>server.kill('SIGKILL'),10000);const [code]=await done;clearTimeout(timer);assert.equal(code,0);
}
async function html() {
  for(let i=0;i<50;i++) {try {const r=await fetch('http://127.0.0.1:3010');assert.equal(r.status,200);assert.match(await r.text(),/Hello World/i);return;}catch(e){if(i===49)throw e;await pause(100);}}
}
async function dashboard() {
  const html=await(await fetch(base)).text();
  const elements=Object.fromEntries(['#apps','#output','#new-app','#github-app'].map(id=>[id,{innerHTML:'',textContent:'',listeners:{},addEventListener(event,fn){this.listeners[event]=fn;}}]));
  const context={document:{querySelector:id=>elements[id]},console,fetch:(route,options)=>fetch(base+route,options),FormData:function(form){return Object.entries(form.values)},window:{open:(url)=>context.opened=url},confirm:()=>true};
  vm.createContext(context);
  await vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1]+'\nloadApps();',context);
  return {elements,context,load:()=>vm.runInContext('loadApps();',context)};
}
async function uiAction(action,method='POST') {
  const button={dataset:{action,method},closest:()=>({dataset:{id:app.id}}),hasAttribute:attribute=>attribute==='data-open'&&action==='open'};
  await ui.elements['#apps'].listeners.click({target:{closest:()=>button}});
  assert.doesNotMatch(ui.elements['#output'].textContent,/^Error:/);
}
async function artifacts() {
  return {apps:(await pool.query('SELECT id FROM applications ORDER BY id')).rows.map(r=>r.id),
    containers:(await docker.listContainers({all:true})).map(c=>c.Id).sort(),
    images:(await docker.listImages()).flatMap(i=>i.RepoTags||[]).filter(t=>t.startsWith('minicloud-source:')).sort(),
    temp:(await readdir(tmpdir())).filter(n=>n.startsWith('minicloud-build-')).sort()};
}
async function failure(body,expected,pattern) {
  const before=await artifacts();const result=await api('/api/deploy/github','POST',body,expected);assert.match(result.error,pattern);
  assert.deepEqual(await artifacts(),before,'Failed request must not leave rows, containers, tagged images, or checkout directories');
}
(async()=>{
  assert.equal(sourceInput({...good,branch:''}).branch,'main');
  for(const url of ['http://github.com/a/b','https://github.com.evil.com/a/b','https://user:pass@github.com/a/b','https://github.com/a/b/tree/main','file:///tmp/repo','https://github.com/a/b?x=1','https://github.com/a/b#x','https://github.com/a/../b']) {
    assert.throws(()=>sourceInput({...good,repositoryUrl:url}));
  }
  assert.throws(()=>sourceInput({...good,branch:'--upload-pack=evil'}));
  for(const containerPort of [0,1.5,65536,true,[3000],'3000.5']) assert.throws(()=>sourceInput({...good,containerPort}));
  assert.throws(()=>sourceInput({...good,branch:42}));
  await start();
  // Submit the actual dashboard GitHub form handler against the live API.
  ui=await dashboard();const button={disabled:false};const form={values:good,querySelector:()=>button,reset(){this.resetCalled=true;}};
  await ui.elements['#github-app'].listeners.submit({preventDefault(){},target:form});
  assert.doesNotMatch(ui.elements['#output'].textContent,/^Error:/);
  app=JSON.parse(ui.elements['#output'].textContent).application;assert.ok(app?.id);assert.equal(button.disabled,false);assert.equal(form.resetCalled,true);
  assert.match(app.image,/^minicloud-source:[0-9a-f-]+$/);assert.equal(app.buildStatus,'succeeded');assert.equal(app.repositoryUrl,good.repositoryUrl);assert.equal(app.branch,'master');assert.ok(app.lastDeployedAt);
  assert.ok(ui.elements['#apps'].innerHTML.includes(`<h3>${good.name}</h3>`));
  const row=(await pool.query('SELECT * FROM applications WHERE id=$1',[app.id])).rows[0];assert.equal(row.docker_image,app.image);assert.equal(row.repository_url,good.repositoryUrl);
  await html();await uiAction('open');assert.equal(ui.context.opened,'http://localhost:3010');
  assert.equal((await artifacts()).temp.length,0);
  console.log('PASS actual dashboard form → public GitHub clone → Docker build → container → SQL → localhost/open URL');

  await failure({...good,name:'Invalid URL',repositoryUrl:'https://example.com/a/b'},400,/public repository URL/);
  await failure({...good,name:'Bad Port',hostPort:70000},400,/ports|hostPort/i);
  await failure({...good,name:'No Dockerfile',repositoryUrl:'https://github.com/octocat/Hello-World',hostPort:3011},422,/Dockerfile/);
  await failure({...good,name:'No Branch',branch:'minicloud-no-such-branch-04',hostPort:3011},422,/Git clone failed/);
  await failure({...good,hostPort:3011},409,/already registered/);
  await failure({...good,name:'V04-GitHub-Test',hostPort:3011},409,/already registered/);
  await failure({...good,name:'Port Conflict'},409,/already registered/);
  const occupied=createServer();await new Promise(resolve=>occupied.listen(3011,'127.0.0.1',resolve));
  try{await failure({...good,name:'Occupied Host Port',hostPort:3011},409,/already in use/);}finally{await new Promise(resolve=>occupied.close(resolve));}
  console.log('PASS invalid URLs/ports, missing Dockerfile/branch, duplicate application/container names, registered and externally occupied ports');

  // Real Docker failure: clone the same public repo, then inject a deterministic invalid
  // Dockerfile into this disposable checkout. No production endpoint permits this override.
  const failing=new SourceDeployer(registry,docker,async(input,directory)=>{
    const checkout=await clonePublicRepository(input,directory);
    await writeFile(path.join(checkout,'Dockerfile'),'FROM busybox:latest\nRUN echo "intentional V04 build failure" && exit 42\n');return checkout;
  });
  const before=await artifacts();
  await assert.rejects(failing.deploy({...good,name:'Build Failure Test',hostPort:3011}),error=>/Docker build failed/.test(error.message)&&/intentional V04 build failure/.test(error.message));
  assert.deepEqual(await artifacts(),before);
  console.log('PASS real Docker build failure returns build output and leaves no broken rows/containers/tagged images/checkouts');

  const brokenRegistry=new ApplicationRegistry();
  brokenRegistry.insert=async()=>{throw Error('Intentional database write failure');};
  const beforeDatabaseFailure=await artifacts();
  await assert.rejects(new SourceDeployer(brokenRegistry,docker).deploy({...good,name:'Database Failure Test',hostPort:3011}),/Intentional database write failure/);
  assert.deepEqual(await artifacts(),beforeDatabaseFailure);
  console.log('PASS database save failure removes the new running container and generated image');

  let allowClone, entered;
  const gate=new Promise(resolve=>allowClone=resolve), enteredClone=new Promise(resolve=>entered=resolve);
  const blocked=new SourceDeployer(registry,docker,async()=>{entered();await gate;throw new RegistryError('Intentional clone cancellation',422);});
  const pending=blocked.deploy({...good,name:'Concurrent Registration Test',hostPort:3011});
  await enteredClone;
  try {
    await api('/api/apps','POST',{name:'Competing Registration',image:'minicloud-sample',containerName:'competing-registration',containerPort:3000,hostPort:3012},409);
    await api('/api/deploy/github','POST',{...good,name:'Competing Source',hostPort:3012},409);
  } finally {allowClone();}
  await assert.rejects(pending,/Intentional clone cancellation/);
  assert.deepEqual(await artifacts(),beforeDatabaseFailure);
  console.log('PASS concurrent source and image registrations cannot race an active deployment');

  await stop();await start();
  const restored=await api(`/api/apps/${app.id}`);assert.equal(restored.image,app.image);assert.equal(restored.repositoryUrl,app.repositoryUrl);assert.equal(restored.lastDeployedAt,app.lastDeployedAt);
  assert.equal(restored.status,(await docker.getContainer(app.containerName).inspect()).State.Status);
  ui=await dashboard();assert.ok(ui.elements['#apps'].innerHTML.includes(`<h3>${good.name}</h3>`));await html();
  await uiAction('stop');assert.equal((await api(`/api/apps/${app.id}`)).status,'exited');
  await uiAction('restart');await html();await uiAction('status','GET');await uiAction('logs','GET');assert.match(ui.elements['#output'].textContent,/httpd started/);
  await api(`/api/apps/${app.id}`,'DELETE');await api(`/api/apps/${app.id}`,'GET',undefined,404);
  await assert.rejects(docker.getContainer(app.containerName).inspect(),error=>error.statusCode===404);
  assert.equal((await pool.query('SELECT id FROM applications WHERE id=$1',[app.id])).rowCount,0);
  // Successful source images are retained by ordinary delete, matching existing image semantics.
  await docker.getImage(app.image).remove();app=undefined;
  console.log('PASS control-plane restart preserves source metadata and runtime status; existing stop/restart/status/logs/delete work');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(app){try{await api(`/api/apps/${app.id}`,'DELETE');await docker.getImage(app.image).remove();}catch(error){console.error('Test cleanup:',error.message);}}
  await stop();await pool.end();
});
