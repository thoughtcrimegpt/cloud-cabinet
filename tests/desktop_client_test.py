import os, tempfile, unittest
from pathlib import Path
from desktop.client import CloudCabinetClient, CabinetError, BLOCK_SIZE

class Resp:
    def __init__(self, status, body=b"", headers=None, url="https://cabinet.test"):
        self.status=status; self._body=body; self.headers=headers or {}; self._url=url
    def read(self, n=-1): return self._body[:n]
    def close(self): pass
    def geturl(self): return self._url

class Opener:
    def __init__(self, content): self.content=content; self.calls=[]
    def open(self, req, timeout=0):
        self.calls.append((req.method, req.full_url, dict(req.header_items())))
        if req.method == "HEAD": return Resp(200, headers={"Content-Length":str(len(self.content)),"Content-Type":"video/mp4"}, url=req.full_url)
        raw=req.get_header("Range"); a,b=map(int,raw.removeprefix("bytes=").split("-")); body=self.content[a:b+1]
        return Resp(206, body, {"Content-Range":f"bytes {a}-{b}/{len(self.content)}","Content-Length":str(len(body))}, req.full_url)

class DesktopClientTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.token=Path(self.tmp.name)/"token"; self.token.write_text("jwt") ; os.chmod(self.token,0o600)
        self.content=bytes((i % 251 for i in range(BLOCK_SIZE+100)))
    def tearDown(self): self.tmp.cleanup()
    def client(self, opener): return CloudCabinetClient("https://cabinet.test", self.token, Path(self.tmp.name)/"cache", opener=opener)
    def test_seek_fetches_one_block_and_cache_reauthenticates(self):
        o=Opener(self.content); c=self.client(o)
        self.assertEqual(c.read_range("e", BLOCK_SIZE+10, 12, "v"), self.content[BLOCK_SIZE+10:BLOCK_SIZE+22])
        self.assertEqual([x[0] for x in o.calls], ["HEAD","GET"])
        self.assertEqual(c.read_range("e", BLOCK_SIZE+10, 12, "v"), self.content[BLOCK_SIZE+10:BLOCK_SIZE+22])
        self.assertEqual([x[0] for x in o.calls], ["HEAD","GET","HEAD"])
        self.assertEqual(o.calls[1][2]["Range"], f"bytes={BLOCK_SIZE}-{len(self.content)-1}")
    def test_server_ignoring_range_is_rejected(self):
        class Bad(Opener):
            def open(self, req, timeout=0):
                if req.method == "GET": return Resp(200, self.content, {"Content-Length":str(len(self.content))}, req.full_url)
                return super().open(req, timeout)
        with self.assertRaises(CabinetError): self.client(Bad(self.content)).read_range("e", 0, 3, "v")
    def test_cross_block_read_fetches_only_two_blocks(self):
        o=Opener(self.content); c=self.client(o)
        got=c.read_range("e", BLOCK_SIZE-3, 10, "v")
        self.assertEqual(got, self.content[BLOCK_SIZE-3:BLOCK_SIZE+7])
        self.assertEqual(sum(x[0]=="GET" for x in o.calls), 2)
    def test_token_permissions_required(self):
        os.chmod(self.token,0o644)
        with self.assertRaises(CabinetError): self.client(Opener(self.content)).read_range("e",0,1,"v")

    def test_revoked_head_blocks_previously_cached_bytes(self):
        o=Opener(self.content); c=self.client(o)
        c.read_range("e", 0, 3, "v")
        class Revoked(Opener):
            def open(self, req, timeout=0):
                if req.method == "HEAD": raise urllib.error.HTTPError(req.full_url, 401, "revoked", {}, None)
                return super().open(req, timeout)
        import urllib.error
        c.opener=Revoked(self.content)
        with self.assertRaises(CabinetError): c.read_range("e", 0, 3, "v")

    def test_token_namespace_prevents_cross_user_cache_reuse(self):
        o=Opener(self.content); c=self.client(o); c.read_range("e",0,3,"v")
        self.token.write_text("different-user-jwt"); os.chmod(self.token,0o600)
        c.read_range("e",0,3,"v")
        self.assertEqual(sum(x[0]=="GET" for x in o.calls),2)

    def test_token_symlink_is_rejected(self):
        target=Path(self.tmp.name)/"target"; target.write_text("jwt"); os.chmod(target,0o600)
        self.token.unlink(); self.token.symlink_to(target)
        with self.assertRaises(CabinetError): self.client(Opener(self.content)).read_range("e",0,1,"v")

    def test_redirect_is_rejected(self):
        class Redirect(Opener):
            def open(self, req, timeout=0): return Resp(200,b"",{"Content-Length":"1"},"https://attacker.test/x")
        with self.assertRaises(CabinetError): self.client(Redirect(self.content)).read_range("e",0,1,"v")

    def test_content_range_total_must_match_head(self):
        class BadTotal(Opener):
            def open(self, req, timeout=0):
                if req.method=="HEAD": return Resp(200,b"",{"Content-Length":"10"},req.full_url)
                return Resp(206,b"x",{"Content-Range":"bytes 0-0/11","Content-Length":"1"},req.full_url)
        with self.assertRaises(CabinetError): self.client(BadTotal(self.content)).read_range("e",0,1,"v")

    def test_cache_restart_evicts_oldest_files(self):
        cache=Path(self.tmp.name)/"cache"; cache.mkdir(mode=0o700)
        for n in ("a","b"):
            p=cache/n; p.write_bytes(b"12"); os.chmod(p,0o600)
        c=CloudCabinetClient("https://cabinet.test",self.token,cache,opener=Opener(self.content),max_cache_bytes=2)
        self.assertLessEqual(sum(p.stat().st_size for p in cache.iterdir()),2)

    def test_fuse_nested_lookup_pins_version_and_dispatches(self):
        from desktop.fuse_mount import CabinetFS
        class C:
            def entries(self, parent):
                if parent=="root": return [{"id":"d","name":"dir","kind":"folder"}]
                return [{"id":"f","name":"clip.mp4","kind":"file","size":4,"currentVersion":"v1"}]
            def read_range(self, *args): self.args=args; return b"data"
        c=C(); fs=CabinetFS(c); fh=fs.open("/dir/clip.mp4",os.O_RDONLY)
        self.assertEqual(fs.read("/dir/clip.mp4",4,0,fh),b"data")
        self.assertEqual(c.args[3],"v1")
        self.assertEqual(fs("getattr","/dir/clip.mp4")["st_size"],4)
        with self.assertRaises(OSError): fs("chmod","/dir/clip.mp4",0)

if __name__ == "__main__": unittest.main()
