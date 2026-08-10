.PHONY: install dev studio build test clean dev-link dev-unlink

install:
	uv sync
	cd web && pnpm install

studio:
	@bash scripts/studio.sh

dev:
	@echo "Start server: uv run python src/viewer_server/server.py start"
	@echo "Start frontend: cd web && pnpm dev"

build:
	rm -rf web/dist  # 必须先清：tailwind v4 vite 插件会把旧 dist/* 扫进 content 源，over-existing 构建非幂等，与 CI clean build 不一致
	cd web && pnpm build

test:
	uv run pytest -v
	cd web && pnpm test

clean:
	rm -rf .runtime/server.pid .runtime/server.port
	rm -rf web/dist src/viewer_server/static

# 把项目内 Skill 链接到 .claude/skills/，Claude Code 即可发现本地开发命令
# 编辑 skills/*/SKILL.md 立即生效，无需复制部署
dev-link:
	mkdir -p .claude/skills
	@find .claude/skills -maxdepth 1 -type l ! -exec test -e {} \; -delete
	@for d in skills/*/; do \
		n=$$(basename $$d); \
		ln -sfn ../../skills/$$n .claude/skills/$$n; \
		echo "Linked: .claude/skills/$$n → skills/$$n"; \
	done
	@echo "Restart Claude Code session to pick up the new skills."

dev-unlink:
	@find .claude/skills -maxdepth 1 -type l -delete 2>/dev/null || true
	@echo "Unlinked. Claude Code will fall back to ~/.claude/skills/ (if installed there)."
