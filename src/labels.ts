// Cómo se cuenta cada herramienta en pantalla y en las conversaciones guardadas
const TOOL_LABEL: Record<string, string> = {
  read_file: "Lee",
  write_file: "Escribe",
  edit_file: "Edita",
  list_dir: "Lista",
  glob: "Busca ficheros",
  grep: "Busca",
  bash: "Ejecuta",
  webfetch: "Abre",
  websearch: "Busca en internet",
  todowrite: "Tareas",
  todoread: "Tareas",
  diagnostics: "Diagnósticos",
  task: "Subagente",
  skill: "Skill",
};

export function toolLabel(name: string): string {
  return TOOL_LABEL[name] || name;
}
