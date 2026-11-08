"""In-process generation jobs.

Generation takes seconds to minutes, so the API answers at once with a job id
and the client polls. This is the seam where a Redis queue (Arq) plugs in later
(see docs/ARCHITECTURE.md); the HTTP contract stays the same.
"""
from __future__ import annotations

import asyncio
import random
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from .imaging import to_tattoo_png
from .providers import ImageProvider, ImageRequest, ProviderError
from .storage import Storage

JOB_TTL = 3600


@dataclass
class Job:
    id: str
    prompt: str
    status: str = "queued"  # queued | running | done | error
    message: str = "У черзі"
    images: list[dict[str, Any]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    created: float = field(default_factory=time.time)

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "status": self.status, "message": self.message,
                "images": self.images, "errors": self.errors, "prompt": self.prompt}


class JobRunner:
    def __init__(self, storage: Storage) -> None:
        self.storage = storage
        self.jobs: dict[str, Job] = {}
        self._tasks: set[asyncio.Task] = set()

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def _cleanup(self) -> None:
        now = time.time()
        for jid in [j for j, job in self.jobs.items() if now - job.created > JOB_TTL]:
            del self.jobs[jid]

    def submit(
        self,
        chain: list[ImageProvider],
        prompt: str,
        negative: str,
        mode: str,
        variants: int,
        seed: int | None,
        size: int,
        prepare: Callable[[str], Awaitable[str]] | None = None,
    ) -> Job:
        self._cleanup()
        job = Job(id=uuid.uuid4().hex, prompt=prompt)
        self.jobs[job.id] = job
        task = asyncio.create_task(self._run(job, chain, negative, mode, variants, seed, size, prepare))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return job

    async def _run(self, job: Job, chain, negative, mode, variants, seed, size, prepare) -> None:  # noqa: ANN001
        job.status = "running"
        try:
            if prepare:
                job.message = "Перекладаю опис…"
                job.prompt = await prepare(job.prompt)
            base_seed = seed if seed is not None else random.randint(1, 2**31 - 1)
            for i in range(variants):
                req = ImageRequest(prompt=job.prompt, negative=negative, size=size, seed=base_seed + i)
                job.message = f"Генерую варіант {i + 1} з {variants}…"
                image = await self._one(job, chain, req, mode)
                if image:
                    job.images.append(image)
            if job.images:
                job.status, job.message = "done", "Готово"
            else:
                job.status, job.message = "error", "Жоден генератор не відповів"
        except Exception as e:  # pragma: no cover - safety net
            job.status, job.message = "error", f"Помилка: {e}"

    async def _one(self, job: Job, chain: list[ImageProvider], req: ImageRequest, mode: str) -> dict[str, Any] | None:
        for provider in chain:
            try:
                raw = await provider.generate(req)
                png = await asyncio.to_thread(to_tattoo_png, raw, mode)
            except ProviderError as e:
                job.errors.append(f"{provider.name}: {e}")
                continue
            except Exception as e:  # network errors, bad images
                job.errors.append(f"{provider.name}: {type(e).__name__}: {e}")
                continue
            image_id = self.storage.save_image(png)
            return {"image_id": image_id, "url": f"/api/images/{image_id}", "provider": provider.name, "seed": req.seed}
        return None
