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

## Pruebas

```bash
npm test            # compila y pasa las pruebas (servidor de IA simulado, sin claves ni internet)
```

Las pruebas de la interfaz necesitan `expect` (en macOS ya viene; en Linux, `apt install expect`). En GitHub Actions se pasan en Linux, macOS y Windows.

## Animación del README

```bash
npm run demo        # vuelve a grabar docs/demo.svg con una sesión real y los modelos gratis (necesita python3)
```

## Publicar una versión

```bash
npm login                            # la primera vez (y gh auth login si no lo tienes)
npm run release -- 0.3.0 --dry-run   # comprueba que todo está listo y enseña lo que haría
npm run release -- 0.3.0             # o patch, minor o major
```

Antes de publicar, apunta los cambios en [CHANGELOG.md](CHANGELOG.md), en «Sin publicar»: el script los pasa a la versión nueva con su fecha y los usa como notas de la release de GitHub.

El script sube el número en `package.json`, pasa las pruebas, crea el commit y la etiqueta, lo sube a GitHub, crea la release con el paquete compilado y lo publica en npm. Quien ya tenga vipcode verá el aviso de versión nueva en menos de un día.

Si se crea la release de GitHub pero `npm publish` no termina (por ejemplo, porque no se completa la verificación en dos pasos), basta con ejecutar `npm publish` en la carpeta del proyecto.
