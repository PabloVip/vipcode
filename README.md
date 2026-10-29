# vipcode

[![npm](https://img.shields.io/npm/v/vipcode.svg)](https://www.npmjs.com/package/vipcode) [![Pruebas](https://github.com/PabloVip/vipcode/actions/workflows/ci.yml/badge.svg)](https://github.com/PabloVip/vipcode/actions/workflows/ci.yml) [![Licencia MIT](https://img.shields.io/badge/licencia-MIT-blue.svg)](LICENSE) · [English](README.en.md)

Agente de programación para la terminal (comando `vipcode`) que solo usa **modelos gratuitos** y **rota automáticamente** entre proveedores cuando uno se agota.

- **Funciona nada más instalarlo, sin claves ni registro**: usa los proveedores que permiten el acceso anónimo (Kilo Gateway, OVHcloud, LLM7 y Pollinations).
- Si quieres más límites y mejores modelos, añade claves gratuitas de los más de 20 proveedores incluidos (Gemini, NVIDIA, Mistral, Cerebras, OpenRouter, Groq, Z.ai…); con OpenRouter basta con iniciar sesión en el navegador. Los modelos gratis nuevos se descubren solos.
- Con una clave gratis de [LLM Stats](https://llm-stats.com), **usa primero los mejores modelos** según su ranking.
- Interfaz en la terminal con Markdown y código coloreado, diffs, diálogos de permiso, autocompletado de `@ficheros` y `/comandos`, paleta de comandos (Ctrl+P), `!comandos`, historial y barra de estado.
- Herramientas: leer, escribir y editar ficheros, `list_dir`, `glob`, `grep`, `bash`, `webfetch`, `websearch`, lista de tareas, subagentes, diagnósticos LSP, herramientas MCP y [skills](#skills).
- `/undo` y `/redo` con instantáneas de git (deshacen también lo que haya cambiado `bash`), sesiones guardadas, resumen automático del contexto, imágenes, agentes y comandos propios, y `/update` para actualizarlo.
- **Seguro por defecto**: pregunta antes de editar, ejecutar o salir a internet, no sale de la carpeta del proyecto y no usa la configuración que traiga un proyecto hasta que confías en él (ver [Seguridad](#seguridad)).

## Instalación

Requiere Node.js 22 o superior.

```bash
npm install -g vipcode
```

Para actualizar, escribe `/update` dentro de vipcode o `vipcode update` en la terminal.

Sin el registro de npm, también puedes instalar el paquete de la última versión de GitHub (`npm install -g https://github.com/PabloVip/vipcode/releases/latest/download/vipcode.tgz`) o usarlo desde el código:

```bash
git clone https://github.com/PabloVip/vipcode.git
cd vipcode
npm install
npm run build
npm link        # deja el comando «vipcode» disponible en cualquier carpeta
```

Funciona en macOS, Linux y Windows: las pruebas automáticas pasan en los tres. Si algo falla, [abre un issue](https://github.com/PabloVip/vipcode/issues).

**En Windows** conviene tener [Git para Windows](https://git-scm.com/download/win): vipcode ejecuta los comandos con su bash, porque los modelos escriben comandos de bash, y usa git para `/undo`. Sin él usa PowerShell y se lo dice al modelo. Para elegir otra shell, pon `VIPCODE_SHELL` (`pwsh`, `powershell`, `cmd` o la ruta de un bash).

## Primeros pasos

No hace falta configurar nada: abre `vipcode` en la carpeta de tu proyecto y escribe. Sin claves, vipcode usa los proveedores que permiten el acceso anónimo:

| Sin clave | Límite aproximado |
|---|---|
| Kilo Gateway (sus modelos gratis: Nemotron 3 Ultra, Beam, Laguna…) | 200 peticiones por hora por IP |
| OVHcloud AI Endpoints (gpt-oss-120b, Qwen 3.5/3.8, Llama 3.3…) | 2 peticiones por minuto en cada modelo |
| LLM7.io | ~60 peticiones por hora |
| Pollinations (GPT-OSS 20B) | límite por hora y por IP |

Cuando uno se agota, salta al siguiente. Para tareas largas se quedan cortos, y además pueden guardar lo que les envías (mira [Privacidad](#privacidad)). Por eso conviene añadir alguna clave gratuita; con una de Gemini, NVIDIA o Mistral se nota mucho. Hay tres formas, y se pueden combinar:

1. **`/connect`** dentro de la interfaz: eliges el proveedor, pegas la clave y listo. Si aún no la tienes, pulsa Enter sin escribir nada y se abre en el navegador la página donde se consigue: inicias sesión, la copias y la pegas.
2. **`vipcode auth login`** (o `vipcode auth login groq`), igual que `/connect` pero desde la terminal. La clave se guarda en `~/.vipcode/auth.json`, legible solo por tu usuario. `vipcode auth list` enseña qué tienes configurado y `vipcode auth logout <proveedor>` la borra.
3. **Variables de entorno** en `~/.zshrc`, por ejemplo `export GEMINI_API_KEY="..."` (abre una terminal nueva después).

### Iniciar sesión sin copiar claves

Con **OpenRouter** no hace falta copiar nada: `vipcode auth login openrouter` (o `/connect openrouter`) → «Iniciar sesión en el navegador». Entras con tu cuenta (Google, GitHub o correo), aceptas y vipcode recibe la clave sola. Usa el inicio de sesión oficial de OpenRouter para programas como este (OAuth con PKCE): la clave se llama «vipcode» en https://openrouter.ai/settings/keys y puedes borrarla desde ahí cuando quieras. Si estás conectado por SSH, vipcode te da un enlace para abrirlo en cualquier navegador y pegar el código que te enseñe.

Otros inicios de sesión no se incluyen porque sus dueños no permiten usarlos desde otros programas o ya no existen:

- **Google (Gemini CLI, Antigravity)**: Google bloquea las cuentas que los usan fuera de sus programas. La vía permitida es la clave gratis de https://aistudio.google.com/apikey.
- **GitHub Copilot**: GitHub solo lo permite en los editores y programas que aprueba, y además es de pago.
- **ChatGPT**: «Iniciar sesión con ChatGPT» existe, pero solo para Plus o Pro, pide que OpenAI dé de alta la aplicación y usa otra API.
- **Qwen Code**: su plan gratis con cuenta cerró el 15/04/2026.

Para elegir el navegador, pon el comando en `VIPCODE_BROWSER` (por ejemplo `export VIPCODE_BROWSER=firefox`).

Si la misma clave está en `auth.json` y en el entorno, gana la de `auth.json`.

| Proveedor | Variable | Dónde conseguir la clave | Plan gratuito |
|---|---|---|---|
| Google Gemini | `GEMINI_API_KEY` | https://aistudio.google.com/apikey | Flash y Flash-Lite con límites por minuto y por día en cada modelo |
| NVIDIA NIM | `NVIDIA_API_KEY` | https://build.nvidia.com/settings/api-keys | ~40 peticiones/minuto para toda la cuenta; solo para desarrollo |
| Mistral | `MISTRAL_API_KEY` | https://console.mistral.ai/api-keys | Plan Experiment: ~1 petición/s y ~1.000 M tokens/mes |
| Cerebras | `CEREBRAS_API_KEY` | https://cloud.cerebras.ai | ~30/min y 14.400/día por modelo, contexto ~64k |
| OpenRouter | `OPENROUTER_API_KEY` | https://openrouter.ai/settings/keys | Modelos `:free`: 20/min y 50/día en total (1.000/día con 10 $ comprados) |
| Groq | `GROQ_API_KEY` | https://console.groq.com/keys | ~30/min y 1.000/día por modelo; pocos tokens por minuto |
| Z.ai | `ZAI_API_KEY` | https://z.ai/manage-apikey/apikey-list | GLM-4.7-Flash, GLM-4.6V-Flash y GLM-4.5-Flash |
| Zhipu (China) | `ZHIPU_API_KEY` | https://open.bigmodel.cn/usercenter/apikeys | Los mismos GLM Flash |
| Poolside | `POOLSIDE_API_KEY` | https://platform.poolside.ai | Modelos Laguna |
| Reflection AI | `REFLECTION_API_KEY` | https://developers.reflection.ai | Beam 1.0 |
| Amazon Nova | `NOVA_API_KEY` | https://nova.amazon.com/dev | Nova 2 Pro y Lite |
| Cohere | `COHERE_API_KEY` | https://dashboard.cohere.com/api-keys | Clave de prueba: 1.000 llamadas/mes, uso no comercial |
| SambaNova | `SAMBANOVA_API_KEY` | https://cloud.sambanova.ai/apis | Límite diario de tokens por modelo |
| Hetzner | `HETZNER_API_KEY` | https://experiments.hetzner.com | Beta gratuita |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | https://vercel.com/ai-gateway | 5 $/mes de crédito; los modelos `-free` no gastan |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` | https://dash.cloudflare.com/profile/api-tokens | 10.000 «neuronas» al día |
| Hugging Face | `HF_TOKEN` | https://huggingface.co/settings/tokens | 0,10 $/mes de crédito |
| ModelScope (China) | `MODELSCOPE_API_KEY` | https://modelscope.cn/my/myaccesstoken | 2.000 llamadas al día |
| Ollama Cloud | `OLLAMA_API_KEY` | https://ollama.com/settings/keys | Límites por hora y por semana |
| UnoRouter | `UNOROUTER_API_KEY` | https://unorouter.com/en/token | Modelos `:free`, ~1 petición/min cada uno |
| Kilo Gateway | sin clave (opcional `KILO_API_KEY`) | https://app.kilo.ai | 200 peticiones/hora por IP sin clave |
| OVHcloud | sin clave (opcional `OVHCLOUD_API_KEY`) | https://www.ovhcloud.com/es-es/public-cloud/ai-endpoints/ | 2/min por modelo sin clave; 400/min con clave |
| LLM7.io | sin clave (opcional `LLM7_API_KEY`) | https://token.llm7.io | ~60/hora sin clave |
| Pollinations | sin clave (opcional `POLLINATIONS_API_KEY`) | https://auth.pollinations.ai | Límite por hora y por IP |
| Ollama, LM Studio, llama.cpp | sin clave | se detectan solos si están encendidos | En tu ordenador, sin límites |

GitHub Models ya no aparece: cerró el 30 de julio de 2026.

## Uso

```bash
cd mi-proyecto
vipcode                      # interfaz
vipcode "arregla el test"    # interfaz y empieza con ese mensaje
vipcode -c                   # continúa la última sesión de esta carpeta
vipcode run "tarea" --yolo   # hace la tarea sin interfaz y termina
vipcode --plan               # empieza en modo solo lectura
vipcode run "/review"        # también acepta comandos y skills: vipcode run "/mi-skill tarea"
vipcode update               # actualiza vipcode
vipcode trust                # confiar en la configuración que trae esta carpeta (vipcode untrust lo deshace)
```

### Actualizar

`/update` (o `vipcode update`) se adapta a cómo lo instalaste:

- **Con npm** (`npm install -g vipcode` o el paquete de la release): mira cuál es la última versión publicada en npm y en GitHub y, si es más nueva que la tuya, la instala.
- **Desde el código** (`git clone` + `npm link`): trae lo último del repositorio con `git pull`, instala las dependencias y compila. Si tienes cambios sin guardar en esa carpeta, no toca nada y te avisa.

Después cierra vipcode y vuelve a abrirlo. Además, una vez al día vipcode mira si hay una versión nueva y te avisa al abrirlo con un recuadro verde, y te lo recuerda en la barra de abajo hasta que actualizas; se desactiva con `"checkUpdates": false` en la configuración.

### En la interfaz

- **Enter** envía. **Alt+Enter** o `\` al final de la línea añade una línea nueva.
- **@ruta** adjunta un fichero, una carpeta o una imagen (con autocompletado). **Ctrl+V** pega una imagen del portapapeles, y arrastrar una imagen a la terminal también la adjunta.
- **Tab** cambia entre los agentes principales (`build` y `plan`, más los tuyos). **↑/↓** recorren el historial.
- **Ctrl+P** abre la paleta con todos los comandos, tus comandos y tus skills; escribe para filtrar.
- **!comando** lo ejecuta en la terminal sin salir de vipcode (por ejemplo `!git status` o `!npm test`). La salida se ve en pantalla y le llega al agente junto con tu siguiente mensaje.
- **Esc** interrumpe al agente. Mientras trabaja puedes seguir escribiendo: el mensaje se le entrega al acabar el paso actual.
- **Ctrl+C** interrumpe, cierra el diálogo o borra lo escrito; dos veces seguidas sale.

Mientras trabaja ves qué modelo está pensando, cada herramienta con su acción en español («Lee», «Edita», «Ejecuta»…), las líneas añadidas y quitadas y lo que tarda. Debajo de cada respuesta aparece el modelo que ha contestado, su nota, el tiempo y los tokens. La barra de abajo muestra el agente, el modelo, cuánto contexto llevas gastado (▰▰▱▱), los modelos disponibles y los mensajes en cola.

Antes de editar un fichero, ejecutar un comando o salir a internet, vipcode pregunta enseñando el diff o el comando. Puedes contestar que sí una vez, que sí a todo lo de ese tipo durante la sesión, que sí siempre a un comando concreto (por ejemplo `npm test*`), que no, o que no y explicarle qué hacer.

### Sesiones

Cada conversación se guarda sola en `~/.vipcode/sessions/`, en dos ficheros:

- **`.json`**, para poder seguirla.
- **`.md`**, con la conversación entera para leerla o compartirla: lo que escribiste, cada respuesta con el modelo que contestó, las herramientas que usó y los cambios que hizo en cada fichero. Se actualiza solo mientras hablas y no pierde nada aunque la conversación se resuma para que quepa en el modelo.

Para volver a una conversación: `vipcode -c` (la última de esta carpeta), `/sessions` (eliges de la lista) o `vipcode -s <id>`. Al volver ves en pantalla toda la conversación anterior, y el modelo tiene su contexto para seguir donde lo dejasteis. `/export` guarda además una copia en `~/.vipcode/exports/`.

### Comandos

| Comando | Qué hace |
|---|---|
| `/models` | Lista de modelos y su estado; elige uno preferido. `/models refresh` busca modelos gratis nuevos |
| `/model <p/m>` | Fija un modelo (`/model auto` vuelve a la rotación) |
| `/connect`, `/disconnect`, `/providers` | Añadir, quitar y ver las claves de los proveedores |
| `/agents`, `/agent <nombre>`, `/plan`, `/build` | Cambiar de agente |
| `/undo`, `/redo`, `/diff [all]` | Deshacer y rehacer el último mensaje (ficheros y conversación); ver los cambios |
| `/todos` | Lista de tareas del agente |
| `/skills` | Skills instaladas; elige una para usarla (o escribe `/nombre-de-la-skill tarea`) |
| `/compact` | Resumir la conversación |
| `/new`, `/sessions`, `/load <n>`, `/delete <n>`, `/export` | Sesiones |
| `/usage` | Tokens usados |
| `/mcp`, `/lsp` | Estado de los servidores MCP y de lenguaje |
| `/yolo [on\|off]` | Aprobar todo sin preguntar durante la sesión |
| `/reset-limits` | Olvidar las pausas guardadas de los proveedores |
| `/update` | Actualizar vipcode (ver [Actualizar](#actualizar)) |
| `/init` | Crea o mejora `AGENTS.md` con las instrucciones del proyecto |
| `/review` | Revisa los cambios sin confirmar (sin tocar nada) |
| `/config`, `/help`, `/exit` | |

### Agentes

- **build**: el principal; puede editar y ejecutar.
- **plan**: solo lectura; investiga y propone un plan. Los subagentes que lance tampoco pueden editar.
- **general** y **explore**: subagentes que el agente principal lanza con la herramienta `task` para investigar o hacer subtareas con su propio contexto. Si pide varios a la vez, trabajan en paralelo.

## Cómo funciona la rotación

### Qué modelo va primero

Sin configurar nada, los modelos van en el orden del catálogo de vipcode: primero los proveedores con mejores modelos gratis y, dentro de cada uno, los que mejor programan.

Si quieres que se ordenen de mejor a peor con datos reales, consigue una clave gratuita en https://llm-stats.com/developer (250 consultas al día; con una actualización diaria sobra) y guárdala con `vipcode auth login llm-stats` o con la variable `LLMSTATS_API_KEY`. vipcode descarga las notas en ese momento y luego una vez al día. vipcode no trae esos datos dentro porque las condiciones de LLM Stats no permiten redistribuirlos: cada persona los descarga con su propia clave y solo se usan en su ordenador.

Como vipcode es un agente de programación, la nota de cada modelo combina sus índices de programación (40 %), agentes (30 %), uso de herramientas (15 %) e índice general (15 %). Cada índice se pasa a percentil para que sean comparables, y la nota va de 0 a 100. La ves delante de cada modelo en `/models` y `vipcode models`.

Con las notas descargadas, el orden completo es:

1. Los modelos que encajen con tus patrones de `order` (y el que fijes con `/model`).
2. Tus proveedores propios (los que añades en `providers` y no vienen en el catálogo).
3. Todos los demás, de mejor a peor nota, tengan clave o no: si un modelo sin clave es mejor que uno con clave, va antes.
4. Al final, los modelos que LLM Stats no conoce (enrutadores como `kilo-auto/free` o modelos muy nuevos).

Si prefieres que los anónimos (sin clave) vayan siempre detrás, porque tienen límites por IP y pueden guardar lo que envías, pon `"ranking": { "anonymousLast": true }`.


### Cuando un modelo falla

vipcode salta al siguiente de la lista. Lo que pasa con el que ha fallado depende del error:

- **Límite por minuto**: se pausa el tiempo que diga el proveedor (o 60 s). Si el límite es de toda la cuenta (NVIDIA, Mistral, OpenRouter…), se pausan todos sus modelos.
- **Límite diario o sin créditos**: se pausa hasta medianoche UTC o hasta cuando diga el proveedor.
- **Modelo que no existe, sin herramientas o fuera del plan gratis**: se descarta durante un día o una semana.
- **Clave inválida**: se descarta el proveedor durante la sesión.
- **Conversación demasiado larga para ese modelo** o error raro: se prueba otro solo para esa petición.
- **Error del servidor o sin respuesta durante 2 minutos**: se pausa 30 s.

Las pausas se guardan en `~/.vipcode/state.json`, así que se recuerdan entre ejecuciones. Si todos están en pausa menos de 90 s, vipcode espera; si no, te dice cuándo vuelve el primero.

Una vez al día (o con `/models refresh`, o `vipcode models refresh` desde la terminal) vipcode pregunta a cada proveedor qué modelos tiene, también a los que no piden clave (Kilo, OVHcloud y LLM7), añade los gratis nuevos y quita los que ya no existen.

## Configuración

- Global: `~/.vipcode/config.json` (se crea la primera vez).
- Por proyecto: `vipcode.json` o `.vipcode/config.json` en la carpeta del proyecto (se mezcla con la global). Solo se usa si confías en la carpeta: ver [Seguridad](#seguridad).

```json
{
  "model": "",
  "order": ["groq/*", "gemini/gemini-3.8-flash"],
  "disabledProviders": ["cohere"],
  "enabledProviders": [],
  "providers": [
    {
      "name": "mi-servidor",
      "baseURL": "http://192.168.1.10:8000/v1",
      "apiKeyEnv": "MI_CLAVE",
      "models": [{ "id": "qwen3-coder", "context": 32000 }]
    },
    { "name": "groq", "models": [{ "id": "openai/gpt-oss-120b", "context": 6000 }] }
  ],
  "permission": {
    "edit": "ask",
    "bash": { "*": "ask", "git status*": "allow", "npm test*": "allow", "rm *": "deny" },
    "webfetch": "allow",
    "mcp": { "*": "ask", "github_list_*": "allow" }
  },
  "mcp": {
    "github": { "type": "local", "command": ["npx", "-y", "@modelcontextprotocol/server-github"], "environment": { "GITHUB_PERSONAL_ACCESS_TOKEN": "..." } },
    "docs": { "type": "remote", "url": "https://ejemplo.com/mcp", "headers": { "Authorization": "Bearer ..." } }
  },
  "lsp": {
    "pyright": false,
    "mi-lsp": { "command": ["mi-lsp", "--stdio"], "extensions": [".foo"] }
  },
  "agents": { "plan": { "model": "gemini/*" } },
  "commands": { "tests": { "template": "Ejecuta los tests y arregla lo que falle. $ARGUMENTS", "description": "Arregla los tests" } },
  "instructions": ["docs/estilo.md", ".cursor/rules/*.md"],
  "maxSteps": 50,
  "autoCompactTokens": 90000,
  "bashTimeoutMs": 120000,
  "maxWaitMs": 90000,
  "snapshot": true,
  "autoUpdateModels": true,
  "checkUpdates": true,
  "keyless": true,
  "ranking": { "enabled": true, "metric": "coding", "anonymousLast": false },
  "skills": { "enabled": true, "paths": [], "disabled": [], "external": true },
  "showReasoning": true
}
```

- **keyless**: `false` para no usar nunca los proveedores anónimos (Kilo, OVHcloud, LLM7, Pollinations) salvo que les pongas clave.
- **ranking**: `enabled: false` vuelve al orden del catálogo; `metric: "general"` ordena por el índice general de LLM Stats en vez de por programación; `anonymousLast: true` pone los anónimos (sin clave) detrás de los que tienen clave aunque tengan mejor nota.
- **providers**: si el nombre coincide con uno del catálogo, solo cambia lo que pongas (los modelos se añaden o se sobrescriben por id; con `"replaceModels": true` se usan solo los tuyos). Si es nuevo, es un proveedor propio compatible con la API de OpenAI y va el primero en la rotación. Admite `apiKeyEnv`, `apiKey`, `headers`, `noKey`, `discover: "openai"` para descubrir sus modelos, y en cada modelo `context`, `vision` y `disabled`.
- **order**: patrones `proveedor/modelo` que van primero. **model**: modelo fijado al arrancar.
- **permission**: `allow`, `ask` o `deny`. En `bash` y `mcp` gana el patrón más concreto, y los comandos encadenados (`&&`, `&`, `|`, `;`, saltos de línea) se comprueban por separado. Aunque un comando esté permitido, se pregunta siempre si escribe en un fichero (`>`, `--output`) o lleva `$(…)` o comillas invertidas. Las reglas `deny` se respetan incluso con `--yolo`.
- **mcp**: servidores locales (`command`) o remotos (`url`, con HTTP o SSE). Los remotos que piden iniciar sesión con OAuth todavía no funcionan; los que usan una cabecera con token, sí. Sus herramientas aparecen como `servidor_herramienta`. En modo plan solo se usan las marcadas como de solo lectura.
- **lsp**: `false` desactiva los diagnósticos; `"id": false` desactiva un servidor concreto.

### Agentes y comandos propios

Ficheros Markdown en `~/.vipcode/agents/` (para todos tus proyectos) o `.vipcode/agents/` (solo para ese proyecto):

```markdown
---
description: Revisa la seguridad del código
mode: subagent          # primary (se elige con Tab), subagent (solo con task) o all
model: gemini/*         # opcional
temperature: 0.2        # opcional
tools:
  write: false
  edit: false
  bash: false
---
Eres un experto en seguridad. Busca inyecciones, secretos en el código y permisos mal puestos.
```

Comandos en `~/.vipcode/commands/` o `.vipcode/commands/`. Se lanzan con `/nombre argumentos`:

```markdown
---
description: Arregla los tests que fallan
agent: build
---
Estos son los tests que fallan ahora mismo:
!`npm test 2>&1 | tail -40`

Arréglalos. Céntrate en $ARGUMENTS.
```

`$ARGUMENTS` es todo lo que escribes detrás del comando, `$1`…`$9` cada palabra (respetando comillas), y `` !`comando` `` se sustituye por su salida. Con `subtask: true` el comando se ejecuta como subagente y no llena la conversación.

Los agentes y comandos que traiga un proyecto (también los de `.opencode/agent/` y `.opencode/command/`, si ya los tiene) se cargan siempre, pero hasta que confías en la carpeta un agente del proyecto no puede cambiar sus permisos (`permission`, `readOnly`) y los `` !`comando` `` de sus comandos no se ejecutan.

### Skills

Una skill es una carpeta con un `SKILL.md`: instrucciones (y, si hace falta, scripts y documentos) para un tipo de tarea concreto, como rellenar PDF, seguir la guía de estilo de la empresa o preparar un informe. Es el formato abierto [Agent Skills](https://agentskills.io), que usan muchos agentes de programación, así que las skills que encuentres para ellos también sirven aquí.

```markdown
---
name: informes-semanales
description: Úsala cuando el usuario pida el informe semanal del equipo.
---

# Informe semanal

1. Lee las notas de `notas/` de esta semana.
2. Rellena la plantilla de `references/plantilla.md` (está en la carpeta de la skill).
```

El agente solo ve el nombre y la descripción de cada skill. Cuando la tarea encaja, la carga él solo con la herramienta `skill` y lee sus documentos cuando los necesita. También puedes usarla tú: `/informes-semanales el de esta semana` en la interfaz, o `vipcode run "/informes-semanales el de esta semana"`.

```bash
vipcode skills                                   # las que tienes y de dónde vienen
vipcode skills add anthropics/skills             # todas las de un repositorio de GitHub
vipcode skills add https://github.com/usuario/repo/tree/main/skills/pdf   # solo una carpeta
vipcode skills add ./mis-skills                  # desde una carpeta de tu ordenador
vipcode skills add <origen> --project            # en .vipcode/skills del proyecto (para compartirla con el equipo)
vipcode skills new informes-semanales            # crea una vacía para rellenar
vipcode skills remove informes-semanales
```

`vipcode skills add` copia las skills a `~/.vipcode/skills`, o con `--project` a `.vipcode/skills`. Si ya existe una con el mismo nombre la deja como está, salvo que añadas `--force`. Para los repositorios hace falta tener `git` instalado.

vipcode también lee las skills que ya tengas de otros programas (`~/.claude/skills`, `~/.config/opencode/skill`, `~/.agents/skills` y las mismas carpetas dentro del proyecto). Si dos tienen el mismo nombre, gana la del proyecto. En la configuración:

```json
"skills": { "enabled": true, "paths": ["~/mis-skills"], "disabled": ["una-que-no-quiero"], "external": true }
```

`paths` añade carpetas, `disabled` ignora skills por nombre y `external: false` deja de leer esas carpetas de otros programas. En la cabecera de la skill, `user-invocable: false` hace que solo la use el agente, y `disable-model-invocation: true` que solo la uses tú con `/nombre`.

Las skills pueden traer scripts: revisa las que instales si no conoces su origen. vipcode no ejecuta nada por su cuenta; si la skill pide lanzar un script, el agente usa `bash` y te pide permiso igual que con cualquier otro comando.

### Instrucciones del proyecto

vipcode lee `AGENTS.md` (o `CLAUDE.md`, o `.vipcode.md`) de la raíz del proyecto, tus instrucciones generales de `~/.vipcode/AGENTS.md` y los ficheros de `instructions`. `/init` crea un `AGENTS.md` analizando el proyecto.

### Diagnósticos (LSP)

Después de cada edición, vipcode pregunta al servidor de lenguaje si hay errores y se los pasa al modelo. Para TypeScript y JavaScript no hace falta instalar nada: usa el servidor que trae TypeScript 7. Para otros lenguajes usa el servidor si lo tienes instalado: pyright o basedpyright, pylsp, gopls, rust-analyzer, clangd, intelephense o phpactor, ruby-lsp, bash-language-server, yaml-language-server, los de VS Code para CSS, HTML y JSON, lua-language-server, zls, dart, csharp-ls, sourcekit-lsp, kotlin-language-server y svelte.

## Seguridad

vipcode ejecuta lo que le pide un modelo de IA, así que está hecho para que nada importante pase sin que lo veas:

- **Permisos.** Antes de editar un fichero, ejecutar un comando, salir a internet o usar una herramienta MCP, pregunta enseñando el diff o el comando. De serie solo se aprueban solos unos pocos comandos que no cambian nada (`git status`, `git diff`, `git log`, `git show`, `ls`, `pwd`), y ni siquiera esos si llevan otro comando detrás (`&`, `;`, `&&`, `|`), escriben en un fichero (`>`, `--output`) o llevan `$(…)`. Con `--yolo` o `/yolo` se aprueba todo menos lo que tengas en `deny`: úsalo solo en carpetas sin nada que perder, porque los comandos no se ejecutan aislados en un sandbox.
- **Carpetas en las que confías.** Un proyecto puede traer su propia configuración de vipcode (`vipcode.json`, `.vipcode/config.json`, agentes con permisos propios, comandos con `` !`órdenes` ``). Como eso podría arrancar programas, mandar tus claves a otro servidor o quitar las preguntas de permiso, vipcode no lo usa hasta que confías en la carpeta. Al abrirlo te enseña qué cambiaría y te pregunta; con `vipcode run` solo avisa. Si la configuración cambia después (por ejemplo tras un `git pull`), vuelve a preguntar. `vipcode trust` y `vipcode untrust` lo cambian a mano.
- **Ficheros.** Las herramientas solo leen y escriben dentro de la carpeta del proyecto. Un enlace simbólico que lleve fuera (por ejemplo a `~/.ssh` o a tus claves) se rechaza.
- **vipcode no puede tocarse a sí mismo.** Aunque lo abras en una carpeta que las contenga (por ejemplo tu carpeta personal), el agente no puede leer ni cambiar `~/.vipcode` (tus claves, tu configuración y las carpetas en las que confías) ni modificar la carpeta donde está instalado vipcode, así que tampoco puede desactivar estas protecciones. Los comandos que nombran esas carpetas se preguntan siempre, aunque tengas una regla `allow` o hayas dicho «sí a todo», y con `--yolo` sin nadie delante se rechazan.
- **Terminal.** Lo que escriben el modelo o las herramientas no puede manejar tu terminal (borrar líneas, cambiar el portapapeles, falsear enlaces). En los diálogos de permiso esos caracteres se ven como `␛` en vez de actuar, para que nadie pueda disfrazar un comando.
- **Tus datos.** `~/.vipcode` solo lo puede abrir tu usuario y `auth.json` tiene permisos 600. vipcode no envía datos de uso a nadie.

Si encuentras un fallo de seguridad, avísalo en privado como explica [SECURITY.md](SECURITY.md).

## Privacidad

La primera vez que vipcode va a usar un proveedor que no pide clave, te lo avisa y te deja elegir entre seguir, añadir antes una clave o no usarlos nunca.

Los planes gratuitos tienen letra pequeña: los proveedores anónimos (Kilo, OVHcloud, LLM7, Pollinations), Mistral (plan Experiment), varios modelos `:free` de OpenRouter, NVIDIA y otros pueden guardar lo que envías o usarlo para entrenar sus modelos. No mandes secretos ni código confidencial. Para eso usa un modelo local con Ollama o LM Studio y pon `"keyless": false` en la configuración.

## Ficheros de datos

Todo está en `~/.vipcode` (o en `VIPCODE_HOME` si la defines):

- `config.json`: tu configuración. `auth.json`: claves (permisos 600). `state.json`: pausas de los proveedores. `notices.json`: avisos que ya has visto. `update.json`: última comprobación de versiones nuevas. `trusted.json`: carpetas en las que confías.
- `models.json`: modelos descubiertos. `ranking.json`: puntuaciones de LLM Stats descargadas con tu clave. `sessions/`: conversaciones (un `.json` para seguirlas y un `.md` para leerlas). `history.jsonl`: lo que has escrito.
- `snapshots/`: instantáneas para `/undo` (un repositorio git aparte por proyecto; no toca tu `.git`).
- `exports/`: conversaciones exportadas. `agents/`, `commands/` y `skills/`: tus agentes, comandos y skills globales.

## Desarrollo

```bash
npm run build       # compila a dist/
npm test            # compila y pasa las pruebas (servidor de IA simulado, sin claves ni internet)
VIPCODE_DEBUG=1 vipcode # apunta los detalles internos en ~/.vipcode/debug.log
```

vipcode no se deja modificar a sí mismo. Si quieres trabajar en su código con un vipcode instalado desde esa misma carpeta (`npm link`), arráncalo con `VIPCODE_ALLOW_SELF_EDIT=1 vipcode`; o usa el instalado con npm para trabajar en tu copia del código.

### Publicar una versión

```bash
npm login                            # la primera vez (y gh auth login si no lo tienes)
npm run release -- 0.3.0 --dry-run   # comprueba que todo está listo y enseña lo que haría
npm run release -- 0.3.0             # o patch, minor o major
```

Sube el número en `package.json`, pasa las pruebas, crea el commit y la etiqueta, lo sube a GitHub, crea la release con el paquete compilado y lo publica en npm. Quien ya tenga vipcode verá el aviso de versión nueva en menos de un día.

## Licencia

[MIT](LICENSE) © Pablo Vicente Juan.

vipcode no envía datos de uso a nadie. Solo se conecta a los proveedores de IA que uses, a las webs que consulte el agente con `webfetch` y `websearch`, a tus servidores MCP, a npm y a GitHub una vez al día para ver si hay versión nueva (`"checkUpdates": false` lo desactiva) y, si le das tu clave, a LLM Stats para descargar el ranking (datos de LLM Stats, llm-stats.com).
