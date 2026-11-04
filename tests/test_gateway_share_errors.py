"""共享错误翻译不能改变其他路由的状态码或吞掉服务器 traceback。"""
import logging
import socket
import threading
import time

import pytest
import requests
import uvicorn

from viewer_server.gateway_app import create_gateway_app
from viewer_server.server_app import build_app


@pytest.mark.parametrize('factory', [build_app, create_gateway_app], ids=['viewer', 'gateway'])
@pytest.mark.parametrize('error_type', [OSError, requests.ConnectionError], ids=['disk', 'network'])
def test_unrelated_oserror_keeps_500_and_traceback(factory, error_type, caplog, monkeypatch):
    app = factory()
    async def probe():
        raise error_type('unrelated-route-failure')
    app.add_api_route('/error-probe', probe)
    app.router.routes.insert(0, app.router.routes.pop())
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=port,
            lifespan='off', ws='none', log_config=None, access_log=False))
        thread = threading.Thread(target=server.run, kwargs={'sockets': [sock]}, daemon=True)
        # 其他真实服务测试可能关闭 uvicorn 向 root 的传播，直接捕获源 logger。
        monkeypatch.setattr(logging.getLogger('uvicorn.error'), 'handlers', [caplog.handler])
        with caplog.at_level(logging.ERROR, logger='uvicorn.error'):
            thread.start()
            try:
                for _ in range(100):
                    if server.started:
                        break
                    time.sleep(.01)
                with requests.Session() as session:
                    session.trust_env = False
                    response = session.get(f'http://127.0.0.1:{port}/error-probe', timeout=3)
                assert response.status_code == 500
                for _ in range(100):
                    if any(record.exc_info for record in caplog.records):
                        break
                    time.sleep(.01)
                assert any(record.exc_info for record in caplog.records)
                assert 'Traceback (most recent call last)' in caplog.text
                assert 'unrelated-route-failure' in caplog.text
            finally:
                server.should_exit = True
                thread.join(timeout=5)
