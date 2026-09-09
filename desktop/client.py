"""Authenticated media reads and resumable uploads. No bucket credentials."""
from __future__ import annotations
import hashlib
import json
import os
import re
import stat
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from pathlib import Path

BLOCK_SIZE = 4 * 1024 * 1024
MAX_CACHE_BYTES = 512 * 1024 * 1024
PART_SIZE = 16 * 1024 * 1024
MAX_FILE = 100 * 1024 ** 3

class CabinetError(RuntimeError):
    pass


def private_read(path, limit):
    """Reject symlinks, nonregular files and files accessible to other users."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise CabinetError('file must be regular, owned by this user and owner-only')
            if info.st_size > limit:
                raise CabinetError('local file exceeds its size limit')
            data = source.read(limit + 1)
            if len(data) > limit:
                raise CabinetError('local file exceeds its size limit')
            return data
    except OSError:
        raise CabinetError('cannot safely open private file') from None


def atomic_private(path, data):
    path = Path(path)
    if path.is_symlink():
        raise CabinetError('private destination may not be a symlink')
    fd, temporary = tempfile.mkstemp(prefix='.pending-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as target:
            os.fchmod(target.fileno(), 0o600)
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class CloudCabinetClient:
    def __init__(self, base_url, token_path, cache_dir, *, opener=None,
                 allow_http_localhost=False, max_cache_bytes=MAX_CACHE_BYTES):
        parsed = urllib.parse.urlparse(base_url)
        if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
            raise ValueError('provide a bare Cloud Cabinet HTTPS origin')
        if parsed.scheme != 'https' and not (allow_http_localhost and parsed.scheme == 'http' and parsed.hostname in {'127.0.0.1', 'localhost', '::1'}):
            raise ValueError('Cloud Cabinet URL must use HTTPS')
        if not isinstance(max_cache_bytes, int) or max_cache_bytes < 0:
            raise ValueError('invalid cache limit')
        self.base_url = base_url.rstrip('/')
        self.token_path = Path(token_path)
        self.cache_dir = Path(cache_dir)
        if self.cache_dir.is_symlink():
            raise CabinetError('cache directory may not be a symlink')
        self.cache_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = self.cache_dir.stat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise CabinetError('cache must be a directory owned by this user')
        os.chmod(self.cache_dir, 0o700)
        self.opener = opener or urllib.request.build_opener(_NoRedirect())
        self.max_cache_bytes = max_cache_bytes
        self._lock = threading.RLock()
        self._lru = OrderedDict()
        self._cache_total = 0
        # A dedicated cache directory is required. Only regular private files
        # are adopted. mtime persists approximate LRU order across restarts.
        entries = []
        for path in self.cache_dir.iterdir():
            info = path.lstat()
            if stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077:
                entries.append((info.st_mtime_ns, path, info.st_size))
        for _, path, size in sorted(entries):
            self._lru[path] = size
            self._cache_total += size
        self._evict()

    def _token(self):
        token = private_read(self.token_path, 16384).decode('ascii').strip()
        if not token or any(c.isspace() for c in token) or any(c in token for c in '\r\n;'):
            raise CabinetError('invalid token file')
        return token

    def _request(self, method, path, headers=None, body=None, token=None):
        token = token or self._token()
        if not path.startswith('/api/'):
            raise CabinetError('invalid API path')
        url = self.base_url + path
        h = {'Accept': 'application/json', 'Cookie': 'CF_Authorization=' + token,
             'Cf-Access-Jwt-Assertion': token}
        if method not in ('GET', 'HEAD'):
            h['Origin'] = self.base_url
        h.update(headers or {})
        try:
            response = self.opener.open(urllib.request.Request(url, headers=h, method=method, data=body), timeout=180)
        except urllib.error.HTTPError as exc:
            exc.close()
            raise CabinetError(f'remote {exc.code}') from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise CabinetError('remote connection failed') from None
        if response.geturl() != url or response.status not in (200, 201, 204, 206):
            response.close()
            raise CabinetError('redirect or unexpected response rejected')
        return response

    @staticmethod
    def _safe_json(response):
        try:
            data = response.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024:
                raise CabinetError('metadata response too large')
            return json.loads(data)
        finally:
            response.close()

    def api(self, method, path, data=None):
        body = None if data is None else json.dumps(data).encode()
        return self._safe_json(self._request(method, path, {'Content-Type': 'application/json'}, body))

    def entries(self, parent='root'):
        offset, result = 0, []
        while True:
            data = self.api('GET', '/api/entries?parent=' + urllib.parse.quote(parent, safe='') + '&offset=' + str(offset))
            result.extend(data.get('entries', []))
            nxt = data.get('nextOffset')
            if nxt is None:
                return result
            if not isinstance(nxt, int) or nxt <= offset or nxt > 10_000_000:
                raise CabinetError('invalid listing pagination')
            offset = nxt

    def authorize(self, entry_id, version=None, token=None):
        query = '?version=' + urllib.parse.quote(version, safe='') if version else ''
        response = self._request('HEAD', '/api/entries/' + urllib.parse.quote(entry_id, safe='') + '/download' + query, {'Accept': '*/*'}, token=token)
        try:
            size = int(response.headers.get('Content-Length', '-1'))
            if response.status != 200 or size < 0:
                raise CabinetError('authorized response lacks size')
            return size, response.headers.get('Content-Type', 'application/octet-stream')
        finally:
            response.close()

    def read_range(self, entry_id, start, length, version=None):
        if not version:
            raise CabinetError('immutable version is required for cached reads')
        if start < 0 or length < 0 or length > 16 * BLOCK_SIZE:
            raise ValueError('invalid or excessive range')
        if length == 0:
            return b''
        with self._lock:
            token = self._token()
            size, _ = self.authorize(entry_id, version, token)
            end, pos, chunks = min(size, start + length), start, []
            while pos < end:
                count = min(end - pos, BLOCK_SIZE - pos % BLOCK_SIZE)
                chunks.append(self._read_block(entry_id, pos, count, version, size, token))
                pos += count
            return b''.join(chunks)

    def _read_block(self, entry_id, start, length, version, size, token):
        begin = start // BLOCK_SIZE * BLOCK_SIZE
        last = min(size - 1, begin + BLOCK_SIZE - 1)
        expected = last - begin + 1
        namespace = hashlib.sha256(token.encode()).hexdigest()
        key = hashlib.sha256(json.dumps([self.base_url, namespace, entry_id, version, begin]).encode()).hexdigest()
        path = self.cache_dir / key
        data = None
        if path.exists() or path.is_symlink():
            if path.is_symlink():
                raise CabinetError('cache block may not be a symlink')
            try:
                data = private_read(path, BLOCK_SIZE)
            except CabinetError:
                path.unlink()
            if data is not None and len(data) != expected:
                data = None
                path.unlink()
        if data is None:
            query = '?version=' + urllib.parse.quote(version, safe='')
            response = self._request('GET', '/api/entries/' + urllib.parse.quote(entry_id, safe='') + '/download' + query,
                                     {'Range': f'bytes={begin}-{last}', 'Accept': '*/*'}, token=token)
            try:
                if response.status != 206:
                    raise CabinetError('server ignored range request')
                if response.headers.get('Content-Range') != f'bytes {begin}-{last}/{size}':
                    raise CabinetError('invalid Content-Range')
                data = response.read(expected + 1)
                if len(data) != expected or response.headers.get('Content-Length') != str(expected):
                    raise CabinetError('invalid ranged response length')
            finally:
                response.close()
            if expected <= self.max_cache_bytes:
                atomic_private(path, data)
        if path.exists():
            self._touch(path, len(data))
        return data[start - begin:start - begin + length]

    def _evict(self):
        while self._cache_total > self.max_cache_bytes and self._lru:
            path, size = self._lru.popitem(last=False)
            path.unlink(missing_ok=True)
            self._cache_total -= size

    def _touch(self, path, size):
        self._cache_total -= self._lru.pop(path, 0)
        self._lru[path] = size
        self._cache_total += size
        os.utime(path, follow_symlinks=False)
        self._evict()

    def upload_multipart(self, source, parent='root', mime='application/octet-stream', state_path=None,
                         entry_id=None, base_version=None):
        path = Path(source).absolute()
        if path.is_symlink():
            raise CabinetError('source may not be a symlink')
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as file:
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE:
                raise CabinetError('source must be a regular file of at most 100 GiB')
            identity = self.api('GET', '/api/me')['email']
            metadata = {'parentId': parent, 'name': path.name, 'size': info.st_size, 'mime': mime}
            if entry_id:
                metadata.update(entryId=entry_id, baseVersion=base_version)
            binding = {'origin': self.base_url, 'identity': identity, 'path': str(path), 'metadata': metadata,
                       'mtimeNs': info.st_mtime_ns, 'inode': info.st_ino}
            if info.st_size <= 20 * 1024 * 1024:
                chunk = file.read(20 * 1024 * 1024 + 1)
                if len(chunk) != info.st_size or os.fstat(file.fileno()).st_mtime_ns != info.st_mtime_ns:
                    raise CabinetError('source changed during upload')
                prepared = self.api('POST', '/api/uploads', metadata)
                return self._safe_json(self._request('PUT', prepared['url'], {'Content-Type': mime}, chunk))
            state_dir = self.cache_dir / '.uploads'
            if state_dir.is_symlink():
                raise CabinetError('upload state directory may not be a symlink')
            state_dir.mkdir(mode=0o700, exist_ok=True)
            os.chmod(state_dir, 0o700)
            state = Path(state_path) if state_path else state_dir / (hashlib.sha256(json.dumps(binding, sort_keys=True).encode()).hexdigest() + '.json')
            if state.exists() or state.is_symlink():
                saved = json.loads(private_read(state, 4 * 1024 * 1024))
                if saved['binding'] != binding:
                    raise CabinetError('upload state belongs to a different source or destination')
                upload_id = saved['uploadId']
                status = self.api('GET', '/api/multipart/' + urllib.parse.quote(upload_id, safe=''))
                if status.get('completed'):
                    state.unlink()
                    return status
            else:
                status = self.api('POST', '/api/multipart', metadata)
                upload_id = status['uploadId']
                atomic_private(state, json.dumps({'binding': binding, 'uploadId': upload_id}).encode())
            if status.get('partSize') != PART_SIZE:
                raise CabinetError('unsupported server part size')
            retained = {part['partNumber']: part for part in status.get('parts', [])}
            for number in range(1, (info.st_size + PART_SIZE - 1) // PART_SIZE + 1):
                expected = min(PART_SIZE, info.st_size - (number - 1) * PART_SIZE)
                chunk = file.read(expected)
                if len(chunk) != expected:
                    raise CabinetError('source changed during upload')
                digest = hashlib.sha256(chunk).hexdigest()
                previous = retained.get(number)
                if previous:
                    if previous['sha256'] != digest or previous['size'] != len(chunk):
                        raise CabinetError('source differs from retained upload; cancel it before restarting')
                else:
                    self._safe_json(self._request('PUT', '/api/multipart/' + urllib.parse.quote(upload_id, safe='') + '/parts/' + str(number),
                                                 {'Content-Type': 'application/octet-stream', 'X-Content-SHA256': digest}, chunk))
                if os.fstat(file.fileno()).st_mtime_ns != info.st_mtime_ns:
                    raise CabinetError('source changed during upload')
            result = self.api('POST', '/api/multipart/' + urllib.parse.quote(upload_id, safe='') + '/complete', {})
            state.unlink()
            return result
