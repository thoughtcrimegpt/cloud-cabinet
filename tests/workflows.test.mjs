import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleWorkflows } from '../src/workflows.ts';
import { handleStorage } from '../src/storage.ts';
import { makeEnv, owner, editor, viewer, outsider, callStorage, jsonResponse, createFolder } from './helpers.mjs';

function workflowEnv() { return makeEnv(); }
async function file(env, folderId, id='file-1', version='version-1', name='contract.pdf') {
  env.DB.prepare('INSERT INTO entries(id,parent_id,name,kind,mime,current_version,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,folderId,name,'file','application/pdf',version,'2026-01-01','2026-01-01',owner.email).run();
  env.DB.prepare('INSERT INTO versions(id,entry_id,object_key,size,mime,created_at,created_by,source) VALUES(?,?,?,?,?,?,?,?)').bind(version,id,`objects/${id}`,10,'application/pdf','2026-01-01',owner.email,'upload').run();
}

test('projects default to current stages, enforce folder visibility, and expose capped inventory', async () => {
  const env=workflowEnv(), folderId=(await createFolder(handleStorage,env,owner,'Launch folder')).id;
  await file(env,folderId); env.DB.prepare('INSERT INTO grants(entry_id,email,role) VALUES(?,?,?)').bind(folderId,editor.email,'viewer').run();
  const created=await jsonResponse(await callStorage(handleWorkflows,env,owner,'/api/projects',{method:'POST',json:{folderId,name:'Launch',stage:'active'}}));
  assert.equal(created.status,201); const id=created.body.project.id;
  assert.equal((await jsonResponse(await callStorage(handleWorkflows,env,editor,'/api/projects'))).body.projects.length,1);
  assert.equal((await jsonResponse(await callStorage(handleWorkflows,env,outsider,'/api/projects'))).body.projects.length,0);
  const defs=await callStorage(handleWorkflows,env,owner,`/api/projects/${id}/checklists`,{method:'PUT',json:{checklists:[{name:'Contract',pattern:'*.pdf',required:true}]}}); assert.equal(defs.status,200);
  const detail=await jsonResponse(await callStorage(handleWorkflows,env,editor,`/api/projects/${id}`)); assert.equal(detail.body.checklist[0].status,'needs_review'); assert.equal(detail.body.inventoryCapped,false);
});

test('review confirmation is bound to the current version and stale reviews are rejected', async () => {
  const env=workflowEnv(), folderId=(await createFolder(handleStorage,env,owner,'Review folder')).id; await file(env,folderId);
  const p=(await jsonResponse(await callStorage(handleWorkflows,env,owner,'/api/projects',{method:'POST',json:{folderId}}))).body.project;
  await callStorage(handleWorkflows,env,owner,`/api/projects/${p.id}/checklists`,{method:'PUT',json:{checklists:[{name:'Contract',pattern:'*.pdf'}]}});
  const c=(await jsonResponse(await callStorage(handleWorkflows,env,owner,`/api/projects/${p.id}/checklists`))).body.checklists[0];
  const ok=await callStorage(handleWorkflows,env,owner,`/api/projects/${p.id}/checklists/${c.id}`,{method:'POST',json:{entryId:'file-1',version:'version-1',action:'confirmed'}}); assert.equal(ok.status,201);
  env.DB.prepare('UPDATE entries SET current_version=? WHERE id=?').bind('version-2','file-1').run();
  const stale=await callStorage(handleWorkflows,env,owner,`/api/projects/${p.id}/checklists/${c.id}`,{method:'POST',json:{entryId:'file-1',version:'version-1',action:'confirmed'}}); assert.equal(stale.status,409);
});

async function projectWithChecklist(env, name='Project', stage='active') {
  const folder=await createFolder(handleStorage,env,owner,name);
  const project=(await jsonResponse(await callStorage(handleWorkflows,env,owner,'/api/projects',{method:'POST',json:{folderId:folder.id,stage}}))).body.project;
  await callStorage(handleWorkflows,env,owner,`/api/projects/${project.id}/checklists`,{method:'PUT',json:{checklists:[{name:'Agreement',pattern:'*agreement*.pdf',required:true}]}});
  return {folder,project};
}
test('closed and archived projects stay out of current work and nearest grants override inherited visibility', async()=>{
  const env=makeEnv();
  const a=await projectWithChecklist(env,'Active','active');
  await projectWithChecklist(env,'Closed','closed');
  await projectWithChecklist(env,'Archived','archived');
  assert.equal((await jsonResponse(await callStorage(handleWorkflows,env,owner,'/api/projects'))).body.projects.length,1);
  assert.equal((await jsonResponse(await callStorage(handleWorkflows,env,owner,'/api/projects?archived=1'))).body.projects.length,2);
  const parent=await createFolder(handleStorage,env,owner,'Team');
  await callStorage(handleStorage,env,owner,`/api/entries/${a.folder.id}`,{method:'PATCH',json:{parentId:parent.id}});
  await callStorage(handleStorage,env,owner,`/api/entries/${parent.id}/access`,{method:'PUT',json:{grants:[{email:viewer.email,role:'viewer'}]}});
  assert.equal((await jsonResponse(await callStorage(handleWorkflows,env,viewer,'/api/projects'))).body.projects.length,1);
  await callStorage(handleStorage,env,owner,`/api/entries/${a.folder.id}/access`,{method:'PUT',json:{grants:[{email:editor.email,role:'editor'}]}});
  assert.equal((await jsonResponse(await callStorage(handleWorkflows,env,viewer,'/api/projects'))).body.projects.length,0);
  env.DB.db.prepare('UPDATE entries SET trashed=1 WHERE id=?').run(parent.id);
  assert.equal((await jsonResponse(await callStorage(handleWorkflows,env,owner,'/api/projects'))).body.projects.length,0);
});

test('checklist edits retain immutable review history and invalidate changed definitions', async()=>{
  const env=makeEnv(),{folder,project}=await projectWithChecklist(env);
  await file(env,folder.id,'document','version','agreement.pdf');
  const detail=()=>callStorage(handleWorkflows,env,owner,`/api/projects/${project.id}`).then(jsonResponse);
  const c=(await detail()).body.checklist[0];
  const path=`/api/projects/${project.id}/checklists`;
  const review={entryId:'document',version:'version',action:'confirmed'};
  assert.equal((await callStorage(handleWorkflows,env,viewer,`${path}/${c.id}`,{method:'POST',json:review})).status,404);
  assert.equal((await callStorage(handleWorkflows,env,owner,`${path}/${c.id}`,{method:'POST',json:review})).status,201);
  assert.equal((await detail()).body.checklist[0].status,'confirmed');
  assert.equal((await callStorage(handleWorkflows,env,owner,path,{method:'PUT',json:{checklists:[{id:c.id,name:c.name,pattern:'*.pdf',required:true}]}})).status,200);
  assert.equal((await detail()).body.checklist[0].status,'needs_review');
  assert.equal((await callStorage(handleWorkflows,env,owner,path,{method:'PUT',json:{checklists:[]}})).status,200);
  assert.equal(env.DB.db.prepare('SELECT count(*) n FROM workflow_reviews').get().n,1);
  assert.throws(()=>env.DB.db.exec('DELETE FROM workflow_reviews'),/immutable/i);
  const row=env.DB.db.prepare('SELECT * FROM workflow_reviews').get();
  assert.throws(()=>env.DB.db.prepare('INSERT OR REPLACE INTO workflow_reviews SELECT * FROM workflow_reviews WHERE id=?').run(row.id),/identity/i);
});

test('inventory suppresses media/templates, observes applicability, and caps reads without false missing claims', async()=>{
  const env=makeEnv(),{folder,project}=await projectWithChecklist(env);
  const add=env.DB.db.prepare("INSERT INTO entries(id,parent_id,name,kind,mime,current_version,created_at,updated_at,created_by) VALUES(?,?,?,'file','application/pdf',?,'2026-01-01','2026-01-01',?)");
  const ver=env.DB.db.prepare("INSERT INTO versions(id,entry_id,object_key,size,mime,created_at,created_by,source) VALUES(?,?,?,1,'application/pdf','2026-01-01',?,?)");
  for(let i=0;i<501;i++){const id=`entry${i}`,v=`v${i}`;add.run(id,folder.id,`template agreement ${i}.pdf`,v,owner.email);ver.run(v,id,`objects/${id}`,owner.email,`upload:${id}`);}
  env.DB.resetQueryCount();
  const result=(await jsonResponse(await callStorage(handleWorkflows,env,owner,`/api/projects/${project.id}`))).body;
  assert.equal(result.inventoryCapped,true);
  assert.equal(result.checklist[0].status,'unassessed');
  assert.equal(result.checklist[0].candidates.length,0);
  assert.ok(env.DB.queryCount<15,`expected batched reads, got ${env.DB.queryCount}`);
});
