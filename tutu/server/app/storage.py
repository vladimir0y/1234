"""File-based storage for scans, projects and generated images.

Simple on purpose: one folder per kind, JSON metadata next to binary blobs.
Swap for S3 + Postgres in stage 6 without touching the API layer.
"""
from __future__ import annotations

import json
import re
import time
import uuid
from pathlib import Path
from typing import Any

_ID_RE = re.compile(r"^[a-f0-9]{32}$")
SCAN_FORMATS = {"obj", "glb", "gltf", "ply", "stl", "usdz"}


class NotFound(Exception):
    pass


def _check_id(item_id: str) -> str:
    if not _ID_RE.match(item_id):
        raise NotFound(item_id)
    return item_id


class Storage:
    def __init__(self, root: Path) -> None:
        self.root = root
        for kind in ("scans", "projects", "images"):
            (root / kind).mkdir(parents=True, exist_ok=True)

    # --- scans -------------------------------------------------------------
    def save_scan(self, data: bytes, fmt: str, name: str) -> dict[str, Any]:
        fmt = fmt.lower()
        if fmt not in SCAN_FORMATS:
            raise ValueError(f"Unsupported mesh format: {fmt}")
        scan_id = uuid.uuid4().hex
        folder = self.root / "scans" / scan_id
        folder.mkdir()
        (folder / f"mesh.{fmt}").write_bytes(data)
        meta = {
            "id": scan_id,
            "name": name,
            "format": fmt,
            "bytes": len(data),
            "created_at": time.time(),
        }
        (folder / "meta.json").write_text(json.dumps(meta))
        return meta

    def scan_meta(self, scan_id: str) -> dict[str, Any]:
        path = self.root / "scans" / _check_id(scan_id) / "meta.json"
        if not path.exists():
            raise NotFound(scan_id)
        return json.loads(path.read_text())

    def scan_file(self, scan_id: str) -> Path:
        meta = self.scan_meta(scan_id)
        return self.root / "scans" / scan_id / f"mesh.{meta['format']}"

    def list_scans(self) -> list[dict[str, Any]]:
        out = []
        for meta in (self.root / "scans").glob("*/meta.json"):
            out.append(json.loads(meta.read_text()))
        return sorted(out, key=lambda m: m["created_at"], reverse=True)

    def delete_scan(self, scan_id: str) -> None:
        folder = self.root / "scans" / _check_id(scan_id)
        if not folder.exists():
            raise NotFound(scan_id)
        for f in folder.iterdir():
            f.unlink()
        folder.rmdir()

    # --- projects ----------------------------------------------------------
    def _project_path(self, project_id: str) -> Path:
        return self.root / "projects" / f"{_check_id(project_id)}.json"

    def create_project(self, body: dict[str, Any]) -> dict[str, Any]:
        project_id = uuid.uuid4().hex
        now = time.time()
        project = {**body, "id": project_id, "created_at": now, "updated_at": now}
        self._project_path(project_id).write_text(json.dumps(project))
        return project

    def get_project(self, project_id: str) -> dict[str, Any]:
        path = self._project_path(project_id)
        if not path.exists():
            raise NotFound(project_id)
        return json.loads(path.read_text())

    def update_project(self, project_id: str, body: dict[str, Any]) -> dict[str, Any]:
        current = self.get_project(project_id)
        project = {
            **current,
            **body,
            "id": project_id,
            "created_at": current["created_at"],
            "updated_at": time.time(),
        }
        self._project_path(project_id).write_text(json.dumps(project))
        return project

    def list_projects(self) -> list[dict[str, Any]]:
        out = []
        for path in (self.root / "projects").glob("*.json"):
            p = json.loads(path.read_text())
            out.append({k: p.get(k) for k in ("id", "name", "scan_id", "created_at", "updated_at")})
        return sorted(out, key=lambda m: m["updated_at"], reverse=True)

    def delete_project(self, project_id: str) -> None:
        path = self._project_path(project_id)
        if not path.exists():
            raise NotFound(project_id)
        path.unlink()

    # --- generated images --------------------------------------------------
    def save_image(self, png: bytes) -> str:
        image_id = uuid.uuid4().hex
        (self.root / "images" / f"{image_id}.png").write_bytes(png)
        return image_id

    def image_file(self, image_id: str) -> Path:
        path = self.root / "images" / f"{_check_id(image_id)}.png"
        if not path.exists():
            raise NotFound(image_id)
        return path
