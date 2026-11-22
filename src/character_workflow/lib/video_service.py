"""The host's video worker lives on the server event loop, across plugin reloads."""
import asyncio
from weakref import WeakKeyDictionary

from .video_encoder import metadata
from .video_operations import VideoQueue, source
from .video_render import VideoRenderer


class VideoService:
    def __init__(self):
        self.renderer = VideoRenderer()
        self.queue = VideoQueue(self.renderer.render)

    async def probe(self, project, version):
        path, _ = await asyncio.to_thread(source, project, version)
        from .canvas_projects import canvas_project_dir

        directory = await asyncio.to_thread(canvas_project_dir, project)
        native = await self.renderer.encoder(directory)
        return {"version_id": version, **await metadata(native, path)}


_services = WeakKeyDictionary()


def service():
    loop = asyncio.get_running_loop()
    if loop not in _services:
        _services[loop] = VideoService()
    return _services[loop]


async def stop_service():
    current = _services.pop(asyncio.get_running_loop(), None)
    if current is not None:
        await current.queue.close()
