import test from 'node:test';
import assert from 'node:assert/strict';
import {importFolder} from '../web/folder-import.ts';
import {handleStorage} from '../src/storage.ts';
import {makeEnv,owner,callStorage,jsonResponse} from './helpers.mjs';
const realFetch=globalThis.fetch;
test.afterEach(()=>{globalThis.fetch=realFetch;});
function fixture(name,path){const file=new File(['sample'],name,{type:'text/plain'});Object.defineProperty(file,'webkitRelativePath',{value:path});return file;}
function connection(env){
  globalThis.fetch=(path,init)=>callStorage(handleStorage,env,owner,path,init);
  return async(path,body,method=body===undefined?'GET':'POST')=>{const response=await callStorage(handleStorage,env,owner,path,{method,json:body});const r=await jsonResponse(response);if(r.status>=400){const error=new Error(r.body.error);error.status=r.status;throw error;}return r.body;};
}
test('folder import preserves nested paths and reports duplicate files without replacing content',async()=>{
  const env=makeEnv(),api=connection(env);
  const files=[fixture('notes.txt','Bundle/Notes/notes.txt'),fixture('summary.txt','Bundle/summary.txt')];
  const first=await importFolder(files,'root',api,()=>{});
  assert.equal(first.saved,2);assert.deepEqual(first.errors,[]);
  const folders=env.DB.db.prepare("SELECT id,parent_id,name FROM entries WHERE kind='folder'").all();
  const bundle=folders.find(f=>f.name==='Bundle'),notes=folders.find(f=>f.name==='Notes');
  assert.equal(notes.parent_id,bundle.id);
  assert.equal(env.DB.db.prepare("SELECT parent_id FROM entries WHERE name='notes.txt'").get().parent_id,notes.id);
  const retry=await importFolder(files,'root',api,()=>{});
  assert.equal(retry.saved,0);assert.equal(retry.errors.length,2);
  assert.equal(env.DB.db.prepare('SELECT count(*) n FROM versions').get().n,2);
});
test('folder import rejects unsafe paths before creating destination folders',async()=>{
  const env=makeEnv(),api=connection(env);
  const result=await importFolder([fixture('notes.txt','Bundle/../notes.txt')],'root',api,()=>{});
  assert.equal(result.saved,0);assert.equal(result.errors.length,1);
  assert.equal(env.DB.db.prepare('SELECT count(*) n FROM entries').get().n,0);
});
