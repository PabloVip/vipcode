# Colaborar con vipcode

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


## Vigilancia diaria de los proveedores

Los planes gratis cambian a menudo: un proveedor quita un modelo, lo deja solo para cuentas antiguas o lo pasa a de pago. Para enterarse antes que los usuarios, la tarea «Vigilancia de proveedores» (`.github/workflows/vigilancia.yml`) lanza cada día `scripts/vigilar.mjs`. El script pide a cada proveedor del catálogo su lista de modelos y, si se puede usar, le hace a cada modelo una pregunta mínima con una herramienta, como las hace vipcode. Si algún modelo del catálogo ya no existe o no contesta, abre un aviso con la etiqueta `vigilancia`; si sigue fallando lo actualiza (y lo comenta si cambia lo que falla), y lo cierra cuando todo vuelve a funcionar. Los límites de peticiones y los errores del servidor salen como avisos pasajeros, sin abrir nada.

Sin claves comprueba los proveedores que funcionan sin registro y los que tienen la lista de modelos pública. Para vigilar los demás, añade su clave como secreto del repositorio (Settings → Secrets and variables → Actions) con el nombre de su variable, por ejemplo `GEMINI_API_KEY`: la lista está en el fichero de la tarea. Las claves nunca salen en el aviso.

Para verlo en tu ordenador (con las claves que tengas en el entorno): `npm run vigilar`.

## Prueba real diaria

Que los modelos contesten no basta: tienen que saber trabajar con vipcode. Por eso la misma tarea tiene una conversación de verdad con los modelos gratis que no piden clave (`scripts/prueba-real.mjs`), como la de alguien que acaba de instalarlo: lee tres ficheros con datos concretos, la conversación deja de caber entera (se limita a 8.000 tokens para que vipcode tenga que resumirla), pregunta de memoria lo que leyó al principio y edita un fichero. Si algo sale mal dos veces seguidas, abre un aviso con la etiqueta `prueba-real` (y lo cierra cuando vuelve a ir bien). Si no hay modelos gratis que contesten a tiempo no dice nada: eso ya lo vigila la otra comprobación.

Los modelos solo pueden leer y editar en una carpeta temporal (los comandos, la web y MCP están prohibidos) y no ven ninguna clave ni el token de GitHub, que solo usa el paso que abre el aviso. Para hacerla en tu ordenador (no toca tu `~/.vipcode`): `npm run prueba-real`.
