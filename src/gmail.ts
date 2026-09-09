import type { User } from './auth.ts';
import { configured } from './auth.ts';
import { importFile, authorized, withStorageLock } from './storage.ts';
import { MAX_GMAIL_ATTACHMENT, readAttachmentBody } from './gmail-attachment-body.ts';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const encoder = new TextEncoder();
const LEASE_MS = 300000;
type Connection = { mailbox_id:string; owner:string; email:string; encrypted_token:string; enabled:number; revision:number };
type Part = { partId?:string; filename?:string; mimeType?:string; headers?:{name:string;value:string}[]; body?:{size?:number;data?:string;attachmentId?:string}; parts?:Part[] };
type Scope = {mailbox_id:string; label:string; destination_id:string; scheduled:number; review_only:number; enabled:number; revision:number};
type Review = {review_id:string; owner:string; mailbox_id:string; identity:string; message_id:string; part_path:string; filename:string; mime:string; size:number; headers_json:string; source_fingerprint:string; destination_id:string|null; entry_id:string|null; state:string; version:number; lease_until:number; lease_token:string|null; last_error:string|null};
class PermanentMessageError extends Error {}
class GmailError extends Error {
  status: number;
  constructor(message:string,status=400) {super(message);this.status=status;}
}
function safeFilename(value:string|undefined) {
  const name=(value || 'attachment').replace(/[\\/\u0000-\u001f\u007f]/g,'_').trim().slice(0,255);
  return !name || name==='.' || name==='..' ? 'attachment' : name;
}
function safeMime(value:string|undefined) { return value && /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value : 'application/octet-stream'; }
function base64(bytes:Uint8Array) {return btoa(String.fromCharCode(...bytes));}
function unbase64(value:string) {return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
function random() {
  return base64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}
function enabled(env: Env) {
  try {
    return (
      !!env.GMAIL_CLIENT_ID &&
      !!env.GMAIL_CLIENT_SECRET &&
      unbase64(env.GMAIL_TOKEN_KEY || '').length === 32
    );
  } catch {
    return false;
  }
}
async function key(env: Env) {
  return crypto.subtle.importKey(
    'raw',
    unbase64(env.GMAIL_TOKEN_KEY || ''),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}
async function seal(env: Env, token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await key(env),
      encoder.encode(token),
    ),
  );
  return `${base64(iv)}.${base64(ciphertext)}`;
}
async function unseal(env: Env, encrypted: string) {
  const [iv, data] = encrypted.split('.');
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unbase64(iv) },
      await key(env),
      unbase64(data),
    ),
  );
}
async function jsonFetch(
  url: string,
  init: RequestInit = {},
  max = 1024 * 1024,
): Promise<Record<string, any>> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      'Google request failed. Reconnect Gmail if the problem continues.',
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Google returned no data.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new PermanentMessageError(
        'This email is too large to import. Download its attachments from Gmail and upload them here.',
      );
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) {
    all.set(part, offset);
    offset += part.length;
  }
  return JSON.parse(new TextDecoder().decode(all));
}
async function accessToken(env: Env, connection: Connection) {
  const token = await jsonFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID || '',
      client_secret: env.GMAIL_CLIENT_SECRET || '',
      refresh_token: await unseal(env, connection.encrypted_token),
      grant_type: 'refresh_token',
    }),
  });
  if (typeof token.access_token !== 'string')
    throw new Error('Reconnect Gmail.');
  return token.access_token as string;
}
function parts(root: Part): {part: Part; path: string}[] {
  const todo = [{part: root, path: '0', depth: 0}], result: {part:Part;path:string}[] = [];
  let seen = 0;
  while (todo.length) {
    const current = todo.pop()!;
    if (++seen > 1000 || current.depth > 50) throw new PermanentMessageError('Message has too many MIME parts.');
    const part = current.part;
    if (!part || typeof part !== 'object') throw new PermanentMessageError('Invalid MIME part.');
    const disposition = part.headers?.find(h => h.name.toLowerCase() === 'content-disposition')?.value || '';
    const cid = part.headers?.some(h => h.name.toLowerCase() === 'content-id');
    const inlineImage = part.mimeType?.startsWith('image/') && (/^inline\b/i.test(disposition) || (cid && !/^attachment\b/i.test(disposition)));
    if (part.filename && !inlineImage) result.push({part, path:current.path});
    if (result.length > 200) throw new PermanentMessageError('Message has more than 200 attachments.');
    for (let i=(part.parts?.length || 0)-1; i>=0; i--) todo.push({part:part.parts![i],path:`${current.path}.${i}`,depth:current.depth+1});
  }
  return result;
}
async function readBody(request: Request) {
  if (Number(request.headers.get('content-length') || 0) > 16384)
    throw new Error('Request too large.');
  const reader = request.body?.getReader();
  let text = '';
  let size = 0;
  const decoder = new TextDecoder();
  if (!reader) return {};
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 16384) {
      await reader.cancel();
      throw new Error('Request too large.');
    }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}
const timestamp = () => new Date().toISOString();
const digest = async (value:string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
function metadata(message:Record<string,any>) {
  const out:Record<string,string> = {};
  for (const header of message.payload?.headers || []) {
    const name = String(header.name).toLowerCase();
    if (['subject','from','to','date','message-id'].includes(name)) out[name] = String(header.value).slice(0,1000);
  }
  return out;
}
async function fingerprint(messageId:string,path:string,part:Part) {
  return digest(JSON.stringify([messageId,path,part.partId || '',part.filename || '',part.mimeType || '',part.body?.size,part.body?.attachmentId || '',part.body?.data ? await digest(part.body.data) : '']));
}
function reviewView(row:Review) {
  return {reviewId:row.review_id,mailboxId:row.mailbox_id,identity:row.identity,messageId:row.message_id,partPath:row.part_path,filename:row.filename,mime:row.mime,size:row.size,headers:JSON.parse(row.headers_json),destinationId:row.destination_id,entryId:row.entry_id,state:row.state,version:row.version,lastError:row.last_error};
}
async function destination(env:Env,user:User,id:string,automatic=false) {
  if (id==='root') return;
  const entry=await authorized(env,id,user,true);
  if (entry.kind!=='folder') throw new GmailError('Choose a folder.',400);
  if (automatic) {
    const closed=await env.DB.prepare(`WITH RECURSIVE chain(id,parent_id,depth) AS (SELECT id,parent_id,0 FROM entries WHERE id=? UNION ALL SELECT e.id,e.parent_id,c.depth+1 FROM entries e JOIN chain c ON e.id=c.parent_id WHERE c.depth<100) SELECT 1 FROM chain c JOIN workflow_projects p ON p.folder_id=c.id WHERE p.stage IN ('closed','archived') LIMIT 1`).bind(id).first();
    if (closed) throw new GmailError('Closed or archived projects require owner review.',409);
  }
}
async function connectionFor(env:Env,user:User,id?:string):Promise<Connection> {
  if (id) {
    const row=await env.DB.prepare('SELECT * FROM gmail_mailboxes WHERE mailbox_id=? AND owner=? AND enabled=1').bind(id,user.email).first<Connection>();
    if (!row) throw new GmailError('This mailbox is disconnected or unavailable.',404);
    return row;
  }
  const rows=(await env.DB.prepare('SELECT * FROM gmail_mailboxes WHERE owner=? AND enabled=1 LIMIT 2').bind(user.email).all<Connection>()).results;
  if (rows.length!==1) throw new GmailError(rows.length?'Select a mailbox.':'Connect Gmail first.');
  return rows[0];
}
async function checkConnection(env:Env,user:User,connection:Connection) {
  if (env.MAINTENANCE_MODE==='true') throw new GmailError('Maintenance is in progress.',503);
  const fresh=await connectionFor(env,user,connection.mailbox_id);
  if (fresh.revision!==connection.revision) throw new GmailError('Mailbox configuration changed. Retry.',409);
}
async function attachmentBytes(token:string,messageId:string,part:Part) {
  const expected=part.body?.size;
  if (!Number.isSafeInteger(expected) || expected!<0 || expected!>MAX_GMAIL_ATTACHMENT) throw new PermanentMessageError('Attachment exceeds the 20 MiB limit or has an invalid size.');
  try {
    if (part.body?.attachmentId) {
      const response=await fetch(`${BASE}messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
      return await readAttachmentBody(response,expected!);
    }
    if (typeof part.body?.data!=='string') throw new PermanentMessageError('Attachment content is unavailable.');
    return await readAttachmentBody(Response.json({size:expected,data:part.body.data.replace(/\+/g,'-').replace(/\//g,'_')}),expected!);
  } catch(error) {
    if (error instanceof PermanentMessageError) throw error;
    throw new GmailError('Attachment download or integrity verification failed. Retry from review.',502);
  }
}
async function ensureReview(env:Env,user:User,connection:Connection,message:Record<string,any>,path:string,part:Part,parent:string|null) {
  const identity=`gmail://${connection.email}/${message.id}/${path}`, id=`review-${await digest(identity)}`;
  const size=Number.isSafeInteger(part.body?.size) && part.body!.size!>=0 ? part.body!.size! : -1;
  await env.DB.prepare(`INSERT OR IGNORE INTO gmail_review_queue(review_id,owner,mailbox_id,identity,message_id,part_path,filename,mime,size,headers_json,source_fingerprint,destination_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,user.email,connection.mailbox_id,identity,message.id,path,safeFilename(part.filename),safeMime(part.mimeType),size,JSON.stringify(metadata(message)),await fingerprint(message.id,path,part),parent,timestamp(),timestamp()).run();
  return (await env.DB.prepare('SELECT * FROM gmail_review_queue WHERE identity=? AND owner=?').bind(identity,user.email).first<Review>())!;
}
async function claimReview(env:Env,user:User,row:Review,parent:string,automatic:boolean) {
  const lease=random(), now=Date.now();
  // Only an explicit review may resume a deferred item. An expired filing lease
  // retains its chosen destination, so a retry cannot silently redirect it.
  const claimed=await env.DB.prepare(`UPDATE gmail_review_queue SET state='filing',destination_id=?,version=version+1,lease_token=?,lease_until=?,last_error=NULL,updated_at=? WHERE review_id=? AND owner=? AND version=? AND (state='pending' OR (?=0 AND state='deferred') OR (state='filing' AND lease_until<? AND destination_id=?)) RETURNING *`).bind(parent,lease,now+LEASE_MS,timestamp(),row.review_id,user.email,row.version,automatic?1:0,now,parent).first<Review>();
  if (!claimed) throw new GmailError('Review changed or filing is already running. Refresh and retry.',409);
  return claimed;
}
async function recordDecision(env:Env,user:User,row:Review,action:string,nextState:string,entryId:string|null=null) {
  const updated=await env.DB.batch([
    env.DB.prepare(`INSERT INTO gmail_review_audit(audit_id,review_id,owner,action,version,destination_id,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM gmail_review_queue WHERE review_id=? AND version=? AND lease_token IS ? AND state=?)`).bind(crypto.randomUUID(),row.review_id,user.email,action,row.version,row.destination_id,timestamp(),row.review_id,row.version,row.lease_token,row.state),
    env.DB.prepare(`UPDATE gmail_review_queue SET state=?,entry_id=COALESCE(?,entry_id),lease_until=0,lease_token=NULL,version=version+1,updated_at=? WHERE review_id=? AND version=? AND lease_token IS ? AND state=? RETURNING review_id`).bind(nextState,entryId,timestamp(),row.review_id,row.version,row.lease_token,row.state),
  ]);
  if (!updated[1].results?.length) throw new GmailError('Review changed. Refresh before retrying.',409);
}
async function fileReview(env:Env,user:User,connection:Connection,row:Review,token:string,part:Part,automatic:boolean,guard?:()=>Promise<void>) {
  const parent=row.destination_id || 'root';
  const validate=async()=>{
    await checkConnection(env,user,connection);
    await destination(env,user,parent,automatic);
    const current=await env.DB.prepare("SELECT 1 FROM gmail_review_queue WHERE review_id=? AND version=? AND lease_token=? AND lease_until>? AND state='filing'").bind(row.review_id,row.version,row.lease_token,Date.now()).first();
    if (!current) throw new GmailError('Filing lease expired. Refresh and retry.',409);
    await guard?.();
  };
  try {
    if (await fingerprint(row.message_id,row.part_path,part)!==row.source_fingerprint) throw new GmailError('The Gmail source changed. Review the original message.',409);
    const bytes=await attachmentBytes(token,row.message_id,part);
    await validate();
    const file=await importFile(env,user,parent,row.filename,row.mime,bytes,row.identity,validate);
    const saved=await env.DB.prepare('SELECT parent_id FROM entries WHERE id=?').bind(file.entryId).first<{parent_id:string|null}>();
    if (!saved || (saved.parent_id || 'root')!==parent) throw new GmailError('This source was already filed elsewhere. Inspect the existing file.',409);
    await recordDecision(env,user,row,automatic?'auto_file':'assign','filed',file.entryId);
    return file.entryId;
  } catch(error) {
    // Do not erase the source or the decision. A deferred item is visible and can
    // be explicitly retried with its new version after a provider failure.
    await env.DB.prepare(`UPDATE gmail_review_queue SET state='deferred',lease_until=0,lease_token=NULL,version=version+1,last_error=?,updated_at=? WHERE review_id=? AND version=? AND lease_token=?`).bind(error instanceof PermanentMessageError || error instanceof GmailError ? error.message:'Filing failed. Review and retry.',timestamp(),row.review_id,row.version,row.lease_token).run();
    throw error;
  }
}
async function scan(env:Env,user:User,input:Record<string,any>,scheduled=false) {
  const label=typeof input.label==='string'?input.label.trim():'';
  if (!label || label.length>100 || /[\u0000-\u001f]/.test(label)) throw new GmailError('Enter an exact Gmail label name.');
  const connection=await connectionFor(env,user,input.mailboxId);
  const scope=await env.DB.prepare('SELECT * FROM gmail_label_scopes WHERE mailbox_id=? AND label=?').bind(connection.mailbox_id,label).first<Scope>();
  if (scheduled && (!scope?.enabled || !scope.scheduled)) return {imported:0,skipped:0,queued:0,remaining:false,issues:[]};
  const parent=scope?.destination_id || (typeof input.parentId==='string'?input.parentId:'root');
  let reviewOnly=scope ? !scope.enabled || !!scope.review_only : !!input.mailboxId;
  try {await destination(env,user,parent,true);} catch {reviewOnly=true;}
  const now=Date.now(),lease=random();
  const job=await env.DB.prepare(`INSERT INTO gmail_mailbox_jobs(mailbox_id,label,parent_id,page_token,started_at,lease_until,lease_token) VALUES(?,?,?,NULL,?,?,?) ON CONFLICT(mailbox_id,label) DO UPDATE SET parent_id=excluded.parent_id,page_token=CASE WHEN parent_id=excluded.parent_id THEN page_token ELSE NULL END,started_at=CASE WHEN parent_id=excluded.parent_id THEN started_at ELSE excluded.started_at END,lease_until=excluded.lease_until,lease_token=excluded.lease_token WHERE lease_until<? RETURNING *`).bind(connection.mailbox_id,label,parent,now,now+LEASE_MS,lease,now).first<{page_token:string|null;started_at:number}>();
  if (!job) throw new GmailError('An import is already running for this label.',409);
  let next:string|undefined, processedMessage=false;
  const advance=async()=>{
    if (next) await env.DB.prepare('UPDATE gmail_mailbox_jobs SET page_token=? WHERE mailbox_id=? AND label=? AND lease_token=?').bind(next,connection.mailbox_id,label,lease).run();
    else await env.DB.prepare('DELETE FROM gmail_mailbox_jobs WHERE mailbox_id=? AND label=? AND lease_token=?').bind(connection.mailbox_id,label,lease).run();
  };
  const guard=async()=>{
    await checkConnection(env,user,connection);
    const active=await env.DB.prepare('SELECT 1 FROM gmail_mailbox_jobs WHERE mailbox_id=? AND label=? AND lease_token=? AND lease_until>?').bind(connection.mailbox_id,label,lease,Date.now()).first();
    if (!active) throw new GmailError('Import lease changed.',409);
    if (scope) {
      const fresh=await env.DB.prepare('SELECT revision,enabled,scheduled FROM gmail_label_scopes WHERE mailbox_id=? AND label=?').bind(connection.mailbox_id,label).first<{revision:number;enabled:number;scheduled:number}>();
      if (!fresh || fresh.revision!==scope.revision || !fresh.enabled || (scheduled && !fresh.scheduled)) throw new GmailError('Filing rule changed. Retry.',409);
    }
  };
  try {
    const token=await accessToken(env,connection), headers={Authorization:`Bearer ${token}`};
    const labels=await jsonFetch(BASE+'labels',{headers});
    const found=(labels.labels || []).find((l:any)=>l.name===label);
    if (!found || typeof found.id!=='string') throw new GmailError('That label was not found. Create it in Gmail first.');
    const listUrl=new URL(BASE+'messages');
    listUrl.search=new URLSearchParams({labelIds:found.id,maxResults:'1',q:`has:attachment before:${Math.ceil(job.started_at/1000)}`,...(job.page_token?{pageToken:job.page_token}:{})}).toString();
    const list=await jsonFetch(listUrl.toString(),{headers});
    next=typeof list.nextPageToken==='string'?list.nextPageToken:undefined;
    const messageId=list.messages?.[0]?.id;
    if (!messageId) {await advance();return {imported:0,skipped:0,queued:0,remaining:false,issues:[]};}
    if (typeof messageId!=='string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(messageId)) throw new PermanentMessageError('Invalid Gmail message identity.');
    processedMessage=true;
    const message=await jsonFetch(`${BASE}messages/${encodeURIComponent(messageId)}?format=full`,{headers},12*1024*1024);
    if (message.id!==messageId) throw new PermanentMessageError('Gmail returned a different message.');
    message.id=messageId;
    if (message.labelIds?.includes('DRAFT')) {await advance();return {imported:0,skipped:1,queued:0,remaining:!!next,issues:['Draft skipped.']};}
    let imported=0,skipped=0,queued=0,remaining=false,bytesUsed=0;
    const issues:string[]=[];
    for (const {part,path} of parts(message.payload || {})) {
      await guard();
      const identity=`gmail://${connection.email}/${messageId}/${path}`;
      const prior=await env.DB.prepare('SELECT entry_id FROM versions WHERE source=?').bind(identity).first();
      if (prior) {skipped++;continue;}
      const row=await ensureReview(env,user,connection,message,path,part,parent);
      if (['filed','dismissed','deferred'].includes(row.state)) {skipped++;continue;}
      if (row.state==='filing' && row.lease_until>Date.now()) {remaining=true;continue;}
      if (reviewOnly) {queued++;continue;}
      if (row.size<0 || row.size>MAX_GMAIL_ATTACHMENT) {issues.push(`${row.filename}: exceeds the attachment limit, left for review.`);queued++;continue;}
      if (imported>=2 || (bytesUsed>0 && bytesUsed+row.size>8*1024*1024)) {remaining=true;break;}
      try {
        const claimed=await claimReview(env,user,row,parent,true);
        await fileReview(env,user,connection,claimed,token,part,true,guard);
        imported++;bytesUsed+=row.size;
      } catch(error) {
        issues.push(error instanceof GmailError || error instanceof PermanentMessageError?error.message:'Attachment remains in review.');
      }
    }
    if (!remaining) {await advance();remaining=!!next;}
    return {imported,skipped,queued,remaining,issues};
  } catch(error) {
    if (error instanceof PermanentMessageError && processedMessage) {await advance();return {imported:0,skipped:0,queued:0,remaining:!!next,issues:[error.message]};}
    throw error;
  } finally {
    await env.DB.prepare('UPDATE gmail_mailbox_jobs SET lease_until=0,lease_token=NULL WHERE mailbox_id=? AND label=? AND lease_token=?').bind(connection.mailbox_id,label,lease).run();
  }
}
async function mailboxList(env:Env,user:User) {
  const rows=(await env.DB.prepare('SELECT mailbox_id,email,enabled FROM gmail_mailboxes WHERE owner=? AND enabled=1 ORDER BY created_at').bind(user.email).all<{mailbox_id:string;email:string;enabled:number}>()).results;
  const scopes=(await env.DB.prepare('SELECT s.* FROM gmail_label_scopes s JOIN gmail_mailboxes m ON m.mailbox_id=s.mailbox_id WHERE m.owner=?').bind(user.email).all<Scope & {last_run_at:number;last_error:string|null}>()).results;
  return rows.map(r=>({mailboxId:r.mailbox_id,email:r.email,enabled:!!r.enabled,labels:scopes.filter(s=>s.mailbox_id===r.mailbox_id).map(s=>({label:s.label,destinationId:s.destination_id,scheduled:!!s.scheduled,reviewOnly:!!s.review_only,enabled:!!s.enabled,lastRunAt:s.last_run_at || null,lastError:s.last_error}))}));
}
export async function handleGmail(request:Request,env:Env,user:User):Promise<Response|null> {
  const url=new URL(request.url);
  if (!url.pathname.startsWith('/api/gmail/')) return null;
  if (!user.isOwner) return Response.json({error:'Only the workspace owner can manage Gmail.'},{status:403});
  const route=url.pathname.slice('/api/gmail/'.length);
  try {
    if ((route==='status' || route==='mailboxes') && request.method==='GET') {
      const mailboxes=await mailboxList(env,user);
      const count=await env.DB.prepare("SELECT count(*) AS n FROM gmail_review_queue WHERE owner=? AND state IN ('pending','deferred')").bind(user.email).first<{n:number}>();
      return Response.json({configured:enabled(env),connected:mailboxes.length>0,email:mailboxes.length===1?mailboxes[0].email:undefined,mailboxes,reviewCount:count?.n || 0});
    }
    const disconnect=route.match(/^mailboxes\/([^/]+)$/);
    if ((route==='disconnect' && request.method==='POST') || (disconnect && request.method==='DELETE')) {
      const body=route==='disconnect'?await readBody(request):{};
      const id=disconnect?decodeURIComponent(disconnect[1]):body.mailboxId;
      const connection=await connectionFor(env,user,id);
      await withStorageLock(env, async () => env.DB.batch([
        env.DB.prepare("UPDATE gmail_mailboxes SET enabled=0,encrypted_token='',revision=revision+1,updated_at=? WHERE mailbox_id=? AND owner=?").bind(timestamp(),connection.mailbox_id,user.email),
        env.DB.prepare('UPDATE gmail_label_scopes SET enabled=0,scheduled=0,revision=revision+1 WHERE mailbox_id=?').bind(connection.mailbox_id),
        env.DB.prepare('DELETE FROM gmail_mailbox_jobs WHERE mailbox_id=?').bind(connection.mailbox_id),
        env.DB.prepare('DELETE FROM gmail_states WHERE owner=?').bind(user.email),
        env.DB.prepare('DELETE FROM gmail_connection WHERE owner=?').bind(user.email),
      ]));
      return Response.json({connected:false,mailboxId:connection.mailbox_id});
    }
    const config=route.match(/^mailboxes\/([^/]+)\/config$/);
    if (config && request.method==='PUT') {
      const c=await connectionFor(env,user,decodeURIComponent(config[1])),body=await readBody(request);
      const label=typeof body.label==='string'?body.label.trim():'';
      const parent=typeof body.destinationId==='string'?body.destinationId:'';
      if (!label || label.length>100 || /[\u0000-\u001f]/.test(label) || !parent) throw new GmailError('A label and destination folder are required.');
      await destination(env,user,parent);
      await withStorageLock(env, async () => env.DB.batch([
        env.DB.prepare(`INSERT INTO gmail_label_scopes(mailbox_id,label,destination_id,scheduled,review_only,enabled,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(mailbox_id,label) DO UPDATE SET destination_id=excluded.destination_id,scheduled=excluded.scheduled,review_only=excluded.review_only,enabled=excluded.enabled,revision=revision+1,updated_at=excluded.updated_at,last_error=NULL`).bind(c.mailbox_id,label,parent,body.scheduled===true?1:0,body.reviewOnly===false?0:1,body.enabled===false?0:1,timestamp()),
        env.DB.prepare('DELETE FROM gmail_mailbox_jobs WHERE mailbox_id=? AND label=?').bind(c.mailbox_id,label),
      ]));
      return Response.json({saved:true});
    }
    if (route==='review' && request.method==='GET') {
      const state=url.searchParams.get('state') || 'pending';
      if (!['pending','deferred','filed','dismissed','filing'].includes(state)) throw new GmailError('Invalid review state.');
      const offset=Number(url.searchParams.get('offset') || 0);
      if (!Number.isSafeInteger(offset) || offset<0) throw new GmailError('Invalid review offset.');
      const rows=(await env.DB.prepare('SELECT * FROM gmail_review_queue WHERE owner=? AND state=? ORDER BY created_at,review_id LIMIT 101 OFFSET ?').bind(user.email,state,offset).all<Review>()).results;
      return Response.json({reviews:rows.slice(0,100).map(reviewView),nextOffset:rows.length>100?offset+100:null});
    }
    if (!enabled(env)) throw new GmailError('Add your own Google OAuth client and encryption key using the Gmail setup guide.',503);
    const redirect=`${url.origin}/api/gmail/callback`;
    if (route==='connect' && request.method==='POST') {
      const body=await readBody(request),id=typeof body.mailboxId==='string'?body.mailboxId:null;
      if (id && !await env.DB.prepare('SELECT 1 FROM gmail_mailboxes WHERE mailbox_id=? AND owner=?').bind(id,user.email).first()) throw new GmailError('Mailbox not found.',404);
      const state=random(),verifier=random();
      const challenge=base64(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(verifier)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM gmail_states WHERE expires_at<? OR owner=?').bind(Date.now(),user.email),
        env.DB.prepare('INSERT INTO gmail_states(state,owner,verifier,expires_at,mailbox_id) VALUES(?,?,?,?,?)').bind(state,user.email,verifier,Date.now()+600000,id),
      ]);
      const auth=new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search=new URLSearchParams({client_id:env.GMAIL_CLIENT_ID!,redirect_uri:redirect,response_type:'code',scope:SCOPE,access_type:'offline',prompt:'consent',state,code_challenge:challenge,code_challenge_method:'S256'}).toString();
      return Response.json({url:auth.toString()});
    }
    if (route==='callback' && request.method==='GET') {
      const stored=await env.DB.prepare('DELETE FROM gmail_states WHERE state=? AND owner=? AND expires_at>? RETURNING verifier,mailbox_id').bind(url.searchParams.get('state') || '',user.email,Date.now()).first<{verifier:string;mailbox_id:string|null}>();
      if (!stored) throw new GmailError('Connection request expired. Start again from the app.');
      if (url.searchParams.get('error') || !url.searchParams.get('code')) return Response.redirect(`${url.origin}/?gmail=cancelled`,303);
      const token=await jsonFetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GMAIL_CLIENT_ID!,client_secret:env.GMAIL_CLIENT_SECRET!,redirect_uri:redirect,grant_type:'authorization_code',code:url.searchParams.get('code')!,code_verifier:stored.verifier})});
      if (typeof token.refresh_token!=='string' || typeof token.access_token!=='string' || !String(token.scope).split(' ').includes(SCOPE)) throw new GmailError('Read-only access and offline consent are required.',502);
      const profile=await jsonFetch(BASE+'profile',{headers:{Authorization:`Bearer ${token.access_token}`}});
      if (typeof profile.emailAddress!=='string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.emailAddress)) throw new GmailError('Google did not identify this mailbox.',502);
      const email=profile.emailAddress.toLowerCase();
      const selected=stored.mailbox_id?await env.DB.prepare('SELECT * FROM gmail_mailboxes WHERE mailbox_id=? AND owner=?').bind(stored.mailbox_id,user.email).first<Connection>():null;
      if (stored.mailbox_id && (!selected || selected.email!==email)) throw new GmailError('Reconnect using the same Google mailbox.',409);
      const existing=await env.DB.prepare('SELECT * FROM gmail_mailboxes WHERE owner=? AND email=?').bind(user.email,email).first<Connection>();
      const id=selected?.mailbox_id || existing?.mailbox_id || crypto.randomUUID();
      const encrypted=await seal(env,token.refresh_token);
      await withStorageLock(env, async () => env.DB.batch([
        env.DB.prepare(`INSERT INTO gmail_mailboxes(mailbox_id,owner,email,encrypted_token,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(mailbox_id) DO UPDATE SET encrypted_token=excluded.encrypted_token,enabled=1,revision=revision+1,updated_at=excluded.updated_at WHERE owner=excluded.owner AND email=excluded.email`).bind(id,user.email,email,encrypted,timestamp(),timestamp()),
        env.DB.prepare('DELETE FROM gmail_mailbox_jobs WHERE mailbox_id=?').bind(id),
      ]));
      return Response.redirect(`${url.origin}/?gmail=connected`,303);
    }
    const review=route.match(/^review\/([^/]+)\/(assign|dismiss|defer)$/);
    if (review && request.method==='POST') {
      const body=await readBody(request),action=review[2];
      const row=await env.DB.prepare('SELECT * FROM gmail_review_queue WHERE review_id=? AND owner=?').bind(decodeURIComponent(review[1]),user.email).first<Review>();
      if (!row || body.version!==row.version || (!['pending','deferred'].includes(row.state) && !(row.state==='filing' && row.lease_until<Date.now()))) throw new GmailError('Review is stale or filing is already running.',409);
      if (action!=='assign') {await recordDecision(env,user,row,action,action==='dismiss'?'dismissed':'deferred');return Response.json({reviewed:true});}
      const parent=typeof body.destinationId==='string'?body.destinationId:'';
      if (!parent) throw new GmailError('Choose a destination folder.');
      await destination(env,user,parent);
      const c=await connectionFor(env,user,row.mailbox_id);
      const claimed=await claimReview(env,user,row,parent,false);
      try {
        const token=await accessToken(env,c);
        const message=await jsonFetch(`${BASE}messages/${encodeURIComponent(row.message_id)}?format=full`,{headers:{Authorization:`Bearer ${token}`}},12*1024*1024);
        if (message.id!==row.message_id || message.labelIds?.includes('DRAFT')) throw new GmailError('Original message is unavailable or is a draft.',409);
        const part=parts(message.payload || {}).find(p=>p.path===row.part_path)?.part;
        if (!part) throw new GmailError('Original attachment is unavailable.',409);
        const entryId=await fileReview(env,user,c,claimed,token,part,false);
        return Response.json({filed:true,entryId});
      } catch(error) {
        await env.DB.prepare("UPDATE gmail_review_queue SET state='deferred',version=version+1,lease_until=0,lease_token=NULL,last_error='Filing failed. Review the original and retry.',updated_at=? WHERE review_id=? AND version=? AND lease_token=?").bind(timestamp(),claimed.review_id,claimed.version,claimed.lease_token).run();
        throw error;
      }
    }
    if (route==='import' && request.method==='POST') return Response.json(await scan(env,user,await readBody(request)));
    return Response.json({error:'Not found.'},{status:404});
  } catch(error) {
    return Response.json({error:error instanceof GmailError || error instanceof PermanentMessageError?error.message:'Gmail could not finish. Check the connection and retry.'},{status:error instanceof GmailError?error.status:502});
  }
}
export async function runGmailSchedule(env:Env) {
  if (!configured(env) || !enabled(env) || env.MAINTENANCE_MODE==='true') return {enabled:false,processed:0};
  const user={email:env.OWNER_EMAIL.trim().toLowerCase(),isOwner:true};
  // Rotate fairly across rules and accounts; each rule processes one message and
  // at most two small attachments or one large attachment per invocation.
  const scopes=(await env.DB.prepare(`SELECT s.* FROM gmail_label_scopes s JOIN gmail_mailboxes m ON m.mailbox_id=s.mailbox_id WHERE m.owner=? AND m.enabled=1 AND s.enabled=1 AND s.scheduled=1 ORDER BY s.last_run_at,s.mailbox_id,s.label LIMIT 2`).bind(user.email).all<Scope>()).results;
  let processed=0;
  for (const scope of scopes) {
    await env.DB.prepare('UPDATE gmail_label_scopes SET last_run_at=? WHERE mailbox_id=? AND label=?').bind(Date.now(),scope.mailbox_id,scope.label).run();
    let error:string|null=null;
    try {
      const result=await scan(env,user,{mailboxId:scope.mailbox_id,label:scope.label,parentId:scope.destination_id},true);
      processed+=result.imported;
      error=result.issues.join(' ').slice(0,500) || null;
    } catch {error='Polling failed. Check the mailbox connection, label, and destination, then retry.';}
    await env.DB.prepare('UPDATE gmail_label_scopes SET last_error=? WHERE mailbox_id=? AND label=? AND revision=?').bind(error,scope.mailbox_id,scope.label,scope.revision).run();
  }
  return {enabled:true,processed};
}
