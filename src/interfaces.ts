// Las interfaces que se pueden elegir con /interfaz (se guarda en "interfaz" en tu configuración)

export interface Interface {
  id: string;
  label: string;
  description: string;
  // Pantalla completa (la conversación con su propio scroll) o la clásica (en la terminal normal)
  fullscreen: boolean;
  // Sin líneas en blanco entre mensajes, la bienvenida en una línea y la caja de escribir sin borde
  compact: boolean;
  // Sin texto atenuado y con colores vivos
  contrast: boolean;
  // Lo justo: sin bienvenida, la caja sin borde y la barra de abajo con lo mínimo
  minimal: boolean;
}

export const INTERFACES: Interface[] = [
  {
    id: "completa",
    label: "Pantalla completa",
    description: "la conversación con su propio scroll, ratón y Ctrl+F (la de serie)",
    fullscreen: true,
    compact: false,
    contrast: false,
    minimal: false,
  },
  {
    id: "clasica",
    label: "Clásica",
    description: "la conversación se queda en la terminal y seleccionas como siempre",
    fullscreen: false,
    compact: false,
    contrast: false,
    minimal: false,
  },
  {
    id: "compacta",
    label: "Compacta",
    description: "sin espacios ni bordes de más: cabe más conversación en la pantalla",
    fullscreen: true,
    compact: true,
    contrast: false,
    minimal: false,
  },
  {
    id: "contraste",
    label: "Alto contraste",
    description: "sin texto atenuado y con colores vivos: se lee mejor (también con fondo claro)",
    fullscreen: true,
    compact: false,
    contrast: true,
    minimal: false,
  },
  {
    id: "zen",
    label: "Zen",
    description: "lo justo: sin bienvenida, sin bordes y con la barra de abajo mínima",
    fullscreen: true,
    compact: false,
    contrast: false,
    minimal: true,
  },
];

// La interfaz de tu configuración ("fullscreen": false, de antes, es la clásica)
export function interfaceFor(config: { interfaz?: string; fullscreen?: boolean }): Interface {
  const chosen = INTERFACES.find((item) => item.id === config.interfaz);
  if (chosen) {
    return chosen;
  }
  return config.fullscreen === false ? INTERFACES[1] : INTERFACES[0];
}
