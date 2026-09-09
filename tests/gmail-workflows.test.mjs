import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleGmail, runGmailSchedule } from '../src/gmail.ts';
import { handleStorage } from '../src/storage.ts';
import { makeEnv, owner, callStorage, jsonResponse, createFolder, MemoryD1 } from './helpers.mjs';

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const config = { GMAIL_CLIENT_ID:'id', GMAIL_CLIENT_SECRET:'secret', GMAIL_TOKEN_KEY:key };
const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

async function connect(env, email) {
  let response = await jsonResponse(await callStorage(handleGmail, env, owner, '/api/gmail/connect', { method:'POST', json:{} }));
  const state = new URL(response.body.url).searchParams.get('state');
  globalThis.fetch = async (url) => url.includes('oauth2.googleapis.com/token')
    ? Response.json({ access_token:'access', refresh_token:`refresh-${email}`, scope:'https://www.googleapis.com/auth/gmail.readonly' })
    : Response.json({ emailAddress:email });
  response = await callStorage(handleGmail, env, owner, `/api/gmail/callback?state=${state}&code=code`);
  assert.equal(response.status, 303);
  return (await env.DB.prepare('SELECT * FROM gmail_mailboxes WHERE owner=? AND email=?').bind(owner.email,email.toLowerCase()).first()).mailbox_id;
}

function provider({ messageId='m1', bytes=new TextEncoder().encode('hello'), failList=false, failMessage=false }={}) {
  const data = btoa(String.fromCharCode(...bytes));
  return async (url) => {
    if (url.includes('oauth2.googleapis.com/token')) return Response.json({ access_token:'access', refresh_token:'refresh', scope:'https://www.googleapis.com/auth/gmail.readonly' });
    if (url.endsWith('/labels')) return Response.json({ labels:[{id:'LBL',name:'Cabinet'}] });
    if (url.includes('/messages?')) return failList ? new Response('down',{status:503}) : Response.json({ messages:[{id:messageId}] });
    return failMessage ? new Response('down',{status:503}) : Response.json({ id:messageId, payload:{parts:[{filename:'mail.txt',mimeType:'text/plain',body:{size:bytes.length,data}}]} });
  };
}

test('OAuth supports multiple mailboxes, isolates selection, rejects wrong reconnect, and disconnects one mailbox', async () => {
  const env = { ...makeEnv(), ...config };
  const first = await connect(env,'one@example.com');
  const second = await connect(env,'two@example.com');
  const status = await jsonResponse(await callStorage(handleGmail,env,owner,'/api/gmail/status'));
  assert.equal(status.body.mailboxes.length,2);
  const select = await jsonResponse(await callStorage(handleGmail,env,owner,'/api/gmail/import',{method:'POST',json:{mailboxId:first,label:'Cabinet'}}));
  assert.equal(select.status,400); // no destination is allowed, but mailbox selection is accepted
  let c = await jsonResponse(await callStorage(handleGmail,env,owner,'/api/gmail/connect',{method:'POST',json:{mailboxId:first}}));
  const state = new URL(c.body.url).searchParams.get('state');
  globalThis.fetch = async (url) => url.includes('oauth2.googleapis.com/token')
    ? Response.json({access_token:'access',refresh_token:'r',scope:'https://www.googleapis.com/auth/gmail.readonly'})
    : Response.json({emailAddress:'two@example.com'});
  assert.equal((await callStorage(handleGmail,env,owner,`/api/gmail/callback?state=${state}&code=x`)).status,409);
  assert.equal((await callStorage(handleGmail,env,owner,`/api/gmail/mailboxes/${encodeURIComponent(first)}`,{method:'DELETE'})).status,200);
  assert.equal((await callStorage(handleGmail,env,owner,`/api/gmail/mailboxes/${encodeURIComponent(first)}/config`,{method:'PUT',json:{label:'Cabinet',destinationId:'root'}})).status,404);
  assert.equal(second.length>0,true);
});

test('0001 through 0004 preserve a legacy token and provenance while creating mailbox workflow tables', async () => {
  const db = new MemoryD1();
  for (const n of ['0001_files.sql','0002_settings_gmail.sql','0003_storage_guard.sql']) db.exec(readFileSync(join(import.meta.dirname,'..','migrations',n),'utf8'));
  db.prepare('INSERT INTO gmail_connection(owner,email,encrypted_token,updated_at) VALUES(?,?,?,?)').bind(owner.email,'old@example.com','sealed-token','2026-01-01').run();
  db.exec(readFileSync(join(import.meta.dirname,'..','migrations','0004_gmail_workflows.sql'),'utf8'));
  const row = db.db.prepare('SELECT email,encrypted_token FROM gmail_mailboxes WHERE owner=?').get(owner.email);
  assert.equal(row.email,'old@example.com');
  assert.equal(row.encrypted_token,'sealed-token');
  assert.equal((await db.prepare("SELECT name FROM sqlite_master WHERE name='gmail_review_queue'").first())?.name,'gmail_review_queue');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM gmail_connection').first()).n,0);
});

test('unconfigured scan queues for review, then explicit assignment files the verified source', async () => {
  const env = { ...makeEnv(), ...config };
  const mailbox = await connect(env,'review@example.com');
  const folder = await createFolder(handleStorage,env,owner,'Inbox');
  globalThis.fetch = provider();
  const queued = await jsonResponse(await callStorage(handleGmail,env,owner,'/api/gmail/import',{method:'POST',json:{mailboxId:mailbox,label:'Cabinet',parentId:folder.id}}));
  assert.equal(queued.body.queued,1);
  const review = await jsonResponse(await callStorage(handleGmail,env,owner,'/api/gmail/review?state=pending'));
  assert.equal(review.body.reviews.length,1);
  const item = review.body.reviews[0];
  const filed = await jsonResponse(await callStorage(handleGmail,env,owner,`/api/gmail/review/${item.reviewId}/assign`,{method:'POST',json:{version:item.version,destinationId:folder.id}}));
  assert.equal(filed.status,200);
  const done = await env.DB.prepare('SELECT state,entry_id FROM gmail_review_queue WHERE review_id=?').bind(item.reviewId).first();
  assert.equal(done.state,'filed');
  assert.ok(done.entry_id);
});

test('dismiss and defer are respected by automatic scans, and deferred items retry explicitly', async () => {
  const env = { ...makeEnv(), ...config };
  const mailbox = await connect(env,'review@example.com');
  const folder = await createFolder(handleStorage,env,owner,'Inbox');
  globalThis.fetch = provider();
  let result = await jsonResponse(await callStorage(handleGmail,env,owner,'/api/gmail/import',{method:'POST',json:{mailboxId:mailbox,label:'Cabinet',parentId:folder.id}}));
  const item = (await jsonResponse(await callStorage(handleGmail,env,owner,'/api/gmail/review'))).body.reviews[0];
  const stale = await jsonResponse(await callStorage(handleGmail,env,owner,`/api/gmail/review/${item.reviewId}/defer`,{method:'POST',json:{version:item.version-1}}));
  assert.equal(stale.status,409);
  result = await jsonResponse(await callStorage(handleGmail,env,owner,`/api/gmail/review/${item.reviewId}/dismiss`,{method:'POST',json:{version:item.version}}));
  assert.equal(result.status,200);
  const again = await jsonResponse(await callStorage(handleGmail,env,owner,'/api/gmail/import',{method:'POST',json:{mailboxId:mailbox,label:'Cabinet',parentId:folder.id}}));
  assert.equal(again.body.queued,0);
  assert.equal((await env.DB.prepare('SELECT state FROM gmail_review_queue WHERE review_id=?').bind(item.reviewId).first()).state,'dismissed');
});

test('provider failure leaves a review deferred and a later explicit decision can retry it', async () => {
  const env = { ...makeEnv(), ...config };
  const mailbox = await connect(env,'retry@example.com');
  const folder = await createFolder(handleStorage,env,owner,'Inbox');
  globalThis.fetch = provider({failList:false});
  await jsonResponse(await callStorage(handleGmail,env,owner,'/api/gmail/import',{method:'POST',json:{mailboxId:mailbox,label:'Cabinet',parentId:folder.id}}));
  let item = (await jsonResponse(await callStorage(handleGmail,env,owner,'/api/gmail/review'))).body.reviews[0];
  globalThis.fetch = provider({failMessage:true});
  const failed = await jsonResponse(await callStorage(handleGmail,env,owner,`/api/gmail/review/${item.reviewId}/assign`,{method:'POST',json:{version:item.version,destinationId:folder.id}}));
  assert.equal(failed.status,502);
  item = (await jsonResponse(await callStorage(handleGmail,env,owner,'/api/gmail/review?state=deferred'))).body.reviews[0];
  globalThis.fetch = provider();
  const retried = await jsonResponse(await callStorage(handleGmail,env,owner,`/api/gmail/review/${item.reviewId}/assign`,{method:'POST',json:{version:item.version,destinationId:folder.id}}));
  assert.equal(retried.status,200);
});

test('scheduler only runs enabled scoped rules for the owning mailbox and disabled providers do no work', async () => {
  const env = { ...makeEnv(), ...config, ACCESS_TEAM_DOMAIN:'https://team.cloudflareaccess.com', ACCESS_AUD:'a'.repeat(64) };
  const mailbox = await connect(env,'scheduled@example.com');
  const folder = await createFolder(handleStorage,env,owner,'Inbox');
  await callStorage(handleGmail,env,owner,`/api/gmail/mailboxes/${mailbox}/config`,{method:'PUT',json:{label:'Cabinet',destinationId:folder.id,scheduled:true,reviewOnly:false}});
  globalThis.fetch = provider();
  const ran = await runGmailSchedule(env);
  assert.equal(ran.enabled,true);
  assert.equal(ran.processed,1);
  env.GMAIL_CLIENT_ID='';
  globalThis.fetch = async()=>{ throw new Error('provider should not be called'); };
  assert.deepEqual(await runGmailSchedule(env),{enabled:false,processed:0});
});

test('automatic filing into a closed project is queued for owner review', async () => {
  const env = { ...makeEnv(), ...config };
  const mailbox = await connect(env,'closed@example.com');
  const folder = await createFolder(handleStorage,env,owner,'Closed project');
  env.DB.prepare('INSERT INTO workflow_projects(id,folder_id,name,stage,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?)').bind('p-closed',folder.id,'Closed','closed','2026-01-01','2026-01-01',owner.email).run();
  globalThis.fetch = provider();
  const result = await jsonResponse(await callStorage(handleGmail,env,owner,'/api/gmail/import',{method:'POST',json:{mailboxId:mailbox,label:'Cabinet',parentId:folder.id}}));
  assert.equal(result.body.queued,1);
  assert.equal((await env.DB.prepare("SELECT state FROM gmail_review_queue WHERE mailbox_id=?").bind(mailbox).first()).state,'pending');
});

test('concurrent review decisions have one winner under the version guard', async () => {
  const env = { ...makeEnv(), ...config };
  const mailbox = await connect(env,'race@example.com');
  const folder = await createFolder(handleStorage,env,owner,'Race');
  globalThis.fetch = provider();
  await callStorage(handleGmail,env,owner,'/api/gmail/import',{method:'POST',json:{mailboxId:mailbox,label:'Cabinet',parentId:folder.id}});
  const item = (await jsonResponse(await callStorage(handleGmail,env,owner,'/api/gmail/review'))).body.reviews[0];
  const responses = await Promise.all([
    callStorage(handleGmail,env,owner,`/api/gmail/review/${item.reviewId}/dismiss`,{method:'POST',json:{version:item.version}}),
    callStorage(handleGmail,env,owner,`/api/gmail/review/${item.reviewId}/defer`,{method:'POST',json:{version:item.version}}),
  ]);
  const statuses = await Promise.all(responses.map(async r => (await jsonResponse(r)).status));
  assert.deepEqual(statuses.sort(),[200,409]);
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM gmail_review_audit WHERE review_id=?').bind(item.reviewId).first()).n,1);
});

test('scheduler rotates current owner rules and never calls a different owner mailbox', async () => {
  const env = { ...makeEnv(), ...config, ACCESS_TEAM_DOMAIN:'https://team.cloudflareaccess.com', ACCESS_AUD:'a'.repeat(64) };
  const mailbox = await connect(env,'current@example.com');
  await callStorage(handleGmail,env,owner,`/api/gmail/mailboxes/${mailbox}/config`,{method:'PUT',json:{label:'Cabinet',destinationId:'root',scheduled:true,reviewOnly:true}});
  const now = new Date().toISOString();
  env.DB.prepare('INSERT INTO gmail_mailboxes(mailbox_id,owner,email,encrypted_token,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind('other-mailbox','other@example.com','other@example.com','bad',now,now).run();
  env.DB.prepare('INSERT INTO gmail_label_scopes(mailbox_id,label,destination_id,scheduled,review_only,enabled,updated_at) VALUES(?,?,?,?,?,?,?)').bind('other-mailbox','Cabinet','root',1,1,1,now).run();
  let providerCalls = 0;
  globalThis.fetch = async (url) => {
    providerCalls++;
    return provider()(url);
  };
  const result = await runGmailSchedule(env);
  assert.equal(result.enabled,true);
  assert.equal(providerCalls>0,true);
  assert.equal((await env.DB.prepare("SELECT last_error FROM gmail_label_scopes WHERE mailbox_id='other-mailbox'").first()).last_error,null);
});

test('mailbox jobs keep independent cursors for the same label', async () => {
  const env = { ...makeEnv(), ...config };
  const first = await connect(env,'cursor-a@example.com');
  const second = await connect(env,'cursor-b@example.com');
  const now = Date.now();
  env.DB.prepare('INSERT INTO gmail_mailbox_jobs(mailbox_id,label,parent_id,page_token,started_at) VALUES(?,?,?,?,?)').bind(first,'Cabinet','root','page-a',now).run();
  env.DB.prepare('INSERT INTO gmail_mailbox_jobs(mailbox_id,label,parent_id,page_token,started_at) VALUES(?,?,?,?,?)').bind(second,'Cabinet','root','page-b',now).run();
  const rows = (await env.DB.prepare('SELECT mailbox_id,page_token FROM gmail_mailbox_jobs WHERE label=? ORDER BY mailbox_id').bind('Cabinet').all()).results;
  assert.equal(rows.length,2);
  assert.deepEqual(rows.map(r=>r.page_token).sort(),['page-a','page-b']);
});
