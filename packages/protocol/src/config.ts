export interface ProjectConfig {
  /** Glob patterns (relative to projectRoot) for route files to parse */
  routeFiles: string[]
  /** PSR-4 namespace → directory mappings, e.g. { "App\\": "app/" } */
  namespaces: Record<string, string>
  /** Directories (relative to projectRoot) where Policy classes live */
  policyPaths: string[]
  /** PHP files (relative to projectRoot) that define permission constants */
  permissionConstantFiles: string[]
  conventions: {
    /** Column/field names that indicate tenant scoping */
    tenantSignals: string[]
    /** Laravel container keys that resolve the current tenant */
    tenantContainerKeys: string[]
  }
}
