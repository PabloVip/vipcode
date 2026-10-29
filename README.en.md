# vipcode

[![npm](https://img.shields.io/npm/v/vipcode.svg)](https://www.npmjs.com/package/vipcode) [![Tests](https://github.com/PabloVip/vipcode/actions/workflows/ci.yml/badge.svg)](https://github.com/PabloVip/vipcode/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) · [Español](README.md)

A coding agent for your terminal (command `vipcode`) that only uses **free AI models** and **automatically switches provider** when one runs out. The interface and messages are in Spanish.

![vipcode fixing a bug in carrito.js: it reads the file, shows the change, asks for permission and applies it](https://raw.githubusercontent.com/PabloVip/vipcode/main/docs/demo.svg)

- **Works right after installing, with no keys or sign-up**: it uses providers that allow anonymous access (Kilo Gateway, OVHcloud, LLM7 and Pollinations).
- For higher limits and better models, add free keys from the 20+ included providers (Gemini, NVIDIA, Mistral, Cerebras, OpenRouter, Groq, Z.ai…). With OpenRouter you just sign in through the browser.
- Reads and edits your files, runs commands and searches your code and the web, showing you every change before making it. `/undo` reverts the last one.
- Tells you how much of each free plan is left, saves your conversations and supports custom agents, commands and skills.

## Install

Requires Node.js 22 or later. Works on macOS, Linux and Windows.

```bash
npm install -g vipcode
```

On Windows, also install [Git for Windows](https://git-scm.com/download/win): vipcode runs commands with its bash and uses git for `/undo`. Without it, it uses PowerShell.

To update, type `/update` inside vipcode or run `vipcode update`. vipcode tells you when a new version is out.

## Quick start

```bash
cd my-project
vipcode                                # open vipcode
vipcode "fix the failing test"         # and start with that message
vipcode -c                             # continue the last conversation in this folder
vipcode run "task"                     # non-interactive: does the task and exits
vipcode auth login                     # add a free key (or /connect inside vipcode)
vipcode limites                        # how much of each free plan is left today
```

Inside vipcode: Enter sends, Tab switches between the `programar` and `planear` (read-only) agents, Ctrl+P opens the command palette, `@path` attaches files, `!command` runs a shell command, Esc interrupts and `/help` lists everything. Every conversation is saved in `~/.vipcode/sessions/`, also as Markdown.

## Security and privacy

- vipcode asks before editing files, running commands, going online or using MCP tools; only a few read-only commands (`git status`, `git diff`, `ls`…) are approved automatically.
- A project's own vipcode configuration is ignored until you trust the folder: vipcode shows what it would change and asks (`vipcode trust` / `vipcode untrust`).
- It only reads and writes inside the project folder and can't read or change your keys or its own configuration.
- Anonymous providers and several free tiers may store what you send or use it for training: don't send secrets or confidential code. For that, use a local model (Ollama, LM Studio) and set `"keyless": false`.
- vipcode sends no usage data; besides your AI providers (and LLM Stats if you give it your key), it only checks npm and GitHub once a day for a new version.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Pablo Vicente Juan. Model ranking with data by LLM Stats (llm-stats.com). The full documentation (in Spanish) is in [README.md](README.md).
