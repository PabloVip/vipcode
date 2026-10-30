# vipcode

[![npm](https://img.shields.io/npm/v/vipcode.svg)](https://www.npmjs.com/package/vipcode) [![Pruebas](https://github.com/PabloVip/vipcode/actions/workflows/ci.yml/badge.svg)](https://github.com/PabloVip/vipcode/actions/workflows/ci.yml) [![Licencia MIT](https://img.shields.io/badge/licencia-MIT-blue.svg)](LICENSE) · [English](README.en.md)

Agente de programación para la terminal (comando `vipcode`) que solo usa **modelos gratuitos** y **rota automáticamente** entre proveedores cuando uno se agota.

![vipcode arreglando un fallo en carrito.js: lee el fichero, enseña el cambio, pide permiso y lo aplica; después, el profe explica por qué](https://raw.githubusercontent.com/PabloVip/vipcode/main/docs/demo.svg)

- **Funciona nada más instalarlo, sin claves ni registro**: usa los proveedores que permiten el acceso anónimo (Kilo Gateway, OVHcloud, LLM7 y Pollinations).
- Con claves gratuitas de los más de 20 proveedores incluidos (Gemini, NVIDIA, Mistral, Cerebras, OpenRouter, Groq, Z.ai…) tienes más límites y mejores modelos; en OpenRouter basta con iniciar sesión en el navegador.
- Lee y edita tus ficheros, ejecuta comandos y busca en tu código y en internet, enseñándote cada cambio antes de hacerlo. `/undo` deshace lo último.
- Te dice cuánto te queda de cada plan gratis, guarda tus conversaciones y admite agentes, comandos y [skills](#skills) propios.
- **Seguro por defecto**: pregunta antes de editar, ejecutar o salir a internet y no sale de la carpeta del proyecto (ver [Seguridad y privacidad](#seguridad-y-privacidad)).

## Instalación

Requiere Node.js 22 o superior. Funciona en macOS, Linux y Windows.

```bash
npm install -g vipcode
```

**En Windows** instala también [Git para Windows](https://git-scm.com/download/win) (`winget install Git.Git`): vipcode usa su bash para los comandos y git para `/undo`. Sin él usa PowerShell, y te lo recuerda al abrirlo.

Para actualizar, escribe `/update` dentro de vipcode o `vipcode update` en la terminal: verás cómo va con una barra de carga y, al terminar, te ofrecerá reiniciar vipcode para usar la versión nueva sin salir de la conversación. Cuando sale una versión nueva, vipcode te avisa (y te dice si trae arreglos de seguridad), y al abrir la nueva te enseña lo que trae. Todas las novedades están en [CHANGELOG.md](CHANGELOG.md).

Si algo falla, ejecuta `vipcode doctor` (o `/doctor` dentro de vipcode): comprueba los programas, tus claves y los proveedores, y dice cómo arreglar lo que falte. Si no se arregla, escribe `/bug` (o `vipcode bug`): abre en tu navegador un issue de GitHub con ese informe ya puesto, que no lleva tus claves; tú cuentas qué ha pasado y lo envías. Con `VIPCODE_DEBUG=1 vipcode` se guarda además en `~/.vipcode/debug.log` un registro que ayuda a encontrar el problema.

## Primeros pasos

¿Es tu primera vez? `vipcode tutorial` te enseña lo básico en 5 pasos, en una carpeta de prácticas.

Abre `vipcode` en la carpeta de tu proyecto y escribe lo que quieres hacer. No hace falta configurar nada: sin claves usa proveedores que permiten el acceso anónimo, con pocos mensajes (Kilo Gateway, 200 por hora; OVHcloud, 2 por minuto en cada modelo; LLM7, unos 60 por hora; Pollinations, un límite por hora). Cuando uno se agota, o tarda mucho en empezar a contestar, salta al siguiente.

Para tareas largas se quedan cortos, así que conviene añadir alguna clave gratuita; con una de Gemini, NVIDIA o Mistral se nota mucho:

- **`/connect`** dentro de vipcode: eliges el proveedor y pegas la clave. Si todavía no la tienes, pulsa Enter sin escribir nada y se abre la página donde se consigue.
- **OpenRouter, sin copiar claves**: `/connect openrouter` → «Iniciar sesión en el navegador». Entras con tu cuenta y vipcode recibe la clave sola; se llama «vipcode» en https://openrouter.ai/settings/keys y la puedes borrar desde ahí. Por SSH te da un enlace para abrirlo en cualquier navegador.
- **Desde la terminal**: `vipcode auth login [proveedor]`, `vipcode auth list` para ver lo que tienes y `vipcode auth logout <proveedor>` para borrar una clave. Se guardan en `~/.vipcode/auth.json`, que solo puede leer tu usuario.
- **Variables de entorno**, por ejemplo `export GEMINI_API_KEY="..."` en `~/.zshrc`.

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

## Uso

```bash
cd mi-proyecto
vipcode                      # abre vipcode
vipcode "arregla el test"    # y empieza con ese mensaje
vipcode -c                   # sigue con la última conversación de esta carpeta
vipcode --plan               # empieza con el agente planear (solo lectura)
vipcode run "tarea"          # hace la tarea sin interfaz y termina
vipcode limites              # cuánto te queda hoy de cada plan gratis
vipcode doctor               # comprueba que todo funciona
vipcode bug                  # avisa de un fallo en GitHub con el informe de vipcode doctor
vipcode tutorial             # aprende lo básico en 5 pasos, en una carpeta de prácticas
```

### En la interfaz

- **Enter** envía. **Alt+Enter** o `\` al final de la línea añade una línea nueva.
- **@ruta** adjunta un fichero, una carpeta o una imagen (con autocompletado). **Ctrl+V** pega una imagen del portapapeles, y arrastrar una imagen a la terminal también la adjunta.
- **Tab** cambia de agente. **↑/↓** recorren lo que has escrito antes.
- **Ctrl+P** abre la paleta con todos los comandos; escribe para filtrar.
- **!comando** lo ejecuta en la terminal sin salir de vipcode (por ejemplo `!git status`). El agente verá la salida con tu siguiente mensaje.
- **Esc** interrumpe al agente. Mientras trabaja puedes seguir escribiendo: el mensaje se le entrega al acabar el paso.
- **Ctrl+C** interrumpe, cierra el diálogo o borra lo escrito; dos veces seguidas sale.
- **La rueda del ratón**, **AvPág** y **RePág** suben y bajan por la conversación; la caja de escribir se queda abajo. Al escribir vuelves al final. La barra de la derecha dice por dónde vas (también se puede pinchar y arrastrar), y **Ctrl+Inicio** y **Ctrl+Fin** llevan al principio y al final.
- **Ctrl+F** busca en la conversación, sin distinguir mayúsculas ni tildes: Enter o ↑ va a la coincidencia anterior, ↓ a la siguiente y Esc cierra.
- **Un clic en una herramienta** (la línea que dice qué ha hecho) despliega su salida entera, y otro clic la pliega.
- **Copiar**: arrastra con el ratón sobre la conversación y, al soltar, lo seleccionado se copia solo al portapapeles. Doble clic copia una palabra (también una ruta o una dirección entera) y triple clic, la línea. `/copiar` copia la última respuesta y `/copiar código`, su último bloque de código. Para seleccionar como siempre lo hace la terminal (por ejemplo en la caja de escribir), mantén **Fn** (Terminal de macOS), **⌥** (iTerm2) o **Mayúsculas** (Windows y Linux) mientras arrastras.

Antes de editar un fichero, ejecutar un comando o salir a internet, vipcode te enseña el cambio o el comando y pregunta. Puedes contestar que sí una vez, que sí a todo lo de ese tipo durante la sesión, que sí siempre a ese comando (por ejemplo `npm test*`), que no, o que no y decirle qué hacer.

La barra de abajo enseña el agente, el modelo, cuánto te queda de su plan gratis y cuánto contexto llevas gastado.

vipcode ocupa la pantalla completa mientras lo usas; al salir, la terminal vuelve a estar como antes y la conversación queda guardada (`vipcode -c` sigue con ella).

Con **`/interfaz`** eliges cómo se ve, y se guarda para la próxima vez:

- **Pantalla completa** (la de serie): la conversación con su propio scroll, ratón y Ctrl+F.
- **Clásica**: la conversación se queda en la terminal y seleccionas como siempre.
- **Compacta**: sin espacios ni bordes de más, para que quepa más conversación.
- **Alto contraste**: sin texto atenuado y con colores vivos; se lee mejor, también con fondo claro.
- **Zen**: lo justo, sin bienvenida ni bordes y con la barra de abajo mínima.
- **Criaturas**: como la pantalla completa, con un monstruito de píxeles a la derecha que se inventa al azar. Sale otro con cada respuesta o si lo pinchas, y da saltitos mientras vipcode trabaja (a veces sale uno dorado). En terminales anchas (120 columnas y 32 filas) sale grande y con más detalle. En el Terminal del Mac se pinta con colores de fondo para que no salgan rayas entre las filas, y necesita una ventana de 90 columnas y 28 filas o más.

Con `"fullscreen": false`, lo que seleccionas se copia solo si lo activas en tu terminal:

- **iTerm2**: viene activado (Ajustes → General → Selection).
- **Windows Terminal**: Configuración → Interacción → «Copiar automáticamente la selección al portapapeles».
- **Terminal de VS Code**: el ajuste `terminal.integrated.copyOnSelection`.
- **kitty**, **Ghostty** y **Alacritty**: `copy_on_select clipboard`, `copy-on-select = clipboard` y `selection.save_to_clipboard = true`.
- **Terminal de macOS** y **GNOME Terminal** no tienen esa opción: selecciona y pulsa Cmd+C o Ctrl+Shift+C.

### Comandos

| Comando | Qué hace |
|---|---|
| `/models` | Lista de modelos y su estado; elige uno preferido. `/models refresh` busca modelos gratis nuevos |
| `/model <p/m>` | Fija un modelo (`/model auto` vuelve a la rotación) |
| `/connect`, `/disconnect`, `/providers` | Añadir, quitar y ver las claves de los proveedores |
| `/agents`, `/agent <nombre>`, `/planear`, `/programar`, `/profe` | Cambiar de agente |
| `/undo`, `/redo`, `/diff [all]` | Deshacer y rehacer el último mensaje (ficheros y conversación); ver los cambios |
| `/todos` | Lista de tareas del agente |
| `/skills` | Skills instaladas; elige una para usarla (o escribe `/nombre-de-la-skill tarea`) |
| `/compact` | Resumir la conversación |
| `/new`, `/sessions`, `/load <n>`, `/delete <n>`, `/export` | Conversaciones |
| `/limites` | Cuánto te queda hoy de cada plan gratis |
| `/copiar [código]` | Copia la última respuesta (o su último bloque de código) al portapapeles |
| `/doctor` | Comprueba que todo funciona y dice cómo arreglar lo que falte |
| `/bug [qué ha pasado]` | Avisa de un fallo: abre un issue en GitHub con el informe de `/doctor` ya puesto (sin tus claves) |
| `/tutorial` | Aprende lo básico en 5 pasos, en una carpeta de prácticas |
| `/interfaz` | Elige cómo se ve vipcode: pantalla completa, clásica, compacta, alto contraste, zen o criaturas |
| `/usage` | Tokens usados |
| `/mcp`, `/lsp` | Estado de los servidores MCP y de lenguaje |
| `/yolo [on\|off]` | Aprobar todo sin preguntar durante la sesión |
| `/reset-limits` | Olvidar las pausas guardadas de los proveedores |
| `/update` | Actualizar vipcode |
| `/init` | Crea o mejora `AGENTS.md` con las instrucciones del proyecto |
| `/review` | Revisa los cambios sin confirmar (sin tocar nada) |
| `/config`, `/help`, `/exit` | |

### Agentes

- **programar**: el principal; puede editar y ejecutar.
- **planear**: solo lee; investiga y propone un plan.
- **profe**: para aprender. Te explica paso a paso, en palabras sencillas, y te propone los cambios para que los hagas tú (no toca nada).
- **ayudante** y **explorar**: subagentes que el principal lanza para subtareas (ayudante puede editar; explorar solo busca y lee). Si lanza varios, trabajan a la vez.

### Conversaciones

Cada conversación se guarda sola en `~/.vipcode/sessions/`, también en Markdown (`.md`) para leerla o compartirla. Para volver a una: `vipcode -c` (la última de esta carpeta), `/sessions` (eliges de la lista) o `vipcode -s <id>`. Ves toda la conversación anterior y el modelo sigue donde lo dejasteis.

### Cuánto te queda

`/limites` (o `vipcode limites`) enseña lo que llevas hoy en cada proveedor y modelo, cuánto te queda y qué está en pausa y hasta cuándo.

- **«quedan»** es lo que dice el propio proveedor (Groq y Cerebras, por ejemplo).
- **«≈ quedan»** es la cuenta de vipcode con los límites conocidos de su plan gratis. Solo cuenta lo de este ordenador: si usas la misma clave en otros programas, te quedará menos.

### Qué modelo usa

Empieza por los mejores modelos gratis y, cuando uno llega a su límite, lo deja en pausa hasta que vuelve y sigue con el siguiente. Con una clave gratuita de [LLM Stats](https://llm-stats.com/developer) (`vipcode auth login llm-stats`) los ordena por su ranking, dando más peso a programar y a usar herramientas. Cada día añade solos los modelos gratis nuevos. `/models` enseña la lista y `/model` fija uno.

## Personalizar

### Configuración

La tuya está en `~/.vipcode/config.json`, y un proyecto puede traer la suya en `vipcode.json` o `.vipcode/config.json` (solo se usa si confías en la carpeta, ver [Seguridad y privacidad](#seguridad-y-privacidad)). Lo más útil:

```json
{
  "order": ["groq/*", "gemini/gemini-3.8-flash"],
  "disabledProviders": ["cohere"],
  "providers": [
    { "name": "mi-servidor", "baseURL": "http://192.168.1.10:8000/v1", "apiKeyEnv": "MI_CLAVE", "models": [{ "id": "qwen3-coder", "context": 32000 }] }
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

- **order**: modelos que van primero. **disabledProviders**: proveedores que no quieres usar.
- **providers**: un servidor tuyo compatible con la API de OpenAI (o cambios en los modelos de uno del catálogo).
- **permission**: `allow`, `ask` o `deny` para `edit`, `bash`, `webfetch` y `mcp`; en `bash` y `mcp` gana el patrón más concreto. Las reglas `deny` se respetan incluso con `--yolo`. Piénsatelo antes de poner `webfetch` en `allow`: un texto malicioso podría hacer que el modelo mande tus datos a una web sin preguntarte.
- **mcp**: servidores MCP locales (`command`) o remotos (`url`); los que piden iniciar sesión con OAuth todavía no funcionan. Un servidor local no recibe tus variables de entorno (ni tus claves), solo lo imprescindible para arrancar: lo que necesite, ponlo en `environment`. Ahí y en `headers`, `{env:NOMBRE}` se cambia por esa variable tuya.
- **keyless**: `false` para no usar nunca los proveedores sin clave. **checkUpdates**: `false` para no buscar versiones nuevas.
- **interfaz**: la que eliges con `/interfaz` (`completa`, `clasica`, `compacta`, `contraste`, `zen` o `criaturas`). El `"fullscreen": false` de antes sigue valiendo y es la clásica.
- **firstResponseMs**: cuánto se espera a que una IA empiece a contestar antes de probar otra (40000, unos 40 s; algo más con conversaciones largas). No cuenta para los modelos de tu ordenador.

Variables de entorno: `VIPCODE_HOME` (otra carpeta en lugar de `~/.vipcode`), `VIPCODE_SHELL` (otra shell para los comandos: `pwsh`, `powershell`, `cmd` o un bash), `VIPCODE_BROWSER` (otro navegador) y `VIPCODE_CLIPBOARD` (otro programa para copiar, que reciba el texto por su entrada).

### Agentes y comandos propios

Un agente es un fichero Markdown en `~/.vipcode/agents/` (para todos tus proyectos) o `.vipcode/agents/` (solo para ese proyecto):

```markdown
---
description: Revisa la seguridad del código
mode: subagent          # primary (se elige con Tab), subagent (lo lanza el agente principal) o all
model: gemini/*         # opcional
tools:
  write: false
  edit: false
  bash: false
---
Eres un experto en seguridad. Busca inyecciones, secretos en el código y permisos mal puestos.
```

Un comando va en `~/.vipcode/commands/` o `.vipcode/commands/` y se lanza con `/nombre argumentos`:

```markdown
---
description: Arregla los tests que fallan
agent: programar
---
Estos son los tests que fallan ahora mismo:
!`npm test 2>&1 | tail -40`

Arréglalos. Céntrate en $ARGUMENTS.
```

`$ARGUMENTS` es lo que escribes detrás del comando, `$1`…`$9` cada palabra, y `` !`comando` `` se sustituye por su salida. Los agentes y comandos que trae un proyecto no pueden cambiar permisos ni ejecutar órdenes hasta que confías en la carpeta.

### Skills

Una skill es una carpeta con un `SKILL.md`: instrucciones (y, si hace falta, scripts y documentos) para un tipo de tarea, como rellenar PDF, seguir la guía de estilo de tu empresa o preparar un informe. Es el formato abierto [Agent Skills](https://agentskills.io), así que sirven las que encuentres para otros agentes de programación.

```markdown
---
name: informes-semanales
description: Úsala cuando el usuario pida el informe semanal del equipo.
---

# Informe semanal

1. Lee las notas de `notas/` de esta semana.
2. Rellena la plantilla de `references/plantilla.md` (está en la carpeta de la skill).
```

El agente la carga él solo cuando la tarea encaja, y tú puedes usarla con `/informes-semanales el de esta semana`.

```bash
vipcode skills                                   # las que tienes
vipcode skills add anthropics/skills             # todas las de un repositorio de GitHub
vipcode skills add ./mis-skills                  # desde una carpeta de tu ordenador
vipcode skills add <origen> --project            # en el proyecto, para compartirla con tu equipo
vipcode skills new informes-semanales            # crea una vacía para rellenar
vipcode skills remove informes-semanales
```

vipcode también lee las skills que ya tengas de otros programas (`~/.claude/skills`, `~/.config/opencode/skill`, `~/.agents/skills`). Las skills pueden traer scripts: revisa las que instales si no conoces su origen. Si una pide ejecutar algo, vipcode te pide permiso como con cualquier otro comando.

### Instrucciones del proyecto

vipcode lee `AGENTS.md` (o `CLAUDE.md`) de tu proyecto y tus instrucciones generales de `~/.vipcode/AGENTS.md`. `/init` crea un `AGENTS.md` analizando el proyecto.

Después de cada edición, le pasa al modelo los errores que encuentre el servidor de lenguaje: con TypeScript y JavaScript sin instalar nada, y con otros lenguajes si tienes su servidor instalado en tu ordenador (pyright, gopls, rust-analyzer, clangd…). Los que traiga un proyecto en su `node_modules` no se usan.

## Seguridad y privacidad

- **Permisos.** Antes de editar un fichero, ejecutar un comando, salir a internet o usar una herramienta MCP, vipcode pregunta enseñando el comando entero. Solo se aprueban solos unos pocos comandos que no cambian nada (`git status`, `git diff`, `git log`, `ls`…), y nunca si miran fuera del proyecto o pueden ejecutar programas (como `git difftool`). Con `--yolo` o `/yolo` se aprueba todo menos lo que tengas en `deny`: úsalo solo en carpetas sin nada que perder.
- **Lo que trae un proyecto no se ejecuta solo.** vipcode no arranca programas de la carpeta del proyecto (ni servidores de lenguaje de su `node_modules`, ni un `git` o un `rg` que traiga), no lee `AGENTS.md`, agentes, comandos ni skills que sean enlaces a ficheros de fuera, y pregunta siempre antes de escribir en `.git` (sus hooks y su configuración se ejecutan cuando usas git).
- **Carpetas en las que confías.** Un proyecto puede traer su propia configuración de vipcode, y eso podría arrancar programas o mandar tus claves a otro sitio. Por eso vipcode no la usa hasta que confías en la carpeta: te enseña qué cambiaría y te pregunta (`vipcode trust` y `vipcode untrust` lo cambian a mano).
- **Ficheros e internet.** Solo lee, busca y escribe dentro de la carpeta del proyecto, y no puede leer ni cambiar tus claves ni su configuración. Antes de entrar en una dirección de tu ordenador o de tu red (tu router, `localhost`…) pregunta siempre, aunque tengas `webfetch` en `allow`.
- **Tus claves.** Los servidores MCP y de lenguaje que arranca vipcode no reciben tus claves: si el paquete de uno estuviera comprometido, no podría llevárselas. «Sí siempre a este comando» tampoco vale si el comando escribe en un fichero (`>`) o lleva `$(…)`: eso se pregunta siempre.
- **Tus datos.** vipcode no envía datos de uso a nadie: solo habla con los proveedores de IA que uses, con las webs que consulte el agente, con tus servidores MCP, con LLM Stats si le das tu clave y, como mucho una vez por hora, con npm y GitHub para ver si hay versión nueva.
- **Planes gratuitos.** Los proveedores sin clave y varios planes gratis pueden guardar lo que les envías o usarlo para entrenar sus modelos. No mandes contraseñas ni código confidencial; para eso usa un modelo local (Ollama, LM Studio) y pon `"keyless": false` en la configuración.

Si encuentras un fallo de seguridad, avísalo en privado como explica [SECURITY.md](SECURITY.md).

## Licencia

[MIT](LICENSE) © Pablo Vicente Juan. Ranking de modelos con datos de LLM Stats (llm-stats.com).
