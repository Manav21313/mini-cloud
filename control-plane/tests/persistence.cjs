// Integration test: requires the Compose database and minicloud-sample image.
// Leaves Pineapple (running) and Banana (stopped) registered for inspection.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const vm = require('node:vm');
const { pool } = require('../dist/database/connection.js');
const Docker = require('dockerode');
const docker = new Docker();
const port = process.env.PERSISTENCE_TEST_PORT || '8082';
const base = `http://127.0.0.1:${port}`;
let server;
async function request(route, method = 'GET', body, expected = 200) {
  const response = await fetch(base + route, { method, headers: body ? {'content-type':'application/json'} : undefined, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}
async function start() {
  let output = '';
  server = spawn(process.execPath, [path.resolve(__dirname, '../dist/server.js')], { env: {...process.env, CONTROL_PLANE_PORT: port}, stdio: ['ignore','pipe','pipe'] });
  server.stdout.on('data', chunk => output += chunk);
  server.stderr.on('data', chunk => output += chunk);
  for (let attempt=0; attempt<100; attempt++) {
    if (server.exitCode !== null) throw Error(output);
    if (output.includes('MiniCloud dashboard:')) return;
    await new Promise(resolve => setTimeout(resolve,100));
  }
  throw Error(`Server did not start: ${output}`);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, 'exit');
  server.kill('SIGTERM');
  const timer = setTimeout(() => server.kill('SIGKILL'), 10000);
  const [code] = await exited;
  clearTimeout(timer);
  assert.equal(code, 0, 'Control plane should shut down gracefully');
}
async function dbRow(id) {
  return (await pool.query('SELECT * FROM applications WHERE id = $1',[id])).rows[0];
}
async function hello(port) {
  for(let i=0;i<40;i++) {
    try {assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'Hello from MiniCloud!\n');return;}
    catch(error) {if(i===39) throw error;await new Promise(resolve=>setTimeout(resolve,100));}
  }
}
async function dashboard(expectedStatuses) {
  const response = await fetch(base);
  assert.equal(response.status, 200);
  const html = await response.text();
  const elements = Object.fromEntries(['#apps','#output','#new-app'].map(id=>[id,{innerHTML:'',textContent:'',addEventListener(){}}]));
  // Run the existing, unchanged UI script with a minimal DOM and real API fetches.
  const context = {document:{querySelector:id=>elements[id]},fetch:(route,options)=>fetch(base+route,options),console};
  await vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1]+'\nloadApps();',context);
  for(const [name,status] of Object.entries(expectedStatuses)) {
    assert.match(elements['#apps'].innerHTML,new RegExp(`<h3>${name}</h3>[\\s\\S]*?class="status">${status}</span>`));
  }
}
async function register(name, hostPort) {
  const containerName = `minicloud-${name.toLowerCase()}`;
  let application = (await request('/api/apps')).find(app=>app.containerName===containerName);
  if (!application) application = await request('/api/apps','POST',{name,image:'minicloud-sample',containerName,containerPort:3000,hostPort},201);
  assert.equal(application.name,name);
  assert.equal(application.hostPort,hostPort);
  assert.equal((await dbRow(application.id)).name,name);
  return application;
}
(async()=>{
  await start();
  const pineapple = await register('Pineapple',3002);
  const banana = await register('Banana',3003);
  const p = `/api/apps/${pineapple.id}`, b = `/api/apps/${banana.id}`;
  for(const app of [pineapple,banana]) {
    await request(`/api/apps/${app.id}/deploy`,'POST');
    await hello(app.hostPort);
    assert.equal((await dbRow(app.id)).status,'running');
  }
  await dashboard({Pineapple:'running',Banana:'running'});
  console.log('PASS Pineapple and Banana registered, persisted, serving HTTP, and rendered by dashboard');
  await request(p+'/stop','POST');assert.equal((await dbRow(pineapple.id)).status,'exited');
  await request(p+'/restart','POST');assert.equal((await dbRow(pineapple.id)).status,'running');
  await request(p+'/restart','POST');await hello(3002);
  assert.match((await request(p+'/logs')).logs,/listening on port 3000/);
  console.log('PASS lifecycle actions update PostgreSQL; logs preserved');
  const duplicates = await Promise.all([1,2].map(()=>request('/api/apps','POST',{name:'Duplicate',image:'minicloud-sample',containerName:pineapple.containerName,containerPort:3000,hostPort:3004},409)));
  assert.equal(duplicates.length,2);
  const disposable = await request('/api/apps','POST',{name:'Delete persistence test',image:'minicloud-sample',containerName:'minicloud-persistence-delete-test',containerPort:3000,hostPort:3004},201);
  await request(`/api/apps/${disposable.id}/deploy`,'POST');
  await request(`/api/apps/${disposable.id}`,'DELETE');
  assert.equal(await dbRow(disposable.id),undefined);
  await assert.rejects(docker.getContainer(disposable.containerName).inspect(),error=>error.statusCode===404);
  console.log('PASS uniqueness constraints and container/database deletion');
  await stop();
  // Simulate Docker changing independently while the control plane is off.
  const details = await docker.getContainer(banana.containerName).inspect();
  if(details.State.Running) await docker.getContainer(banana.containerName).stop({t:10});
  assert.equal((await dbRow(banana.id)).status,'running','Cached status should be stale before startup');
  await start();
  const apps = await request('/api/apps');
  for (const original of [pineapple,banana]) {
    const restored = apps.find(app=>app.id===original.id);
    assert.ok(restored,`${original.name} survives restart`);
    assert.equal(restored.createdAt,original.createdAt);
    const actual = await docker.getContainer(original.containerName).inspect();
    assert.equal(restored.status,actual.State.Status);
    assert.equal((await dbRow(original.id)).status,actual.State.Status);
    assert.equal((await request(`/api/apps/${original.id}/status`)).status.running,actual.State.Running);
  }
  assert.equal(await dbRow(disposable.id),undefined);
  await hello(3002);
  await dashboard({Pineapple:'running',Banana:'exited'});
  console.log('PASS dashboard renders both apps after restart');
  console.log('PASS restart preserves IDs and timestamps; Pineapple running, Banana exited; startup repaired stale Docker status');
  await stop();
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await stop();await pool.end();});
