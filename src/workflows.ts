import type { User } from './auth.ts';
import { authorized, permissionMap, withStorageLock, type Entry } from './storage.ts';
export type Stage = 'ready_to_launch'|'active'|'under_contract'|'closing'|'closed'|'archived';
type Project = {id:string;folder_id:string;name:string;stage:Stage;created_at:string;updated_at:string;created_by:string};
type Checklist = {id:string;project_id:string;name:string;pattern:string;required:number;applicability:string;revision:number};
const STAGES:Stage[]=['ready_to_launch','active','under_contract','closing','closed','archived'];
const now=()=>new Date().toISOString();
class WorkflowError extends Error {
  status:number;
  constructor(status:number,message:string) {super(message);this.status=status;}
}
async function body(request:Request):Promise<Record<string,any>> {
  const reader=request.body?.getReader();
  if (!reader) throw new WorkflowError(400,'A JSON request is required.');
  const decoder=new TextDecoder();let length=0,text='';
  for (;;) {
    const chunk=await reader.read();if(chunk.done)break;
    length+=chunk.value.length;
    if(length>32000){await reader.cancel();throw new WorkflowError(413,'Project settings are too large.');}
    text+=decoder.decode(chunk.value,{stream:true});
  }
  try {
    const result=JSON.parse(text+decoder.decode());
    if(!result || typeof result!=='object' || Array.isArray(result))throw Error();
    return result;
  } catch {throw new WorkflowError(400,'Invalid JSON request.');}
}
function clean(value:unknown,max=255) {
  if(typeof value!=='string' || !value.trim() || value.length>max || /[\u0000-\u001f]/.test(value))throw new WorkflowError(400,'Use a short, nonempty name or pattern without control characters.');
  return value.trim();
}
function view(p:Project) {return {id:p.id,folderId:p.folder_id,name:p.name,stage:p.stage,createdAt:p.created_at,updatedAt:p.updated_at,archived:['closed','archived'].includes(p.stage)};}
async function projectFor(env:Env,user:User,id:string) {
  const p=await env.DB.prepare('SELECT * FROM workflow_projects WHERE id=?').bind(id).first<Project>();
  if(!p)throw new WorkflowError(404,'Project not found.');
  try {await authorized(env,p.folder_id,user);} catch {throw new WorkflowError(404,'Project not found.');}
  return p;
}
// Glob matching uses bounded string comparisons, not a user-controlled regexp.
export function filenameMatches(pattern:string,name:string) {
  pattern=pattern.toLowerCase();name=name.toLowerCase();
  let p=0,n=0,star=-1,retry=0;
  while(n<name.length) {
    if(p<pattern.length && (pattern[p]==='?' || pattern[p]===name[n])){p++;n++;}
    else if(pattern[p]==='*'){star=p++;retry=n;}
    else if(star!==-1){p=star+1;n=++retry;}
    else return false;
  }
  while(pattern[p]==='*')p++;
  return p===pattern.length;
}
function evidenceFile(file:Entry) {
  return !/^(image|video|audio)\//i.test(file.mime) && !/\b(template|sample|example|blank)\b/i.test(file.name.replace(/[_-]/g,' ')) && !/\.(dotx?|dotm|potx?|potm|xltx?|xltm|jpe?g|png|gif|svg|webp|mp[34]|mov|wav)$/i.test(file.name);
}
async function inventory(env:Env,user:User,p:Project) {
  const rows=(await env.DB.prepare(`WITH RECURSIVE tree AS (SELECT e.*,0 depth FROM entries e WHERE id=? UNION ALL SELECT e.*,t.depth+1 FROM entries e JOIN tree t ON e.parent_id=t.id WHERE t.depth<100 AND t.trashed=0) SELECT * FROM tree WHERE kind='file' AND current_version IS NOT NULL AND trashed=0 ORDER BY name,id LIMIT 501`).bind(p.folder_id).all<Entry>()).results;
  const capped=rows.length>500,candidates=rows.slice(0,500);
  const access=await permissionMap(env,candidates.map(f=>f.id),user);
  const files=candidates.filter(f=>access.has(f.id));
  const defs=(await env.DB.prepare('SELECT * FROM workflow_checklists WHERE project_id=? AND active=1 ORDER BY created_at,id').bind(p.id).all<Checklist>()).results;
  const reviews=(await env.DB.prepare(`SELECT r.* FROM workflow_reviews r JOIN (SELECT checklist_id,entry_id,MAX(rowid) latest FROM workflow_reviews WHERE project_id=? GROUP BY checklist_id,entry_id) latest ON latest.latest=r.rowid`).bind(p.id).all<{checklist_id:string;entry_id:string;version_id:string;definition_revision:number;action:string}>()).results;
  const map=new Map(reviews.map(r=>[`${r.checklist_id}:${r.entry_id}`,r]));
  const checklist=defs.map(d=>{
    const applicable=d.applicability==='always' || d.applicability===p.stage;
    const matches=files.filter(f=>evidenceFile(f)&&filenameMatches(d.pattern,f.name)).map(f=>{
      const review=map.get(`${d.id}:${f.id}`);
      const reviewed=review?.version_id===f.current_version && review.definition_revision===d.revision;
      return {entryId:f.id,name:f.name,currentVersion:f.current_version,downloadUrl:`/api/entries/${f.id}/download?version=${encodeURIComponent(f.current_version!)}`,status:reviewed?review.action:'needs_review'};
    });
    return {id:d.id,name:d.name,pattern:d.pattern,required:!!d.required,applicability:d.applicability,candidates:matches,status:!applicable?'not_applicable':capped?'unassessed':matches.some(f=>f.status==='confirmed')?'confirmed':matches.length?'needs_review':'not_found'};
  });
  return {filesScanned:files.length,inventoryCapped:capped,checklist};
}
async function dispatch(request:Request,env:Env,user:User):Promise<Response|null> {
  const url=new URL(request.url);
  if(url.pathname==='/api/projects' && request.method==='GET') {
    const archived=url.searchParams.get('archived')==='1',offset=Number(url.searchParams.get('offset') || 0);
    if(!Number.isSafeInteger(offset)||offset<0)throw new WorkflowError(400,'Invalid page.');
    const rows=(await env.DB.prepare("SELECT * FROM workflow_projects WHERE (?=1 AND stage IN ('closed','archived')) OR (?=0 AND stage NOT IN ('closed','archived')) ORDER BY updated_at DESC,id LIMIT 201 OFFSET ?").bind(archived?1:0,archived?1:0,offset).all<Project>()).results;
    const access=await permissionMap(env,rows.slice(0,200).map(p=>p.folder_id),user);
    return Response.json({projects:rows.slice(0,200).filter(p=>access.has(p.folder_id)).map(view),archived,nextOffset:rows.length>200?offset+200:null});
  }
  if(url.pathname==='/api/projects' && request.method==='POST') {
    if(!user.isOwner)throw new WorkflowError(403,'Only the owner can designate projects.');
    const d=await body(request),folder=await authorized(env,clean(d.folderId),user,true);
    if(folder.kind!=='folder')throw new WorkflowError(400,'Choose a folder.');
    if(await env.DB.prepare('SELECT 1 FROM workflow_projects WHERE folder_id=?').bind(folder.id).first())throw new WorkflowError(409,'This folder is already a project.');
    const stage=d.stage===undefined?'ready_to_launch':d.stage;
    if(!STAGES.includes(stage))throw new WorkflowError(400,'Invalid stage.');
    const p={id:crypto.randomUUID(),folder_id:folder.id,name:d.name?clean(d.name):folder.name,stage,created_at:now(),updated_at:now(),created_by:user.email};
    await env.DB.prepare('INSERT INTO workflow_projects(id,folder_id,name,stage,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?)').bind(p.id,p.folder_id,p.name,p.stage,p.created_at,p.updated_at,p.created_by).run();
    return Response.json({project:view(p)},{status:201});
  }
  const match=url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(checklists|inventory)(?:\/([^/]+))?)?$/);
  if(!match)return null;
  const [,id,action,child]=match,p=await projectFor(env,user,id);
  if(!action&&request.method==='GET')return Response.json({project:view(p),...await inventory(env,user,p)});
  if(action==='inventory'&&request.method==='GET')return Response.json(await inventory(env,user,p));
  if(!action&&request.method==='PATCH') {
    if(!user.isOwner)throw new WorkflowError(403,'Only the owner can edit project stages.');
    const d=await body(request);
    if(!STAGES.includes(d.stage))throw new WorkflowError(400,'Invalid stage.');
    const name=d.name?clean(d.name):p.name,t=now();
    await env.DB.prepare('UPDATE workflow_projects SET name=?,stage=?,updated_at=? WHERE id=?').bind(name,d.stage,t,id).run();
    return Response.json({project:view({...p,name,stage:d.stage,updated_at:t})});
  }
  if(action==='checklists'&&!child&&request.method==='GET')return Response.json({checklists:(await env.DB.prepare('SELECT * FROM workflow_checklists WHERE project_id=? AND active=1 ORDER BY created_at,id').bind(id).all()).results});
  if(action==='checklists'&&!child&&request.method==='PUT') {
    if(!user.isOwner)throw new WorkflowError(403,'Only the owner can edit checklists.');
    const d=await body(request);
    if(!Array.isArray(d.checklists)||d.checklists.length>50)throw new WorkflowError(400,'Provide at most 50 checklist items.');
    const existing=(await env.DB.prepare('SELECT * FROM workflow_checklists WHERE project_id=?').bind(id).all<Checklist>()).results;
    const statements=[env.DB.prepare('UPDATE workflow_checklists SET active=0 WHERE project_id=?').bind(id)];
    const ids=new Set<string>();
    for(const c of d.checklists) {
      const name=clean(c?.name),pattern=clean(c?.pattern,120),applicability=c.applicability || 'always';
      if(applicability!=='always'&&!STAGES.includes(applicability))throw new WorkflowError(400,'Choose an applicable stage or always.');
      const previous=c.id?existing.find(e=>e.id===c.id):existing.find(e=>e.name===name&&e.pattern===pattern&&!ids.has(e.id));
      if(c.id&&!previous)throw new WorkflowError(409,'Checklist identity is stale. Refresh.');
      const cid=previous?.id || crypto.randomUUID();
      if(ids.has(cid))throw new WorkflowError(400,'Duplicate checklist item.');ids.add(cid);
      const changed=previous && (previous.name!==name||previous.pattern!==pattern||previous.applicability!==applicability||!!previous.required!==!!c.required);
      statements.push(env.DB.prepare(`INSERT INTO workflow_checklists(id,project_id,name,pattern,required,applicability,active,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,pattern=excluded.pattern,required=excluded.required,applicability=excluded.applicability,active=1,revision=revision+?,updated_at=excluded.updated_at`).bind(cid,id,name,pattern,c.required?1:0,applicability,now(),now(),changed?1:0));
    }
    await env.DB.batch(statements);
    return Response.json({checklists:(await env.DB.prepare('SELECT * FROM workflow_checklists WHERE project_id=? AND active=1 ORDER BY created_at,id').bind(id).all()).results});
  }
  if(action==='checklists'&&child&&request.method==='POST') {
    if(!user.isOwner)throw new WorkflowError(403,'Only the owner can confirm checklist evidence.');
    const d=await body(request),entryId=clean(d.entryId),version=clean(d.version);
    if(!['confirmed','dismissed'].includes(d.action))throw new WorkflowError(400,'Invalid review action.');
    await authorized(env,entryId,user,true);
    const result=await env.DB.prepare(`WITH RECURSIVE tree(id,depth) AS (SELECT id,0 FROM entries WHERE id=? AND trashed=0 UNION ALL SELECT e.id,t.depth+1 FROM entries e JOIN tree t ON e.parent_id=t.id WHERE t.depth<100 AND e.trashed=0) INSERT INTO workflow_reviews(id,project_id,checklist_id,entry_id,version_id,reviewer,definition_revision,action,created_at) SELECT ?,?,?,?,?,?,c.revision,?,? FROM workflow_checklists c WHERE c.id=? AND c.project_id=? AND c.active=1 AND EXISTS(SELECT 1 FROM tree WHERE id=? AND id!=?) AND EXISTS(SELECT 1 FROM entries e JOIN versions v ON v.id=e.current_version AND v.entry_id=e.id WHERE e.id=? AND e.kind='file' AND e.current_version=? AND e.trashed=0) RETURNING id`).bind(p.folder_id,crypto.randomUUID(),id,child,entryId,version,user.email,d.action,now(),child,id,entryId,p.folder_id,entryId,version).first();
    if(!result)throw new WorkflowError(409,'The file or checklist changed, or the file is outside this project. Refresh.');
    return Response.json({reviewed:true,entryId,versionId:version,action:d.action},{status:201});
  }
  return null;
}
export async function handleWorkflows(request:Request,env:Env,user:User):Promise<Response|null> {
  if(!new URL(request.url).pathname.startsWith('/api/projects'))return null;
  try {return ['GET','HEAD'].includes(request.method)?await dispatch(request,env,user):await withStorageLock(env,()=>dispatch(request,env,user));}
  catch(error) {return Response.json({error:error instanceof WorkflowError?error.message:'The project request could not be completed.'},{status:error instanceof WorkflowError?error.status:500});}
}
