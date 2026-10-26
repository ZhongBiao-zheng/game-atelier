.PHONY: install dev studio build test verify clean dev-link dev-unlink release

install:
	uv sync
	cd web && pnpm install

studio:
	@bash scripts/studio.sh

dev:
	@echo "Start server: GAME_ATELIER_DEV_ORIGIN=http://localhost:5173 uv run python src/viewer_server/server.py start"
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

# 只有获得发布授权后才运行；定义直接保存在 Makefile，避免另建发布脚本。
PYTHON ?= python3
define RELEASE_COMMAND
import json, re, subprocess, sys, time
from pathlib import Path

def fail(message):
    print("无法发布：" + message, file=sys.stderr)
    sys.exit(1)

def git(*args):
    result = subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8", timeout=30)
    if result.returncode:
        fail("git " + args[0] + " 失败，请检查仓库和网络")
    return result.stdout.strip()

if git("branch", "--show-current") != "main":
    fail("当前分支必须是 main")
if git("status", "--porcelain"):
    fail("工作区必须干净（包括未跟踪文件）")
version = json.loads(Path(".claude-plugin/plugin.json").read_text(encoding="utf-8"))["version"]
if not isinstance(version, str) or not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", version):
    fail("版本号必须是正式三段版本")
first = re.search(r"version:\s*['\"]([^'\"]+)['\"]", Path("web/src/lib/changelog.ts").read_text(encoding="utf-8"))
if not first or first.group(1) != version:
    fail("更新日志最新一条必须与 plugin.json 版本一致")
tag = "v" + version
if git("tag", "--list", tag):
    fail("本地已存在 " + tag)
remote = dict(line.split()[::-1] for line in git("ls-remote", "origin", "refs/heads/main", "refs/tags/" + tag).splitlines())
if "refs/tags/" + tag in remote:
    fail("远端已存在 " + tag)
if remote.get("refs/heads/main") != git("rev-parse", "HEAD"):
    fail("HEAD 与远端 main 不一致，请先同步并推送发版提交")
# 在所有检查后才创建 tag；不覆盖既有 tag。推送失败保留本地 tag 供人工检查。
git("tag", tag)
git("push", "origin", "refs/tags/" + tag)
print("已推送 " + tag)
# Actions 创建 run 有短暂延迟；链接查询失败不改变已成功的发布请求。
for attempt in range(5):
    try:
        result = subprocess.run(["gh", "run", "list", "--workflow", "release.yml", "--branch", tag,
                                 "--event", "push", "--limit", "1", "--json", "url"],
                                capture_output=True, text=True, timeout=5)
        runs = json.loads(result.stdout) if result.returncode == 0 else []
        if runs:
            print(runs[0]["url"])
            break
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    if attempt < 4:
        time.sleep(1)
else:
    print("发布运行尚未可查询：https://github.com/ZhongBiao-zheng/game-atelier/actions/workflows/release.yml")
endef
export RELEASE_COMMAND

release:
	@$(PYTHON) -c "$$RELEASE_COMMAND"
