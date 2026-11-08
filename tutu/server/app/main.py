"""Tutu backend API."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import Settings, get_settings
from .prompts import STYLES, build_prompt, shape_hint_from_aspect
from .providers import get_provider
from .storage import NotFound, Storage

MEDIA_TYPES = {
    "obj": "text/plain",
    "ply": "application/octet-stream",
    "stl": "model/stl",
    "glb": "model/gltf-binary",
    "gltf": "model/gltf+json",
    "usdz": "model/vnd.usdz+zip",
}


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=2, max_length=1000)
    style: str = "fine-line"
    size: int = Field(default=1024, ge=256, le=2048)
    seed: int | None = None
    region_aspect: float | None = Field(default=None, gt=0, le=50)
    provider: str | None = None


class GenerateResponse(BaseModel):
    image_id: str
    url: str
    provider: str
    prompt: str


class ProjectBody(BaseModel):
    name: str = Field(default="Без назви", max_length=200)
    scan_id: str | None = None
    # Editor state: selected face indices, layers, brush strokes, etc.
    state: dict[str, Any] = Field(default_factory=dict)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    storage = Storage(settings.data_dir)
    app = FastAPI(title="Tutu API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def not_found(exc: NotFound) -> HTTPException:
        return HTTPException(status_code=404, detail="Not found")

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        provider = get_provider(settings).name
        return {"ok": True, "image_provider": provider}

    @app.get("/api/styles")
    def styles() -> list[dict[str, str]]:
        return [{"id": k, "description": v} for k, v in STYLES.items()]

    # --- generation -------------------------------------------------------
    @app.post("/api/generate", response_model=GenerateResponse)
    async def generate(req: GenerateRequest) -> GenerateResponse:
        if req.style not in STYLES:
            raise HTTPException(400, f"Unknown style '{req.style}'")
        try:
            provider = get_provider(settings, req.provider)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        prompt = build_prompt(req.prompt, req.style, shape_hint_from_aspect(req.region_aspect))
        try:
            png = await provider.generate(prompt, req.size, req.seed)
        except Exception as e:  # provider/network failures
            raise HTTPException(502, f"Generation failed: {e}") from e
        image_id = storage.save_image(png)
        return GenerateResponse(
            image_id=image_id, url=f"/api/images/{image_id}", provider=provider.name, prompt=prompt
        )

    @app.get("/api/images/{image_id}")
    def get_image(image_id: str) -> FileResponse:
        try:
            return FileResponse(storage.image_file(image_id), media_type="image/png")
        except NotFound as e:
            raise not_found(e) from e

    # --- scans ------------------------------------------------------------
    @app.post("/api/scans")
    async def upload_scan(file: UploadFile = File(...), name: str = Form("Скан")) -> dict[str, Any]:
        fmt = Path(file.filename or "").suffix.lstrip(".").lower()
        data = await file.read()
        if len(data) > settings.max_scan_mb * 1024 * 1024:
            raise HTTPException(413, "Scan is too large")
        if not data:
            raise HTTPException(400, "Empty file")
        try:
            return storage.save_scan(data, fmt, name)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e

    @app.get("/api/scans")
    def list_scans() -> list[dict[str, Any]]:
        return storage.list_scans()

    @app.get("/api/scans/{scan_id}")
    def scan_meta(scan_id: str) -> dict[str, Any]:
        try:
            return storage.scan_meta(scan_id)
        except NotFound as e:
            raise not_found(e) from e

    @app.get("/api/scans/{scan_id}/mesh")
    def scan_mesh(scan_id: str) -> FileResponse:
        try:
            path = storage.scan_file(scan_id)
        except NotFound as e:
            raise not_found(e) from e
        fmt = path.suffix.lstrip(".")
        return FileResponse(path, media_type=MEDIA_TYPES.get(fmt), filename=f"scan.{fmt}")

    @app.delete("/api/scans/{scan_id}")
    def delete_scan(scan_id: str) -> dict[str, bool]:
        try:
            storage.delete_scan(scan_id)
        except NotFound as e:
            raise not_found(e) from e
        return {"ok": True}

    # --- projects ---------------------------------------------------------
    @app.post("/api/projects")
    def create_project(body: ProjectBody) -> dict[str, Any]:
        return storage.create_project(body.model_dump())

    @app.get("/api/projects")
    def list_projects() -> list[dict[str, Any]]:
        return storage.list_projects()

    @app.get("/api/projects/{project_id}")
    def get_project(project_id: str) -> dict[str, Any]:
        try:
            return storage.get_project(project_id)
        except NotFound as e:
            raise not_found(e) from e

    @app.put("/api/projects/{project_id}")
    def update_project(project_id: str, body: ProjectBody) -> dict[str, Any]:
        try:
            return storage.update_project(project_id, body.model_dump())
        except NotFound as e:
            raise not_found(e) from e

    @app.delete("/api/projects/{project_id}")
    def delete_project(project_id: str) -> dict[str, bool]:
        try:
            storage.delete_project(project_id)
        except NotFound as e:
            raise not_found(e) from e
        return {"ok": True}

    # Serve the built web editor (tutu/web/dist) if present.
    web_dist = Path(__file__).resolve().parents[2] / "web" / "dist"
    if web_dist.exists():
        app.mount("/", StaticFiles(directory=web_dist, html=True), name="web")

    return app


app = create_app()
