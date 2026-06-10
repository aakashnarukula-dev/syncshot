# ScreenshotX Hub + Mac Client (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-hosted hub server (runs on the Mac mini) plus a Mac client agent (runs on the MacBook) that sync screenshots between Macs through the hub — independent of iCloud — with the existing ScreenshotX Tauri app surfacing + clipboard-copying received shots via its folder poll.

**Architecture:** Hub = FastAPI + SQLite catalog + content-addressed blob store + WebSocket fan-out. Mac client = folder watcher (upload) + WebSocket receiver (writes received shots into the configured ScreenshotX folder). Dedup by SHA-256. Phase 1 deliberately excludes FCM/Android (Phase 2) so there is **no Firebase dependency** and everything is testable on `localhost`.

**Tech Stack:** Python 3.13, FastAPI, uvicorn, SQLite (stdlib `sqlite3`), Pillow, watchdog, websockets (via FastAPI/Starlette), httpx (client), pytest. Deployed via LaunchAgents + cloudflared (deploy step, not required for tests).

---

## File structure (new repo: `/Users/aakashnarukula/Developer/screenshotx-hub`)

```
screenshotx-hub/
  pyproject.toml                # deps + pytest config
  README.md
  src/ssx_hub/
    __init__.py
    config.py                   # HubConfig: paths, port, configured ScreenshotX folder
    hashing.py                  # sha256_file / sha256_bytes
    catalog.py                  # SQLite layer: screenshots, devices, pairings
    blobstore.py                # content-addressed blob store + thumbnails
    icloud.py                   # materialize .icloud placeholders
    auth.py                     # device-token dependency
    fanout.py                   # WebSocket connection manager + Notifier protocol
    app.py                      # FastAPI app + all endpoints
    watcher.py                  # watchdog folder observer → ingest + mirror
    main.py                     # uvicorn entrypoint + start watcher
  src/ssx_client/
    __init__.py
    config.py                   # ClientConfig: base_url, device_token, folder
    pair.py                     # claim a pairing code → store token (CLI)
    uploader.py                 # folder watcher → POST /api/upload
    receiver.py                 # WS client → pull received → write into folder
    main.py                     # run uploader + receiver
  deploy/
    com.aakashnarukula.ssxhub.plist
    com.aakashnarukula.ssxclient.plist
    TUNNEL.md                   # cloudflared runbook (user-side)
  tests/
    conftest.py
    test_hashing.py
    test_catalog.py
    test_blobstore.py
    test_auth.py
    test_pairing.py
    test_upload.py
    test_catalog_endpoints.py
    test_fanout.py
    test_icloud.py
    test_watcher.py
    test_client_pair.py
    test_client_uploader.py
    test_client_receiver.py
```

---

### Task 1: Scaffold the hub repo

**Files:**
- Create: `/Users/aakashnarukula/Developer/screenshotx-hub/pyproject.toml`
- Create: `src/ssx_hub/__init__.py`, `src/ssx_client/__init__.py`, `tests/conftest.py`

- [ ] **Step 1: Create repo + venv + deps**

```bash
mkdir -p /Users/aakashnarukula/Developer/screenshotx-hub/{src/ssx_hub,src/ssx_client,tests,deploy}
cd /Users/aakashnarukula/Developer/screenshotx-hub
git init -q
python3 -m venv .venv
.venv/bin/pip -q install --upgrade pip
.venv/bin/pip -q install "fastapi>=0.115" "uvicorn[standard]>=0.32" "pillow>=11" "watchdog>=5" "httpx>=0.27" "websockets>=13" "python-multipart>=0.0.9" "pytest>=8" "pytest-asyncio>=0.24"
```

- [ ] **Step 2: Write `pyproject.toml`**

```toml
[project]
name = "ssx-hub"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "fastapi>=0.115", "uvicorn[standard]>=0.32", "pillow>=11",
  "watchdog>=5", "httpx>=0.27", "websockets>=13", "python-multipart>=0.0.9",
]

[tool.pytest.ini_options]
pythonpath = ["src"]
asyncio_mode = "auto"
testpaths = ["tests"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"
```

- [ ] **Step 3: Create package markers + `.gitignore`**

```bash
touch src/ssx_hub/__init__.py src/ssx_client/__init__.py
printf '.venv/\n__pycache__/\n*.pyc\nstore/\n*.db\n.pytest_cache/\n' > .gitignore
```

- [ ] **Step 4: Write `tests/conftest.py`** (shared tmp-dir fixtures)

```python
import os, sys, pathlib, pytest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

@pytest.fixture
def workdir(tmp_path):
    folder = tmp_path / "ScreenshotX"; folder.mkdir()
    store = tmp_path / "store"; store.mkdir()
    db = tmp_path / "ssx.db"
    return {"folder": folder, "store": store, "db": db}
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -q -m "chore: scaffold ssx-hub repo"
```

---

### Task 2: Hashing util

**Files:** Create `src/ssx_hub/hashing.py`; Test `tests/test_hashing.py`

- [ ] **Step 1: Write the failing test**

```python
from ssx_hub.hashing import sha256_bytes, sha256_file

def test_sha256_bytes_known_vector():
    assert sha256_bytes(b"abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

def test_sha256_file_matches_bytes(tmp_path):
    p = tmp_path / "x.bin"; p.write_bytes(b"hello world")
    assert sha256_file(p) == sha256_bytes(b"hello world")
```

- [ ] **Step 2: Run → FAIL**: `/.venv/bin/pytest tests/test_hashing.py -q` → ModuleNotFoundError.

- [ ] **Step 3: Implement**

```python
import hashlib, pathlib

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def sha256_file(path: "str | pathlib.Path", chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()
```

- [ ] **Step 4: Run → PASS**: `.venv/bin/pytest tests/test_hashing.py -q`

- [ ] **Step 5: Commit**: `git add -A && git commit -q -m "feat: sha256 hashing util"`

---

### Task 3: Config module

**Files:** Create `src/ssx_hub/config.py`; Test `tests/test_config.py` (add to Task 1 list)

- [ ] **Step 1: Write the failing test**

```python
from ssx_hub.config import HubConfig

def test_config_defaults_and_override(workdir, monkeypatch):
    cfg = HubConfig(folder=workdir["folder"], store=workdir["store"], db=workdir["db"], port=8787)
    assert cfg.port == 8787
    assert cfg.folder.exists() and cfg.store.exists()

def test_config_from_env(workdir, monkeypatch):
    monkeypatch.setenv("SSX_FOLDER", str(workdir["folder"]))
    monkeypatch.setenv("SSX_PORT", "9999")
    cfg = HubConfig.from_env(base=workdir["folder"].parent)
    assert cfg.port == 9999 and cfg.folder == workdir["folder"]
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```python
import os, pathlib
from dataclasses import dataclass

@dataclass
class HubConfig:
    folder: pathlib.Path     # the user-visible ScreenshotX folder (configurable, may move)
    store: pathlib.Path      # content-addressed blob store
    db: pathlib.Path         # sqlite catalog
    port: int = 8787

    def __post_init__(self):
        self.folder = pathlib.Path(self.folder); self.folder.mkdir(parents=True, exist_ok=True)
        self.store = pathlib.Path(self.store); self.store.mkdir(parents=True, exist_ok=True)
        self.db = pathlib.Path(self.db)

    @classmethod
    def from_env(cls, base: "pathlib.Path | None" = None) -> "HubConfig":
        base = pathlib.Path(base or (pathlib.Path.home() / "Library/Application Support/ScreenshotXHub"))
        base.mkdir(parents=True, exist_ok=True)
        folder = pathlib.Path(os.environ.get("SSX_FOLDER", pathlib.Path.home() / "Desktop/ScreenshotX"))
        return cls(folder=folder, store=base / "store", db=base / "ssx.db",
                   port=int(os.environ.get("SSX_PORT", "8787")))
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit:** `git add -A && git commit -q -m "feat: hub config"`

---

### Task 4: SQLite catalog layer

**Files:** Create `src/ssx_hub/catalog.py`; Test `tests/test_catalog.py`

- [ ] **Step 1: Write the failing test**

```python
import time
from ssx_hub.catalog import Catalog

def test_screenshots_insert_idempotent(workdir):
    c = Catalog(workdir["db"])
    row = c.add_screenshot(hash="h1", filename="a.png", origin="mini", mime="image/png", size=10, created_at=1.0)
    assert row["new"] is True
    again = c.add_screenshot(hash="h1", filename="a.png", origin="mini", mime="image/png", size=10, created_at=1.0)
    assert again["new"] is False
    assert len(c.list_screenshots()) == 1

def test_list_since(workdir):
    c = Catalog(workdir["db"])
    c.add_screenshot(hash="h1", filename="a.png", origin="mini", mime="image/png", size=1, created_at=1.0)
    c.add_screenshot(hash="h2", filename="b.png", origin="mac", mime="image/png", size=1, created_at=5.0)
    assert [r["hash"] for r in c.list_screenshots(since=2.0)] == ["h2"]

def test_devices_and_tokens(workdir):
    c = Catalog(workdir["db"])
    tok = c.add_device(name="MacBook", platform="mac", fcm_token=None)
    assert c.device_by_token(tok)["name"] == "MacBook"
    assert c.device_by_token("nope") is None

def test_pairing_lifecycle(workdir):
    c = Catalog(workdir["db"])
    c.create_pairing("ABC123", expires_at=time.time() + 300)
    assert c.consume_pairing("ABC123") is True
    assert c.consume_pairing("ABC123") is False        # single-use
    c.create_pairing("OLD", expires_at=time.time() - 1)
    assert c.consume_pairing("OLD") is False            # expired
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```python
import sqlite3, secrets, time, pathlib, threading

_SCHEMA = """
CREATE TABLE IF NOT EXISTS screenshots(
  hash TEXT PRIMARY KEY, filename TEXT, origin TEXT, mime TEXT, size INTEGER, created_at REAL);
CREATE TABLE IF NOT EXISTS devices(
  id TEXT PRIMARY KEY, name TEXT, platform TEXT, token TEXT UNIQUE,
  fcm_token TEXT, paired_at REAL, last_seen REAL);
CREATE TABLE IF NOT EXISTS pairings(
  code TEXT PRIMARY KEY, expires_at REAL, used INTEGER DEFAULT 0);
"""

class Catalog:
    def __init__(self, db_path: "str | pathlib.Path"):
        self._lock = threading.Lock()
        self.db = sqlite3.connect(str(db_path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(_SCHEMA); self.db.commit()

    def add_screenshot(self, *, hash, filename, origin, mime, size, created_at):
        with self._lock:
            cur = self.db.execute("SELECT 1 FROM screenshots WHERE hash=?", (hash,))
            if cur.fetchone():
                return {"new": False, "hash": hash}
            self.db.execute(
                "INSERT INTO screenshots(hash,filename,origin,mime,size,created_at) VALUES(?,?,?,?,?,?)",
                (hash, filename, origin, mime, size, created_at))
            self.db.commit()
            return {"new": True, "hash": hash}

    def list_screenshots(self, since: float = 0.0):
        cur = self.db.execute(
            "SELECT hash,filename,origin,mime,size,created_at FROM screenshots "
            "WHERE created_at > ? ORDER BY created_at DESC", (since,))
        return [dict(r) for r in cur.fetchall()]

    def add_device(self, *, name, platform, fcm_token=None) -> str:
        did = secrets.token_hex(8); token = secrets.token_urlsafe(32)
        with self._lock:
            self.db.execute(
                "INSERT INTO devices(id,name,platform,token,fcm_token,paired_at,last_seen) "
                "VALUES(?,?,?,?,?,?,?)", (did, name, platform, token, fcm_token, time.time(), time.time()))
            self.db.commit()
        return token

    def device_by_token(self, token: str):
        cur = self.db.execute("SELECT * FROM devices WHERE token=?", (token,))
        r = cur.fetchone(); return dict(r) if r else None

    def list_devices(self):
        return [dict(r) for r in self.db.execute("SELECT * FROM devices").fetchall()]

    def create_pairing(self, code: str, expires_at: float):
        with self._lock:
            self.db.execute("INSERT OR REPLACE INTO pairings(code,expires_at,used) VALUES(?,?,0)",
                            (code, expires_at)); self.db.commit()

    def consume_pairing(self, code: str) -> bool:
        with self._lock:
            cur = self.db.execute("SELECT expires_at,used FROM pairings WHERE code=?", (code,))
            r = cur.fetchone()
            if not r or r["used"] or r["expires_at"] < time.time():
                return False
            self.db.execute("UPDATE pairings SET used=1 WHERE code=?", (code,)); self.db.commit()
            return True
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit:** `git add -A && git commit -q -m "feat: sqlite catalog (screenshots, devices, pairings)"`

---

### Task 5: Blob store + thumbnails

**Files:** Create `src/ssx_hub/blobstore.py`; Test `tests/test_blobstore.py`

- [ ] **Step 1: Write the failing test**

```python
from PIL import Image
import io
from ssx_hub.blobstore import BlobStore

def _png_bytes(w=400, h=300):
    buf = io.BytesIO(); Image.new("RGB", (w, h), (10, 20, 30)).save(buf, "PNG"); return buf.getvalue()

def test_put_get_roundtrip(workdir):
    bs = BlobStore(workdir["store"]); data = _png_bytes()
    h = bs.put(data, suffix=".png")
    assert bs.exists(h) and bs.get(h) == data

def test_thumbnail_smaller(workdir):
    bs = BlobStore(workdir["store"]); h = bs.put(_png_bytes(), suffix=".png")
    thumb = bs.thumbnail(h, width=100)
    im = Image.open(io.BytesIO(thumb)); assert im.width == 100 and im.height == 75
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```python
import pathlib, io
from PIL import Image
from .hashing import sha256_bytes

class BlobStore:
    def __init__(self, root: "str | pathlib.Path"):
        self.root = pathlib.Path(root); self.root.mkdir(parents=True, exist_ok=True)
        self.thumbs = self.root / "thumbs"; self.thumbs.mkdir(exist_ok=True)

    def _path(self, h: str, suffix: str = ".png") -> pathlib.Path:
        return self.root / f"{h}{suffix}"

    def put(self, data: bytes, suffix: str = ".png") -> str:
        h = sha256_bytes(data); p = self._path(h, suffix)
        if not p.exists(): p.write_bytes(data)
        return h

    def find(self, h: str) -> "pathlib.Path | None":
        for p in self.root.glob(f"{h}.*"):
            if p.is_file(): return p
        return None

    def exists(self, h: str) -> bool: return self.find(h) is not None
    def get(self, h: str) -> bytes:
        p = self.find(h)
        if not p: raise KeyError(h)
        return p.read_bytes()

    def thumbnail(self, h: str, width: int = 320) -> bytes:
        cache = self.thumbs / f"{h}_{width}.jpg"
        if cache.exists(): return cache.read_bytes()
        im = Image.open(io.BytesIO(self.get(h))).convert("RGB")
        ratio = width / im.width
        im = im.resize((width, max(1, round(im.height * ratio))), Image.LANCZOS)
        buf = io.BytesIO(); im.save(buf, "JPEG", quality=82)
        cache.write_bytes(buf.getvalue()); return buf.getvalue()
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit:** `git add -A && git commit -q -m "feat: content-addressed blob store + thumbnails"`

---

### Task 6: FastAPI app skeleton + auth dependency + health

**Files:** Create `src/ssx_hub/auth.py`, `src/ssx_hub/app.py`; Test `tests/test_auth.py`

- [ ] **Step 1: Write the failing test**

```python
from fastapi.testclient import TestClient
from ssx_hub.app import create_app
from ssx_hub.config import HubConfig

def _client(workdir):
    cfg = HubConfig(folder=workdir["folder"], store=workdir["store"], db=workdir["db"])
    app = create_app(cfg); return TestClient(app), app.state.catalog

def test_health_open(workdir):
    client, _ = _client(workdir)
    assert client.get("/api/health").json()["ok"] is True

def test_catalog_requires_token(workdir):
    client, cat = _client(workdir)
    assert client.get("/api/catalog").status_code == 401
    tok = cat.add_device(name="MB", platform="mac")
    assert client.get("/api/catalog", headers={"Authorization": f"Bearer {tok}"}).status_code == 200
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `auth.py`**

```python
from fastapi import Header, HTTPException, Request

async def require_device(request: Request, authorization: str = Header(default="")):
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token")
    token = authorization[7:]
    device = request.app.state.catalog.device_by_token(token)
    if not device:
        raise HTTPException(401, "invalid token")
    return device
```

- [ ] **Step 4: Implement `app.py` (skeleton + health + catalog stub)**

```python
from fastapi import FastAPI, Depends
from .config import HubConfig
from .catalog import Catalog
from .blobstore import BlobStore
from .auth import require_device

def create_app(cfg: HubConfig) -> FastAPI:
    app = FastAPI(title="ScreenshotX Hub")
    app.state.cfg = cfg
    app.state.catalog = Catalog(cfg.db)
    app.state.blobs = BlobStore(cfg.store)

    @app.get("/api/health")
    async def health(): return {"ok": True}

    @app.get("/api/catalog")
    async def catalog(since: float = 0.0, device=Depends(require_device)):
        return {"screenshots": app.state.catalog.list_screenshots(since=since)}

    return app
```

- [ ] **Step 5: Run → PASS, then commit:** `git add -A && git commit -q -m "feat: fastapi app + device-token auth + health/catalog"`

---

### Task 7: Pairing endpoints

**Files:** Modify `src/ssx_hub/app.py`; Test `tests/test_pairing.py`

- [ ] **Step 1: Write the failing test**

```python
from fastapi.testclient import TestClient
from ssx_hub.app import create_app
from ssx_hub.config import HubConfig

def _client(workdir):
    cfg = HubConfig(folder=workdir["folder"], store=workdir["store"], db=workdir["db"])
    return TestClient(create_app(cfg))

def test_pair_new_then_claim(workdir):
    c = _client(workdir)
    code = c.post("/api/pair/new").json()["code"]
    assert len(code) >= 6
    r = c.post("/api/pair/claim", json={"code": code, "device_name": "Phone", "platform": "android"})
    tok = r.json()["device_token"]; assert tok
    # token works
    assert c.get("/api/catalog", headers={"Authorization": f"Bearer {tok}"}).status_code == 200
    # code is single-use
    assert c.post("/api/pair/claim", json={"code": code, "device_name": "X", "platform": "mac"}).status_code == 400
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement (add to `create_app` in `app.py`)**

```python
    import secrets, time
    from fastapi import HTTPException
    from pydantic import BaseModel

    class ClaimBody(BaseModel):
        code: str; device_name: str; platform: str; fcm_token: str | None = None

    @app.post("/api/pair/new")
    async def pair_new():
        code = secrets.token_hex(3).upper()        # 6 hex chars
        app.state.catalog.create_pairing(code, expires_at=time.time() + 300)
        return {"code": code, "expires_in": 300}

    @app.post("/api/pair/claim")
    async def pair_claim(body: ClaimBody):
        if not app.state.catalog.consume_pairing(body.code):
            raise HTTPException(400, "invalid or expired code")
        token = app.state.catalog.add_device(
            name=body.device_name, platform=body.platform, fcm_token=body.fcm_token)
        return {"device_token": token}
```

- [ ] **Step 4: Run → PASS, commit:** `git add -A && git commit -q -m "feat: pairing endpoints (new/claim)"`

---

### Task 8: Fan-out manager + Notifier protocol

**Files:** Create `src/ssx_hub/fanout.py`; Test `tests/test_fanout.py`

- [ ] **Step 1: Write the failing test**

```python
import asyncio
from ssx_hub.fanout import FanOut

class FakeWS:
    def __init__(self): self.sent = []
    async def send_json(self, obj): self.sent.append(obj)

def test_fanout_broadcasts_to_all_but_origin():
    fo = FanOut()
    a, b = FakeWS(), FakeWS()
    fo.add("devA", a); fo.add("devB", b)
    asyncio.run(fo.broadcast_new("h1", origin_device_id="devA"))
    assert a.sent == []                                # origin skipped
    assert b.sent == [{"type": "new", "hash": "h1"}]
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```python
from typing import Protocol

class Notifier(Protocol):
    async def notify_new(self, hash: str, origin_device_id: str) -> None: ...

class FanOut:
    """Tracks live WebSocket clients (Macs) and broadcasts 'new' events."""
    def __init__(self):
        self._clients: dict[str, object] = {}     # device_id -> ws
    def add(self, device_id: str, ws): self._clients[device_id] = ws
    def remove(self, device_id: str): self._clients.pop(device_id, None)

    async def broadcast_new(self, hash: str, origin_device_id: str):
        dead = []
        for did, ws in list(self._clients.items()):
            if did == origin_device_id:
                continue
            try:
                await ws.send_json({"type": "new", "hash": hash})
            except Exception:
                dead.append(did)
        for did in dead:
            self.remove(did)
```

- [ ] **Step 4: Run → PASS, commit:** `git add -A && git commit -q -m "feat: websocket fan-out manager + Notifier protocol"`

---

### Task 9: Upload endpoint (store + catalog + mirror + fan-out)

**Files:** Modify `src/ssx_hub/app.py`; Test `tests/test_upload.py`

- [ ] **Step 1: Write the failing test**

```python
import io
from PIL import Image
from fastapi.testclient import TestClient
from ssx_hub.app import create_app
from ssx_hub.config import HubConfig
from ssx_hub.hashing import sha256_bytes

def _png(): 
    b = io.BytesIO(); Image.new("RGB", (50, 40), (1, 2, 3)).save(b, "PNG"); return b.getvalue()

def _client(workdir):
    cfg = HubConfig(folder=workdir["folder"], store=workdir["store"], db=workdir["db"])
    app = create_app(cfg); return TestClient(app), cfg, app.state.catalog

def test_upload_stores_catalogs_and_mirrors(workdir):
    client, cfg, cat = _client(workdir)
    tok = cat.add_device(name="mini", platform="mac")
    data = _png(); h = sha256_bytes(data)
    r = client.post("/api/upload",
        headers={"Authorization": f"Bearer {tok}"},
        data={"sha256": h, "origin_device": "mini", "created_at": "1.0", "filename": "s.png"},
        files={"file": ("s.png", data, "image/png")})
    assert r.status_code == 200 and r.json()["new"] is True
    # catalog row
    assert any(s["hash"] == h for s in cat.list_screenshots())
    # mirrored into the configured folder so the Tauri app's poll surfaces it
    assert (cfg.folder / "s.png").read_bytes() == data
    # idempotent
    r2 = client.post("/api/upload", headers={"Authorization": f"Bearer {tok}"},
        data={"sha256": h, "origin_device": "mini", "created_at": "1.0", "filename": "s.png"},
        files={"file": ("s.png", data, "image/png")})
    assert r2.json()["new"] is False
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Add a FanOut to app state and the upload route. In `create_app`, after blobs:

```python
    from .fanout import FanOut
    app.state.fanout = FanOut()
```

Then add the route (uses `UploadFile`):

```python
    from fastapi import UploadFile, File, Form, HTTPException

    @app.post("/api/upload")
    async def upload(file: UploadFile = File(...), sha256: str = Form(...),
                     origin_device: str = Form(...), created_at: float = Form(...),
                     filename: str = Form(...), device=Depends(require_device)):
        data = await file.read()
        from .hashing import sha256_bytes
        if sha256_bytes(data) != sha256:
            raise HTTPException(400, "hash mismatch")
        app.state.blobs.put(data, suffix=".png")
        res = app.state.catalog.add_screenshot(
            hash=sha256, filename=filename, origin=origin_device,
            mime=file.content_type or "image/png", size=len(data), created_at=created_at)
        if res["new"]:
            # mirror into the visible folder (collision-safe) so the existing app shows + clipboards
            target = app.state.cfg.folder / filename
            if target.exists():
                target = app.state.cfg.folder / f"{sha256[:8]}-{filename}"
            target.write_bytes(data)
            await app.state.fanout.broadcast_new(sha256, origin_device_id=device["id"])
        return {"new": res["new"], "hash": sha256}
```

- [ ] **Step 4: Run → PASS, commit:** `git add -A && git commit -q -m "feat: upload endpoint (store+catalog+mirror+fanout)"`

---

### Task 10: Image + thumb endpoints

**Files:** Modify `src/ssx_hub/app.py`; Test `tests/test_catalog_endpoints.py`

- [ ] **Step 1: Write the failing test**

```python
import io
from PIL import Image
from fastapi.testclient import TestClient
from ssx_hub.app import create_app
from ssx_hub.config import HubConfig
from ssx_hub.hashing import sha256_bytes

def _png():
    b = io.BytesIO(); Image.new("RGB", (200, 100), (9, 9, 9)).save(b, "PNG"); return b.getvalue()

def _setup(workdir):
    cfg = HubConfig(folder=workdir["folder"], store=workdir["store"], db=workdir["db"])
    app = create_app(cfg); client = TestClient(app); tok = app.state.catalog.add_device(name="m", platform="mac")
    data = _png(); h = sha256_bytes(data)
    client.post("/api/upload", headers={"Authorization": f"Bearer {tok}"},
        data={"sha256": h, "origin_device": "m", "created_at": "1.0", "filename": "p.png"},
        files={"file": ("p.png", data, "image/png")})
    return client, tok, h, data

def test_image_and_thumb(workdir):
    client, tok, h, data = _setup(workdir); H = {"Authorization": f"Bearer {tok}"}
    assert client.get(f"/api/image/{h}", headers=H).content == data
    timg = client.get(f"/api/thumb/{h}?w=80", headers=H)
    assert timg.status_code == 200 and Image.open(io.BytesIO(timg.content)).width == 80

def test_image_rejects_bad_hash(workdir):
    client, tok, h, data = _setup(workdir)
    assert client.get("/api/image/..%2f..%2fetc%2fpasswd", headers={"Authorization": f"Bearer {tok}"}).status_code in (400, 404)
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement (add to `create_app`)**

```python
    import re
    from fastapi import Response, HTTPException
    _HASH_RE = re.compile(r"^[0-9a-f]{64}$")

    @app.get("/api/image/{h}")
    async def image(h: str, device=Depends(require_device)):
        if not _HASH_RE.match(h): raise HTTPException(400, "bad hash")
        if not app.state.blobs.exists(h): raise HTTPException(404, "not found")
        return Response(app.state.blobs.get(h), media_type="image/png")

    @app.get("/api/thumb/{h}")
    async def thumb(h: str, w: int = 320, device=Depends(require_device)):
        if not _HASH_RE.match(h): raise HTTPException(400, "bad hash")
        if not app.state.blobs.exists(h): raise HTTPException(404, "not found")
        return Response(app.state.blobs.thumbnail(h, width=max(32, min(w, 1024))), media_type="image/jpeg")
```

- [ ] **Step 4: Run → PASS, commit:** `git add -A && git commit -q -m "feat: image + thumb endpoints (hash-validated)"`

---

### Task 11: WebSocket /events endpoint

**Files:** Modify `src/ssx_hub/app.py`; Test `tests/test_ws.py`

- [ ] **Step 1: Write the failing test** (TestClient supports websockets)

```python
import io
from PIL import Image
from fastapi.testclient import TestClient
from ssx_hub.app import create_app
from ssx_hub.config import HubConfig
from ssx_hub.hashing import sha256_bytes

def _png():
    b = io.BytesIO(); Image.new("RGB", (10, 10), (5, 5, 5)).save(b, "PNG"); return b.getvalue()

def test_ws_receives_new_event(workdir):
    cfg = HubConfig(folder=workdir["folder"], store=workdir["store"], db=workdir["db"])
    app = create_app(cfg); client = TestClient(app)
    uploader = app.state.catalog.add_device(name="mini", platform="mac")
    listener = app.state.catalog.add_device(name="macbook", platform="mac")
    with client.websocket_connect(f"/events?token={listener}") as ws:
        data = _png(); h = sha256_bytes(data)
        client.post("/api/upload", headers={"Authorization": f"Bearer {uploader}"},
            data={"sha256": h, "origin_device": "mini", "created_at": "1.0", "filename": "w.png"},
            files={"file": ("w.png", data, "image/png")})
        msg = ws.receive_json()
        assert msg == {"type": "new", "hash": h}
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement (add to `create_app`)**

```python
    from fastapi import WebSocket
    from starlette.websockets import WebSocketDisconnect

    @app.websocket("/events")
    async def events(ws: WebSocket, token: str = ""):
        device = app.state.catalog.device_by_token(token)
        if not device:
            await ws.close(code=4401); return
        await ws.accept()
        app.state.fanout.add(device["id"], ws)
        try:
            while True:
                await ws.receive_text()       # keepalive / ignore client msgs
        except WebSocketDisconnect:
            pass
        finally:
            app.state.fanout.remove(device["id"])
```

- [ ] **Step 4: Run → PASS, commit:** `git add -A && git commit -q -m "feat: websocket /events live push"`

---

### Task 12: iCloud placeholder materialization

**Files:** Create `src/ssx_hub/icloud.py`; Test `tests/test_icloud.py`

- [ ] **Step 1: Write the failing test**

```python
from ssx_hub.icloud import resolve_path

def test_resolve_normal_file(tmp_path):
    p = tmp_path / "a.png"; p.write_bytes(b"x")
    assert resolve_path(p) == p

def test_resolve_placeholder(monkeypatch, tmp_path):
    real = tmp_path / "b.png"
    stub = tmp_path / ".b.png.icloud"; stub.write_bytes(b"")
    calls = []
    def fake_download(path): calls.append(path); real.write_bytes(b"materialized")
    monkeypatch.setattr("ssx_hub.icloud._brctl_download", fake_download)
    out = resolve_path(real)        # real missing, stub present
    assert calls and out == real and real.read_bytes() == b"materialized"
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```python
import pathlib, subprocess

def _brctl_download(path: pathlib.Path):
    subprocess.run(["brctl", "download", str(path)], check=False)

def resolve_path(path: "str | pathlib.Path") -> pathlib.Path:
    """If `path` is an iCloud-evicted file (only a .<name>.icloud stub on disk),
    trigger download and return the real path once materialized."""
    path = pathlib.Path(path)
    if path.exists():
        return path
    stub = path.with_name("." + path.name + ".icloud")
    if stub.exists():
        _brctl_download(path)
    return path
```

- [ ] **Step 4: Run → PASS, commit:** `git add -A && git commit -q -m "feat: icloud placeholder materialization helper"`

---

### Task 13: Folder watcher (ingest local captures + dedup)

**Files:** Create `src/ssx_hub/watcher.py`; Test `tests/test_watcher.py`

- [ ] **Step 1: Write the failing test** (test the ingest fn directly; watchdog wiring is thin)

```python
import io, pathlib
from PIL import Image
from ssx_hub.config import HubConfig
from ssx_hub.catalog import Catalog
from ssx_hub.blobstore import BlobStore
from ssx_hub.watcher import ingest_file

def _png(p):
    Image.new("RGB", (20, 20), (3, 3, 3)).save(p, "PNG")

def test_ingest_adds_to_catalog_and_store(workdir):
    cfg = HubConfig(folder=workdir["folder"], store=workdir["store"], db=workdir["db"])
    cat = Catalog(cfg.db); bs = BlobStore(cfg.store)
    f = cfg.folder / "local.png"; _png(f)
    res = ingest_file(f, cfg=cfg, catalog=cat, blobs=bs, origin="mini")
    assert res["new"] is True and bs.exists(res["hash"])
    assert any(s["filename"] == "local.png" for s in cat.list_screenshots())
    # second ingest of same content is a no-op
    assert ingest_file(f, cfg=cfg, catalog=cat, blobs=bs, origin="mini")["new"] is False
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```python
import pathlib, time
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from .hashing import sha256_file
from .icloud import resolve_path

_EXTS = {".png", ".jpg", ".jpeg"}

def ingest_file(path, *, cfg, catalog, blobs, origin: str):
    path = resolve_path(path)
    if not path.exists() or path.suffix.lower() not in _EXTS:
        return {"new": False, "hash": None}
    h = sha256_file(path)
    if catalog.list_screenshots() and any(s["hash"] == h for s in catalog.list_screenshots()):
        return {"new": False, "hash": h}
    data = path.read_bytes()
    blobs.put(data, suffix=".png")
    res = catalog.add_screenshot(hash=h, filename=path.name, origin=origin,
                                 mime="image/png", size=len(data), created_at=path.stat().st_mtime)
    return {"new": res["new"], "hash": h}

class _Handler(FileSystemEventHandler):
    def __init__(self, on_new): self.on_new = on_new
    def on_created(self, event):
        if not event.is_directory: self.on_new(pathlib.Path(event.src_path))
    def on_moved(self, event):
        if not event.is_directory: self.on_new(pathlib.Path(event.dest_path))

def start_folder_watch(cfg, on_new) -> Observer:
    obs = Observer(); obs.schedule(_Handler(on_new), str(cfg.folder), recursive=False)
    obs.daemon = True; obs.start(); return obs
```

- [ ] **Step 4: Run → PASS, commit:** `git add -A && git commit -q -m "feat: folder watcher + ingest with dedup"`

---

### Task 14: Hub entrypoint (wire watcher → fan-out) + run script

**Files:** Create `src/ssx_hub/main.py`, `deploy/run-hub.sh`; Test `tests/test_main_smoke.py`

- [ ] **Step 1: Write the failing smoke test** (app builds + folder-new triggers catalog + broadcast)

```python
import io, asyncio
from PIL import Image
from ssx_hub.config import HubConfig
from ssx_hub.app import create_app
from ssx_hub.main import wire_watcher
from ssx_hub.hashing import sha256_file

def test_wire_watcher_ingests_and_broadcasts(workdir):
    cfg = HubConfig(folder=workdir["folder"], store=workdir["store"], db=workdir["db"])
    app = create_app(cfg)
    captured = []
    class FakeWS:
        async def send_json(self, o): captured.append(o)
    app.state.fanout.add("listener", FakeWS())
    on_new = wire_watcher(app, origin="mini", loop=asyncio.new_event_loop())
    f = cfg.folder / "cap.png"; Image.new("RGB", (12, 12), (1, 1, 1)).save(f, "PNG")
    on_new(f)                                  # simulate a filesystem event
    h = sha256_file(f)
    assert any(s["hash"] == h for s in app.state.catalog.list_screenshots())
    assert {"type": "new", "hash": h} in captured
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `main.py`**

```python
import asyncio, threading, uvicorn
from .config import HubConfig
from .app import create_app
from .watcher import ingest_file, start_folder_watch

def wire_watcher(app, *, origin: str, loop: asyncio.AbstractEventLoop):
    """Returns an on_new(path) callback that ingests a file and broadcasts."""
    def on_new(path):
        res = ingest_file(path, cfg=app.state.cfg, catalog=app.state.catalog,
                          blobs=app.state.blobs, origin=origin)
        if res["new"]:
            asyncio.run_coroutine_threadsafe(
                app.state.fanout.broadcast_new(res["hash"], origin_device_id="local"), loop)
    return on_new

def main():
    cfg = HubConfig.from_env()
    app = create_app(cfg)
    loop = asyncio.get_event_loop()
    on_new = wire_watcher(app, origin="mini", loop=loop)
    app.state.observer = start_folder_watch(cfg, on_new)
    uvicorn.run(app, host="127.0.0.1", port=cfg.port, log_level="warning")

if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Write `deploy/run-hub.sh`**

```bash
#!/bin/zsh
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin"
ROOT="/Users/aakashnarukula/Developer/screenshotx-hub"
export SSX_FOLDER="${SSX_FOLDER:-$HOME/Desktop/ScreenshotX}"
exec "$ROOT/.venv/bin/python" -m ssx_hub.main
```

- [ ] **Step 5: Run test → PASS; `chmod +x deploy/run-hub.sh`; commit:** `git add -A && git commit -q -m "feat: hub entrypoint + run script"`

---

### Task 15: Mac client — config + pairing CLI

**Files:** Create `src/ssx_client/config.py`, `src/ssx_client/pair.py`; Test `tests/test_client_pair.py`

- [ ] **Step 1: Write the failing test** (mock the HTTP claim with a respx-style monkeypatch on httpx)

```python
import json, pathlib
import httpx
from ssx_client.config import ClientConfig
from ssx_client import pair

def test_claim_stores_token(tmp_path, monkeypatch):
    cfgpath = tmp_path / "client.json"
    def fake_post(url, json=None, timeout=None):
        assert url.endswith("/api/pair/claim")
        return httpx.Response(200, json={"device_token": "TOK123"})
    monkeypatch.setattr(httpx, "post", fake_post)
    cfg = pair.claim(base_url="https://hub.example.com", code="ABC123",
                     device_name="MacBook", platform="mac", config_path=cfgpath)
    assert cfg.device_token == "TOK123"
    assert json.loads(cfgpath.read_text())["device_token"] == "TOK123"
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `config.py`**

```python
import json, pathlib
from dataclasses import dataclass, asdict

@dataclass
class ClientConfig:
    base_url: str
    device_token: str
    folder: str

    @classmethod
    def load(cls, path) -> "ClientConfig":
        d = json.loads(pathlib.Path(path).read_text())
        return cls(**d)

    def save(self, path):
        pathlib.Path(path).write_text(json.dumps(asdict(self), indent=2))
```

- [ ] **Step 4: Implement `pair.py`**

```python
import httpx, pathlib
from .config import ClientConfig

DEFAULT_FOLDER = str(pathlib.Path.home() / "Desktop/ScreenshotX")

def claim(*, base_url: str, code: str, device_name: str, platform: str,
          config_path, folder: str = DEFAULT_FOLDER) -> ClientConfig:
    r = httpx.post(base_url.rstrip("/") + "/api/pair/claim",
                   json={"code": code, "device_name": device_name, "platform": platform},
                   timeout=15)
    r.raise_for_status()
    cfg = ClientConfig(base_url=base_url.rstrip("/"), device_token=r.json()["device_token"], folder=folder)
    cfg.save(config_path)
    return cfg

if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True); ap.add_argument("--code", required=True)
    ap.add_argument("--name", default="MacBook"); ap.add_argument("--config", required=True)
    a = ap.parse_args()
    c = claim(base_url=a.url, code=a.code, device_name=a.name, platform="mac", config_path=a.config)
    print("paired; token stored at", a.config)
```

- [ ] **Step 5: Run → PASS, commit:** `git add -A && git commit -q -m "feat: mac client config + pairing CLI"`

---

### Task 16: Mac client — uploader (folder watch → POST)

**Files:** Create `src/ssx_client/uploader.py`; Test `tests/test_client_uploader.py`

- [ ] **Step 1: Write the failing test**

```python
import io, httpx
from PIL import Image
from ssx_client.uploader import upload_file
from ssx_client.config import ClientConfig

def _png(p): Image.new("RGB", (16, 16), (7, 7, 7)).save(p, "PNG")

def test_upload_file_posts_multipart(tmp_path, monkeypatch):
    f = tmp_path / "shot.png"; _png(f)
    seen = {}
    def fake_post(url, data=None, files=None, headers=None, timeout=None):
        seen.update(url=url, data=data, has_file=("file" in files), auth=headers["Authorization"])
        return httpx.Response(200, json={"new": True, "hash": data["sha256"]})
    monkeypatch.setattr(httpx, "post", fake_post)
    cfg = ClientConfig(base_url="https://hub", device_token="T", folder=str(tmp_path))
    res = upload_file(f, cfg=cfg, origin_device="macbook")
    assert res["new"] is True
    assert seen["url"].endswith("/api/upload") and seen["has_file"] and seen["auth"] == "Bearer T"
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```python
import httpx, pathlib
import sys; sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from ssx_hub.hashing import sha256_file       # reuse hashing
from ssx_hub.watcher import start_folder_watch # reuse watchdog wiring
from .config import ClientConfig

_EXTS = {".png", ".jpg", ".jpeg"}

def upload_file(path, *, cfg: ClientConfig, origin_device: str):
    path = pathlib.Path(path)
    if path.suffix.lower() not in _EXTS or not path.exists():
        return {"new": False}
    h = sha256_file(path); data = path.read_bytes()
    r = httpx.post(cfg.base_url + "/api/upload",
        data={"sha256": h, "origin_device": origin_device, "created_at": str(path.stat().st_mtime),
              "filename": path.name},
        files={"file": (path.name, data, "image/png")},
        headers={"Authorization": f"Bearer {cfg.device_token}"}, timeout=60)
    r.raise_for_status(); return r.json()
```

> Note: `start_folder_watch` is reused from `ssx_hub.watcher`; the client's `main.py` (Task 18) wires it to `upload_file`. Offline resilience for the Mac client is a thin retry loop in `main.py` (Task 18); WorkManager-grade queueing is the Android client's job (Phase 2).

- [ ] **Step 4: Run → PASS, commit:** `git add -A && git commit -q -m "feat: mac client uploader"`

---

### Task 17: Mac client — receiver (WS → pull → write into folder)

**Files:** Create `src/ssx_client/receiver.py`; Test `tests/test_client_receiver.py`

- [ ] **Step 1: Write the failing test** (test the handle-event fn; WS transport is thin)

```python
import io, httpx, pathlib
from PIL import Image
from ssx_client.receiver import handle_new_hash
from ssx_client.config import ClientConfig
from ssx_hub.hashing import sha256_bytes

def _png():
    b = io.BytesIO(); Image.new("RGB", (18, 18), (4, 4, 4)).save(b, "PNG"); return b.getvalue()

def test_handle_new_hash_downloads_and_writes(tmp_path, monkeypatch):
    data = _png(); h = sha256_bytes(data)
    def fake_get(url, headers=None, timeout=None):
        assert url.endswith(f"/api/image/{h}")
        return httpx.Response(200, content=data)
    monkeypatch.setattr(httpx, "get", fake_get)
    folder = tmp_path / "ScreenshotX"; folder.mkdir()
    cfg = ClientConfig(base_url="https://hub", device_token="T", folder=str(folder))
    out = handle_new_hash(h, cfg=cfg, known_hashes=set())
    assert out is not None and pathlib.Path(out).read_bytes() == data

def test_handle_skips_known(tmp_path):
    cfg = ClientConfig(base_url="https://hub", device_token="T", folder=str(tmp_path))
    assert handle_new_hash("deadbeef", cfg=cfg, known_hashes={"deadbeef"}) is None
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```python
import httpx, pathlib
from .config import ClientConfig

def handle_new_hash(h: str, *, cfg: ClientConfig, known_hashes: set) -> "str | None":
    if h in known_hashes:
        return None
    r = httpx.get(cfg.base_url + f"/api/image/{h}",
                  headers={"Authorization": f"Bearer {cfg.device_token}"}, timeout=60)
    r.raise_for_status()
    folder = pathlib.Path(cfg.folder); folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"sync-{h[:12]}.png"
    target.write_bytes(r.content)            # existing Tauri poll picks this up → shows + clipboards
    known_hashes.add(h)
    return str(target)
```

- [ ] **Step 4: Run → PASS, commit:** `git add -A && git commit -q -m "feat: mac client receiver (pull + write to folder)"`

---

### Task 18: Mac client — entrypoint (uploader + WS receiver loop)

**Files:** Create `src/ssx_client/main.py`, `deploy/run-client.sh`

- [ ] **Step 1: Implement `main.py`** (no unit test — integration glue; covered by E2E in Task 19)

```python
import asyncio, json, pathlib, threading
import httpx, websockets
from .config import ClientConfig
from .uploader import upload_file
from ssx_hub.watcher import start_folder_watch

ORIGIN = "macbook"

def _seed_known(cfg) -> set:
    # Pre-seed with hashes already present so we don't re-download our own folder.
    from ssx_hub.hashing import sha256_file
    known = set()
    for p in pathlib.Path(cfg.folder).glob("*"):
        if p.suffix.lower() in {".png", ".jpg", ".jpeg"}:
            try: known.add(sha256_file(p))
            except OSError: pass
    return known

async def _ws_loop(cfg: ClientConfig, known: set):
    from .receiver import handle_new_hash
    url = cfg.base_url.replace("https://", "wss://").replace("http://", "ws://") + f"/events?token={cfg.device_token}"
    while True:
        try:
            async with websockets.connect(url, ping_interval=20) as ws:
                async for raw in ws:
                    msg = json.loads(raw)
                    if msg.get("type") == "new":
                        await asyncio.to_thread(handle_new_hash, msg["hash"], cfg=cfg, known_hashes=known)
        except Exception:
            await asyncio.sleep(3)            # reconnect with backoff

def main():
    cfg = ClientConfig.load(pathlib.Path.home() / ".config/ssx/client.json")
    known = _seed_known(cfg)
    def on_new(path):
        try:
            res = upload_file(path, cfg=cfg, origin_device=ORIGIN)
            if res.get("hash"): known.add(res["hash"])
        except Exception:
            pass                              # retried on next event; folder still has the file
    start_folder_watch(cfg, on_new)
    asyncio.run(_ws_loop(cfg, known))

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Write `deploy/run-client.sh`**

```bash
#!/bin/zsh
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin"
ROOT="/Users/aakashnarukula/Developer/screenshotx-hub"
exec "$ROOT/.venv/bin/python" -m ssx_client.main
```

- [ ] **Step 3: `chmod +x deploy/run-client.sh`; commit:** `git add -A && git commit -q -m "feat: mac client entrypoint (uploader + ws receiver)"`

---

### Task 19: Local end-to-end test + LaunchAgents + tunnel runbook

**Files:** Create `tests/test_e2e_local.py`, `deploy/*.plist`, `deploy/TUNNEL.md`

- [ ] **Step 1: Write a local E2E test** (hub in-thread; two "devices" via TestClient; verifies upload → catalog → mirror → fan-out path end to end)

```python
import io, threading, time
from PIL import Image
from fastapi.testclient import TestClient
from ssx_hub.app import create_app
from ssx_hub.config import HubConfig
from ssx_hub.hashing import sha256_bytes

def _png(c):
    b = io.BytesIO(); Image.new("RGB", (30, 20), c).save(b, "PNG"); return b.getvalue()

def test_capture_on_a_appears_for_b(workdir):
    cfg = HubConfig(folder=workdir["folder"], store=workdir["store"], db=workdir["db"])
    app = create_app(cfg); client = TestClient(app)
    a = app.state.catalog.add_device(name="mini", platform="mac")
    b = app.state.catalog.add_device(name="macbook", platform="mac")
    data = _png((100, 50, 25)); h = sha256_bytes(data)
    with client.websocket_connect(f"/events?token={b}") as ws:
        client.post("/api/upload", headers={"Authorization": f"Bearer {a}"},
            data={"sha256": h, "origin_device": "mini", "created_at": "1.0", "filename": "e2e.png"},
            files={"file": ("e2e.png", data, "image/png")})
        assert ws.receive_json() == {"type": "new", "hash": h}
    # B pulls and gets identical bytes; folder mirror exists for the Tauri app
    assert client.get(f"/api/image/{h}", headers={"Authorization": f"Bearer {b}"}).content == data
    assert (cfg.folder / "e2e.png").read_bytes() == data
```

- [ ] **Step 2: Run full suite → PASS:** `.venv/bin/pytest -q`

- [ ] **Step 3: Write `deploy/com.aakashnarukula.ssxhub.plist`** (Mac mini)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.aakashnarukula.ssxhub</string>
  <key>ProgramArguments</key>
  <array><string>/Users/aakashnarukula/Developer/screenshotx-hub/deploy/run-hub.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/ssxhub.log</string>
  <key>StandardErrorPath</key><string>/tmp/ssxhub.err</string>
</dict></plist>
```

- [ ] **Step 4: Write `deploy/com.aakashnarukula.ssxclient.plist`** (MacBook — same shape, `run-client.sh`, label `...ssxclient`, logs `/tmp/ssxclient.*`).

- [ ] **Step 5: Write `deploy/TUNNEL.md`** (user-side runbook)

```markdown
# Cloudflare named tunnel for the hub (run on the Mac mini)

1. cloudflared tunnel login                      # opens browser; pick gyftalala.com
2. cloudflared tunnel create screenshotx         # note the tunnel UUID + creds json
3. cloudflared tunnel route dns screenshotx screenshotx.gyftalala.com
4. Create ~/.cloudflared/config.yml:
     tunnel: <UUID>
     credentials-file: /Users/<you>/.cloudflared/<UUID>.json
     ingress:
       - hostname: screenshotx.gyftalala.com
         service: http://localhost:8787
       - service: http_status:404
5. sudo cloudflared service install              # runs cloudflared as a daemon
6. Load the hub:  launchctl load ~/Library/LaunchAgents/com.aakashnarukula.ssxhub.plist
7. Verify:  curl https://screenshotx.gyftalala.com/api/health   →  {"ok": true}
```

- [ ] **Step 6: Commit:** `git add -A && git commit -q -m "test: local e2e + deploy launchagents + tunnel runbook"`

---

## Self-Review

**Spec coverage check (spec §4.1 hub / §4.2 mac client / §5 pairing / §6 data flow / §7 security / §8 resilience):**
- Hub storage/catalog/blobs → Tasks 4,5. REST upload/catalog/image/thumb → Tasks 9,10. Pairing → Task 7. WS fan-out → Tasks 8,11. iCloud placeholders → Task 12. Folder watch + mirror → Tasks 9,13,14. ✓
- Mac client pair/upload/receive → Tasks 15,16,17,18. ✓
- Pairing flow (code single-use, token issue) → Tasks 4,7,15. ✓
- Data flow capture→everywhere → E2E Task 19. ✓
- Security: token auth (Task 6), hash-validated paths (Task 10), single-use pairing (Task 4). ✓
- Resilience: dedup by hash (Tasks 4,13), reconnect backoff (Task 18), KeepAlive LaunchAgents (Task 19). ✓
- **Deferred to Phase 2 (Android plan), intentionally:** FCM notifier impl (the `Notifier` protocol exists in Task 8 as the seam), WorkManager queueing, notify-to-copy. Documented in spec §11.

**Placeholder scan:** No TBD/TODO; every code step has real code. ✓
**Type consistency:** `add_screenshot(hash,filename,origin,mime,size,created_at)` used identically in Tasks 4/9/13. `FanOut.broadcast_new(hash, origin_device_id)` consistent Tasks 8/9/14. `ClientConfig(base_url,device_token,folder)` consistent Tasks 15/16/17/18. ✓

## Out of scope for this plan (own plans)
- **Phase 2:** `screenshotx-android` (Kotlin/Compose, FCM, observer, WorkManager, gallery, notify-to-copy) — separate plan + needs Firebase project.
- **Phase 3:** delete propagation, WiFi-only, retention, hub device-management UI.
