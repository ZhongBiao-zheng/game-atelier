"""Daily service logs shared by foreground tasks and detached desktop launches."""
from pathlib import Path


def log_config(runtime: Path) -> dict:
    runtime.mkdir(parents=True, exist_ok=True)
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {"default": {"format": "%(asctime)s %(levelname)s %(name)s: %(message)s"}},
        "filters": {"secrets": {"()": "character_workflow.lib.secret_filter.SecretRedactionFilter"}},
        "handlers": {"daily": {
            "class": "logging.handlers.TimedRotatingFileHandler",
            "filename": str(runtime / "server.log"),
            "when": "midnight", "backupCount": 14, "encoding": "utf-8",
            "formatter": "default",
            "filters": ["secrets"],
        }},
        "root": {"handlers": ["daily"], "level": "INFO"},
        "loggers": {
            "uvicorn": {"handlers": ["daily"], "level": "INFO", "propagate": False},
            "uvicorn.error": {"handlers": [], "level": "INFO", "propagate": True},
            "uvicorn.access": {"handlers": ["daily"], "level": "INFO", "propagate": False},
        },
    }
