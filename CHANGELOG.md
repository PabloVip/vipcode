# Novedades

Los cambios importantes de cada versión de vipcode. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones, el [versionado semántico](https://semver.org/lang/es/).

## [Sin publicar]

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

[Sin publicar]: https://github.com/PabloVip/vipcode/compare/v0.2.9...HEAD
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
