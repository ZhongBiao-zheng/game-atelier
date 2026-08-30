.PHONY: install dev studio build test verify clean dev-link dev-unlink

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

# 本地交付守门，覆盖当前主机的 CI 主路径。先 stage 预期的 web/dist 更新；clean build 后若仍产生 unstaged
# 产物或新文件，说明源码与待提交静态包不一致。
verify:
	uv run ruff check src scripts tests
	uv run pytest -v
	cd web && pnpm test
	cd web && pnpm lint
	$(MAKE) build
	uv run python scripts/check_plugin.py
	bash scripts/check_no_project_root.sh
	git diff --check
	git diff --cached --check
	@ git diff --quiet -- web/dist || (echo "web/dist clean build 后仍有未暂存差异；请重新 stage 构建产物。" && git --no-pager diff --stat -- web/dist && exit 1)
	@ test -z "$$(git ls-files --others --exclude-standard web/dist)" || (echo "web/dist clean build 产生未跟踪文件；请检查并 stage 构建产物。" && git ls-files --others --exclude-standard web/dist && exit 1)
	@ echo "Local verification OK"

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
