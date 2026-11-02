// Copyright (C) 2026 Pablo Vicente Juan
// SPDX-License-Identifier: AGPL-3.0-or-later
// Comparación con comodines: "*" vale cualquier cosa ("gemini/*", "npm run *", "github_*")
export function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*");
  return new RegExp(`^${escaped}$`);
}

export function wildcardMatch(pattern: string, text: string): boolean {
  return wildcardToRegex(pattern).test(text);
}
