"""Optional read-only FUSE adapter. Importing does not mount or install anything."""
from __future__ import annotations
import errno
import os
import stat
import threading
from datetime import datetime
from .client import CabinetError

class CabinetFS:
    def __init__(self, client):
        self.client = client
        self._lock = threading.RLock()
        self._meta = {'/': {'kind': 'folder', 'id': 'root'}}
        self._handles = {}
        self._next = 1

    def __call__(self, operation, *args):
        fn = getattr(self, operation, None)
        if fn is None:
            raise OSError(errno.ENOSYS, operation)
        try:
            return fn(*args)
        except CabinetError:
            raise OSError(errno.EACCES, 'Cloud Cabinet access or connection failed') from None

    def init(self, path):
        return None

    def destroy(self, path):
        return None

    def _refresh(self, parent_id, prefix):
        prefix = prefix.rstrip('/') or '/'
        entries = self.client.entries(parent_id)
        previous = {p for p in self._meta if p != '/' and os.path.dirname(p) == prefix}
        for entry in entries:
            name = entry['name']
            if name in ('', '.', '..') or '/' in name or '\x00' in name:
                raise CabinetError('invalid remote filename')
            path = prefix.rstrip('/') + '/' + name
            self._meta[path] = entry
            previous.discard(path)
        for removed in previous:
            for path in list(self._meta):
                if path == removed or path.startswith(removed + '/'):
                    self._meta.pop(path)

    def _entry(self, path, refresh=False):
        if path == '/':
            return self._meta['/']
        if not path.startswith('/') or '..' in path.split('/'):
            raise OSError(errno.ENOENT, path)
        with self._lock:
            parent = os.path.dirname(path) or '/'
            parent_entry = self._entry(parent)
            if parent_entry['kind'] != 'folder':
                raise OSError(errno.ENOTDIR, parent)
            if refresh or path not in self._meta:
                self._refresh(parent_entry['id'], parent)
            if path not in self._meta:
                raise OSError(errno.ENOENT, path)
            return self._meta[path]

    def getattr(self, path, fh=None):
        if fh is not None and fh in self._handles:
            entry = self._handles[fh]
        else:
            entry = self._entry(path, refresh=True)
        is_dir = entry['kind'] == 'folder'
        stamp = entry.get('updatedAt')
        modified = datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp() if stamp else 0
        return {'st_mode': (stat.S_IFDIR | 0o555) if is_dir else (stat.S_IFREG | 0o444),
                'st_nlink': 2 if is_dir else 1, 'st_size': int(entry.get('size', 0)),
                'st_uid': os.getuid(), 'st_gid': os.getgid(),
                'st_ctime': modified, 'st_mtime': modified, 'st_atime': modified}

    def readdir(self, path, fh):
        with self._lock:
            entry = self._entry(path, refresh=True)
            if entry['kind'] != 'folder':
                raise OSError(errno.ENOTDIR, path)
            self._refresh(entry['id'], path)
            return ['.', '..'] + [os.path.basename(p) for p in self._meta if p != '/' and os.path.dirname(p) == path]

    def open(self, path, flags):
        if flags & (os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC):
            raise OSError(errno.EROFS, path)
        entry = self._entry(path, refresh=True)
        if entry['kind'] != 'file':
            raise OSError(errno.EISDIR, path)
        if not entry.get('currentVersion'):
            raise OSError(errno.ENOENT, path)
        with self._lock:
            handle = self._next
            self._next += 1
            self._handles[handle] = dict(entry)
            return handle

    def release(self, path, fh):
        self._handles.pop(fh, None)
        return 0

    def read(self, path, size, offset, fh):
        entry = self._handles.get(fh)
        if entry is None:
            raise OSError(errno.EBADF, path)
        if offset >= entry['size'] or size == 0:
            return b''
        return self.client.read_range(entry['id'], offset, min(size, entry['size'] - offset), entry['currentVersion'])

    def access(self, path, mode):
        self._entry(path, refresh=True)
        if mode & os.W_OK:
            raise OSError(errno.EROFS, path)
        return 0

    def flush(self, path, fh):
        return 0

    def _readonly(self, *args):
        raise OSError(errno.EROFS, 'read-only mount')

    write = create = mkdir = unlink = rmdir = rename = truncate = chmod = chown = utimens = symlink = link = _readonly


def mount(client, mountpoint, foreground=True):
    try:
        from fuse import FUSE
    except (ImportError, OSError, RuntimeError) as exc:
        raise CabinetError('install optional fusepy and a compatible FUSE runtime before mounting') from exc
    # Serialize callbacks for this pilot and disable kernel data caching so it
    # cannot serve content without the client's online permission check.
    FUSE(CabinetFS(client), mountpoint, foreground=foreground, ro=True,
         direct_io=True, nothreads=True, attr_timeout=0, entry_timeout=0, negative_timeout=0)
