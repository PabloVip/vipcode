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

