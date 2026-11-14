"""Your own computer as a generator ("pc"): a small worker script runs next to a local
Stable Diffusion (Forge / A1111 API) and pulls tasks from this server.

The worker connects out to the server (long polling), so the computer needs no open
ports and the server can live anywhere (Render, Docker). When the computer has not
polled recently, the provider is simply absent and the online generators are used.
"""
from __future__ import annotations

import asyncio
import base64
import time
import uuid
from dataclasses import dataclass, field

from .base import ImageRequest, ProviderError

ONLINE_SECONDS = 45      # the computer counts as online this long after its last poll
TASK_TIMEOUT = 240       # how long a task may take on the computer before falling back


@dataclass
class Task:
    id: str
    payload: dict
    future: asyncio.Future
    taken: float | None = None


@dataclass
class WorkerHub:
    """Tasks waiting for the computer, and its last sign of life."""
    last_seen: float = 0.0
    info: dict = field(default_factory=dict)
    queue: list[Task] = field(default_factory=list)
    tasks: dict[str, Task] = field(default_factory=dict)
    _wake: asyncio.Event | None = None

    def online(self) -> bool:
        return time.time() - self.last_seen < ONLINE_SECONDS

    def _event(self) -> asyncio.Event:
        if self._wake is None:
            self._wake = asyncio.Event()
        return self._wake

    async def submit(self, payload: dict, timeout: float = TASK_TIMEOUT) -> bytes:
        loop = asyncio.get_running_loop()
        task = Task(uuid.uuid4().hex, payload, loop.create_future())
        self.queue.append(task)
        self.tasks[task.id] = task
        self._event().set()
        try:
            return await asyncio.wait_for(task.future, timeout)
        except asyncio.TimeoutError as e:
            raise ProviderError("комп'ютер не встиг") from e
        finally:
            self.tasks.pop(task.id, None)
            if task in self.queue:
                self.queue.remove(task)

    async def next(self, wait: float, info: dict | None = None) -> Task | None:
        """Called by the worker: the next task, waiting up to `wait` seconds."""
        self.last_seen = time.time()
        if info:
            self.info = info
        deadline = time.time() + wait
        while True:
            if self.queue:
                task = self.queue.pop(0)
                task.taken = time.time()
                return task
            left = deadline - time.time()
            if left <= 0:
                return None
            ev = self._event()
            ev.clear()
            try:
                await asyncio.wait_for(ev.wait(), left)
            except asyncio.TimeoutError:
                return None
            finally:
                self.last_seen = time.time()

    def finish(self, task_id: str, image: bytes | None, error: str | None = None) -> bool:
        self.last_seen = time.time()
        task = self.tasks.get(task_id)
        if not task or task.future.done():
            return False
        if image:
            task.future.set_result(image)
        else:
            task.future.set_exception(ProviderError(error or "помилка на комп'ютері"))
        return True


HUB = WorkerHub()


class WorkerProvider:
    name = "pc"
    label = "Мій комп'ютер (локальна відеокарта)"
    free = True
    img2img = True

    def __init__(self, hub: WorkerHub = HUB) -> None:
        self.hub = hub
        model = hub.info.get("model")
        if model:
            self.label = f"Мій комп'ютер · {model}"

    async def generate(self, req: ImageRequest) -> bytes:
        if not self.hub.online():
            raise ProviderError("комп'ютер недоступний")
        w, h = req.dims
        payload = {"prompt": req.prompt, "negative": req.negative, "width": w, "height": h, "seed": req.seed}
        if req.init_image:
            payload["init_image"] = base64.b64encode(req.init_image).decode()
            payload["denoise"] = req.denoise
        if req.mask:
            payload["mask"] = base64.b64encode(req.mask).decode()
        return await self.hub.submit(payload)
