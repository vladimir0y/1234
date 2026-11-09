"""Tutu backend API."""
from __future__ import annotations

import base64
import binascii
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .body import BODY_PRESETS, BodyParams
from .body.model import build_cached
from .body.presets import find_preset
from .config import Settings, get_settings
from .jobs import JobRunner
from .prompts import NEGATIVE, STYLES, STYLES_LIST, build_prompt, needs_translation, shape_hint_from_aspect
from .providers import build_provider, provider_chain
from .providers.cloudflare import CloudflareProvider
from .providers.worker import HUB
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
    variants: int = Field(default=2, ge=1, le=4)
    region_aspect: float | None = Field(default=None, gt=0, le=50)
    provider: str | None = None
    width: int | None = Field(default=None, ge=256, le=2048)
    height: int | None = Field(default=None, ge=256, le=2048)
    # img2img: a guide image (base64 PNG/JPEG/WEBP) that keeps the composition's layout,
    # and how far the result may move away from it (0 = same, 1 = ignore the guide).
    init_image: str | None = Field(default=None, max_length=12_000_000)
    denoise: float = Field(default=0.6, ge=0.05, le=1.0)
    # Use the prompt as is (no tattoo-flash wrapping) - for full compositions.
    raw_prompt: bool = False


class ProjectBody(BaseModel):
    name: str = Field(default="Без назви", max_length=200)
    scan_id: str | None = None
    # Editor state: selected face indices, layers, brush strokes, etc.
    state: dict[str, Any] = Field(default_factory=dict)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    storage = Storage(settings.data_dir)
    jobs = JobRunner(storage)
    app = FastAPI(title="Tutu API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(GZipMiddleware, minimum_size=2048)

    def not_found(exc: NotFound) -> HTTPException:
        return HTTPException(status_code=404, detail="Not found")

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        chain = provider_chain(settings)
        return {"ok": True, "image_provider": chain[0].name if chain else None}

    @app.get("/api/providers")
    def providers() -> list[dict[str, Any]]:
        """Configured generators in the order they are tried."""
        return [{"id": p.name, "label": p.label, "free": p.free} for p in provider_chain(settings)]

    @app.get("/api/styles")
    def styles() -> list[dict[str, str]]:
        return [{"id": s.id, "label": s.label, "mode": s.mode, "description": s.prompt} for s in STYLES_LIST]

    # --- bodies ---------------------------------------------------------------
    @app.get("/api/bodies/presets")
    def body_presets() -> list[dict[str, Any]]:
        return BODY_PRESETS

    @app.get("/api/bodies/mesh")
    def body_mesh(
        preset: str | None = None,
        sex: float | None = None,
        height_cm: float | None = None,
        weight: float | None = None,
        muscle: float | None = None,
        breast: float | None = None,
        glutes: float | None = None,
        belly: float | None = None,
    ) -> Response:
        """Realistic body mesh (TUTB binary). Preset values can be overridden one by one."""
        values: dict[str, float] = {}
        if preset:
            found = find_preset(preset)
            if not found:
                raise HTTPException(404, f"Unknown preset '{preset}'")
            values.update(found["params"])
        overrides = dict(sex=sex, height_cm=height_cm, weight=weight, muscle=muscle,
                         breast=breast, glutes=glutes, belly=belly)
        values.update({k: v for k, v in overrides.items() if v is not None})
        # Round so near-identical slider values share the cache.
        params = BodyParams(**{k: round(float(v), 2) for k, v in values.items()}).clamped()
        return Response(
            build_cached(params),
            media_type="application/octet-stream",
            headers={"Cache-Control": "public, max-age=86400"},
        )

    # --- generation -------------------------------------------------------
    @app.post("/api/generate")
    async def generate(req: GenerateRequest) -> dict[str, Any]:
        """Start a generation job; poll GET /api/jobs/{id}."""
        style = STYLES.get(req.style)
        if not style:
            raise HTTPException(400, f"Unknown style '{req.style}'")
        if req.provider and build_provider(req.provider, settings) is None:
            raise HTTPException(400, f"Provider '{req.provider}' is not configured")
        init = None
        if req.init_image:
            try:
                init = base64.b64decode(req.init_image.split(",", 1)[-1], validate=True)
            except (binascii.Error, ValueError) as e:
                raise HTTPException(400, "init_image is not base64") from e
        chain = provider_chain(settings, req.provider, img2img=init is not None)
        if not chain:
            raise HTTPException(400, "No generator can follow a guide image right now")
        translator = build_provider("cloudflare", settings)

        async def prepare(text: str) -> str:
            # FLUX/SDXL understand English best; translate Ukrainian when we can.
            if needs_translation(req.prompt) and isinstance(translator, CloudflareProvider):
                try:
                    translated = await translator.translate(req.prompt)
                    return text.replace(req.prompt.strip(), translated.strip(), 1)
                except Exception:
                    return text
            return text

        prompt = req.prompt if req.raw_prompt else build_prompt(req.prompt, req.style, shape_hint_from_aspect(req.region_aspect))
        extra = {"width": req.width, "height": req.height, "init_image": init, "denoise": req.denoise}
        job = jobs.submit(chain, prompt, NEGATIVE, style.mode, req.variants, req.seed, req.size, prepare, extra)
        return job.public()

    # --- your own computer as a generator ------------------------------------
    def worker_auth(token: str | None) -> None:
        if not settings.worker_token or token != settings.worker_token:
            raise HTTPException(401, "Bad worker token")

    @app.get("/api/worker/next")
    async def worker_next(wait: float = 25, model: str | None = None,
                          x_tutu_worker: str | None = Header(default=None)) -> Response:
        """Long poll for the computer's worker: 200 with a task, or 204 when there is none."""
        worker_auth(x_tutu_worker)
        task = await HUB.next(min(max(wait, 0), 30), {"model": model} if model else None)
        if not task:
            return Response(status_code=204)
        return JSONResponse({"id": task.id, **task.payload})

    @app.post("/api/worker/result/{task_id}")
    async def worker_result(task_id: str, request: Request, error: str | None = None,
                            x_tutu_worker: str | None = Header(default=None)) -> dict[str, bool]:
        worker_auth(x_tutu_worker)
        body = await request.body()
        return {"accepted": HUB.finish(task_id, body or None, error)}

    @app.get("/api/worker/status")
    def worker_status() -> dict[str, Any]:
        return {"configured": bool(settings.worker_token), "online": HUB.online(), **HUB.info}

    @app.get("/api/jobs/{job_id}")
    def job_status(job_id: str) -> dict[str, Any]:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "Not found")
        return job.public()

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
