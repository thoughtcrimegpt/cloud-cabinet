export type Api = <T>(url: string, body?: unknown, method?: string) => Promise<T>;
type Target = { parentId: string | null; name: string; entryId?: string; baseVersion?: string | null };
type Session = {
  uploadId: string;
  partSize: number;
  parts?: { partNumber: number; sha256: string; size: number }[];
  completed?: boolean;
};
const SMALL = 20 * 1024 * 1024;
const MAX = 100 * 1024 ** 3;
function remember(key: string, value?: string) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* Uploads also work with browser storage disabled. */ }
  return null;
}
async function put(url: string, bytes: Blob) {
  const response = await fetch(url, {
    method: 'PUT', body: bytes, signal: AbortSignal.timeout(180000),
    redirect: 'error',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(error.error || 'Upload failed. Select the same file to resume.');
  }
}
/** Reselecting a file resumes a pending upload. Every retained part is hashed
 * against the selected bytes before it is skipped, never trusted by filename. */
export async function uploadMedia(
  file: File, target: Target, api: Api, progress: (text: string) => void,
  identity: string,
) {
  if (file.size > MAX) throw new Error('The media beta accepts files up to 100 GiB.');
  const metadata = { ...target, size: file.size, mime: file.type || 'application/octet-stream' };
  if (file.size <= SMALL) {
    const prepared = await api<{ url: string }>('/api/uploads', metadata);
    progress(`Uploading ${file.name}`);
    await put(prepared.url, file);
    return;
  }
  const key = 'cabinet-upload:' + JSON.stringify([identity, target, file.size, file.lastModified]);
  let session: Session | undefined;
  const pending = remember(key);
  if (pending) {
    try {
      session = await api<Session>(`/api/multipart/${encodeURIComponent(pending)}`);
      if (session.completed) { remember(key, ''); return; }
    } catch (error) {
      if (![404, 410].includes((error as { status?: number }).status || 0)) throw error;
      remember(key, '');
    }
  }
  if (!session) {
    session = await api<Session>('/api/multipart', metadata);
    remember(key, session.uploadId);
  }
  if (!Number.isSafeInteger(session.partSize) || session.partSize !== 16 * 1024 * 1024)
    throw new Error('Unsupported upload part size.');
  const existing = new Map((session.parts || []).map(part => [part.partNumber, part]));
  const count = Math.ceil(file.size / session.partSize);
  for (let partNumber = 1; partNumber <= count; partNumber++) {
    const start = (partNumber - 1) * session.partSize;
    const blob = file.slice(start, Math.min(file.size, start + session.partSize));
    progress(`${file.name}: part ${partNumber}/${count} (${Math.floor(100 * start / file.size)}%)`);
    const retained = existing.get(partNumber);
    if (retained) {
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      if (retained.size !== blob.size || retained.sha256 !== sha256) {
        // Do not splice different source files into the same cloud object.
        await api(`/api/multipart/${encodeURIComponent(session.uploadId)}`, undefined, 'DELETE');
        remember(key, '');
        throw new Error('This file differs from the interrupted upload. The old upload was cancelled. Select the file again to start fresh.');
      }
      continue;
    }
    await put(`/api/multipart/${encodeURIComponent(session.uploadId)}/parts/${partNumber}`, blob);
  }
  progress(`Finalizing ${file.name}`);
  await api(`/api/multipart/${encodeURIComponent(session.uploadId)}/complete`, {});
  remember(key, '');
}
