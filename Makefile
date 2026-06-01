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
	ln -sfn ../../skills/character   .claude/skills/character
	ln -sfn ../../skills/promo       .claude/skills/promo
	ln -sfn ../../skills/turnaround  .claude/skills/turnaround
	ln -sfn ../../skills/viewer-server        .claude/skills/viewer-server
	@echo "Linked: .claude/skills/{character,promo,turnaround,viewer-server} → skills/*"
	@echo "Restart Claude Code session to pick up the new skills."

dev-unlink:
	rm -f .claude/skills/character .claude/skills/promo .claude/skills/turnaround .claude/skills/viewer-server
	@echo "Unlinked. Claude Code will fall back to ~/.claude/skills/ (if installed there)."
