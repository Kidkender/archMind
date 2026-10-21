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
    /**
     * Call symbols recognized as audit/activity-log sinks, e.g. "Activity::add"
     * or "activity()->log" (spatie/laravel-activitylog). A matching call is
     * classified as ir:audit_log instead of a generic ir:service_call.
     */
    auditSinks: string[]
  }
}

/**
 * User-defined overrides loaded from archmind.json at the project root.
 * All fields are optional — the engine falls back to built-in heuristics.
 */
export interface ArchMindUserConfig {
  guards?: {
    /** Class names that should be classified as ir:auth_gate (e.g. "CheckLogin") */
    auth_gate?: string[]
    /** Class names that should be classified as ir:authz_check (e.g. "TenantGuard") */
    authz_check?: string[]
  }
  /**
   * Regex patterns (as strings) matched against the route path to identify
   * credential endpoints for no_rate_limiting detection.
   * Defaults to built-in patterns when omitted.
   */
  credentialPaths?: string[]
  /**
   * How the project authorizes a request. Self-service APIs (a game, a
   * personal app) scope every query to the caller instead of checking a
   * role, so the role/policy heuristics would flag all of their routes.
   */
  authorization?: {
    /**
     * Names of the functions that resolve the calling user's own record, e.g.
     * "currentCharacter". A handler that calls one is treated as authorizing
     * by ownership (an ir:authz_check node). Go/Gin only for now.
     */
    ownershipSources?: string[]
  }
  /** Finding types to drop from the report, e.g. ["missing_authorization"]. */
  ignoreFindings?: string[]
}
