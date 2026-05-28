import io
import logging

from character_workflow.lib.secret_filter import SecretRedactionFilter


def _build_logger(name: str) -> tuple[logging.Logger, io.StringIO]:
    h = io.StringIO()
    logger = logging.getLogger(name)
    logger.handlers.clear()
    handler = logging.StreamHandler(h)
    handler.addFilter(SecretRedactionFilter())
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    return logger, h


def test_redacts_access_key_in_message():
    logger, h = _build_logger("test-redact-1")
    logger.info("calling with access_key=ak_supersecret")
    assert "ak_supersecret" not in h.getvalue()
    assert "access_key=***" in h.getvalue()


def test_redacts_secret_key_in_message():
    logger, h = _build_logger("test-redact-2")
    logger.info("secret_key=sk_xyz123")
    assert "sk_xyz123" not in h.getvalue()


def test_redacts_in_args_dict():
    logger, h = _build_logger("test-redact-3")
    logger.info("payload: %s", {"access_key": "leak_me", "alias": "x"})
    assert "leak_me" not in h.getvalue()


def test_does_not_alter_safe_messages():
    logger, h = _build_logger("test-redact-4")
    logger.info("hello world")
    assert "hello world" in h.getvalue()
