"""鉴权后的成员上传协议；文件收取流式执行，磁盘操作不阻塞事件循环。"""
import asyncio
import hashlib

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from character_workflow.lib import gateway_share_store as store
from character_workflow.lib.gateway_share_models import MAX_FILE_BYTES, SharedLibraryManifest


def create_router(require_key):
    router = APIRouter(prefix='/gateway/v1/shares')

    @router.put('/{share_id}/manifest')
    def manifest(share_id: str, body: SharedLibraryManifest, key=Depends(require_key)):
        return {'missing': store.stage(key.id, share_id, body.model_dump())}

    @router.put('/{share_id}/blobs/{sha}')
    async def upload(share_id: str, sha: str, request: Request, key=Depends(require_key)):
        expected = await asyncio.to_thread(store.upload_expected, key.id, share_id, sha)
        temp = await asyncio.to_thread(store.temporary_upload)
        size, digest = 0, hashlib.sha256()
        try:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_FILE_BYTES or size > expected:
                    raise store.ShareError(413, '文件过大')
                digest.update(chunk)
                await asyncio.to_thread(store.write_upload, temp, chunk)
            await asyncio.to_thread(store.close_upload, temp)
            await asyncio.to_thread(store.finish_upload, key.id, share_id, sha, temp.name, digest.hexdigest(), size)
        finally:
            await asyncio.to_thread(store.discard_upload, temp)
        return {'ok': True}

    @router.post('/{share_id}/commit')
    def commit(share_id: str, key=Depends(require_key)):
        store.commit(key.id, share_id)
        return {'ok': True}

    @router.delete('/{share_id}')
    def delete(share_id: str, key=Depends(require_key)):
        store.delete(key.id, share_id)
        return {'ok': True}

    return router


def install_errors(app):
    @app.exception_handler(store.ShareError)
    async def share_error(_request, error):
        body = {'detail': error.detail}
        if error.missing is not None:
            body['missing'] = error.missing
        return JSONResponse(body, status_code=error.status)

