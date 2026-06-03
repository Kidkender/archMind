// Known guard name → IR type heuristic.
// Unknown custom guards emit "unknown_guard" so they can be classified later.

const AUTH_GATE_NAMES = new Set([
  "AuthGuard", "JwtAuthGuard", "LocalAuthGuard", "BearerAuthGuard",
  "ApiKeyGuard", "GoogleAuthGuard", "FacebookAuthGuard", "GithubAuthGuard",
  "PassportAuthGuard",
])
const AUTH_GATE_PATTERNS = [/AuthGuard$/, /ApiKeyGuard$/, /BearerGuard$/]

const AUTHZ_CHECK_NAMES = new Set([
  "RolesGuard", "PermissionsGuard", "PolicyGuard", "AbilitiesGuard",
  "AclGuard", "CaslGuard", "RequirePermissionsGuard",
])
const AUTHZ_CHECK_PATTERNS = [/Roles?Guard$/, /Permissions?Guard$/, /Policy?Guard$/, /Abilities?Guard$/]

export function classifyGuard(className: string): "ir:auth_gate" | "ir:authz_check" | "unknown_guard" {
  if (AUTH_GATE_NAMES.has(className) || AUTH_GATE_PATTERNS.some(p => p.test(className))) {
    return "ir:auth_gate"
  }
  if (AUTHZ_CHECK_NAMES.has(className) || AUTHZ_CHECK_PATTERNS.some(p => p.test(className))) {
    return "ir:authz_check"
  }
  return "unknown_guard"
}
