<div align="center">

# vipcode

**El agente de programación para la terminal que no te cuesta nada.**<br>
Usa las IA gratuitas de más de 20 proveedores, funciona sin claves ni registro y, cuando una se agota, salta sola a otra.

[![npm](https://img.shields.io/npm/v/vipcode.svg)](https://www.npmjs.com/package/vipcode) [![Descargas](https://img.shields.io/npm/dm/vipcode.svg?label=descargas)](https://www.npmjs.com/package/vipcode) [![Pruebas](https://github.com/PabloVip/vipcode/actions/workflows/ci.yml/badge.svg)](https://github.com/PabloVip/vipcode/actions/workflows/ci.yml) [![Vigilancia diaria](https://github.com/PabloVip/vipcode/actions/workflows/vigilancia.yml/badge.svg)](https://github.com/PabloVip/vipcode/actions/workflows/vigilancia.yml) [![Licencia AGPL-3.0](https://img.shields.io/badge/licencia-AGPL--3.0-blue.svg)](LICENSE) ![macOS · Linux · Windows](https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-555.svg)

[English](README.en.md) · [Novedades](CHANGELOG.md) · [Colaborar](CONTRIBUTING.md) · [Seguridad](SECURITY.md)

</div>

![vipcode arreglando un fallo en carrito.js: lee el fichero, enseña el cambio, pide permiso y lo aplica; después, el profe explica por qué](https://raw.githubusercontent.com/PabloVip/vipcode/main/docs/demo.svg)

```bash
npm install -g vipcode
cd mi-proyecto && vipcode
```

Escribe lo que quieres hacer («arregla el test que falla», «añade un botón de exportar», «explícame este fichero») y vipcode lo hace: busca y lee en tu código, propone los cambios, te los enseña, pide permiso y los aplica. También ejecuta comandos y pruebas y consulta internet.

## En qué destaca

- **💸 Gratis de verdad.** Solo usa modelos gratuitos: nunca pagas nada. Nada más instalarlo funciona **sin claves ni registro**, con los proveedores que dejan entrar sin cuenta (Kilo Gateway, OVHcloud, LLM7 y Pollinations). Con claves gratuitas de más de 20 proveedores (Gemini, NVIDIA, Cerebras, Mistral, OpenRouter, Groq…) tienes más cupo y mejores modelos.
- **🔄 No te deja tirado.** Cuando un modelo llega a su límite, falla, está saturado o tarda en empezar a contestar, lo deja en pausa y sigue con otro sin que tengas que hacer nada. Si es todo un proveedor el que no responde, lo aparta entero en vez de esperar a cada modelo. Recuerda las pausas entre sesiones y te dice cuánto te queda de cada plan gratis.
- **🧠 Conversaciones largas también con modelos pequeños.** Si la conversación ya no cabe en los modelos libres, al de más capacidad le llega un resumen de lo anterior y los últimos mensajes tal cual. La conversación no se pierde: cuando vuelve un modelo en el que cabe entera, la recibe entera. Y aprende de cada respuesta cuántos tokens cuentan de verdad los proveedores, para no mandarle a un modelo lo que no le cabe.
- **🇪🇸 En español.** La interfaz, los avisos, los mensajes y la documentación. Y con un agente, el **profe**, que te enseña paso a paso para que lo hagas tú, sin tocar tu código.
- **🔒 Seguro por defecto.** Pregunta antes de editar, ejecutar o salir a internet, enseñando el cambio o el comando entero. No sale de la carpeta del proyecto, no ejecuta lo que traiga un proyecto hasta que confías en él y los programas que arranca no reciben tus claves. `/undo` deshace ficheros y conversación.
- **🩺 Un catálogo vigilado a diario.** Los planes gratis cambian sin avisar, así que cada día una tarea de GitHub comprueba que los modelos del catálogo siguen contestando y mantiene una conversación de verdad con los gratis: lee ficheros, resume, recuerda y edita. Si algo deja de funcionar, se sabe antes de que te pase a ti.
- **🧰 Completo.** Agentes y subagentes que trabajan a la vez, comandos y [skills](#skills) propios (con el formato abierto Agent Skills), servidores MCP, errores del servidor de lenguaje después de cada edición, imágenes, conversaciones guardadas también en Markdown, modelos en tu ordenador (Ollama, LM Studio, llama.cpp) y modo sin interfaz para scripts (`vipcode run`).
- **🖱️ Una interfaz cuidada.** Pantalla completa con ratón (rueda, selección que se copia sola, clic en enlaces y en comandos), búsqueda con Ctrl+F y cuatro estilos, uno de ellos con criaturas de píxeles.
- **💻 macOS, Linux y Windows.** Cada cambio se prueba en los tres antes de publicarse.

## Índice

- [Instalación](#instalación)
- [Primeros pasos](#primeros-pasos) · [Proveedores](#proveedores)
- [Cómo elige el modelo](#cómo-elige-el-modelo)
- [Conversaciones largas](#conversaciones-largas)
- [Uso](#uso): [en la interfaz](#en-la-interfaz) · [comandos](#comandos) · [agentes](#agentes) · [conversaciones](#conversaciones) · [cuánto te queda](#cuánto-te-queda)
- [Personalizar](#personalizar): [configuración](#configuración) · [agentes y comandos propios](#agentes-y-comandos-propios) · [skills](#skills) · [instrucciones del proyecto](#instrucciones-del-proyecto)
- [Seguridad y privacidad](#seguridad-y-privacidad)
- [Preguntas frecuentes](#preguntas-frecuentes)
- [Colaborar](#colaborar) · [Licencia](#licencia)

## Instalación

Requiere Node.js 22 o superior. Funciona en macOS, Linux y Windows.

```bash
npm install -g vipcode
```

**En Windows** instala también [Git para Windows](https://git-scm.com/download/win) (`winget install Git.Git`): vipcode usa su bash para los comandos y git para `/undo`. Sin él usa PowerShell, y te lo recuerda al abrirlo.

**Actualizar.** Escribe `/update` dentro de vipcode o `vipcode update` en la terminal: verás cómo va con una barra de carga y, al terminar, te ofrecerá reiniciar vipcode para usar la versión nueva sin salir de la conversación. Cuando sale una versión nueva, vipcode te avisa (y te dice si trae arreglos de seguridad), y al abrirla te enseña lo que trae. Todas las novedades están en [CHANGELOG.md](CHANGELOG.md).

**Si algo falla**, ejecuta `vipcode doctor` (o `/doctor` dentro de vipcode): comprueba los programas, tus claves y los proveedores, y dice cómo arreglar lo que falte. Si no se arregla, escribe `/bug` (o `vipcode bug`): abre en tu navegador un issue de GitHub con ese informe ya puesto, sin tus claves; tú cuentas qué ha pasado y lo envías. Con `VIPCODE_DEBUG=1 vipcode` se guarda además en `~/.vipcode/debug.log` un registro que ayuda a encontrar el problema.

## Primeros pasos

¿Es tu primera vez? `vipcode tutorial` te enseña lo básico en 5 pasos, en una carpeta de prácticas que no toca nada tuyo.

Abre `vipcode` en la carpeta de tu proyecto y escribe lo que quieres hacer. No hace falta configurar nada: sin claves usa los proveedores que permiten el acceso anónimo, con pocos mensajes (Kilo Gateway, 200 por hora; OVHcloud, 2 por minuto en cada modelo; LLM7, unos 60 por hora; Pollinations, un límite por hora). Cuando uno se agota, o tarda mucho en empezar a contestar, salta al siguiente.

Para trabajar en serio conviene añadir alguna clave gratuita. **Con estas tres se nota mucho**, y cada una se consigue en unos minutos:

1. **NVIDIA**: muchos de los mejores modelos abiertos (DeepSeek, GLM, Kimi, Nemotron) y unas 40 peticiones por minuto.
2. **Gemini**: los modelos Flash de Google, de buena calidad y con conversaciones muy largas.
3. **Cerebras**: el más rápido, con 14.400 peticiones al día por modelo.

Para añadir una clave:

- **`/connect`** dentro de vipcode: eliges el proveedor y pegas la clave. Si todavía no la tienes, pulsa Enter sin escribir nada y se abre la página donde se consigue.
- **OpenRouter, sin copiar claves**: `/connect openrouter` → «Iniciar sesión en el navegador». Entras con tu cuenta y vipcode recibe la clave solo; se llama «vipcode» en https://openrouter.ai/settings/keys y la puedes borrar desde ahí. Por SSH te da un enlace para abrirlo en cualquier navegador.
- **Desde la terminal**: `vipcode auth login [proveedor]`, `vipcode auth list` para ver lo que tienes y `vipcode auth logout <proveedor>` para borrar una clave. Se guardan en `~/.vipcode/auth.json`, que solo puede leer tu usuario.
- **Variables de entorno**, por ejemplo `export GEMINI_API_KEY="..."` en `~/.zshrc`.

### Proveedores

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

## Cómo elige el modelo

vipcode empieza por los mejores modelos gratis que tienes disponibles y va cambiando de uno a otro según haga falta:

- **Límites.** Cuando un modelo llega al límite de su plan gratis, lo deja en pausa hasta que vuelve (lo que diga el proveedor, o hasta el día siguiente si es un límite diario) y sigue con el siguiente. Las pausas se recuerdan aunque cierres vipcode.
- **Saturados.** Si un proveedor dice que el modelo está saturado (el famoso error 503), lo deja descansar un par de minutos y usa otro mientras tanto.
- **Lentos.** Si un modelo no empieza a contestar en unos 40 segundos (60 en Gemini, que suele tardar más; algo más con conversaciones largas), prueba otro y se acuerda de que es lento para ponerlo detrás. Si ya ha empezado a contestar, se le espera.
- **Proveedores caídos.** Si dos modelos distintos del mismo proveedor no responden en pocos minutos, lo que falla es el proveedor: lo pausa entero 5 minutos y sigue enseguida con otros, en vez de esperar a cada uno de sus modelos.
- **Modelos que desaparecen.** Si un modelo ya no existe o no admite herramientas, lo descarta. Cada día añade solos los modelos gratis nuevos que publican los proveedores.
- **Calidad.** Con una clave gratuita de [LLM Stats](https://llm-stats.com/developer) (`vipcode auth login llm-stats`) los ordena por su ranking, dando más peso a programar y a usar herramientas.

`/models` enseña cada modelo con su estado (disponible, en pausa hasta…, lento), `/model <proveedor/modelo>` fija uno y `/model auto` vuelve a la rotación. En la [configuración](#configuración), `order` pone primero los que prefieras.

## Conversaciones largas

Los modelos gratis tienen tamaños muy distintos: algunos admiten cientos de miles de tokens y otros apenas unos miles. vipcode lo gestiona solo:

- **Si la conversación cabe** en algún modelo libre, se le manda entera.
- **Si no cabe en ninguno**, primero se recortan las salidas antiguas de las herramientas y, si no basta, al modelo libre con más capacidad le llega **un resumen de lo anterior y los últimos mensajes tal cual**, sin romper nunca una llamada a una herramienta y su respuesta. Te avisa cuando un modelo recibe esta versión resumida.
- **La conversación nunca se pierde.** El resumen solo es lo que se le manda a ese modelo: la conversación entera se guarda, y cuando vuelve un modelo en el que cabe (por ejemplo, Gemini tras su pausa), la recibe entera.
- **Sin gastar de más.** El resumen se guarda con la conversación y se reutiliza; cuando hace falta, se actualiza solo con lo nuevo. Si un modelo devuelve algo que no es un resumen de verdad, se le pide otra vez y, si tampoco, vipcode hace uno sencillo sin perder el anterior.
- **Con cálculos que se ajustan.** vipcode estima lo que ocupa la conversación por su número de caracteres, y con el código se quedaría corto. Por eso aprende de cada respuesta cuántos tokens cuentan de verdad los proveedores y lo recuerda para la próxima vez.

`/compact` resume la conversación a mano y la sustituye por el resumen (el historial que ves, y el `.md` de la conversación, siguen enteros).

## Uso

```bash
cd mi-proyecto
vipcode                      # abre vipcode
vipcode "arregla el test"    # y empieza con ese mensaje
vipcode -c                   # sigue con la última conversación de esta carpeta
vipcode --plan               # empieza con el agente planear (solo lectura)
vipcode run "tarea"          # hace la tarea sin interfaz y termina (útil en scripts)
vipcode limites              # cuánto te queda hoy de cada plan gratis
vipcode models               # modelos disponibles (refresh busca modelos gratis nuevos)
vipcode doctor               # comprueba que todo funciona
vipcode bug                  # avisa de un fallo en GitHub con el informe de vipcode doctor
vipcode tutorial             # aprende lo básico en 5 pasos, en una carpeta de prácticas
```

Otras opciones: `-s <id>` abre una conversación concreta, `-m <proveedor/modelo>` elige el modelo preferido, `--agent <nombre>` el agente con el que empezar, `--image <fichero>` adjunta una imagen, `--plain` usa una interfaz de texto simple y `--yolo` aprueba todo sin preguntar. `vipcode --help` las enseña todas.

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
- **Un clic en una herramienta** (la línea que dice qué ha hecho) despliega su salida entera, y otro clic la pliega. **Un clic en un enlace** lo abre en el navegador, y en un comando que sale en el texto (por ejemplo `/update`) lo deja escrito en la caja, listo para pulsar Enter. Un clic en «y más en CHANGELOG.md» enseña las novedades enteras, y en «↓ N líneas más» baja al final.
- **Copiar**: arrastra con el ratón sobre la conversación y, al soltar, lo seleccionado se copia solo al portapapeles. Doble clic copia una palabra (también una ruta o una dirección entera) y triple clic, la línea. `/copiar` copia la última respuesta y `/copiar código`, su último bloque de código. Para seleccionar como siempre lo hace la terminal (por ejemplo en la caja de escribir), mantén **Fn** (Terminal de macOS), **⌥** (iTerm2) o **Mayúsculas** (Windows y Linux) mientras arrastras.

**Permisos.** Antes de editar un fichero, ejecutar un comando o salir a internet, vipcode te enseña el cambio o el comando y pregunta. Puedes contestar que sí una vez, que sí a todo lo de ese tipo durante la sesión, que sí siempre a ese comando (por ejemplo `npm test*`), que no, o que no y decirle qué hacer.

La barra de abajo enseña el agente, el modelo, cuánto te queda de su plan gratis y cuánto contexto llevas gastado. vipcode ocupa la pantalla completa mientras lo usas; al salir, la terminal vuelve a estar como antes y la conversación queda guardada (`vipcode -c` sigue con ella).

**Estilos.** Con **`/interfaz`** eliges cómo se ve, y se guarda para la próxima vez. Todos ocupan la pantalla completa, con el scroll, el ratón y Ctrl+F de arriba:

- **Pantalla completa** (la de serie).
- **Compacta**: sin espacios ni bordes de más, para que quepa más conversación.
- **Zen**: lo justo, sin bienvenida ni bordes y con la barra de abajo mínima.
- **Criaturas**: como la pantalla completa, con un monstruito de píxeles a la derecha que se inventa al azar. Sale otro con cada respuesta o si lo pinchas, y da saltitos mientras vipcode trabaja (a veces sale uno dorado). En terminales anchas (120 columnas y 32 filas) sale grande y con más detalle. En el Terminal del Mac se pinta con colores de fondo para que no salgan rayas entre las filas, y necesita una ventana de 90 columnas y 28 filas o más.

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
| `/interfaz` | Elige cómo se ve vipcode: pantalla completa, compacta, zen o criaturas |
| `/usage` | Tokens usados |
| `/mcp`, `/lsp` | Estado de los servidores MCP y de lenguaje |
| `/yolo [on\|off]` | Aprobar todo sin preguntar durante la sesión |
| `/reset-limits` | Olvidar las pausas guardadas de los proveedores |
| `/update` | Actualizar vipcode |
| `/init` | Crea o mejora `AGENTS.md` con las instrucciones del proyecto |
| `/review` | Revisa los cambios sin confirmar (sin tocar nada) |
| `/config`, `/help`, `/exit` | Rutas de la configuración, ayuda y salir |

### Agentes

- **programar**: el principal; puede editar y ejecutar.
- **planear**: solo lee; investiga y propone un plan.
- **profe**: para aprender. Te explica paso a paso, en palabras sencillas, y te propone los cambios para que los hagas tú (no toca nada).
- **ayudante** y **explorar**: subagentes que el principal lanza para subtareas (ayudante puede editar; explorar solo busca y lee). Si lanza varios, trabajan a la vez.

Puedes crear los tuyos: mira [Agentes y comandos propios](#agentes-y-comandos-propios).

### Conversaciones

Cada conversación se guarda sola en `~/.vipcode/sessions/`, también en Markdown (`.md`) para leerla o compartirla. Para volver a una: `vipcode -c` (la última de esta carpeta), `/sessions` (eliges de la lista) o `vipcode -s <id>`. Ves toda la conversación anterior y el modelo sigue donde lo dejasteis.

### Cuánto te queda

`/limites` (o `vipcode limites`) enseña lo que llevas hoy en cada proveedor y modelo, cuánto te queda y qué está en pausa y hasta cuándo.

- **«quedan»** es lo que dice el propio proveedor (Groq y Cerebras, por ejemplo).
- **«≈ quedan»** es la cuenta de vipcode con los límites conocidos de su plan gratis. Solo cuenta lo de este ordenador: si usas la misma clave en otros programas, te quedará menos.

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
- **mcp**: servidores MCP locales (`command`) o remotos (`url`); los que piden iniciar sesión con OAuth todavía no funcionan. Un servidor local no recibe tus variables de entorno (ni tus claves), solo lo imprescindible para arrancar: lo que necesite, ponlo en `environment`. Ahí y en `headers`, `{env:NOMBRE}` se cambia por esa variable tuya. Sus herramientas se llaman `servidor_herramienta`; si dos acaban con el mismo nombre, la segunda lleva `_2` detrás.
- **keyless**: `false` para no usar nunca los proveedores sin clave. **checkUpdates**: `false` para no buscar versiones nuevas.
- **interfaz**: la que eliges con `/interfaz` (`completa`, `compacta`, `zen` o `criaturas`). La clásica y la de alto contraste (y el `"fullscreen": false` de antes) ya no existen: si las tenías, vipcode te avisa una vez y usa la pantalla completa.
- **firstResponseMs**: cuánto se espera a que una IA empiece a contestar antes de probar otra (40000, unos 40 s; algo más con conversaciones largas). A Gemini se le espera al menos 60 s, porque suele tardar más. No cuenta para los modelos de tu ordenador.
- **autoCompactTokens**: el máximo de tokens que se le manda a un modelo aunque admita más (90000). Por encima, le llega la [versión resumida](#conversaciones-largas).

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
- **Resúmenes.** Los resúmenes de las conversaciones largas los escribe un modelo a partir de todo lo anterior (también de webs o de salidas de comandos), así que van marcados como contexto y no como instrucciones tuyas.
- **Tus datos.** vipcode no envía datos de uso a nadie: solo habla con los proveedores de IA que uses, con las webs que consulte el agente, con tus servidores MCP, con LLM Stats si le das tu clave y, como mucho una vez por hora, con npm y GitHub para ver si hay versión nueva.
- **Planes gratuitos.** Los proveedores sin clave y varios planes gratis pueden guardar lo que les envías o usarlo para entrenar sus modelos. No mandes contraseñas ni código confidencial; para eso usa un modelo local (Ollama, LM Studio) y pon `"keyless": false` en la configuración.

Si encuentras un fallo de seguridad, avísalo en privado como explica [SECURITY.md](SECURITY.md).

## Preguntas frecuentes

**¿De verdad es gratis? ¿Dónde está el truco?**
vipcode es gratis y de código abierto, y solo usa los planes gratuitos de los proveedores. El «precio» es el de esos planes: tienen límites (por eso vipcode cambia de uno a otro), a veces van lentos o están saturados y algunos pueden guardar lo que les mandas.

**¿Qué proveedores me recomiendas?**
Sin claves ya funciona. Para trabajar en serio, saca claves gratuitas de NVIDIA, Gemini y Cerebras (ver [Primeros pasos](#primeros-pasos)); con esas tres casi nunca te quedarás sin cupo. Para código privado, un modelo en tu ordenador con Ollama o LM Studio.

**¿Por qué a veces tarda o salen avisos de «saturado» o «no ha empezado a contestar»?**
Son los planes gratis: en horas de mucho uso los proveedores se saturan o ponen las peticiones en cola. vipcode espera un tiempo razonable, pausa el modelo (o el proveedor entero si no contesta ninguno de sus modelos) y sigue con otro. Con más claves tiene más sitios a los que ir.

**¿Funciona sin internet?**
Sí, con un modelo en tu ordenador: enciende Ollama, LM Studio o llama.cpp y vipcode lo detecta solo.

**¿Puedo usar un modelo de pago o mi propio servidor?**
Sí: cualquier servidor compatible con la API de OpenAI se añade en `providers` de la [configuración](#configuración), con su clave en una variable de entorno.

**¿En qué se diferencia de otros agentes como opencode, Aider o Claude Code?**
Esos agentes usan el modelo que tú elijas, normalmente de pago o con tus propias claves (opencode, por ejemplo, ofrece unos pocos modelos gratis solo dentro de su aplicación). vipcode está hecho para no pagar nunca: junta los planes gratis de muchos proveedores, cambia solo de uno a otro, funciona sin claves y gestiona conversaciones largas con modelos de capacidades muy distintas. Además, todo está en español.

**¿Por qué en español?**
Porque la mayoría de estas herramientas solo hablan inglés, y programar (o aprender a programar) es más fácil en tu idioma. El agente **profe** está pensado justo para aprender.

## Colaborar

Las ideas, los avisos de fallos y las mejoras son bienvenidos: [CONTRIBUTING.md](CONTRIBUTING.md) explica cómo usar vipcode desde el código, pasar las pruebas y cómo se vigila a diario el catálogo de modelos gratis. Cada cambio pasa más de cien pruebas automáticas en Linux, macOS y Windows antes de publicarse.

## Licencia

[AGPL-3.0 o posterior](LICENSE) · Copyright © 2026 Pablo Vicente Juan. Ranking de modelos con datos de LLM Stats (llm-stats.com).

**El nombre.** La licencia cubre el código, no el nombre «vipcode». Puedes usar el código, cambiarlo y publicar tu propia versión, pero ponle otro nombre y no la presentes como vipcode ni como la versión oficial. La oficial es la de este repositorio y el paquete `vipcode` de npm.
