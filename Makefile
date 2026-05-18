.PHONY: install dev build test clean

install:
	uv sync
	cd web && pnpm install

dev:
	@echo "Start server: uv run python skill/viewer_server/server.py start"
	@echo "Start frontend: cd web && pnpm dev"

build:
	cd web && pnpm build

test:
	uv run pytest -v
	cd web && pnpm test

clean:
	rm -rf .runtime/server.pid .runtime/server.port
	rm -rf skill/viewer_server/static
