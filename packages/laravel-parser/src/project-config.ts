import { readFileSync, existsSync } from "fs"
import { join } from "path"
import type { ProjectConfig } from "@archmind/protocol"

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  routeFiles: ["routes/api.php"],
  namespaces: { "App\\": "app/" },
  policyPaths: ["app/Policies"],
  permissionConstantFiles: [],
  conventions: {
    tenantSignals: [
      "tenant_id", "tenantId", "tenant",
      "organization_id", "organizationId",
      "whereTenant", "whereTenantId", "forTenant",
      "whereOrganization", "whereOrganizationId",
    ],
    tenantContainerKeys: ["tenant", "organization"],
  },
}

export function loadProjectConfig(projectRoot: string): ProjectConfig {
  const configPath = join(projectRoot, ".archmind.json")
  if (!existsSync(configPath)) return DEFAULT_PROJECT_CONFIG

  let overrides: Partial<ProjectConfig>
  try {
    overrides = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<ProjectConfig>
  } catch {
    return DEFAULT_PROJECT_CONFIG
  }

  return {
    routeFiles: overrides.routeFiles ?? DEFAULT_PROJECT_CONFIG.routeFiles,
    namespaces: overrides.namespaces ?? DEFAULT_PROJECT_CONFIG.namespaces,
    policyPaths: overrides.policyPaths ?? DEFAULT_PROJECT_CONFIG.policyPaths,
    permissionConstantFiles: overrides.permissionConstantFiles ?? DEFAULT_PROJECT_CONFIG.permissionConstantFiles,
    conventions: {
      tenantSignals: overrides.conventions?.tenantSignals ?? DEFAULT_PROJECT_CONFIG.conventions.tenantSignals,
      tenantContainerKeys: overrides.conventions?.tenantContainerKeys ?? DEFAULT_PROJECT_CONFIG.conventions.tenantContainerKeys,
    },
  }
}

/** Resolve a fully-qualified PHP class name to a relative file path using the namespace map. */
export function fqcnToPath(fqcn: string, namespaces: Record<string, string>): string | null {
  for (const [ns, dir] of Object.entries(namespaces)) {
    if (fqcn.startsWith(ns)) {
      const relative = fqcn.slice(ns.length).replace(/\\/g, "/")
      return `${dir}${relative}.php`
    }
  }
  return null
}
