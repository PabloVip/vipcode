# Novedades

Los cambios importantes de cada versión de vipcode. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones, el [versionado semántico](https://semver.org/lang/es/).

## [Sin publicar]

### Cambiado

- **Licencia: pasa de MIT a AGPL-3.0 (o posterior).** Puedes seguir usando vipcode para lo que quieras, también en el trabajo, y cambiarlo para ti. Quien publique una versión modificada, o la ofrezca como servicio por internet, tiene que publicar también su código con la misma licencia. Las versiones hasta la 0.3.2 siguen siendo MIT. `/help` y `vipcode --help` dicen ahora de quién es, que no tiene garantía y con qué licencia se usa, como pide la AGPL.

## [0.3.2] - 2026-10-31

### Añadido

- Más cosas que se pueden pinchar con el ratón en la conversación:
  - **un enlace** se abre en el navegador, también si no cabía en una línea y está partido en dos (solo direcciones web);
  - **un comando** que sale en el texto (por ejemplo `/update` en el aviso de versión nueva, o cualquiera de `/help`) queda escrito en la caja, listo para pulsar Enter;
  - **«y más en CHANGELOG.md»** despliega las novedades enteras ahí mismo, y otro clic las pliega;
  - **«↓ N líneas más»** baja al final de la conversación.

  Abajo sale un aviso de lo que se ha hecho («Abriendo ejemplo.com en el navegador»), que ya no desaparece por falta de sitio.

### Cambiado

- Un modelo saturado (error 503 de «mucha demanda») se deja en pausa 2 minutos, no 30 s: un pico de demanda dura minutos y a los 30 s volvía a fallar. Mientras, vipcode usa otros modelos.
- Con `/new` (o `/clear`) se limpia la pantalla y se ve solo la conversación nueva, con la bienvenida arriba. Al cargar otra con `/sessions` se ve solo esa. Antes, la nueva o la cargada se quedaban debajo de lo anterior.

## [0.3.1] - 2026-10-31

### Arreglado

- Gemini: de su lista de modelos solo se usan los del plan gratis (Flash, Flash-Lite y Gemma). Antes se añadían también los de pago (Pro, Gemini 4 Argon, Omni), las versiones preview y modelos de imágenes, y cuando los Flash se quedaban sin peticiones por minuto vipcode los probaba todos, con un aviso de «no incluido en el plan gratis» o de error por cada uno.
- Cuando un modelo está saturado (error 503), el aviso dice «saturado» y no «error del servidor»: no se ha roto nada, le llegan demasiadas peticiones. vipcode lo deja en pausa 30 s y sigue con otro, como antes.
- El agente ya no mete scripts de varias líneas entre comillas en la línea de comandos (`python3 -c '…'`), que se rompían en cuanto el script llevaba una comilla: los pasa con un heredoc (en PowerShell, con su equivalente).
- Gemini: se quitan Gemini 2.5 Pro, Flash y Flash-Lite. Google ya solo los deja usar a quien los usaba antes, y con una clave nueva contestaban «modelo no disponible». Tampoco se añaden al buscar modelos nuevos.
- Catálogo revisado: había modelos que ya no existen y se probaban igual, con su aviso de error. Se quitan los de NVIDIA (GLM-5.3), Vercel (Laguna S 2.1), Hugging Face (Qwen3 Coder 30B) y LLM7 (MiniMax M2.7); en SambaNova, MiniMax-M3 pasa a ser MiniMax-M3.1-Flash. En ModelScope no quedaba ninguno: ahora tiene los actuales (Qwen3.8, DeepSeek V4.1 Flash, GLM-5.2…), y a partir de ahora se añaden solos los nuevos y se quitan los que desaparecen, lo mismo que en SambaNova, Ollama Cloud y OVHcloud. Vercel suma Ling 3.1 Flash (gratis) y Hugging Face, GLM-5.3 Flash.
- Gemini: los Flash tardaban más de 40 s en empezar a contestar (piensan antes sin mandar nada) y vipcode los daba por colgados («no ha empezado a contestar»). Ahora se les pide pensar en nivel bajo, que los hace mucho más rápidos, y a Gemini se le espera hasta 60 s antes de probar otro.

- Parar un `!comando` con Esc (o porque se pasa de tiempo) paraba solo la shell en macOS y Linux: lo que había lanzado, por ejemplo el servidor de un `!npm run dev`, seguía en marcha, y vipcode se quedaba esperando a que acabara. Ahora se para todo, y la salida dice si se interrumpió o se pasó de tiempo. Lo mismo con los comandos de las plantillas.
- Si se cierra vipcode con un comando en marcha (también cerrando la ventana de la terminal), ese comando y lo que haya lanzado se paran con él.
- Al abrir una versión nueva, las novedades se ven desde su título: en una ventana normal, con el aviso de otra versión o la bienvenida debajo, solo se veía su final.
- MCP: si dos herramientas acababan con el mismo nombre (por ejemplo, de dos servidores con nombres parecidos), o con el de una de vipcode, los proveedores rechazaban todas las peticiones. Ahora la repetida lleva `_2` detrás.
- MCP: un servidor que se cae ya no sale como «conectado» en `/mcp`, y sus herramientas dejan de ofrecerse.
- Servidores de lenguaje: si uno se cae (por ejemplo, porque se queda sin memoria), se vuelve a arrancar la siguiente vez que hace falta (hasta 3 veces); antes ya no había errores de ese lenguaje hasta reiniciar vipcode. Y uno que no llega a arrancar bien ya no se queda encendido.
- Skills: un fichero de más de 20 MB ya no se carga entero en memoria, y un enlace de GitHub cuya carpeta tiene `..` ya no puede salir del repositorio descargado.
- Si `auth.json` está roto (por ejemplo, editado a mano con un error), vipcode avisa al abrirse, y al conectar otra cuenta ya no lo sobrescribe: antes se perdían todas las claves guardadas.
- Con `auth.json` o la configuración rotos, el aviso dice la línea y la columna del error sin citar lo que hay allí: el mensaje de antes podía enseñar en pantalla un trozo de una clave.
- Un error al conectar la primera cuenta al abrir vipcode lo cerraba de golpe; ahora se enseña.

## [0.3.0] - 2026-10-31

### Quitado

- Las interfaces «Clásica» y «Alto contraste», porque no funcionaban bien en todas las terminales. La clásica dejaba trozos repetidos de la caja de escribir en la pantalla al cambiar el tamaño de la ventana, y la de alto contraste se leía peor con fondo claro (por ejemplo, el título de los permisos en amarillo chillón sobre blanco). Quedan la pantalla completa, la compacta, la zen y la de criaturas. Si tenías elegida una de las que se han quitado (o `"fullscreen": false`), vipcode te avisa una vez y usa la pantalla completa.

### Arreglado

- Las respuestas se parten bien cuando no caben: lo que baja de una lista sigue debajo del texto, las citas llevan su raya en todas las líneas, el código partido conserva su sangría, las tablas anchas se reparten el ancho de la pantalla, y ninguna línea partida empieza con un espacio de más.
- Las listas de tareas (`- [x]`) salían con «[x]» repetido y el texto en la línea de abajo.
- Borrar o moverse por un emoji, una bandera o una letra con la tilde aparte la partía por la mitad, dejando un carácter roto en pantalla y en el mensaje.
- En ventanas estrechas, el texto de ayuda de la caja de escribir ocupaba dos o tres líneas; ahora se corta en una.
- La salida de los comandos (y de `!comando`, las búsquedas y `/update`) podía romper alguna letra con tilde o «ñ» cuando llegaba partida entre dos trozos.
- Al leer un fichero, el salto de línea del final contaba como una línea más vacía.
- Si todos los modelos fallaban por un error que no es de límites, vipcode decía que la conversación era demasiado larga y que usaras /compact. Ahora solo lo dice cuando de verdad no cabe, y si no, avisa de que ninguno ha podido contestar. Los avisos de error ya no repiten el código («400 400 …»).
- Las conversaciones, tus claves, la configuración y las carpetas de confianza se guardan de golpe: si vipcode se cierra a mitad de guardar, el fichero de antes sigue entero.
- `/help` con `--plain` enseñaba los atajos del ratón de la pantalla completa.

## [0.2.17] - 2026-10-30

### Cambiado

- Interfaz «Criaturas»: en terminales anchas (120 columnas y 32 filas o más) la criatura sale grande y con más detalle: esquinas redondeadas, luces y sombras y un brillo en los ojos. Si el panel no cabe entero, se quita primero el texto de debajo del dibujo.

### Arreglado

- Interfaz «Criaturas»: en el Terminal del Mac salían rayas entre las filas del dibujo, porque pinta los medios bloques sin llenar todo el alto de la línea. Allí ahora cada píxel se pinta con color de fondo, sin rayas (necesita una ventana de 90 columnas y 28 filas o más).

## [0.2.16] - 2026-10-30

### Añadido

- Interfaz «Criaturas» en `/interfaz`: como la pantalla completa, con un monstruito de píxeles a la derecha. Cada uno se inventa al azar (forma, colores, ojos, boca, orejas, patas y nombre), sale otro al terminar cada respuesta o al pincharlo, y da saltitos mientras vipcode trabaja. De vez en cuando sale uno dorado. En terminales de menos de 70 columnas no se enseña.

## [0.2.15] - 2026-10-30

### Añadido

- `/interfaz` para elegir cómo se ve vipcode, y se guarda para la próxima vez: pantalla completa (la de serie), clásica (la conversación en la terminal normal), compacta (sin espacios ni bordes de más), alto contraste (sin texto atenuado y con colores vivos, también para fondos claros) y zen (lo justo). Al pasar a la clásica o volver de ella se rehace la pantalla y sigue la misma conversación.

## [0.2.14] - 2026-10-30

### Añadido

- Ctrl+F busca en la conversación, sin distinguir mayúsculas ni tildes, resalta lo encontrado y dice cuántas veces sale («3 de 12»).
- Doble clic copia una palabra (también una ruta o una dirección entera) y triple clic, la línea.
- Un clic en una herramienta despliega su salida entera (lo que vio el agente) y otro clic la pliega.
- Barra de desplazamiento a la derecha de la conversación, que se puede pinchar y arrastrar, y Ctrl+Inicio y Ctrl+Fin para ir al principio o al final.

## [0.2.13] - 2026-10-30

### Añadido

- Pantalla completa: la conversación tiene su propio scroll. La rueda del ratón, AvPág y RePág la mueven y la caja de escribir se queda abajo; al escribir vuelves al final. Al salir, la terminal queda como estaba y la conversación, guardada (`vipcode -c`). Con `"fullscreen": false` vuelve el modo de antes.
- Copiar arrastrando: lo que seleccionas con el ratón sobre la conversación se copia solo al portapapeles al soltar, en cualquier terminal (también en la de macOS, que no sabe hacerlo).

### Corregido

- Un comando de varias líneas ya no ocupa media pantalla mientras se ejecuta (ni deja sin sitio al diálogo de permiso): se ve su primera línea.

## [0.2.12] - 2026-10-30

### Añadido

- `/tutorial` (y `vipcode tutorial`): aprende lo básico en 5 pasos (pedir cosas, señalar ficheros con `@`, ejecutar comandos con `!`, deshacer con `/undo` y preguntar al profe) en una carpeta de prácticas, sin tocar tus ficheros. Cada paso avanza solo cuando lo haces. La primera vez que abres vipcode, te lo sugiere.

### Cambiado

- Si una IA no empieza a contestar en unos 40 segundos (algo más con conversaciones largas), vipcode prueba otra en vez de esperar hasta 2 minutos, y recuerda durante unas horas las que suelen tardar para usarlas después de las rápidas. Si ya está escribiendo, se le espera como siempre, y los modelos de tu ordenador no cuentan. Se cambia con `firstResponseMs`.
- En terminales estrechas, la barra de abajo acorta el nombre del modelo antes que quitar de quién es el límite.
- Animación nueva en el README, también con el profe.

## [0.2.11] - 2026-10-30

### Añadido

- `/update` y `vipcode update` enseñan una barra de carga con el paso en el que van. Al terminar, un recuadro te dice que reinicies vipcode para usar la versión nueva (con `vipcode -c` sigues en la misma conversación), y al salir te lo recuerda.
- Después de instalar, `/update` comprueba que la versión instalada es de verdad la nueva.
- «Reiniciar ahora» al terminar `/update`: abre la versión nueva sin salir de la conversación. Mientras se instala no se pueden enviar mensajes, para que no se mezclen las dos versiones.
- `/bug` (y `vipcode bug`) para avisar de un fallo: abre en tu navegador un issue de GitHub con el informe de `/doctor` ya puesto, sin tus claves. No se envía nada hasta que lo revisas y pulsas el botón.
- Cuando quedan pocas peticiones gratis hoy en un proveedor, vipcode te lo dice una vez y te sugiere una cuenta gratis que da muchas más (Cerebras o Groq), si no la tienes.

### Cambiado

- La barra de abajo dice de quién es el límite que enseña: «OpenRouter: quedan 46/50 hoy».

### Corregido

- `/update` ya no vuelve a instalar la versión nueva si ya la habías instalado y solo faltaba reiniciar.

## [0.2.10] - 2026-10-30

### Seguridad

- La pregunta de si confías en una carpeta enseña enteros los comandos y las direcciones que trae su configuración (antes se cortaban los largos), y un nombre con saltos de línea ya no puede fingir otra línea.
- Los caracteres invisibles que cambian cómo se lee un texto (los que ponen un trozo del revés y los de anchura cero) se ven en el diálogo de permisos y en esa pregunta, para que no puedan disfrazar un comando.
- Si la carpeta cambia mientras contestas, su configuración no se usa: se aprueba justo lo que has visto.

### Cambiado

- La pregunta de si confías en una carpeta se entiende mejor: cuenta en palabras sencillas qué haría su configuración (qué programas arrancaría, a dónde mandaría lo que escribes, qué dejaría de preguntarte), y solo lo que cambia respecto a lo que ya tienes.

### Corregido

- El aviso de versión nueva llega como mucho una hora después de publicarse, también si tienes vipcode abierto. Antes podía tardar hasta un día si ya lo habías abierto ese día.
- Al abrir vipcode en tu carpeta personal ya no te pregunta si confías en tu propia configuración (`~/.vipcode`).

## [0.2.9] - 2026-10-30

### Añadido

- `vipcode doctor` (y `/doctor`): comprueba los programas que usa vipcode, tus claves y los proveedores, y dice cómo arreglar lo que falte. Su informe no lleva tus claves, así que se puede pegar en un issue.
- Agente `profe`, para aprender: te explica paso a paso y en palabras sencillas, y te propone los cambios para que los hagas tú (no toca nada).
- En Windows, si falta Git para Windows, vipcode te lo recuerda al abrirlo (una vez al día) con el comando para instalarlo: `winget install Git.Git`.

## [0.2.8] - 2026-10-30

### Añadido

- Al abrir una versión nueva, un recuadro con lo que trae.
- El aviso de versión nueva dice si trae arreglos de seguridad, en rojo, para que no lo dejes para luego.
- `/copiar` copia la última respuesta al portapapeles y `/copiar código`, su último bloque de código, en macOS, Linux y Windows (por SSH, si tu terminal lo permite). Lo copiado no lleva caracteres invisibles que puedan ejecutar algo al pegarlo en una terminal.

### Cambiado

- `/help` y el README explican cómo copiar texto, y `/help` llama a los agentes por su nombre nuevo.

## [0.2.7] - 2026-10-30

### Seguridad

- `git difftool -x` y otras formas de hacer que git ejecute programas ya no se aprueban solas (la regla `git diff*` de serie las dejaba pasar).
- Los comandos de git y `ls` que se aprueban solos ya no pueden leer ficheros de fuera del proyecto, como `git diff /dev/null ~/.ssh/id_rsa`.
- vipcode ya no arranca servidores de lenguaje que traiga el proyecto en `node_modules/.bin`, ni programas de la carpeta del proyecto con el nombre de `rg`, `git` o `powershell` (en Windows se buscaban primero ahí).
- `glob` y `grep` ya no salen de la carpeta del proyecto con patrones como `../**`.
- `AGENTS.md`, agentes, comandos y skills del proyecto que sean enlaces a ficheros de fuera ya no se leen.
- Si un comando no cabe en el diálogo de permiso, se escribe entero justo encima antes de preguntar.
- `webfetch` pregunta siempre antes de entrar en una dirección de tu ordenador o de tu red, también si una página redirige a ella.
- Escribir en `.git` (sus hooks y su configuración) o cambiar la configuración de git se pregunta siempre.
- En un repositorio cuya configuración de git ejecuta programas, ningún comando de git se aprueba solo.
- El registro de depuración (`VIPCODE_DEBUG`) oculta lo que tenga pinta de clave.

### Cambiado

- Los servidores de lenguaje solo se usan si están instalados en tu ordenador.
- Tamaño máximo al leer un fichero (20 MB) y al descargar una página (5 MB).

## [0.2.6] - 2026-10-30

### Seguridad

- Los servidores MCP locales ya no heredan todas tus variables de entorno (claves incluidas): solo lo imprescindible para arrancar y lo que pongas en su `environment`, donde `{env:NOMBRE}` pasa una variable concreta. Gracias a quien lo avisó.
- Los servidores de lenguaje reciben tu entorno sin las variables con pinta de clave.
- «Sí siempre a este comando» ya no deja pasar un comando que escribe en un fichero (`>`) o lleva `$(…)`.
- Al pedir confianza en una carpeta, se dice qué variables tuyas recibiría cada servidor MCP.

### Cambiado

- El README solo trae lo necesario para usar vipcode; lo de desarrollo está en [CONTRIBUTING.md](CONTRIBUTING.md).

## [0.2.5] - 2026-10-29

### Añadido

- Animación de vipcode en el README.

### Corregido

- Las respuestas largas ya no se salen de la terminal ni cortan palabras por la mitad.
- La barra de abajo ya no se corta con modelos de nombre largo.

## [0.2.4] - 2026-10-29

### Añadido

- Windows: los comandos usan el bash de Git para Windows (o PowerShell si no está), Ctrl+V pega imágenes y las pruebas automáticas también se pasan en Windows. `VIPCODE_SHELL` elige otra shell.
- `/limites` (y `vipcode limites`): lo que llevas hoy en cada plan gratis y cuánto te queda. La barra de abajo lo enseña del modelo que estás usando.

### Cambiado

- Los agentes se llaman `programar`, `planear`, `ayudante` y `explorar`. Los nombres de antes siguen valiendo.

### Seguridad

- En macOS y Windows ya no se pueden leer tus claves escribiendo la ruta con otras mayúsculas (`~/.VIPCODE`).

### Corregido

- Al salir, vipcode espera a que terminen los servidores de lenguaje.

## [0.2.3] - 2026-10-29

### Cambiado

- Bienvenida y consejos con un tono más cercano.
- La versión nueva se anuncia en un recuadro verde y se recuerda en la barra de abajo hasta que actualizas.

## [0.2.2] - 2026-10-29

### Añadido

- Al volver a una sesión se ve toda la conversación anterior.
- Cada conversación se guarda también en Markdown en `~/.vipcode/sessions/`.

## [0.2.1] - 2026-10-29

### Seguridad

- La configuración que trae un proyecto no se usa hasta que confías en la carpeta (`vipcode trust`).
- Las herramientas no salen del proyecto por un enlace simbólico.
- Lo que se aprueba solo no puede colar otro comando ni escribir en ficheros.
- El texto que llega de fuera no puede manejar tu terminal.
- vipcode no puede leer ni cambiar sus datos (tus claves) ni modificar su propia instalación.

## [0.2.0] - 2026-10-29

### Añadido

- Primera versión pública: agente de programación para la terminal que usa IAs gratuitas sin claves ni registro y cambia solo de proveedor cuando uno se agota, entre más de 20.
- Inicio de sesión en OpenRouter desde el navegador, ranking de modelos con LLM Stats, `/undo` y `/redo`, sesiones, agentes, comandos y skills propios, servidores MCP y de lenguaje.
- Instalación con `npm install -g vipcode` y `/update` para actualizar.

[Sin publicar]: https://github.com/PabloVip/vipcode/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/PabloVip/vipcode/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/PabloVip/vipcode/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/PabloVip/vipcode/compare/v0.2.17...v0.3.0
[0.2.17]: https://github.com/PabloVip/vipcode/compare/v0.2.16...v0.2.17
[0.2.16]: https://github.com/PabloVip/vipcode/compare/v0.2.15...v0.2.16
[0.2.15]: https://github.com/PabloVip/vipcode/compare/v0.2.14...v0.2.15
[0.2.14]: https://github.com/PabloVip/vipcode/compare/v0.2.13...v0.2.14
[0.2.13]: https://github.com/PabloVip/vipcode/compare/v0.2.12...v0.2.13
[0.2.12]: https://github.com/PabloVip/vipcode/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/PabloVip/vipcode/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/PabloVip/vipcode/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/PabloVip/vipcode/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/PabloVip/vipcode/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/PabloVip/vipcode/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/PabloVip/vipcode/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/PabloVip/vipcode/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/PabloVip/vipcode/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/PabloVip/vipcode/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/PabloVip/vipcode/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/PabloVip/vipcode/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/PabloVip/vipcode/releases/tag/v0.2.0
