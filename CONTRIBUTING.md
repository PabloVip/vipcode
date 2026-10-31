# Colaborar con vipcode

¡Gracias por querer ayudar! Las ideas, los avisos de fallos y las mejoras son bienvenidos.

- **¿Has encontrado un fallo?** Lo más fácil es escribir `/bug` dentro de vipcode (o `vipcode bug`): abre un issue con el informe de `vipcode doctor` ya puesto, sin tus claves. Cuenta qué hacías, qué esperabas y qué ha pasado.
- **¿Un fallo de seguridad?** No abras un issue público: sigue [SECURITY.md](SECURITY.md).
- **¿Una idea?** Abre un issue contando qué te gustaría poder hacer y por qué.
- **¿Un cambio en el código?** Mejor si antes lo comentas en un issue, sobre todo si es grande. Después, un pull request con el cambio, sus pruebas y la línea del CHANGELOG (abajo están las normas).

## Usarlo desde el código

```bash
git clone https://github.com/PabloVip/vipcode.git
cd vipcode
npm install
npm run build
npm link        # deja el comando «vipcode» disponible en cualquier carpeta
```

Instalado así, `/update` trae lo último del repositorio con `git pull`, instala las dependencias y compila; si tienes cambios sin guardar en esa carpeta, no toca nada y te avisa.

vipcode no se deja modificar a sí mismo. Para trabajar en su código con un vipcode instalado desde esa misma carpeta, arráncalo con `VIPCODE_ALLOW_SELF_EDIT=1 vipcode`, o usa el instalado con npm.

## Cómo está organizado

Es TypeScript (Node.js 22 o superior, módulos ES) y la interfaz está hecha con [Ink](https://github.com/vadimdemedes/ink) (React para la terminal). Lo principal:

| Fichero | Qué hace |
|---|---|
| `src/index.ts` | La línea de comandos: `vipcode`, `vipcode run`, `auth`, `skills`, `doctor`… |
| `src/app.ts` | La aplicación: configuración, proveedores, comandos con `/` y sesiones |
| `src/agent.ts` | El agente: el bucle de pedir al modelo, ejecutar herramientas y seguir, y los subagentes |
| `src/router.ts` | Elige el modelo y cambia de uno a otro: límites, pausas, saturados, lentos, proveedores caídos y el cálculo de tokens |
| `src/context.ts` | La versión resumida de las conversaciones que no caben en los modelos libres |
| `src/catalog.ts`, `src/discovery.ts` | Los proveedores gratuitos y sus modelos, y cómo se descubren los nuevos |
| `src/tools.ts` | Las herramientas del agente: leer, editar, buscar, ejecutar, consultar la web… |
| `src/permissions.ts`, `src/trust.ts` | Qué se pregunta antes de hacer, y la confianza en la configuración de cada carpeta |
| `src/session.ts`, `src/snapshot.ts` | Conversaciones guardadas, y las instantáneas de `/undo` |
| `src/mcp.ts`, `src/lsp.ts`, `src/skills.ts` | Servidores MCP, servidores de lenguaje y skills |
| `src/tui/` | La interfaz de pantalla completa: conversación, ratón, diálogos, estilos y criaturas |

## Pruebas

```bash
npm test
```

Compila y pasa todas las pruebas con `node --test`, con un servidor de IA de mentira (`test/helpers/mock-llm.mjs`) y carpetas temporales: nunca tocan tu `~/.vipcode`. Las de la interfaz (`test/fixtures/*.exp`) manejan vipcode en una pseudo-terminal con [expect](https://core.tcl-lang.org/expect/), que viene con macOS y en Linux se instala con `sudo apt-get install expect`; sin él se saltan. En GitHub, cada cambio pasa por Linux (Node 22 y 24), macOS y Windows.

## Normas

- **Todo en español**: los mensajes de vipcode, los comentarios del código y la documentación. Que se entiendan sin saber programar mucho.
- **Que funcione en macOS, Linux y Windows.** Ojo con las rutas, las shells y los saltos de línea.
- **Seguridad primero.** Cada función nueva se revisa también pensando en qué podría hacer con ella un modelo engañado o un proyecto malicioso: que no salga de la carpeta, que no lleve claves a otros programas y que no se apruebe sola nada que cambie cosas.
- **Con pruebas.** Cada arreglo o función nueva lleva su prueba, a ser posible una que fallara sin el cambio.
- **CHANGELOG.md.** Todo lo que note quien usa vipcode se apunta en «## [Sin publicar]» (Seguridad, Añadido, Cambiado o Corregido), contado para quien lo usa, no para quien lo programa.
- **Nada de claves en el código**, ni en las pruebas: las de las pruebas son inventadas.

## Publicar una versión

Solo quien mantiene el proyecto: `npm run release -- <versión>` comprueba que todo está en orden, sube la versión, pasa las pruebas, convierte «Sin publicar» del CHANGELOG en la versión nueva, crea la etiqueta y la release de GitHub y publica en npm (`--dry-run` lo simula sin publicar nada).

## Vigilancia diaria de los proveedores

Los planes gratis cambian a menudo: un proveedor quita un modelo, lo deja solo para cuentas antiguas o lo pasa a de pago. Para enterarse antes que los usuarios, la tarea «Vigilancia de proveedores» (`.github/workflows/vigilancia.yml`) lanza cada día `scripts/vigilar.mjs`. El script pide a cada proveedor del catálogo su lista de modelos y, si se puede usar, le hace a cada modelo una pregunta mínima con una herramienta, como las hace vipcode. Si algún modelo del catálogo ya no existe o no contesta, abre un aviso con la etiqueta `vigilancia`; si sigue fallando lo actualiza (y lo comenta si cambia lo que falla), y lo cierra cuando todo vuelve a funcionar. Los límites de peticiones y los errores del servidor salen como avisos pasajeros, sin abrir nada.

Sin claves comprueba los proveedores que funcionan sin registro y los que tienen la lista de modelos pública. Para vigilar los demás, añade su clave como secreto del repositorio (Settings → Secrets and variables → Actions) con el nombre de su variable, por ejemplo `GEMINI_API_KEY`: la lista está en el fichero de la tarea. Las claves nunca salen en el aviso.

Para verlo en tu ordenador (con las claves que tengas en el entorno): `npm run vigilar`.

## Prueba real diaria

Que los modelos contesten no basta: tienen que saber trabajar con vipcode. Por eso la misma tarea tiene una conversación de verdad con los modelos gratis que no piden clave (`scripts/prueba-real.mjs`), como la de alguien que acaba de instalarlo: lee tres ficheros con datos concretos, la conversación deja de caber entera (se limita a 8.000 tokens para que vipcode tenga que resumirla), pregunta de memoria lo que leyó al principio y edita un fichero. Si algo sale mal dos veces seguidas, abre un aviso con la etiqueta `prueba-real` (y lo cierra cuando vuelve a ir bien). Si no hay modelos gratis que contesten a tiempo no dice nada: eso ya lo vigila la otra comprobación.

Los modelos solo pueden leer y editar en una carpeta temporal (los comandos, la web y MCP están prohibidos) y no ven ninguna clave ni el token de GitHub, que solo usa el paso que abre el aviso. Para hacerla en tu ordenador (no toca tu `~/.vipcode`): `npm run prueba-real`.
