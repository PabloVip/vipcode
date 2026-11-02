// Copyright (C) 2026 Pablo Vicente Juan
// SPDX-License-Identifier: AGPL-3.0-or-later

// Ficheros que suelen guardar claves o contraseñas. Lo que el agente lee se manda al modelo que esté contestando, que puede ser
// de un proveedor sin cuenta: estos no se leen sin preguntar (permission.secrets)
const SECRET_DIRS = /(^|\/)(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.password-store|\.config\/gcloud)\//;
const SECRET_FILES =
  /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$|defaults?$)[^/]+)?|[^/]+\.env|\.envrc|\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|\.pgpass|\.my\.cnf|\.htpasswd|\.vault-token|\.docker\/config\.json|id_(rsa|dsa|ecdsa|ed25519)|(credentials|secrets?)(\.(json|ya?ml|toml|ini|txt|xml|env|cfg|conf))?|[^/]+\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|tfstate)|terraform\.tfvars|wallet\.dat|\.bash_history|\.zsh_history|login data|cookies)$/;

// ¿Esta ruta (relativa o absoluta, con / o con \) puede guardar secretos?
export function isSecretPath(file: string): boolean {
  const clean = file.replace(/\\/g, "/").toLowerCase();
  return SECRET_DIRS.test(clean) || SECRET_FILES.test(clean);
}

// ¿Este comando nombra alguno? Se mira palabra por palabra: «cat .env», «git show HEAD:.env», «--env-file=.env»
export function mentionsSecret(command: string): boolean {
  return command.split(/[\s"'=<>|;&():,]+/).some((word) => word !== "" && isSecretPath(word));
}
