"""A stand-in for the bits of the Google Drive API v3 Petrel uses, to try drive.rs without a Google account.

    python3 src-tauri/tests/fake_drive.py 8765 &
    PETREL_DRIVE_URL=http://127.0.0.1:8765 cargo test -p petrel drive_against_fake -- --ignored

Files live in memory. Only what drive.rs sends is understood.
"""
import hashlib, json, re, sys, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FOLDER = "application/vnd.google-apps.folder"
files = {}  # id -> dict(name, parents, mimeType, data, trashed)
changes = []  # file ids, in order
seq = [0]


def new_id():
    seq[0] += 1
    return f"id{seq[0]}"


def meta(i):
    f = files[i]
    out = {"id": i, "name": f["name"], "parents": f["parents"], "mimeType": f["mimeType"]}
    if f["mimeType"] != FOLDER:
        out["md5Checksum"] = hashlib.md5(f["data"]).hexdigest()
    return out


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        if self.headers.get("Authorization") != "Bearer t":
            return self.send(401, {"error": {"message": "no"}})
        if u.path == "/drive/v3/changes/startPageToken":
            return self.send(200, {"startPageToken": str(len(changes))})
        if u.path == "/drive/v3/changes":
            start = int(q["pageToken"])
            return self.send(200, {"changes": [{"fileId": i} for i in changes[start:]], "newStartPageToken": str(len(changes))})
        if u.path == "/drive/v3/about":
            return self.send(200, {"user": {"emailAddress": "you@example.com"}})
        if u.path == "/drive/v3/files":
            qs = q.get("q", "")
            live = [i for i, f in files.items() if not f["trashed"]]
            m = re.search(r"name = '([^']+)'", qs)
            if m:
                live = [i for i in live if files[i]["name"] == m.group(1) and "root" in files[i]["parents"]]
            return self.send(200, {"files": [meta(i) for i in live]})
        m = re.match(r"/drive/v3/files/([^/]+)$", u.path)
        if m and q.get("alt") == "media":
            f = files.get(m.group(1))
            return self.send(200, f["data"]) if f else self.send(404, {"error": {"message": "not found"}})
        self.send(404, {"error": {"message": self.path}})

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        raw = self.body()
        if u.path == "/drive/v3/files":
            m = json.loads(raw)
            i = new_id()
            files[i] = {"name": m["name"], "parents": m["parents"], "mimeType": m.get("mimeType", ""), "data": b"", "trashed": False}
            changes.append(i)
            return self.send(200, {"id": i})
        if u.path == "/upload/drive/v3/files":
            boundary = re.search(r"boundary=(\S+)", self.headers["Content-Type"]).group(1).encode()
            parts = raw.split(b"--" + boundary)
            m = json.loads(parts[1].split(b"\r\n\r\n", 1)[1].strip())
            data = parts[2].split(b"\r\n\r\n", 1)[1][:-2]
            i = new_id()
            files[i] = {"name": m["name"], "parents": m["parents"], "mimeType": "text/markdown", "data": data, "trashed": False}
            changes.append(i)
            return self.send(200, {"id": i, "md5Checksum": hashlib.md5(data).hexdigest()})
        self.send(404, {"error": {"message": self.path}})

    def do_PATCH(self):
        u = urllib.parse.urlparse(self.path)
        raw = self.body()
        m = re.match(r"/upload/drive/v3/files/([^/]+)$", u.path)
        if m:
            f = files[m.group(1)]
            f["data"] = raw
            changes.append(m.group(1))
            return self.send(200, {"id": m.group(1), "md5Checksum": hashlib.md5(raw).hexdigest()})
        m = re.match(r"/drive/v3/files/([^/]+)$", u.path)
        if m:
            files[m.group(1)]["trashed"] = json.loads(raw).get("trashed", False)
            changes.append(m.group(1))
            return self.send(200, {"id": m.group(1)})
        self.send(404, {"error": {"message": self.path}})


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1] if len(sys.argv) > 1 else 8765)), H).serve_forever()
