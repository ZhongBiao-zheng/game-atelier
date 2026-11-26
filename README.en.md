# Cobrush

The AI canvas for creating together: share models, canvases and assets with your team.

[![Release](https://img.shields.io/github/v/release/ZhongBiao-zheng/game-atelier?label=version)](https://github.com/ZhongBiao-zheng/game-atelier/releases/latest) [![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)](https://github.com/ZhongBiao-zheng/game-atelier/releases/latest)

[简体中文](README.md) · **English**

Cobrush runs on your own computer: lay out assets and connect nodes on a canvas, call models from several providers to make images and videos, and keep every result and file on your machine. Turn on the team gateway and teammates on the same local network can use the models you connected without setting up keys of their own; share a canvas you are halfway through and they can keep working on it. Models come from the providers you configure. Cobrush does not sell models and never handles your work.

> [!NOTE]
> The app interface is in Simplified Chinese only.

## Install

### Option 1: Release package (recommended)

1. Download the package for your platform from [Releases](https://github.com/ZhongBiao-zheng/game-atelier/releases/latest): `GameAtelier-<version>-windows-x64.zip`, `-macos-arm64.tar.gz` or `-linux-x64.tar.gz`.
2. Extract the whole archive into a writable folder.
3. Double-click 「启动」 (Start) in the extracted folder.

No Git, uv, Python or Node needed. Later versions update inside the app. Folder layout and how to move the install folder: [`docs/release-notes.md`](docs/release-notes.md) (Chinese).

### Option 2: Source (to read or change the code)

```bash
git clone https://github.com/ZhongBiao-zheng/game-atelier.git
# Mirror in mainland China, synced with GitHub main:
# git clone https://cnb.cool/ZhongBiao-zheng/game-atelier.git
```

Double-click the launcher for your system: `Mac一键启动.command`, `Windows一键启动.bat` or `Linux一键启动.desktop`. The launcher prepares the runtime and checks for updates.

### Optional: connect Claude Code / Codex

Install this only if you want an external agent to work on your local canvas. From the plugin marketplace:

```bash
claude plugin marketplace add ZhongBiao-zheng/game-atelier
claude plugin install game-atelier@atelier
```

Or, in the source folder, run the install script. It detects the agents installed on this machine (Claude Code / Codex) and links the skills into them:

```bash
# macOS / Linux
./install.sh

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The script reports each agent as installed or skipped; restart the agent afterwards. Run the script again after updating the source; the one-click launcher does this for you. Add `--uninstall` to remove.

To load the plugin for the current session only, without installing:

```bash
claude --plugin-dir .
```

> Step-by-step Windows guide: [`docs/windows-install-checklist.md`](docs/windows-install-checklist.md) (Chinese).
>
> Team library folder format, for other tools that read or write it: [`docs/team-library-format.md`](docs/team-library-format.md) (Chinese).

---

## First launch

A local page opens in your browser; follow it to finish setup (with Claude Code connected you can also run `/game-atelier:viewer-server`):

1. **Data folder** — defaults to `~/game-atelier/` (you can choose another)
2. **Python environment** — bundled in the release package; the source version creates `.venv` inside the data folder automatically
3. **API key** — add an image provider key on the settings page of the local web UI
4. **Agent access** — Settings → Local agent connection: pick projects and capabilities, then configure Codex / Claude following the [local MCP guide](docs/mcp-local-client.md) (Chinese)

External agents work on projects through the `canvas_*` MCP tools and must get explicit confirmation before any paid generation. Credentials stay in protected files on your machine.

## Agent commands (with Claude Code connected)

| Command | What it does |
|---|---|
| `/game-atelier:viewer-server` | Start Cobrush locally |
| `/game-atelier:canvas` | Edit a project canvas through the authorized tools |

## Typical loop

1. Open Cobrush and create a project from the canvas page.
2. Add project specs, reference assets and generation nodes.
3. Confirm a generation on the canvas or in the studio, review the results, and finalize the good ones into the reference library.
4. Keep editing with the built-in agent or an authorized external agent.

## Data folder

Data lives apart from the program; deleting or moving the install folder does not delete your assets.

```
~/game-atelier/
├── canvases/<project_id>/    # project documents, specs, notes and media
├── studio/<job_id>/          # studio results
├── creation-assets/          # creation asset library
├── .runtime/jobs/            # current jobs
└── .config/keys.json         # model provider settings
```

Files under the old workshop's characters/ and projects/ are kept as they were; archive them by hand if you like. Why the workshop was retired: [ADR-0027](docs/adr/0027-canvas-project-is-the-project.md) (Chinese).

## Supported image providers

Any image service with an **OpenAI-compatible API** works once you add its key, which covers most models on the market:

- **OpenAI**: the gpt-image series, high-quality photorealism
- **Volcengine / Doubao Seedream**: ByteDance models, good with Chinese prompts
- **Third-party aggregators**: one key for several model families (such as gpt-image and nano-banana); size, aspect ratio and quality controls are detected from the modelId
- **Custom OpenAI-compatible endpoints**: enter a base URL and a key

Add keys on the settings page of the web UI. In a conversation you can switch by saying "use model X for this one". Size, aspect ratio and quality controls adapt to each model family.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Source version says `uv` is not installed | Install it with the command the launcher prints, or see the [uv docs](https://docs.astral.sh/uv/); the release package does not need it |
| Port 5174 is taken | viewer-server moves to the next free port, recorded in `.runtime/server.port` |
| Web UI did not open | Double-click the launcher again |
| Agent reports no access / no MCP tools | Create a project grant in local settings and configure the client per the MCP guide; do not fall back to direct generation commands |
| Another page is editing | Keep the old page's draft first, then take over explicitly; do not edit in two pages at once |
| Wrong API key | Update it, or delete and add it again, on the web settings page |
| Stale server.pid | Detected and cleaned up at startup |
| Update blocked by local changes in `web/dist` | Double-click `Mac一键修复.command` or `Windows一键修复.bat` |

### One-click update / repair

The source repository keeps a prebuilt `web/dist`, so a fresh download or `git clone` does not need Node / pnpm. The one-click launcher only reads these built files; it never rebuilds or rewrites them at startup.

The one-click launcher and the skills share the `.venv` inside the data folder (default `~/game-atelier/.venv`). The first launch prepares it; after that, dependencies sync only when `pyproject.toml`, `uv.lock`, `.python-version` or the source install path changes, so ordinary source updates and repeated launches do not reinstall. Before syncing, local services that hold the environment are stopped so Windows file locks do not block the install; a failed install stops the launch instead of carrying on with the old environment.

Python itself downloads from npmmirror, and Python packages and build tools from the Tsinghua mirror; the download URLs in `uv.lock` point to that mirror too. Installs follow the locked versions, and the lock file is never rewritten at startup. An existing environment syncs once after moving to this launch flow.

If an old one-click launcher left changes in `web/dist`, double-click the "one-click repair" script for your system. It checks itself first, restores only the regenerable `web/dist`, then runs a fast-forward update; project assets, settings and any other source changes are left alone.

You can run the same safe recovery by hand in the project root:

```bash
git restore --source=HEAD --staged --worktree -- web/dist
git clean -fd -- web/dist
git pull --ff-only
```

On older Git without `git restore`, replace the first line with `git checkout HEAD -- web/dist`. A ZIP download has no Git history and cannot update in place; download the latest version again. Your project assets stay in the separate data folder.

---

## Local development

```bash
# Install dependencies
make install

# Link local skills into Claude Code (restart Claude Code afterwards)
make dev-link

# Start (two terminals)
GAME_ATELIER_DEV_ORIGIN=http://localhost:5173 uv run python src/viewer_server/server.py start # backend
cd web && pnpm dev                                  # frontend

# Test
make test

# Pre-release checks (clean build and refresh the committed web/dist)
make build
uv run python scripts/check_plugin.py
claude plugin validate .
```

The dev page runs at `http://localhost:5173`; if you change the frontend port, update `GAME_ATELIER_DEV_ORIGIN` too (no wildcard origins).
The variable is only for the Vite dev proxy; you do not need it when using the built local page.

---

## Security

- viewer-server **binds to `127.0.0.1` only** and is not exposed to the network
- Projects, media, downloads and SSE require a local session; agents use only the canvas_* tools with canvas_read / canvas_edit / canvas_generate grants, and paid operations need a human confirmation
- API keys are stored locally in `.config/keys.json` and never written to logs or conversations
- The image read endpoint uses a job_id allowlist and can only access registered output files
