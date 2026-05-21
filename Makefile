.PHONY: install dev build test clean dev-link dev-unlink

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

# 把项目内 Skill 链接到 .claude/skills/，Claude Code 即可发现所有 /character-* 命令
# 编辑 skill/*/SKILL.md 立即生效，无需复制部署
dev-link:
	mkdir -p .claude/skills
	ln -sfn ../../skill/character_workflow   .claude/skills/character-workflow
	ln -sfn ../../skill/character_promo      .claude/skills/character-promo
	ln -sfn ../../skill/character_turnaround .claude/skills/character-turnaround
	ln -sfn ../../skill/viewer_server        .claude/skills/viewer-server
	@echo "Linked: .claude/skills/{character-workflow,character-promo,character-turnaround,viewer-server} → skill/*"
	@echo "Restart Claude Code session to pick up the new skills."

dev-unlink:
	rm -f .claude/skills/character-workflow .claude/skills/character-promo .claude/skills/character-turnaround .claude/skills/viewer-server
	@echo "Unlinked. Claude Code will fall back to ~/.claude/skills/ (if installed there)."
