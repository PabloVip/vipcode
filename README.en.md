# vipcode

[![npm](https://img.shields.io/npm/v/vipcode.svg)](https://www.npmjs.com/package/vipcode) [![Tests](https://github.com/PabloVip/vipcode/actions/workflows/ci.yml/badge.svg)](https://github.com/PabloVip/vipcode/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) · [Español](README.md)

A coding agent for your terminal (command `vipcode`) that only uses **free AI models** and **automatically switches provider** when one runs out. The interface and messages are in Spanish.

![vipcode fixing a bug in carrito.js: it reads the file, shows the change, asks for permission and applies it](https://raw.githubusercontent.com/PabloVip/vipcode/main/docs/demo.svg)

- **Works right after installing, with no keys or sign-up**: it uses providers that allow anonymous access (Kilo Gateway, OVHcloud, LLM7 and Pollinations).
- For higher limits and better models, add free keys from the 20+ included providers (Gemini, NVIDIA, Mistral, Cerebras, OpenRouter, Groq, Z.ai…). With OpenRouter you just sign in through the browser: `vipcode auth login openrouter`.
- With a free [LLM Stats](https://llm-stats.com) key, the best models are tried first according to their ranking.
- Terminal UI with Markdown, syntax highlighting, diffs, permission prompts, `@file` and `/command` completion, a command palette (Ctrl+P) and `!command` to run shell commands.
- Tools: read, write and edit files, `list_dir`, `glob`, `grep`, `bash`, `webfetch`, `websearch`, todo list, subagents, LSP diagnostics, MCP tools and **skills** (the open Agent Skills format used by many coding agents).
- `/undo` and `/redo` backed by git snapshots, saved sessions, automatic context compaction, images, custom agents and commands.

## Install

Requires Node.js 22 or later.

```bash
npm install -g vipcode
```

Works on macOS, Linux and Windows. On Windows, install [Git for Windows](https://git-scm.com/download/win): vipcode runs commands with its bash (models write bash commands) and uses git for `/undo`; without it, it falls back to PowerShell and tells the model. `VIPCODE_SHELL` picks another shell (`pwsh`, `powershell`, `cmd` or a path to bash).

To update, type `/update` inside vipcode or run `vipcode update` (it installs the latest published version, or pulls the repository if you installed from source). Without the npm registry you can also install the latest GitHub release (`npm install -g https://github.com/PabloVip/vipcode/releases/latest/download/vipcode.tgz`) or run it from source:

```bash
git clone https://github.com/PabloVip/vipcode.git
cd vipcode
npm install
npm run build
npm link        # makes the «vipcode» command available everywhere
```

## Quick start

```bash
cd my-project
vipcode                                # interactive UI
vipcode "fix the failing test"         # UI, starting with that message
vipcode run "task" --yolo              # non-interactive: does the task and exits
vipcode auth login                     # add a free key (or /connect inside the UI)
vipcode skills add anthropics/skills   # install skills from GitHub
vipcode update                         # update vipcode
```

Every conversation is saved automatically in `~/.vipcode/sessions/` as `.json` (to resume it) and `.md` (the whole conversation, readable and never truncated by context compaction). When you resume one (`vipcode -c`, `/sessions`), the previous conversation is shown on screen.

Inside the UI: Enter sends, Tab switches between the `programar` (build) and `planear` (plan) agents, `/limites` shows how much of each free plan is left today (also in the status bar), Ctrl+P opens the command palette, `@path` attaches files, `!command` runs a shell command, Esc interrupts and `/help` lists everything.

## Security

vipcode asks before editing files, running commands, going online or using MCP tools; only a few read-only commands (`git status`, `git diff`, `git log`, `git show`, `ls`, `pwd`) are auto-approved, and never when they chain another command, write to a file or use `$(…)`. A project's own vipcode configuration (MCP servers, providers, permissions, agents with permissions, commands that run shell) is ignored until you trust the folder: vipcode shows what it would change and asks (`vipcode trust` / `vipcode untrust`). Tools can't leave the project folder, not even through symlinks; vipcode can't read or change its own data folder (`~/.vipcode`: keys, config, trusted folders) nor modify its own installation, and commands that mention them always ask. Terminal escape sequences from the model or tools are stripped. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Privacy

Free plans have fine print: anonymous providers and several free tiers may store what you send or use it for training. The first time vipcode is about to use a provider that needs no key, it tells you and lets you continue, add a key first or never use them (`"keyless": false`). Don't send secrets or confidential code; for that, use a local model with Ollama or LM Studio. vipcode itself sends no telemetry; it only checks npm and GitHub once a day for a new version (`"checkUpdates": false` turns it off).

## Ranking data

vipcode does not ship LLM Stats data, because their terms don't allow redistribution. Each user downloads it with their own free key (`vipcode auth login llm-stats`); it is only used locally. Data by LLM Stats (llm-stats.com).

## License

[MIT](LICENSE) © Pablo Vicente Juan. The full documentation (in Spanish) is in [README.md](README.md).
