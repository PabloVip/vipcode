// Las interfaces que se pueden elegir con /interfaz (se guarda en "interfaz" en tu configuración). Todas son de pantalla
// completa: la conversación con su propio scroll y la caja de escribir fija abajo

export interface Interface {
  id: string;
  label: string;
  description: string;
  // Sin líneas en blanco entre mensajes, la bienvenida en una línea y la caja de escribir sin borde
  compact: boolean;
  // Lo justo: sin bienvenida, la caja sin borde y la barra de abajo con lo mínimo
  minimal: boolean;
  // Un monstruito de píxeles a la derecha que cambia con cada respuesta
  pets: boolean;
}

export const INTERFACES: Interface[] = [
  {
    id: "completa",
    label: "Pantalla completa",
    description: "la conversación con su propio scroll, ratón y Ctrl+F (la de serie)",
    compact: false,
    minimal: false,
    pets: false,
  },
  {
    id: "compacta",
    label: "Compacta",
    description: "sin espacios ni bordes de más: cabe más conversación en la pantalla",
    compact: true,
    minimal: false,
    pets: false,
  },
  {
    id: "zen",
    label: "Zen",
    description: "lo justo: sin bienvenida, sin bordes y con la barra de abajo mínima",
    compact: false,
    minimal: true,
    pets: false,
  },
  {
    id: "criaturas",
    label: "Criaturas",
    description: "como la completa, con un monstruito de píxeles a la derecha: sale otro con cada respuesta",
    compact: false,
    minimal: false,
    pets: true,
  },
];

// Las que había antes y se han quitado porque no funcionaban bien en todas las terminales: la clásica (al cambiar el
// tamaño de la ventana dejaba trozos repetidos en la pantalla) y la de alto contraste (con fondo claro se leía peor)
export const RETIRED_INTERFACES: Record<string, string> = {
  clasica: "Clásica",
  contraste: "Alto contraste",
};

// La interfaz de tu configuración (si no existe, la de serie)
export function interfaceFor(config: { interfaz?: string }): Interface {
  return INTERFACES.find((item) => item.id === config.interfaz) || INTERFACES[0];
}

// Si tu configuración pedía una interfaz que ya no existe (también el «"fullscreen": false» de antes, que era la
// clásica), cuál era, para avisarte una vez de que ahora se usa la de serie
export function retiredInterface(config: { interfaz?: unknown; fullscreen?: unknown }): string | null {
  if (typeof config.interfaz === "string" && RETIRED_INTERFACES[config.interfaz]) {
    return RETIRED_INTERFACES[config.interfaz];
  }
  if (config.fullscreen === false && !INTERFACES.some((item) => item.id === config.interfaz)) {
    return RETIRED_INTERFACES.clasica;
  }
  return null;
}
