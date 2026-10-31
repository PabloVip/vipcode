<div align="center">

# vipcode

**The terminal coding agent that costs you nothing.**<br>
It uses the free AI plans of 20+ providers, works with no keys or sign-up, and switches to another one by itself when one runs out.

[![npm](https://img.shields.io/npm/v/vipcode.svg)](https://www.npmjs.com/package/vipcode) [![Downloads](https://img.shields.io/npm/dm/vipcode.svg)](https://www.npmjs.com/package/vipcode) [![Tests](https://github.com/PabloVip/vipcode/actions/workflows/ci.yml/badge.svg)](https://github.com/PabloVip/vipcode/actions/workflows/ci.yml) [![Daily check](https://github.com/PabloVip/vipcode/actions/workflows/vigilancia.yml/badge.svg)](https://github.com/PabloVip/vipcode/actions/workflows/vigilancia.yml) [![AGPL-3.0 License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE) ![macOS · Linux · Windows](https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-555.svg)

[Español](README.md) · [Changelog](CHANGELOG.md) (Spanish) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

</div>

> **Note:** vipcode's interface and messages are in Spanish. Command names are Spanish too (`/limites`, `/planear`, `/profe`…); this page explains what each one does.

![vipcode fixing a bug in carrito.js: it reads the file, shows the change, asks for permission and applies it; then the teacher agent explains why](https://raw.githubusercontent.com/PabloVip/vipcode/main/docs/demo.svg)

```bash
npm install -g vipcode
cd my-project && vipcode
```

Type what you want to do ("fix the failing test", "add an export button", "explain this file") and vipcode does it: it searches and reads your code, proposes the changes, shows them to you, asks for permission and applies them. It also runs commands and tests and looks things up online.

## What makes it different

- **💸 Truly free.** It only uses free models: you never pay anything. Right after installing it works **with no keys or sign-up**, through providers that allow anonymous access (Kilo Gateway, OVHcloud, LLM7 and Pollinations). With free keys from 20+ providers (Gemini, NVIDIA, Cerebras, Mistral, OpenRouter, Groq…) you get more quota and better models.
- **🔄 It doesn't leave you stranded.** When a model hits its limit, fails, is overloaded or takes too long to start answering, vipcode pauses it and moves on to another one without you doing anything. If a whole provider stops responding, it sets the whole provider aside instead of waiting for each of its models. Pauses are remembered across sessions, and it tells you how much of each free plan is left.
- **🧠 Long conversations, even with small models.** If the conversation no longer fits in the available models, the one with the most room gets a summary of the earlier part plus the latest messages verbatim. Nothing is lost: when a model that fits the whole conversation comes back, it gets the whole conversation. vipcode also learns from every answer how many tokens providers really count, so it doesn't send a model more than it can take.
- **🇪🇸 In Spanish.** The interface, notices, messages and docs. Plus an agent, **profe** ("teacher"), that walks you through things step by step so you do them yourself, without touching your code.
- **🔒 Safe by default.** It asks before editing, running anything or going online, showing the full change or command. It stays inside the project folder, doesn't run anything a project brings until you trust it, and the programs it starts never get your keys. `/undo` reverts files and conversation.
- **🩺 A catalog checked every day.** Free plans change without notice, so every day a GitHub job checks that the catalog's models still answer and has a real conversation with the free ones: it reads files, summarizes, remembers and edits. If something stops working, it's known before it happens to you.
- **🧰 Complete.** Agents and subagents working in parallel, custom commands and [skills](#skills) (in the open Agent Skills format), MCP servers, language-server errors after every edit, images, conversations also saved as Markdown, local models (Ollama, LM Studio, llama.cpp) and a non-interactive mode for scripts (`vipcode run`).
- **🖱️ A polished interface.** Full screen with mouse support (wheel, selection that copies itself, clickable links and commands), Ctrl+F search and four styles, one of them with pixel creatures.
- **💻 macOS, Linux and Windows.** Every change is tested on all three before release.

## Contents

- [Install](#install)
- [Getting started](#getting-started) · [Providers](#providers)
- [How it picks a model](#how-it-picks-a-model)
- [Long conversations](#long-conversations)
- [Usage](#usage): [in the interface](#in-the-interface) · [commands](#commands) · [agents](#agents) · [conversations](#conversations) · [what's left](#whats-left)
- [Customize](#customize): [configuration](#configuration) · [custom agents and commands](#custom-agents-and-commands) · [skills](#skills) · [project instructions](#project-instructions)
- [Security and privacy](#security-and-privacy)
- [FAQ](#faq)
- [Contributing](#contributing) · [License](#license)

## Install

Requires Node.js 22 or later. Works on macOS, Linux and Windows.

```bash
npm install -g vipcode
```

**On Windows**, also install [Git for Windows](https://git-scm.com/download/win) (`winget install Git.Git`): vipcode runs commands with its bash and uses git for `/undo`. Without it, it uses PowerShell, and reminds you when it starts.

**Updating.** Type `/update` inside vipcode or run `vipcode update`: a progress bar shows how it goes, and when it finishes it offers to restart vipcode on the new version without leaving the conversation. When a new version is out, vipcode tells you (and whether it includes security fixes), and the first time you open it, it shows what's new. Everything is in [CHANGELOG.md](CHANGELOG.md) (in Spanish).

**If something doesn't work**, run `vipcode doctor` (or `/doctor` inside vipcode): it checks programs, your keys and the providers, and tells you how to fix what's missing. If that doesn't solve it, type `/bug` (or run `vipcode bug`): it opens a GitHub issue in your browser with that report already filled in, without your keys; you describe what happened and submit it. With `VIPCODE_DEBUG=1 vipcode`, a log that helps find the problem is also saved to `~/.vipcode/debug.log`.

## Getting started

First time? `vipcode tutorial` teaches you the basics in 5 steps, in a practice folder that doesn't touch anything of yours.

Open `vipcode` in your project folder and type what you want to do. Nothing needs to be configured: with no keys it uses the providers that allow anonymous access, with few messages (Kilo Gateway, 200 per hour; OVHcloud, 2 per minute per model; LLM7, about 60 per hour; Pollinations, an hourly limit). When one runs out, or takes too long to start answering, it jumps to the next one.

For real work it's worth adding a free key or two. **These three make a big difference**, and each takes a few minutes to get:

1. **NVIDIA**: many of the best open models (DeepSeek, GLM, Kimi, Nemotron) and about 40 requests per minute.
2. **Gemini**: Google's Flash models, good quality and very long conversations.
3. **Cerebras**: the fastest, with 14,400 requests a day per model.

To add a key:

- **`/connect`** inside vipcode: pick the provider and paste the key. If you don't have one yet, press Enter without typing anything and the page where you get it opens.
- **OpenRouter, without copying keys**: `/connect openrouter` → "Iniciar sesión en el navegador" (sign in through the browser). You log in with your account and vipcode receives the key by itself; it's called "vipcode" at https://openrouter.ai/settings/keys and you can delete it from there. Over SSH it gives you a link to open in any browser.
- **From the terminal**: `vipcode auth login [provider]`, `vipcode auth list` to see what you have and `vipcode auth logout <provider>` to delete a key. Keys are saved in `~/.vipcode/auth.json`, readable only by your user.
- **Environment variables**, for example `export GEMINI_API_KEY="..."` in `~/.zshrc`.

### Providers

| Provider | Variable | Where to get the key | Free plan |
|---|---|---|---|
| Google Gemini | `GEMINI_API_KEY` | https://aistudio.google.com/apikey | Flash and Flash-Lite, with per-minute and per-day limits on each model |
| NVIDIA NIM | `NVIDIA_API_KEY` | https://build.nvidia.com/settings/api-keys | ~40 requests/minute for the whole account; development use only |
| Mistral | `MISTRAL_API_KEY` | https://console.mistral.ai/api-keys | Experiment plan: ~1 request/s and ~1,000 M tokens/month |
| Cerebras | `CEREBRAS_API_KEY` | https://cloud.cerebras.ai | ~30/min and 14,400/day per model, ~64k context |
| OpenRouter | `OPENROUTER_API_KEY` | https://openrouter.ai/settings/keys | `:free` models: 20/min and 50/day in total (1,000/day once you've bought $10 of credits) |
| Groq | `GROQ_API_KEY` | https://console.groq.com/keys | ~30/min and 1,000/day per model; few tokens per minute |
| Z.ai | `ZAI_API_KEY` | https://z.ai/manage-apikey/apikey-list | GLM-4.7-Flash, GLM-4.6V-Flash and GLM-4.5-Flash |
| Zhipu (China) | `ZHIPU_API_KEY` | https://open.bigmodel.cn/usercenter/apikeys | The same GLM Flash models |
| Poolside | `POOLSIDE_API_KEY` | https://platform.poolside.ai | Laguna models |
| Reflection AI | `REFLECTION_API_KEY` | https://developers.reflection.ai | Beam 1.0 |
| Amazon Nova | `NOVA_API_KEY` | https://nova.amazon.com/dev | Nova 2 Pro and Lite |
| Cohere | `COHERE_API_KEY` | https://dashboard.cohere.com/api-keys | Trial key: 1,000 calls/month, non-commercial use |
| SambaNova | `SAMBANOVA_API_KEY` | https://cloud.sambanova.ai/apis | Daily token limit per model |
| Hetzner | `HETZNER_API_KEY` | https://experiments.hetzner.com | Free beta |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | https://vercel.com/ai-gateway | $5/month of credit; `-free` models don't use it |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` | https://dash.cloudflare.com/profile/api-tokens | 10,000 "neurons" a day |
| Hugging Face | `HF_TOKEN` | https://huggingface.co/settings/tokens | $0.10/month of credit |
| ModelScope (China) | `MODELSCOPE_API_KEY` | https://modelscope.cn/my/myaccesstoken | 2,000 calls a day |
| Ollama Cloud | `OLLAMA_API_KEY` | https://ollama.com/settings/keys | Hourly and weekly limits |
| UnoRouter | `UNOROUTER_API_KEY` | https://unorouter.com/en/token | `:free` models, ~1 request/min each |
| Kilo Gateway | no key (optional `KILO_API_KEY`) | https://app.kilo.ai | 200 requests/hour per IP without a key |
| OVHcloud | no key (optional `OVHCLOUD_API_KEY`) | https://www.ovhcloud.com/en/public-cloud/ai-endpoints/ | 2/min per model without a key; 400/min with one |
| LLM7.io | no key (optional `LLM7_API_KEY`) | https://token.llm7.io | ~60/hour without a key |
| Pollinations | no key (optional `POLLINATIONS_API_KEY`) | https://auth.pollinations.ai | Hourly limit per IP |
| Ollama, LM Studio, llama.cpp | no key | detected automatically when running | On your computer, no limits |

## How it picks a model

vipcode starts with the best free models you have available and switches between them as needed:

- **Limits.** When a model hits the limit of its free plan, vipcode pauses it until it's back (whatever the provider says, or until the next day for daily limits) and moves on to the next one. Pauses are remembered even if you close vipcode.
- **Overloaded.** If a provider says the model is overloaded (the well-known 503 error), vipcode lets it rest for a couple of minutes and uses another one meanwhile.
- **Slow.** If a model doesn't start answering within about 40 seconds (60 for Gemini, which tends to be slower; a bit more for long conversations), vipcode tries another one and remembers it's slow so it goes last. Once a model has started answering, vipcode waits for it.
- **Providers that are down.** If two different models from the same provider stop responding within a few minutes, the problem is the provider: vipcode pauses it entirely for 5 minutes and moves straight on to others, instead of waiting for each of its models.
- **Models that disappear.** If a model no longer exists or doesn't support tools, it's dropped. New free models published by providers are added automatically every day.
- **Quality.** With a free [LLM Stats](https://llm-stats.com/developer) key (`vipcode auth login llm-stats`), models are ranked by its leaderboard, with extra weight on coding and tool use.

`/models` shows each model and its status (available, paused until…, slow), `/model <provider/model>` pins one and `/model auto` goes back to rotation. In the [configuration](#configuration), `order` puts your favorites first.

## Long conversations

Free models come in very different sizes: some take hundreds of thousands of tokens and others just a few thousand. vipcode handles this by itself:

- **If the conversation fits** in an available model, it's sent whole.
- **If it doesn't fit in any**, old tool outputs are trimmed first and, if that's not enough, the available model with the most room gets **a summary of the earlier part plus the latest messages verbatim**, never splitting a tool call from its result. vipcode tells you when a model gets this summarized version.
- **The conversation is never lost.** The summary is only what that model receives: the whole conversation is kept, and when a model that fits it comes back (for example, Gemini after its pause), it gets the whole thing.
- **No wasted requests.** The summary is saved with the conversation and reused; when needed, it's updated with only the new part. If a model returns something that isn't really a summary, vipcode asks again and, failing that, writes a simple one itself without losing the previous one.
- **Estimates that adjust.** vipcode estimates a conversation's size from its character count, which would fall short with code. So it learns from every answer how many tokens providers really count, and remembers it for next time.

`/compact` summarizes the conversation on demand and replaces it with the summary (the history you see, and the conversation's `.md`, stay complete).

## Usage

```bash
cd my-project
vipcode                      # open vipcode
vipcode "fix the test"       # and start with that message
vipcode -c                   # continue the last conversation in this folder
vipcode --plan               # start with the planear agent (read-only)
vipcode run "task"           # do the task without the interface and exit (handy in scripts)
vipcode limites              # how much of each free plan is left today
vipcode models               # available models (refresh looks for new free models)
vipcode doctor               # check that everything works
vipcode bug                  # report a bug on GitHub with the vipcode doctor report
vipcode tutorial             # learn the basics in 5 steps, in a practice folder
```

Other options: `-s <id>` opens a specific conversation, `-m <provider/model>` sets the preferred model, `--agent <name>` the agent to start with, `--image <file>` attaches an image, `--plain` uses a simple text interface and `--yolo` approves everything without asking. `vipcode --help` lists them all.

### In the interface

- **Enter** sends. **Alt+Enter** or `\` at the end of the line adds a new line.
- **@path** attaches a file, a folder or an image (with autocomplete). **Ctrl+V** pastes an image from the clipboard, and dragging an image onto the terminal attaches it too.
- **Tab** switches agents. **↑/↓** go through what you've typed before.
- **Ctrl+P** opens the palette with every command; type to filter.
- **!command** runs it in the terminal without leaving vipcode (for example `!git status`). The agent sees the output with your next message.
- **Esc** interrupts the agent. While it works you can keep typing: your message is delivered when the current step ends.
- **Ctrl+C** interrupts, closes the dialog or clears what you typed; twice in a row exits.
- **The mouse wheel**, **PgDn** and **PgUp** scroll the conversation; the input box stays at the bottom. Typing takes you back to the end. The bar on the right shows where you are (you can also click and drag it), and **Ctrl+Home** and **Ctrl+End** jump to the start and the end.
- **Ctrl+F** searches the conversation, ignoring case and accents: Enter or ↑ goes to the previous match, ↓ to the next one and Esc closes.
- **A click on a tool** (the line that says what it did) expands its full output, and another click collapses it. **A click on a link** opens it in the browser, and on a command in the text (for example `/update`) it types it into the input box, ready to press Enter. A click on "y más en CHANGELOG.md" shows all the release notes, and on "↓ N líneas más" it scrolls to the end.
- **Copying**: drag the mouse over the conversation and, when you let go, the selection is copied to the clipboard. Double click copies a word (also a whole path or address) and triple click, the line. `/copiar` copies the last answer and `/copiar código`, its last code block. To select the way your terminal normally does (for example in the input box), hold **Fn** (macOS Terminal), **⌥** (iTerm2) or **Shift** (Windows and Linux) while dragging.

**Permissions.** Before editing a file, running a command or going online, vipcode shows you the change or the command and asks. You can answer yes once, yes to everything of that kind for the session, always yes to that command (for example `npm test*`), no, or no and tell it what to do instead.

The bottom bar shows the agent, the model, how much of its free plan is left and how much context you've used. vipcode takes the full screen while you use it; when you exit, the terminal is back as it was and the conversation is saved (`vipcode -c` continues it).

**Styles.** With **`/interfaz`** you choose how it looks, and it's remembered next time. All of them are full screen, with the scrolling, mouse and Ctrl+F above:

- **Full screen** (the default).
- **Compact**: no extra spacing or borders, so more of the conversation fits.
- **Zen**: just the essentials, no welcome or borders and a minimal bottom bar.
- **Creatures**: like full screen, with a pixel monster on the right that's made up at random. A new one appears with every answer or when you click it, and it hops while vipcode works (sometimes a golden one shows up). On wide terminals (120 columns and 32 rows) it's bigger and more detailed. On the Mac Terminal it's drawn with background colors so no lines appear between rows, and it needs a window of 90 columns and 28 rows or more.

### Commands

| Command | What it does |
|---|---|
| `/models` | List of models and their status; pick a preferred one. `/models refresh` looks for new free models |
| `/model <p/m>` | Pins a model (`/model auto` goes back to rotation) |
| `/connect`, `/disconnect`, `/providers` | Add, remove and see provider keys |
| `/agents`, `/agent <name>`, `/planear`, `/programar`, `/profe` | Switch agents |
| `/undo`, `/redo`, `/diff [all]` | Undo and redo the last message (files and conversation); see the changes |
| `/todos` | The agent's task list |
| `/skills` | Installed skills; pick one to use it (or type `/skill-name task`) |
| `/compact` | Summarize the conversation |
| `/new`, `/sessions`, `/load <n>`, `/delete <n>`, `/export` | Conversations |
| `/limites` | How much of each free plan is left today |
| `/copiar [código]` | Copies the last answer (or its last code block) to the clipboard |
| `/doctor` | Checks that everything works and tells you how to fix what's missing |
| `/bug [what happened]` | Reports a bug: opens a GitHub issue with the `/doctor` report already filled in (without your keys) |
| `/tutorial` | Learn the basics in 5 steps, in a practice folder |
| `/interfaz` | Choose how vipcode looks: full screen, compact, zen or creatures |
| `/usage` | Tokens used |
| `/mcp`, `/lsp` | Status of MCP and language servers |
| `/yolo [on\|off]` | Approve everything without asking for the session |
| `/reset-limits` | Forget the saved provider pauses |
| `/update` | Update vipcode |
| `/init` | Creates or improves `AGENTS.md` with the project's instructions |
| `/review` | Reviews uncommitted changes (without touching anything) |
| `/config`, `/help`, `/exit` | Configuration paths, help and exit |

### Agents

- **programar** ("code"): the main one; it can edit and run things.
- **planear** ("plan"): read-only; it investigates and proposes a plan.
- **profe** ("teacher"): for learning. It explains step by step, in plain words, and proposes the changes so you make them yourself (it doesn't touch anything).
- **ayudante** ("helper") and **explorar** ("explore"): subagents the main agent launches for subtasks (ayudante can edit; explorar only searches and reads). If it launches several, they work in parallel.

You can create your own: see [Custom agents and commands](#custom-agents-and-commands).

### Conversations

Every conversation is saved automatically in `~/.vipcode/sessions/`, also as Markdown (`.md`) to read or share it. To go back to one: `vipcode -c` (the last one in this folder), `/sessions` (pick from the list) or `vipcode -s <id>`. You see the whole previous conversation and the model picks up where you left off.

### What's left

`/limites` (or `vipcode limites`) shows what you've used today with each provider and model, how much is left and what's paused and until when.

- **"quedan"** ("left") is what the provider itself reports (Groq and Cerebras, for example).
- **"≈ quedan"** is vipcode's own count using the known limits of each free plan. It only counts this computer: if you use the same key in other programs, you'll have less left.

## Customize

### Configuration

Yours is in `~/.vipcode/config.json`, and a project can bring its own in `vipcode.json` or `.vipcode/config.json` (only used if you trust the folder, see [Security and privacy](#security-and-privacy)). The most useful settings:

```json
{
  "order": ["groq/*", "gemini/gemini-3.8-flash"],
  "disabledProviders": ["cohere"],
  "providers": [
    { "name": "my-server", "baseURL": "http://192.168.1.10:8000/v1", "apiKeyEnv": "MY_KEY", "models": [{ "id": "qwen3-coder", "context": 32000 }] }
  ],
  "permission": {
    "bash": { "*": "ask", "npm test*": "allow", "rm *": "deny" }
  },
  "mcp": {
    "github": { "type": "local", "command": ["npx", "-y", "@modelcontextprotocol/server-github"], "environment": { "GITHUB_PERSONAL_ACCESS_TOKEN": "{env:GITHUB_TOKEN}" } }
  },
  "keyless": true,
  "checkUpdates": true
}
```

- **order**: models that go first. **disabledProviders**: providers you don't want to use.
- **providers**: a server of yours compatible with the OpenAI API (or changes to the models of a catalog provider).
- **permission**: `allow`, `ask` or `deny` for `edit`, `bash`, `webfetch` and `mcp`; in `bash` and `mcp` the most specific pattern wins. `deny` rules apply even with `--yolo`. Think twice before setting `webfetch` to `allow`: a malicious text could make the model send your data to a website without asking.
- **mcp**: local (`command`) or remote (`url`) MCP servers; those that require OAuth sign-in don't work yet. A local server doesn't get your environment variables (or your keys), only what it needs to start: put whatever it needs in `environment`. There and in `headers`, `{env:NAME}` is replaced by that variable of yours. Its tools are named `server_tool`; if two end up with the same name, the second gets `_2` appended.
- **keyless**: `false` to never use the keyless providers. **checkUpdates**: `false` to not look for new versions.
- **interfaz**: the one you choose with `/interfaz` (`completa`, `compacta`, `zen` or `criaturas`). The classic and high-contrast ones (and the old `"fullscreen": false`) no longer exist: if you had them, vipcode tells you once and uses full screen.
- **firstResponseMs**: how long to wait for a model to start answering before trying another one (40000, about 40 s; a bit more for long conversations). Gemini always gets at least 60 s, as it tends to be slower. It doesn't apply to models on your computer.
- **autoCompactTokens**: the most tokens sent to a model even if it takes more (90000). Above that, it gets the [summarized version](#long-conversations).

Environment variables: `VIPCODE_HOME` (another folder instead of `~/.vipcode`), `VIPCODE_SHELL` (another shell for commands: `pwsh`, `powershell`, `cmd` or a bash), `VIPCODE_BROWSER` (another browser) and `VIPCODE_CLIPBOARD` (another program to copy with, which receives the text on its input).

### Custom agents and commands

An agent is a Markdown file in `~/.vipcode/agents/` (for all your projects) or `.vipcode/agents/` (for that project only):

```markdown
---
description: Reviews the code's security
mode: subagent          # primary (chosen with Tab), subagent (launched by the main agent) or all
model: gemini/*         # optional
tools:
  write: false
  edit: false
  bash: false
---
You are a security expert. Look for injections, secrets in the code and badly set permissions.
```

A command goes in `~/.vipcode/commands/` or `.vipcode/commands/` and runs with `/name arguments`:

```markdown
---
description: Fixes the failing tests
agent: programar
---
These are the tests failing right now:
!`npm test 2>&1 | tail -40`

Fix them. Focus on $ARGUMENTS.
```

`$ARGUMENTS` is whatever you type after the command, `$1`…`$9` each word, and `` !`command` `` is replaced by its output. Agents and commands a project brings can't change permissions or run anything until you trust the folder.

### Skills

A skill is a folder with a `SKILL.md`: instructions (and, when needed, scripts and documents) for a kind of task, like filling in PDFs, following your company's style guide or preparing a report. It's the open [Agent Skills](https://agentskills.io) format, so the ones you find for other coding agents work too.

```markdown
---
name: weekly-reports
description: Use it when the user asks for the team's weekly report.
---

# Weekly report

1. Read this week's notes in `notes/`.
2. Fill in the template in `references/template.md` (it's in the skill's folder).
```

The agent loads it by itself when the task fits, and you can use it with `/weekly-reports this week's`.

```bash
vipcode skills                                   # the ones you have
vipcode skills add anthropics/skills             # all of a GitHub repository's skills
vipcode skills add ./my-skills                   # from a folder on your computer
vipcode skills add <source> --project            # in the project, to share it with your team
vipcode skills new weekly-reports                # creates an empty one to fill in
vipcode skills remove weekly-reports
```

vipcode also reads the skills you already have from other programs (`~/.claude/skills`, `~/.config/opencode/skill`, `~/.agents/skills`). Skills can include scripts: review the ones you install if you don't know where they come from. If one needs to run something, vipcode asks for permission like with any other command.

### Project instructions

vipcode reads your project's `AGENTS.md` (or `CLAUDE.md`) and your general instructions from `~/.vipcode/AGENTS.md`. `/init` creates an `AGENTS.md` by analyzing the project.

After every edit, it passes the model the errors found by the language server: for TypeScript and JavaScript without installing anything, and for other languages if you have their server installed (pyright, gopls, rust-analyzer, clangd…). Those a project brings in its `node_modules` are not used.

## Security and privacy

- **Permissions.** Before editing a file, running a command, going online or using an MCP tool, vipcode asks, showing the full command. Only a few commands that don't change anything are approved automatically (`git status`, `git diff`, `git log`, `ls`…), and never if they look outside the project or can run programs (like `git difftool`). With `--yolo` or `/yolo` everything is approved except what you set to `deny`: use it only in folders with nothing to lose.
- **What a project brings doesn't run by itself.** vipcode doesn't start programs from the project folder (no language servers from its `node_modules`, no `git` or `rg` it may bring), ignores `AGENTS.md`, agents, commands or skills that are symlinks to files outside it, and always asks before writing into `.git` (its hooks and configuration run when you use git).
- **Folders you trust.** A project can bring its own vipcode configuration, which could start programs or send your keys elsewhere. That's why vipcode ignores it until you trust the folder: it shows you what would change and asks (`vipcode trust` and `vipcode untrust` change it manually).
- **Files and the internet.** It only reads, searches and writes inside the project folder, and can't read or change your keys or its own configuration. Before visiting an address on your computer or your network (your router, `localhost`…) it always asks, even with `webfetch` set to `allow`.
- **Your keys.** The MCP and language servers vipcode starts don't get your keys: if one of their packages were compromised, it couldn't take them. "Always yes to this command" doesn't apply either if the command writes to a file (`>`) or contains `$(…)`: that's always asked.
- **Summaries.** Long-conversation summaries are written by a model from everything before (including websites or command outputs), so they're marked as context, not as your instructions.
- **Your data.** vipcode sends no usage data: it only talks to the AI providers you use, the websites the agent looks up, your MCP servers, LLM Stats if you give it your key and, at most once an hour, npm and GitHub to check for a new version.
- **Free plans.** Keyless providers and several free plans may store what you send or use it to train their models. Don't send passwords or confidential code; for that, use a local model (Ollama, LM Studio) and set `"keyless": false` in the configuration.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## FAQ

**Is it really free? What's the catch?**
vipcode is free and open source, and it only uses the providers' free plans. The "price" is that of those plans: they have limits (that's why vipcode switches between them), they're sometimes slow or overloaded, and some may store what you send.

**Which providers do you recommend?**
It works without keys. For real work, get free keys from NVIDIA, Gemini and Cerebras (see [Getting started](#getting-started)); with those three you'll rarely run out. For private code, a model on your computer with Ollama or LM Studio.

**Why is it sometimes slow, or why do I see "saturado" or "no ha empezado a contestar" notices?**
That's the free plans: at busy times providers get overloaded or queue requests. vipcode waits a reasonable time, pauses the model (or the whole provider if none of its models answer) and moves on. The more keys you add, the more places it has to go.

**Does it work offline?**
Yes, with a model on your computer: start Ollama, LM Studio or llama.cpp and vipcode detects it automatically.

**Can I use a paid model or my own server?**
Yes: any server compatible with the OpenAI API can be added under `providers` in the [configuration](#configuration), with its key in an environment variable.

**How is it different from other agents like opencode, Aider or Claude Code?**
Those agents use the model you choose, usually a paid one or with your own keys (opencode, for example, offers a few free models only inside its own app). vipcode is built so you never pay: it pools the free plans of many providers, switches between them by itself, works without keys and handles long conversations across models of very different sizes. And everything is in Spanish.

**Why Spanish?**
Because most of these tools only speak English, and coding (or learning to code) is easier in your own language. The **profe** agent is designed precisely for learning.

## Contributing

Ideas, bug reports and improvements are welcome: [CONTRIBUTING.md](CONTRIBUTING.md) (in Spanish) explains how to run vipcode from source, run the tests, and how the free model catalog is checked every day. Every change passes more than a hundred automated tests on Linux, macOS and Windows before release.

## License

[AGPL-3.0 or later](LICENSE) · Copyright © 2026 Pablo Vicente Juan. Model ranking with data by LLM Stats (llm-stats.com).

In short: you can use vipcode for anything, including at work, and change it for yourself. If you publish a modified version, or offer it as a service over a network, you must also publish its source code under this same license. Up to version 0.3.2, vipcode was released under the MIT license.

**The name.** The license covers the code, not the name "vipcode". You can use the code, change it and publish your own version, but give it a different name and don't present it as vipcode or as the official version. The official one is this repository and the `vipcode` package on npm.
