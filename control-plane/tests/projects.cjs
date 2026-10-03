const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, readFile, rm, mkdir, symlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { prepareProject } = require('../dist/deployments/projects.js');

async function fixture(files, run) {
  const directory = await mkdtemp(path.join(tmpdir(),'minicloud-project-test-'));
  try {
    for(const [name,value] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(directory,name)),{recursive:true});
      await writeFile(path.join(directory,name),typeof value==='string'?value:JSON.stringify(value));
    }
    return await run(directory);
  } finally { await rm(directory,{recursive:true,force:true}); }
}
const vite = {devDependencies:{vite:'^8.0.0','@vitejs/plugin-react':'^6.0.0'},dependencies:{react:'^19.0.0'},scripts:{dev:'vite',build:'vite build'}};

test('existing Dockerfile wins even with invalid package.json; all source files unchanged',()=>fixture({Dockerfile:'FROM busybox\n','.dockerignore':'some-rule\n','package.json':'invalid'},async dir=>{
  const result=await prepareProject(dir,8000);assert.equal(result.projectType,'Existing Dockerfile');
  assert.equal(await readFile(path.join(dir,'Dockerfile'),'utf8'),'FROM busybox\n');
  assert.equal(await readFile(path.join(dir,'.dockerignore'),'utf8'),'some-rule\n');
}));
test('Vite with lockfile uses npm ci, a build stage, and nginx on the selected port',()=>fixture({'package.json':vite,'package-lock.json':{},'index.html':'<div></div>','.dockerignore':'private/\n'},async dir=>{
  assert.equal((await prepareProject(dir,8081)).projectType,'Vite');
  const file=await readFile(path.join(dir,'Dockerfile'),'utf8');assert.match(file,/npm ci --include=dev/);assert.match(file,/FROM nginx/);assert.match(file,/npm run build && test -f dist\/index.html/);assert.match(file,/EXPOSE 8081/);
  const config=file.match(/COPY (\.minicloud-nginx-[^ ]+) /)[1];
  assert.match(await readFile(path.join(dir,config),'utf8'),/listen 8081;/);assert.match(await readFile(path.join(dir,config),'utf8'),/try_files \$uri \$uri\/ \/index.html/);
  assert.match(await readFile(path.join(dir,'.dockerignore'),'utf8'),/private\/[\s\S]*\*\*\/.env/);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir,'package.json'),'utf8')),vite);
}));
test('Vite with no lockfile uses npm install and supports a TypeScript pre-build command',()=>fixture({'package.json':{...vite,scripts:{build:'tsc -b && vite build'}},'index.html':'<div></div>'},async dir=>{
  assert.equal((await prepareProject(dir,80)).projectType,'Vite');assert.match(await readFile(path.join(dir,'Dockerfile'),'utf8'),/npm install --include=dev/);
}));
test('Node start command is preserved; production dependencies and PORT are configured',()=>fixture({'package.json':{scripts:{start:'node src/server.js'}},'src/server.js':'require("node:http")','package-lock.json':{}},async dir=>{
  assert.equal((await prepareProject(dir,3020)).projectType,'Node.js');const file=await readFile(path.join(dir,'Dockerfile'),'utf8');
  assert.match(file,/npm ci --omit=dev/);assert.match(file,/ENV PORT=3020/);assert.match(file,/CMD \["npm", "start"\]/);assert.match(file,/USER node/);
}));
test('Node default server.js entrypoint and npm shrinkwrap are supported',()=>fixture({'package.json':{},'server.js':'require("node:http")','npm-shrinkwrap.json':{}},async dir=>{
  const result=await prepareProject(dir,3000);assert.equal(result.projectType,'Node.js');assert.match(result.detectionReason,/default server.js/);assert.match(await readFile(path.join(dir,'Dockerfile'),'utf8'),/npm-shrinkwrap.json/);
}));
test('React alone, library main entry, invalid manifests, dev runners, SSR, and monorepos are rejected',async()=>{
  for(const manifest of [
    {dependencies:{react:'19'},scripts:{build:'react-scripts build'}},
    {main:'index.js'}, {scripts:{start:'nodemon server.js'}}, {scripts:{start:'node server.js',build:'tsc'}},
    {...vite,scripts:{build:'vite build --ssr server.js'}}, {...vite,workspaces:['packages/*']},
    {...vite,packageManager:'pnpm@10'}, {...vite,scripts:{dev:'vite'}},
    {...vite,scripts:{build:'vite build',start:'node server.js'}}, {...vite,scripts:{build:'vite build',start:'node --watch server.js'}}
  ]) await fixture({'package.json':manifest,...(manifest.scripts?.start?{'server.js':''}:{}),'index.js':'','index.html':''},async dir=>{
    await assert.rejects(prepareProject(dir,3000),/could not automatically determine.*Add a Dockerfile manually/);
  });
  await fixture({'package.json':'invalid'},async dir=>assert.rejects(prepareProject(dir,3000),/valid JSON/));
});
test('custom Vite output and non-npm lockfiles require an explicit Dockerfile',async()=>{
  await fixture({'package.json':vite,'index.html':'','vite.config.js':"export default {build:{outDir:'custom'}}"},async dir=>assert.rejects(prepareProject(dir,80),/default dist/));
  await fixture({'package.json':vite,'index.html':'','pnpm-lock.yaml':'x'},async dir=>assert.rejects(prepareProject(dir,80),/non-npm/));
});
test('symlinked metadata/entrypoints are rejected, and invalid port cannot enter a template',()=>fixture({'other.json':{},'package.json':{scripts:{start:'node server.js'}}},async dir=>{
  await assert.rejects(prepareProject(dir,'80\nRUN arbitrary'),/Invalid container port/);
  await symlink(path.join(dir,'other.json'),path.join(dir,'Dockerfile'));
  await assert.rejects(prepareProject(dir,80),/regular file/);
  await rm(path.join(dir,'Dockerfile'));
  await symlink(path.join(dir,'other.json'),path.join(dir,'server.js'));
  await assert.rejects(prepareProject(dir,80),/regular file/);
}));
