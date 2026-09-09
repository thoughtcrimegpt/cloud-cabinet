import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Archive,
  ChevronRight,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  HardDrive,
  History,
  LoaderCircle,
  LogIn,
  Menu,
  MoreHorizontal,
  RefreshCw,
  Search,
  Settings,
  Shield,
  Upload,
  X,
} from 'lucide-react';
import './styles.css';
import { importFolder } from './folder-import.ts';
import { uploadMedia } from './media-upload.ts';
type Entry = {
  id: string;
  parentId: string | null;
  name: string;
  kind: 'file' | 'folder';
  size: number;
  mime: string;
  currentVersion: string | null;
  updatedAt: string;
  trashed: boolean;
  role: 'owner' | 'editor' | 'viewer';
};
type Me = {
  email: string;
  isOwner: boolean;
  maxUploadBytes: number;
  maxMultipartBytes?: number;
  maxStorageBytes: number;
  maintenance?: boolean;
};
type Branding = { companyName: string; accentColor: string; customCss: string };
type Listing = {
  entries: Entry[];
  ancestors: { id: string; name: string }[];
  usedBytes: number;
  limitBytes: number;
  truncated: boolean;
  nextOffset: number | null;
  canCreate: boolean;
};
type Version = {
  id: string;
  size: number;
  createdAt: string;
  createdBy: string;
  source: string;
};
type Project = { id:string; folderId:string; name:string; stage:string; archived:boolean };
type ProjectDetail = { project:Project; filesScanned:number; inventoryCapped:boolean; checklist:Array<{id:string;name:string;pattern:string;required:boolean;applicability:string;status:string;candidates:Array<{entryId:string;name:string;currentVersion:string;downloadUrl:string;status:string}>}> };
const DOCS = 'https://github.com/thoughtcrimegpt/cloud-cabinet/blob/main/docs/';
const defaults: Branding = {
  companyName: 'Cloud Cabinet',
  accentColor: '#1430a3',
  customCss: '',
};
const size = (n: number) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  while (n >= 1000 && index < 4) {
    n /= 1000;
    index++;
  }
  return `${n.toFixed(index ? 1 : 0)} ${units[index]}`;
};
const message = (e: unknown) =>
  e instanceof Error ? e.message : 'Request could not be completed.';
async function api<T>(
  url: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const r = await fetch(url, {
    method,
    headers:
      body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r
    .json()
    .catch(() => ({ error: 'The server returned an unexpected response.' }));
  if (!r.ok)
    throw Object.assign(
      new Error(
        (data as { error?: string }).error || `Request failed (${r.status}).`,
      ),
      { status: r.status },
    );
  return data as T;
}
function Modal({
  title,
  close,
  children,
  busy = false,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => {
      ref.current?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={close}
          disabled={busy}
          aria-label="Close"
        >
          <X />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Notice({ text }: { text: string }) {
  return text ? (
    <p className="notice" role="status">
      {text}
    </p>
  ) : null;
}
function Setup({ error, retry }: { error?: string; retry?: () => void }) {
  return (
    <main className="setup">
      <div className="setup-card">
        <div className="logo-mark">
          <Archive />
        </div>
        <p className="eyebrow">CLOUD CABINET</p>
        <h1>
          Your files.
          <br />
          Your cloud.
        </h1>
        <p className="lede">
          A private file workspace that runs in your own Cloudflare account.
        </p>
        {error ? (
          <>
            <Notice text={error} />
            <button className="button primary" onClick={retry}>
              Try again
            </button>
          </>
        ) : (
          <>
            <div className="setup-steps">
              <div>
                <span>01</span>
                <b>Install your copy</b>
                <small>
                  Cloudflare creates your app, private R2 bucket, and D1
                  database.
                </small>
              </div>
              <div>
                <span>02</span>
                <b>Secure your sign-in</b>
                <small>
                  Configure Cloudflare Access and set your owner email and
                  Access secrets.
                </small>
              </div>
              <div>
                <span>03</span>
                <b>Open your cabinet</b>
                <small>
                  Upload files, keep revisions, and grant your team access.
                </small>
              </div>
            </div>
            <a
              className="button primary"
              href={DOCS + 'setup.md'}
              target="_blank"
              rel="noreferrer"
            >
              Follow the setup guide <ChevronRight size={17} />
            </a>
            <button className="button subtle" onClick={() => location.reload()}>
              Check setup
            </button>
          </>
        )}
        <p className="setup-note">
          Your storage and hosting are billed directly to your Cloudflare
          account. No files or credentials are sent to this project’s publisher.
        </p>
      </div>
    </main>
  );
}
function Login() {
  return (
    <main className="setup">
      <div className="setup-card">
        <Shield />
        <h1>Sign in to your cabinet.</h1>
        <p className="lede">
          Use an identity allowed by this installation’s Cloudflare Access
          policy.
        </p>
        <a className="button primary" href="/cdn-cgi/access/login">
          <LogIn /> Sign in
        </a>
        <p className="setup-note">
          If sign-in is unavailable, ask the installation owner to finish Access
          setup for this hostname.
        </p>
      </div>
    </main>
  );
}
function ProjectDashboard({ owner, openFolder }: { owner:boolean; openFolder:(id:string)=>void }) {
  const [archived,setArchived]=useState(false), [projects,setProjects]=useState<Project[]>([]), [selected,setSelected]=useState<ProjectDetail|null>(null), [error,setError]=useState(''), [loading,setLoading]=useState(false), [folders,setFolders]=useState<Entry[]>([]), [folderId,setFolderId]=useState(''), [newName,setNewName]=useState(''), [stage,setStage]=useState('ready_to_launch'), [pattern,setPattern]=useState(''), [checkName,setCheckName]=useState(''), [editingChecklist,setEditingChecklist]=useState<string|null>(null), [checkRequired,setCheckRequired]=useState(false), [checkStage,setCheckStage]=useState('always');
  const load=async()=>{setLoading(true); try{const r=await api<{projects:Project[]}>(`/api/projects${archived?'?archived=1':''}`);setProjects(r.projects);if(owner&&!archived){const f=await api<{entries:Entry[]}>('/api/entries?parent=root');setFolders(f.entries.filter(e=>e.kind==='folder'));}}catch(e){setError(message(e));}finally{setLoading(false);}};
  useEffect(()=>{void load();},[archived]);
  const open=async(p:Project)=>{setLoading(true);try{setSelected(await api<ProjectDetail>(`/api/projects/${p.id}`));}catch(e){setError(message(e));}finally{setLoading(false);}};
  const create=async()=>{try{const r=await api<{project:Project}>('/api/projects',{folderId,name:newName,stage});setNewName('');await load();}catch(e){setError(message(e));}};
  const replaceChecklist=async(items:ProjectDetail['checklist'])=>{
    if(!selected || loading)return;
    setLoading(true);setError('');
    try {
      await api(`/api/projects/${selected.project.id}/checklists`,{checklists:items.map(c=>({id:c.id||undefined,name:c.name,pattern:c.pattern,required:c.required,applicability:c.applicability||'always'}))},'PUT');
      setSelected(await api<ProjectDetail>(`/api/projects/${selected.project.id}`));
      setCheckName('');setPattern('');setEditingChecklist(null);
    } catch(e){setError(message(e));} finally {setLoading(false);}
  };
  const saveChecklist=async()=>{
    if(!selected||!checkName.trim()||!pattern.trim())return;
    const item={id:editingChecklist||'',name:checkName,pattern,required:checkRequired,applicability:checkStage,status:'unassessed',candidates:[]};
    await replaceChecklist(editingChecklist?selected.checklist.map(c=>c.id===editingChecklist?item:c):[...selected.checklist,item]);
  };

  const saveStage=async()=>{if(!selected)return;try{await api(`/api/projects/${selected.project.id}`,{stage},'PATCH');setSelected(await api<ProjectDetail>(`/api/projects/${selected.project.id}`));await load();}catch(e){setError(message(e));}};
  return <section className="project-dashboard" aria-label="Projects"><div className="project-toolbar"><div><p className="eyebrow">PROJECTS</p><h1>Project dashboard</h1><p className="muted">Keep current work together. Checklist matches need a content review; they do not verify signatures or completeness.</p></div><button className="button subtle" onClick={()=>{setSelected(null);setArchived(!archived);}}>{archived?'Current projects':'Closed and archived'}</button></div>{error&&<Notice text={error}/>} {!selected&&<>{owner&&!archived&&<div className="project-create"><strong>Designate an existing folder</strong><DestinationPicker value={folderId} onChange={setFolderId} disabled={loading}/><input aria-label="Project name" placeholder="Project name (optional)" value={newName} onChange={e=>setNewName(e.target.value)}/><select aria-label="Project stage" value={stage} onChange={e=>setStage(e.target.value)}>{['ready_to_launch','active','under_contract','closing','closed','archived'].map(s=><option key={s} value={s}>{s.replaceAll('_',' ')}</option>)}</select><button className="button primary" disabled={!folderId||loading} onClick={()=>void create()}>Create project</button></div>}<div className="project-grid">{loading?<p>Loading projects…</p>:projects.length?projects.filter(p=>archived||!['closed','archived'].includes(p.stage)).map(p=><button className="project-card" key={p.id} onClick={()=>{setStage(p.stage);void open(p);}}><strong>{p.name}</strong><span>{p.stage.replaceAll('_',' ')}</span><small>{p.archived?'Archived':'Current'}</small></button>):<div className="empty"><Folder size={30}/><h2>No projects yet</h2><p>{owner?'Designate a project from an existing folder to begin.':'Projects shared with you will appear here.'}</p></div>}</div></>}{selected&&<div><button className="button subtle" onClick={()=>setSelected(null)}>Back to projects</button><button className="button subtle" onClick={()=>openFolder(selected.project.folderId)}>Open project folder</button>{owner&&<div className="project-edit"><label>Stage<select value={stage} onChange={e=>setStage(e.target.value)}>{['ready_to_launch','active','under_contract','closing','closed','archived'].map(s=><option key={s} value={s}>{s.replaceAll('_',' ')}</option>)}</select></label><button className="button subtle" disabled={loading} onClick={()=>void saveStage()}>Save stage</button></div>}<div className="project-detail"><h2>{selected.project.name}</h2><p className="muted">Stage: {selected.project.stage.replaceAll('_',' ')} · {selected.filesScanned} files scanned{selected.inventoryCapped?' · inventory capped, more files may exist':''}</p>{selected.inventoryCapped&&<p className="notice">This inventory reached its safety limit. Missing evidence cannot be concluded from this scan.</p>}{owner&&<div className="project-edit"><input aria-label="Checklist name" placeholder="Checklist name" value={checkName} onChange={e=>setCheckName(e.target.value)}/><input aria-label="Filename pattern" placeholder="Filename pattern, for example *.pdf" value={pattern} onChange={e=>setPattern(e.target.value)}/><button className="button subtle" disabled={loading||!checkName.trim()||!pattern.trim()} onClick={()=>void saveChecklist()}>Save checklist</button><label>Applies at<select value={checkStage} onChange={e=>setCheckStage(e.target.value)}>{['always','ready_to_launch','active','under_contract','closing','closed','archived'].map(s=><option key={s} value={s}>{s.replaceAll('_',' ')}</option>)}</select></label><label><input type="checkbox" checked={checkRequired} onChange={e=>setCheckRequired(e.target.checked)}/> Required in your process</label><small className="muted">Patterns support * and ?. Filename matches need a content review.</small></div>}{selected.checklist.map(c=><article className="checklist-card" key={c.id}><div><strong>{c.name}</strong>{owner&&<><button className="button subtle" disabled={loading} onClick={()=>{setEditingChecklist(c.id);setCheckName(c.name);setPattern(c.pattern);setCheckRequired(c.required);setCheckStage(c.applicability||'always');}}>Edit checklist item</button><button className="button subtle" disabled={loading} onClick={()=>void replaceChecklist(selected.checklist.filter(item=>item.id!==c.id))}>Retire item</button></>}<span>{c.required?'Required · ':''}{c.pattern} · {c.applicability||'always'}</span></div><b className={`check-status ${c.status}`}>{c.status==='confirmed'?'Evidence reviewed':c.status.replaceAll('_',' ')}</b>{c.candidates.map(f=><div className="evidence-row" key={f.entryId}><a href={f.downloadUrl}>{f.name}</a><span>{f.status==='confirmed'?'Reviewed by owner':f.status.replaceAll('_',' ')}</span><small>Review applies to this file version</small>{owner&&f.status==='needs_review'&&<button className="button subtle" onClick={()=>void api(`/api/projects/${selected.project.id}/checklists/${c.id}`,{entryId:f.entryId,version:f.currentVersion,action:'confirmed'},'POST').then(()=>open(selected.project)).catch(e=>setError(message(e)))}>Mark evidence reviewed</button>}</div>)}</article>)}</div></div>}</section>;
}
function App() {
  const [state, setState] = useState<
      'loading' | 'setup' | 'login' | 'ready' | 'error'
    >('loading'),
    [me, setMe] = useState<Me | null>(null),
    [brand, setBrand] = useState(defaults),
    [error, setError] = useState('');
  const [listing, setListing] = useState<Listing>({
      entries: [],
      ancestors: [],
      usedBytes: 0,
      limitBytes: 0,
      truncated: false,
      nextOffset: null,
      canCreate: false,
    }),
    [parent, setParent] = useState('root'),
    [trash, setTrash] = useState(false),
    [query, setQuery] = useState(''),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(''),
    [navigation, setNavigation] = useState(false);
  const [projectMode,setProjectMode]=useState(false);
  const [selected, setSelected] = useState<Entry | null>(null),
    [dialog, setDialog] = useState<
      | 'folder'
      | 'entry'
      | 'rename'
      | 'move'
      | 'share'
      | 'versions'
      | 'trash'
      | 'settings'
      | 'gmail'
      | null
    >(null);
  const uploadRef = useRef<HTMLInputElement>(null),
    folderUploadRef = useRef<HTMLInputElement>(null),
    newVersionRef = useRef<HTMLInputElement>(null),
    activeRequest = useRef(0),
    loadedFilter = useRef({ parent: 'root', trash: false, query: '' });
  const init = async () => {
    setState('loading');
    try {
      const setup = await api<{ configured: boolean }>('/api/setup');
      if (!setup.configured) {
        setState('setup');
        return;
      }
      const who = await api<Me>('/api/me');
      setMe(who);
      setBrand(await api<Branding>('/api/settings'));
      setState('ready');
    } catch (e) {
      setError(message(e));
      setState((e as { status?: number }).status === 401 ? 'login' : 'error');
    }
  };
  const refresh = async (p = parent, t = trash, q = query, offset = 0) => {
    const id = ++activeRequest.current;
    setLoading(true);
    try {
      const data = await api<Listing>(
        `/api/entries?parent=${encodeURIComponent(p)}&offset=${offset}${t ? '&trash=1' : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      );
      if (activeRequest.current === id) {
        loadedFilter.current = { parent: p, trash: t, query: q };
        setListing((previous) =>
          offset
            ? {
                ...data,
                entries: [
                  ...new Map(
                    [...previous.entries, ...data.entries].map((e) => [
                      e.id,
                      e,
                    ]),
                  ).values(),
                ],
              }
            : data,
        );
      }
    } catch (e) {
      if ((e as { status?: number }).status === 401) setState('login');
      else setError(message(e));
    } finally {
      if (activeRequest.current === id) setLoading(false);
    }
  };
  useEffect(() => {
    void init();
  }, []);
  useEffect(() => {
    if (state === 'ready') void refresh(parent, trash, '');
  }, [state, parent, trash]);
  const go = (id = 'root', trashed = false) => {
    setParent(id);
    setTrash(trashed);
    setQuery('');
    setNavigation(false);
    setSelected(null);
  };
  const mutate = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(message(e));
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setDialog(null);
    setSelected(null);
  };
  const sendFile = async (file: globalThis.File, entry?: Entry) => {
    if (!me || busy) return;
    if (file.size > (me.maxMultipartBytes || me.maxUploadBytes)) {
      setError('This file exceeds the upload limit for this installation.');
      return;
    }
    await mutate(async () => {
      try {
        setProgress(`Preparing ${file.name}`);
        await uploadMedia(file, {
          parentId: entry?.parentId || parent,
          name: entry?.name || file.name,
          ...(entry ? { entryId: entry.id, baseVersion: entry.currentVersion } : {}),
        }, api, setProgress, me.email);
        close();
      } finally {
        setProgress('');
        if (uploadRef.current) uploadRef.current.value = '';
        if (newVersionRef.current) newVersionRef.current.value = '';
      }
    }).catch(() => {});
  };
  if (state === 'loading')
    return (
      <div className="loading-screen">
        <LoaderCircle className="spin" />
        Opening your cabinet
      </div>
    );
  if (state === 'setup') return <Setup />;
  if (state === 'error')
    return <Setup error={error} retry={() => void init()} />;
  if (state === 'login') return <Login />;
  const editable =
    selected && (selected.role === 'owner' || selected.role === 'editor');
  return (
    <div
      className="app"
      style={{ '--accent': brand.accentColor } as React.CSSProperties}
    >
      <header className="topbar">
        <button
          className="mobile-menu icon-button"
          onClick={() => setNavigation(!navigation)}
          aria-label="Toggle navigation"
        >
          <Menu />
        </button>
        <div className="wordmark">
          <span className="logo-mark">
            <Archive size={18} />
          </span>
          {brand.companyName}
        </div>
        <div className="top-actions">
          {me?.isOwner && (
            <button
              className="toolbar-link"
              aria-label="Branding"
              onClick={() => setDialog('settings')}
            >
              <Settings size={17} />
              <span>Branding</span>
            </button>
          )}
          <a
            className="toolbar-link"
            aria-label="Sign out"
            href="/cdn-cgi/access/logout"
          >
            <LogIn size={17} />
            <span>Sign out</span>
          </a>
        </div>
      </header>
      <div className="body">
        {me?.maintenance && <div className="maintenance-banner" role="status">Maintenance mode is active. Files and project settings are temporarily read-only.</div>}
        <aside className={`sidebar ${navigation ? 'open' : ''}`}>
          <p className="side-label">Workspace</p>
          <button
            className={`side-link ${!trash ? 'active' : ''}`}
            onClick={() => {setProjectMode(false); go();}}
          >
            <HardDrive size={17} />
            {me?.isOwner ? 'All files' : 'Shared with me'}
          </button>
          <button className={`side-link ${projectMode ? 'active' : ''}`} onClick={() => {setProjectMode(true);setNavigation(false);}}><Folder size={17}/>Projects</button>
          {me?.isOwner && (
            <>
              <button
                className={`side-link ${trash ? 'active' : ''}`}
                onClick={() => go('root', true)}
              >
                <Archive size={17} />
                Trash
              </button>
              <button className="side-link" onClick={() => setDialog('gmail')}>
                <RefreshCw size={17} />
                Gmail import
              </button>
              <a
                className="side-link"
                href="/api/export"
                download="cabinet-manifest.json"
              >
                <Download size={17} />
                Export index
              </a>
            </>
          )}
          <div className="storage">
            <div className="storage-head">
              <span>Storage</span>
              <span>
                {listing.limitBytes
                  ? Math.round((listing.usedBytes / listing.limitBytes) * 100)
                  : 0}
                %
              </span>
            </div>
            <div className="meter">
              <i
                style={{
                  width: `${Math.min(100, (listing.usedBytes / (listing.limitBytes || 1)) * 100)}%`,
                }}
              />
            </div>
            <small>
              {size(listing.usedBytes)} of {size(listing.limitBytes)}
            </small>
            <small>Includes versions and trash</small>
          </div>
          <a
            className="side-doc"
            href={DOCS + 'setup.md'}
            target="_blank"
            rel="noreferrer"
          >
            Help & setup <ChevronRight size={16} />
          </a>
        </aside>
        <main className="content">
          {!projectMode && <div className="page-head">
            <div>
              <p className="eyebrow">
                {trash ? 'RETAINED FILES' : 'PRIVATE WORKSPACE'}
              </p>
              <nav className="breadcrumbs" aria-label="Folder path">
                <button onClick={() => go()}>
                  {trash ? 'Trash' : 'Files'}
                </button>
                {listing.ancestors.map((a) => (
                  <React.Fragment key={a.id}>
                    <ChevronRight size={15} />
                    <button onClick={() => go(a.id)}>{a.name}</button>
                  </React.Fragment>
                ))}
              </nav>
            </div>
            <div className="head-actions">
              <button
                className="button subtle"
                disabled={busy || !listing.canCreate || trash}
                onClick={() => setDialog('folder')}
              >
                <FolderPlus size={17} />
                New folder
              </button>
              <button
                className="button primary"
                disabled={busy || !listing.canCreate || trash}
                onClick={() => uploadRef.current?.click()}
              >
                <Upload size={17} />
                Upload
              </button>
              <button className="button subtle" disabled={busy || !listing.canCreate || trash} onClick={() => folderUploadRef.current?.click()}>
                Upload folder
              </button>
            </div>
          </div>}
          {projectMode ? <ProjectDashboard owner={!!me?.isOwner} openFolder={(id) => { setProjectMode(false); go(id); }}/> : <>
          <form
            className="search-row"
            onSubmit={(e) => {
              e.preventDefault();
              void refresh();
            }}
          >
            <div className="search-box">
              <Search size={18} />
              <input
                aria-label="Search accessible files"
                placeholder="Search your accessible files"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <button className="button subtle" type="submit">
              Search
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={() => void refresh()}
              aria-label="Refresh files"
            >
              <RefreshCw size={18} />
            </button>
          </form>
          {error && (
            <div className="error" role="alert">
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError('')}>
                <X size={17} />
              </button>
            </div>
          )}
          {progress && (
            <p className="upload-status" role="status">
              <LoaderCircle className="spin" size={17} />
              {progress}
            </p>
          )}
          {listing.truncated && (
            <button
              className="button subtle"
              disabled={loading}
              onClick={() => {
                const f = loadedFilter.current;
                void refresh(
                  f.parent,
                  f.trash,
                  f.query,
                  listing.nextOffset || 0,
                );
              }}
            >
              Load more files
            </button>
          )}
          {brand.customCss && <style>{brand.customCss}</style>}
          <section className="brand-surface">
            <div className="file-panel">
              <div className="file-panel-head">
                <span>{listing.entries.length} items</span>
                <span>
                  {trash ? 'Trash still uses storage' : 'Cloud storage'}
                </span>
              </div>
              {loading ? (
                <div className="empty">
                  <LoaderCircle className="spin" />
                  Loading files
                </div>
              ) : listing.entries.length === 0 ? (
                <div className="empty">
                  <Folder size={32} />
                  <h2>
                    {query
                      ? 'No matches'
                      : trash
                        ? 'Trash is empty'
                        : me?.isOwner
                          ? 'Your cabinet is ready'
                          : 'No shared files yet'}
                  </h2>
                  <p>
                    {query
                      ? 'Try a different name.'
                      : trash
                        ? 'Files moved to trash appear here.'
                        : me?.isOwner
                          ? 'Create a folder or upload your first file.'
                          : 'The owner can grant you access to a file or folder.'}
                  </p>
                </div>
              ) : (
                <div className="file-list">
                  {listing.entries.map((e) => (
                    <div className="file-row" key={e.id}>
                      <div className="file-icon">
                        {e.kind === 'folder' ? (
                          <Folder size={20} />
                        ) : (
                          <FileIcon size={20} />
                        )}
                      </div>
                      <button
                        className="file-name"
                        onClick={() => {
                          if (e.kind === 'folder' && !trash) go(e.id);
                          else {
                            setSelected(e);
                            setDialog('entry');
                          }
                        }}
                      >
                        {e.name}
                      </button>
                      <span className="file-meta">
                        {e.kind === 'folder' ? 'Folder' : size(e.size)}
                      </span>
                      <span className="file-meta date">
                        {new Date(e.updatedAt).toLocaleDateString()}
                      </span>
                      <span className="role-pill">{e.role}</span>
                      <button
                        className="icon-button"
                        aria-label={`Actions for ${e.name}`}
                        onClick={() => {
                          setSelected(e);
                          setDialog('entry');
                        }}
                      >
                        <MoreHorizontal size={18} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section></>}
        </main>
      </div>
      <input
        type="file"
        hidden
        ref={uploadRef}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void sendFile(f);
        }}
      />
      <input type="file" hidden ref={folderUploadRef} {...({ webkitdirectory: 'true', directory: 'true' } as React.InputHTMLAttributes<HTMLInputElement>)} onChange={(e) => { const files=Array.from(e.target.files || []); e.target.value=''; void mutate(async()=>{ try { const result=await importFolder(files,parent,api,setProgress,me?.email || ''); setError(result.errors.length ? `${result.saved} saved. ${result.errors.length} could not be uploaded. ${result.errors.slice(0,8).join(' ')}` : ''); } finally {setProgress('');} }).catch(()=>{}); }} />
      <input
        type="file"
        hidden
        ref={newVersionRef}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && selected) void sendFile(f, selected);
        }}
      />
      {dialog === 'entry' && selected && (
        <Modal title={selected.name} close={close} busy={busy}>
          <div className="modal-body">
            <p className="muted">
              {selected.kind === 'folder' ? 'Folder' : size(selected.size)} ·{' '}
              {selected.role}
            </p>
            <div className="action-stack">
              {selected.kind === 'file' && (
                <>
                  <a
                    className="button primary"
                    href={`/api/entries/${selected.id}/download`}
                  >
                    <Download size={16} />
                    Download
                  </a>
                  <button
                    className="button subtle"
                    onClick={() => setDialog('versions')}
                  >
                    <History size={16} />
                    Version history
                  </button>
                  {editable && !selected.trashed && (
                    <button
                      className="button subtle"
                      onClick={() => newVersionRef.current?.click()}
                      disabled={busy}
                    >
                      Upload new version
                    </button>
                  )}
                </>
              )}
              {editable && !selected.trashed && (
                <button
                  className="button subtle"
                  onClick={() => setDialog('rename')}
                >
                  Rename
                </button>
              )}
              {me?.isOwner && !selected.trashed && (
                <>
                  <button
                    className="button subtle"
                    onClick={() => setDialog('move')}
                  >
                    Move to folder
                  </button>
                  <button
                    className="button subtle"
                    onClick={() => setDialog('share')}
                  >
                    Manage access
                  </button>
                </>
              )}
              {editable && (selected.kind === 'file' || me?.isOwner) && (
                <button
                  className="button subtle danger-text"
                  disabled={busy}
                  onClick={() => {
                    if (selected.trashed)
                      void mutate(async () => {
                        await api(`/api/entries/${selected.id}/restore`, {});
                        close();
                      }).catch(() => {});
                    else setDialog('trash');
                  }}
                >
                  {selected.trashed ? 'Restore item' : 'Move to trash'}
                </button>
              )}
            </div>
            <Notice text={error} />
          </div>
        </Modal>
      )}
      {dialog === 'folder' && (
        <NameDialog
          title="New folder"
          close={close}
          submit={(name) =>
            mutate(async () => {
              await api('/api/folders', { parentId: parent, name });
              close();
            })
          }
        />
      )}
      {dialog === 'rename' && selected && (
        <NameDialog
          title="Rename item"
          value={selected.name}
          close={close}
          submit={(name) =>
            mutate(async () => {
              await api(`/api/entries/${selected.id}`, { name }, 'PATCH');
              close();
            })
          }
        />
      )}
      {dialog === 'move' && selected && (
        <MoveDialog
          entry={selected}
          close={close}
          submit={(dest) =>
            mutate(async () => {
              await api(
                `/api/entries/${selected.id}`,
                { parentId: dest },
                'PATCH',
              );
              close();
            })
          }
        />
      )}
      {dialog === 'trash' && selected && (
        <Confirm
          title="Move to trash?"
          close={close}
          submit={() =>
            mutate(async () => {
              await api(`/api/entries/${selected.id}/trash`, {});
              close();
            })
          }
        >
          <p>
            {selected.name} will remain recoverable and continue to use storage.
            Folders must be empty.
          </p>
        </Confirm>
      )}
      {dialog === 'share' && selected && (
        <ShareDialog
          entry={selected}
          close={close}
          changed={() => void refresh()}
        />
      )}
      {dialog === 'versions' && selected && (
        <VersionsDialog
          entry={selected}
          close={close}
          editable={!!editable && !selected.trashed}
          changed={() => {
            close();
            void refresh();
          }}
          upload={() => newVersionRef.current?.click()}
        />
      )}
      {dialog === 'settings' && (
        <BrandDialog
          initial={brand}
          close={close}
          saved={(value) => {
            setBrand(value);
            setDialog(null);
          }}
        />
      )}
      {dialog === 'gmail' && (
        <GmailDialog
          parent={parent}
          close={close}
          changed={() => void refresh()}
        />
      )}
    </div>
  );
}
function NameDialog({
  title,
  value = '',
  close,
  submit,
}: {
  title: string;
  value?: string;
  close: () => void;
  submit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(value),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal title={title} close={close} busy={busy}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          try {
            await submit(name.trim());
          } catch (e) {
            setError(message(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Name
          <input
            autoFocus
            required
            maxLength={255}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <Notice text={error} />
        <div className="dialog-actions">
          <button
            type="button"
            className="button subtle"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Confirm({
  title,
  children,
  close,
  submit,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
  submit: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal title={title} close={close} busy={busy}>
      <div className="modal-body">
        {children}
        <Notice text={error} />
      </div>
      <div className="dialog-actions">
        <button className="button subtle" disabled={busy} onClick={close}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await submit();
            } catch (e) {
              setError(message(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Confirm
        </button>
      </div>
    </Modal>
  );
}
function MoveDialog({
  entry,
  close,
  submit,
}: {
  entry: Entry;
  close: () => void;
  submit: (id: string) => Promise<void>;
}) {
  const [folder, setFolder] = useState('root'),
    [listing, setListing] = useState<Listing | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setListing(null);
    api<Listing>(`/api/entries?parent=${encodeURIComponent(folder)}`)
      .then((data) => {
        if (active) setListing(data);
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, [folder]);
  return (
    <Modal title="Choose destination" close={close} busy={busy}>
      <div className="modal-body">
        <button className="button subtle" onClick={() => setFolder('root')}>
          Root
        </button>
        <p>
          {listing?.ancestors.map((a) => a.name).join(' / ') || 'All files'}
        </p>
        <div className="folder-picker">
          {listing?.entries
            .filter((e) => e.kind === 'folder' && e.id !== entry.id)
            .map((e) => (
              <button
                className="button subtle"
                key={e.id}
                onClick={() => setFolder(e.id)}
              >
                <Folder size={16} />
                {e.name}
                <ChevronRight size={16} />
              </button>
            ))}
        </div>
        {listing?.nextOffset !== null && listing?.nextOffset !== undefined && (
          <button
            className="button subtle"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const next = await api<Listing>(
                  `/api/entries?parent=${encodeURIComponent(folder)}&offset=${listing.nextOffset}`,
                );
                setListing((previous) => ({
                  ...next,
                  entries: [...(previous?.entries || []), ...next.entries],
                }));
              } catch (e) {
                setError(message(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Load more folders
          </button>
        )}
        <Notice text={error} />
      </div>
      <div className="dialog-actions">
        <button className="button subtle" disabled={busy} onClick={close}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={busy || !listing || folder === entry.id}
          onClick={async () => {
            setBusy(true);
            try {
              await submit(folder);
            } catch (e) {
              setError(message(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Move here
        </button>
      </div>
    </Modal>
  );
}
function ShareDialog({
  entry,
  close,
  changed,
}: {
  entry: Entry;
  close: () => void;
  changed: () => void;
}) {
  const [grants, setGrants] = useState<
      { email: string; role: 'viewer' | 'editor' }[]
    >([]),
    [email, setEmail] = useState(''),
    [role, setRole] = useState<'viewer' | 'editor'>('viewer'),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    api<{ grants: typeof grants }>(`/api/entries/${entry.id}/access`)
      .then((d) => {
        setGrants(d.grants);
        setLoaded(true);
      })
      .catch((e) => setError(message(e)));
  }, [entry.id]);
  return (
    <Modal title="Manage access" close={close} busy={busy}>
      <div className="modal-body">
        <p className="muted">
          Recipients must also be allowed by Cloudflare Access. No invitations
          are sent. A nonempty list replaces inherited permissions for this item
          and its descendants. An empty list uses the parent’s permissions.
        </p>
        {!loaded && !error && <p>Loading permissions…</p>}
        <div className="grant-list">
          {grants.map((g, i) => (
            <div key={g.email}>
              <span>{g.email}</span>
              <select
                aria-label={`Role for ${g.email}`}
                value={g.role}
                onChange={(e) =>
                  setGrants((gs) =>
                    gs.map((v, j) =>
                      j === i
                        ? { ...v, role: e.target.value as 'viewer' | 'editor' }
                        : v,
                    ),
                  )
                }
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
              <button
                className="icon-button"
                onClick={() => setGrants((gs) => gs.filter((_, j) => j !== i))}
                aria-label={`Remove ${g.email}`}
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
        <form
          className="grant-add"
          onSubmit={(e) => {
            e.preventDefault();
            const normalized = email.trim().toLowerCase();
            if (grants.some((g) => g.email === normalized)) {
              setError('This person is already listed.');
              return;
            }
            setGrants([...grants, { email: normalized, role }]);
            setEmail('');
          }}
        >
          <input
            type="email"
            aria-label="Recipient email"
            value={email}
            required
            placeholder="person@example.com"
            onChange={(e) => setEmail(e.target.value)}
          />
          <select
            aria-label="New recipient role"
            value={role}
            onChange={(e) => setRole(e.target.value as 'viewer' | 'editor')}
          >
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
          </select>
          <button className="button subtle" disabled={!loaded || busy}>
            Add
          </button>
        </form>
        <Notice text={error} />
      </div>
      <div className="dialog-actions">
        <button className="button subtle" disabled={busy} onClick={close}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={!loaded || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/api/entries/${entry.id}/access`, { grants }, 'PUT');
              changed();
              close();
            } catch (e) {
              setError(message(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Save permissions
        </button>
      </div>
    </Modal>
  );
}
function VersionsDialog({
  entry,
  close,
  editable,
  changed,
  upload,
}: {
  entry: Entry;
  close: () => void;
  editable: boolean;
  changed: () => void;
  upload: () => void;
}) {
  const [versions, setVersions] = useState<Version[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [restoring, setRestoring] = useState<Version | null>(null);
  useEffect(() => {
    api<{ versions: Version[] }>(`/api/entries/${entry.id}/versions`)
      .then((d) => setVersions(d.versions))
      .catch((e) => setError(message(e)));
  }, [entry.id]);
  return (
    <Modal title="Version history" close={close} busy={busy}>
      <div className="modal-body">
        <p className="muted">
          Restoring keeps every saved version.{' '}
          {editable
            ? 'Upload a revision to this file, or restore earlier content.'
            : 'You have read-only access.'}
        </p>
        {editable && (
          <button className="button primary" disabled={busy} onClick={upload}>
            Upload new version
          </button>
        )}
        <div className="version-list">
          {versions.map((v) => (
            <div key={v.id}>
              <div>
                <b>{new Date(v.createdAt).toLocaleString()}</b>
                <small>
                  {size(v.size)} ·{' '}
                  {v.id === entry.currentVersion
                    ? 'Current version'
                    : v.source.startsWith('gmail:')
                      ? 'Gmail import'
                      : 'Saved version'}
                </small>
              </div>
              <a
                className="button subtle"
                href={`/api/entries/${entry.id}/download?version=${v.id}`}
              >
                Download
              </a>
              {editable && v.id !== entry.currentVersion && (
                <button
                  className="button subtle"
                  disabled={busy}
                  onClick={() => setRestoring(v)}
                >
                  Restore
                </button>
              )}
            </div>
          ))}
        </div>
        {restoring && (
          <div className="confirm-inline">
            <p>
              Restore content saved{' '}
              {new Date(restoring.createdAt).toLocaleString()}?
            </p>
            <button
              className="button subtle"
              disabled={busy}
              onClick={() => setRestoring(null)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(
                    `/api/entries/${entry.id}/versions/${restoring.id}/restore`,
                    { baseVersion: entry.currentVersion },
                  );
                  changed();
                } catch (e) {
                  setError(message(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Confirm restore
            </button>
          </div>
        )}
        <Notice text={error} />
      </div>
    </Modal>
  );
}
function BrandDialog({
  initial,
  close,
  saved,
}: {
  initial: Branding;
  close: () => void;
  saved: (value: Branding) => void;
}) {
  const [value, setValue] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal title="Company branding" close={close} busy={busy}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const updated = await api<Branding>('/api/settings', value, 'PUT');
            saved(updated);
          } catch (e) {
            setError(message(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Company name
          <input
            required
            maxLength={80}
            value={value.companyName}
            onChange={(e) =>
              setValue({ ...value, companyName: e.target.value })
            }
          />
        </label>
        <label>
          Accent color
          <input
            type="color"
            value={value.accentColor}
            onChange={(e) =>
              setValue({ ...value, accentColor: e.target.value })
            }
          />
        </label>
        <label>
          Scoped CSS
          <textarea
            maxLength={8000}
            value={value.customCss}
            onChange={(e) => setValue({ ...value, customCss: e.target.value })}
            placeholder={
              '.brand-surface .file-row { border-color: #d0ddff; padding: 12px; }'
            }
          />
        </label>
        <p className="muted">
          Style colors, borders, type size, padding, and gaps inside
          .brand-surface. External resources and unscoped rules are rejected.
          Sign-in and sharing controls stay outside this area.
        </p>
        <a href={DOCS + 'company.md'} target="_blank" rel="noreferrer">
          Customization guide
        </a>
        <Notice text={error} />
        <div className="dialog-actions">
          <button
            type="button"
            className="button subtle"
            onClick={close}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            Save branding
          </button>
        </div>
      </form>
    </Modal>
  );
}
type GmailMailbox = { mailboxId:string; email:string; enabled:boolean; labels:Array<{label:string;destinationId:string;scheduled:boolean;reviewOnly:boolean;enabled:boolean;lastRunAt:number|null;lastError:string|null}> };
type GmailReview = { reviewId:string; mailboxId:string; identity:string; messageId:string; filename:string; mime:string; size:number; headers:{subject?:string;from?:string;date?:string}; destinationId:string|null; state:string; version:number; lastError:string|null };

function DestinationPicker({ value, onChange, disabled = false }: { value:string; onChange:(id:string)=>void; disabled?:boolean }) {
  const [folder, setFolder] = useState(value || 'root');
  const [listing, setListing] = useState<Listing|null>(null);
  const [error, setError] = useState('');
  useEffect(() => { let active = true; setListing(null); api<Listing>(`/api/entries?parent=${encodeURIComponent(folder)}`).then(d => { if (active) setListing(d); }).catch(e => { if (active) setError(message(e)); }); return () => { active = false; }; }, [folder]);
  return <div className="destination-picker"><div className="destination-current"><span>{listing?.ancestors.map(a=>a.name).join(' / ') || 'All files'}</span><button type="button" className="button subtle" disabled={disabled || folder==='root'} onClick={()=>setFolder(listing?.ancestors.at(-2)?.id || 'root')}>Up</button></div><button type="button" className="button subtle" disabled={disabled || !listing} onClick={()=>onChange(folder)}>Use this folder</button><div className="folder-picker">{listing?.entries.filter(e=>e.kind==='folder').map(e=><button type="button" className={`button subtle ${value===e.id?'selected-folder':''}`} key={e.id} disabled={disabled} onClick={()=>{onChange(e.id);setFolder(e.id);}}><Folder size={15}/>{e.name}<ChevronRight size={15}/></button>)}</div>{listing?.nextOffset!==null&&listing?.nextOffset!==undefined&&<button type="button" className="button subtle" disabled={disabled} onClick={()=>api<Listing>(`/api/entries?parent=${encodeURIComponent(folder)}&offset=${listing.nextOffset}`).then(next=>setListing({...next,entries:[...(listing.entries||[]),...next.entries]})).catch(e=>setError(message(e)))}>Load more folders</button>}<p className="muted small-text">Selected folder: {value===folder ? (listing?.ancestors.map(a=>a.name).join(' / ') || 'All files') : 'Previously selected folder'}</p><Notice text={error}/></div>;
}

function GmailDialog({ parent, close, changed }: { parent:string; close:()=>void; changed:()=>void }) {
  const [status,setStatus] = useState<{configured:boolean;mailboxes:GmailMailbox[];reviewCount:number}|null>(null);
  const [mailboxId,setMailboxId] = useState(''); const [label,setLabel] = useState(''); const [destinationId,setDestinationId] = useState(parent);
  const [scheduled,setScheduled] = useState(false); const [reviewOnly,setReviewOnly] = useState(true); const [enabled,setEnabled] = useState(true);
  const [busy,setBusy] = useState(false); const [error,setError] = useState(''); const [result,setResult] = useState<{imported:number;skipped:number;remaining:boolean;issues:string[];queued?:number}|null>(null);
  const [reviewState,setReviewState] = useState<'pending'|'deferred'|'filing'|'filed'|'dismissed'>('pending'); const [reviews,setReviews] = useState<GmailReview[]>([]); const [nextOffset,setNextOffset] = useState<number|null>(null);
  const selectedMailbox = status?.mailboxes.find(m=>m.mailboxId===mailboxId);
  const loadReviews = async (state=reviewState, offset=0) => { const r=await api<{reviews:GmailReview[];nextOffset:number|null}>(`/api/gmail/review?state=${state}&offset=${offset}`); setReviews(offset?[...reviews,...r.reviews]:r.reviews); setNextOffset(r.nextOffset); };
  useEffect(() => { Promise.all([api<NonNullable<typeof status>>('/api/gmail/status'),api<{reviews:GmailReview[];nextOffset:number|null}>('/api/gmail/review?state=pending')]).then(([s,r])=>{setStatus(s);setMailboxId(s.mailboxes[0]?.mailboxId||'');setReviews(r.reviews);setNextOffset(r.nextOffset);}).catch(e=>setError(message(e))); }, []);
  useEffect(() => { const scope=selectedMailbox?.labels.find(l=>l.label===label); setDestinationId(scope?.destinationId || parent); setScheduled(scope?.scheduled||false); setReviewOnly(scope?.reviewOnly ?? true); setEnabled(scope?.enabled ?? true); }, [mailboxId,label]);
  const run = async (fn:()=>Promise<void>) => { if (busy) return; setBusy(true); setError(''); try { await fn(); } catch(e) { setError(message(e)); } finally { setBusy(false); } };
  const connect = (another=false) => void run(async()=>{ const {url}=await api<{url:string}>('/api/gmail/connect', !another&&mailboxId?{mailboxId}:{}); location.assign(url); });
  const saveConfig = () => void run(async()=>{ if(!mailboxId||!label.trim()||!destinationId) throw new Error('Choose a mailbox, label, and destination folder.'); await api(`/api/gmail/mailboxes/${encodeURIComponent(mailboxId)}/config`,{label:label.trim(),destinationId,scheduled,reviewOnly,enabled},'PUT'); const fresh=await api<NonNullable<typeof status>>('/api/gmail/status'); setStatus(fresh); });
  const action = (r:GmailReview, name:'assign'|'defer'|'dismiss') => void run(async()=>{ if(name==='assign'&&!destinationId) throw new Error('Choose a destination folder before filing.'); await api(`/api/gmail/review/${encodeURIComponent(r.reviewId)}/${name}`,{version:r.version,...(name==='assign'?{destinationId}:{})}); await loadReviews(reviewState); changed(); });
  return <Modal title="Import from Gmail" close={close} busy={busy}><div className="modal-body"><p className="muted">Read-only Gmail import. Configure labels, choose a destination folder, then scan manually or review queued attachments before filing.</p><div className="gmail-actions"><a href={DOCS+'gmail.md'} target="_blank" rel="noreferrer">Gmail setup guide</a>{status?.configured&&<button type="button" className="button subtle" disabled={busy} onClick={()=>connect(true)}>Connect another mailbox</button>}</div>{!status&&!error&&<p>Checking connection…</p>}{status&&!status.configured&&<Notice text="Gmail is not configured yet. Add the OAuth client and encryption key using the setup guide."/>}{status?.mailboxes.map(m=><div className={`mailbox-card ${m.mailboxId===mailboxId?'selected':''}`} key={m.mailboxId}><label className="mailbox-choice"><input type="radio" checked={mailboxId===m.mailboxId} onChange={()=>{setMailboxId(m.mailboxId);setLabel('');}}/> <span><b>{m.email}</b><small>{m.labels.length} configured label{m.labels.length===1?'':'s'}</small></span></label>{m.mailboxId===mailboxId&&<button type="button" className="button subtle danger-text" disabled={busy} onClick={()=>void run(async()=>{await api(`/api/gmail/mailboxes/${encodeURIComponent(m.mailboxId)}`,{},'DELETE');setStatus({...status,mailboxes:status.mailboxes.filter(x=>x.mailboxId!==m.mailboxId)});setMailboxId('');setLabel('');})}>Disconnect</button>}</div>)}{status?.mailboxes.length===0&&status.configured&&<p className="empty-inline">No mailbox connected. Connect another mailbox to begin.</p>}{selectedMailbox&&<div className="gmail-config"><button type="button" className="button subtle" disabled={busy} onClick={()=>connect(false)}>Reconnect selected mailbox</button><label>Gmail label<input value={label} placeholder="Label, for example Cabinet" onChange={e=>setLabel(e.target.value)} disabled={busy}/></label><label>Destination folder<DestinationPicker value={destinationId} onChange={setDestinationId} disabled={busy}/></label><div className="toggle-row"><label><input type="checkbox" checked={reviewOnly} onChange={e=>setReviewOnly(e.target.checked)} disabled={busy}/> Review before filing</label><label><input type="checkbox" checked={scheduled} onChange={e=>setScheduled(e.target.checked)} disabled={busy}/> Scheduled scan</label><label><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)} disabled={busy}/> Enabled</label></div><p className="muted small-text">Scheduled scans require the Cloudflare cron setup described in the Gmail setup guide.</p><button type="button" className="button subtle" disabled={busy||!label.trim()||!destinationId} onClick={saveConfig}>Save label rule</button>{selectedMailbox.labels.map(l=><div className="label-status" key={l.label}><span><b>{l.label}</b><small>{l.lastRunAt?`Last run ${new Date(l.lastRunAt).toLocaleString()}`:'Never scanned'}{l.lastError?` · ${l.lastError}`:''}</small></span><span>{l.reviewOnly?'Review first':'Automatic filing'}{l.scheduled?' · scheduled':''}</span></div>)}<button type="button" className="button primary" disabled={busy||!label.trim()||!destinationId} onClick={()=>void run(async()=>{setResult(await api('/api/gmail/import',{mailboxId,label:label.trim(),parentId:destinationId}));await loadReviews(reviewState); changed();})}>{busy?'Scanning…':result?.remaining?'Continue scan':'Scan label now'}</button></div>}{result&&<div className="import-result" role="status"><b>{result.imported} imported, {result.skipped} already handled{result.queued?`, ${result.queued} queued for review`:''}.</b>{result.remaining&&<p>More attachments remain. Scan again to continue.</p>}{result.issues.length>0&&<ul>{result.issues.map((i,n)=><li key={n}>{i}</li>)}</ul>}</div>}<div className="review-panel"><div className="review-head"><strong>Review queue</strong><div className="review-tabs">{(['pending','deferred','filing','filed','dismissed'] as const).map(s=><button type="button" className={reviewState===s?'active':''} key={s} disabled={busy} onClick={()=>{setReviewState(s);void run(()=>loadReviews(s));}}>{s}</button>)}</div></div>{reviews.length===0?<p className="muted">No {reviewState} items.</p>:reviews.map(r=><article className="review-card" key={r.reviewId}><div><b>{r.filename}</b><small>{r.headers.subject||'No subject'} · {r.headers.from||'Unknown sender'} · {r.headers.date||'Unknown date'}</small><small>{status?.mailboxes.find(m=>m.mailboxId===r.mailboxId)?.email||'Disconnected mailbox'} · {size(r.size)} · {r.state}{r.lastError?` · ${r.lastError}`:''}</small><a href={`https://mail.google.com/mail/?authuser=${encodeURIComponent(status?.mailboxes.find(m=>m.mailboxId===r.mailboxId)?.email||'') }#all/${encodeURIComponent(r.messageId)}`} target="_blank" rel="noreferrer">Open original in Gmail</a></div><div className="review-buttons">{(r.state==='pending'||r.state==='deferred'||r.state==='filing')&&<><button type="button" className="button primary" disabled={busy||!destinationId} onClick={()=>action(r,'assign')}>File here</button><button type="button" className="button subtle" disabled={busy} onClick={()=>action(r,'defer')}>Defer</button><button type="button" className="button subtle" disabled={busy} onClick={()=>action(r,'dismiss')}>Dismiss</button></>}</div></article>)}{nextOffset!==null&&<button type="button" className="button subtle" disabled={busy} onClick={()=>void loadReviews(reviewState,nextOffset)}>Load more</button>}</div><Notice text={error}/></div><div className="dialog-actions"><button type="button" className="button subtle" disabled={busy} onClick={close}>Done</button></div></Modal>;
}
createRoot(document.getElementById('root')!).render(<App />);
