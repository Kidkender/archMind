# @kidkender/archmind-go-parser

**Go/Gin adapter for ArchMind.** Turns a Gin project into one execution graph per route: the route, its authentication and authorization checks, input validation and database transaction boundary.

Uses tree-sitter (no Go toolchain needed to parse).

---

## Install

```bash
npm install @kidkender/archmind-go-parser
```

## Usage

```ts
import { isGinProject, parseGinProjectAt } from "@kidkender/archmind-go-parser"

if (isGinProject(root)) {
  const graphs = parseGinProjectAt(root)   // IntermediateExecutionGraph[], one per route
  for (const g of graphs) console.log(g.entrypoint, g.nodes.map((n) => n.type))
}
```

`parseGinProjectAt` reads the project's `archmind.json` itself. `parseGinProject(files, options)` takes an already-read file list (used in tests and by tools that hold the sources in memory).

Most of ArchMind uses it through `@kidkender/archmind-analysis`, the CLI (`archmind trace`, `archmind findings`) and the MCP server, which detect a Go project from `go.mod` and a `gin-gonic/gin` dependency.

---

## What it extracts

- **Routes**, including registration spread over several function layers (`main()` → `RegisterRoutes()` → `RegisterXRoutes()`) and a router built in a factory function (`func NewRouter() *gin.Engine`).
- **Authentication gates**, including a globally applied middleware that exempts routes through a runtime skip-list read from the middleware's own body. Role and permission arguments resolve Go constants (`model.RoleAdmin` → `"admin"`).
- **Authorization checks**: role/policy middleware, and **ownership** checks. A handler that calls one of the functions named in `archmind.json` → `authorization.ownershipSources` (for example `["currentCharacter"]`) is treated as authorizing by ownership.
- **Validation gates**: `ShouldBindJSON`, `ShouldBindQuery` and `ShouldBindUri` resolved to the DTO struct and its `binding` tags.
- **Transaction boundaries**: GORM `.Transaction(func...)` closures, followed one hop into a directly called service method.
- **Tenant isolation**: on a route that resolves a tenant (a middleware whose name carries a tenant key, a `c.Get("tenant_id")`-style read from the Gin context, or an accessor such as `GetTenantID(c)` / `tenant.FromContext(ctx)`), an `ir:tenant_context` node, and every GORM query in the handler and up to two calls below it (handler → service → repository) as `ir:scoped_query` or `ir:unscoped_query` / `ir:unscoped_write`. An unscoped query gets a `missing_tenant_scope` edge, which the explainer reports as a `missing_tenant_scope` finding. Routes that resolve no tenant get none of these nodes.
- A handler wired up as a local variable (`h := handler.NewXxx(...)`) is resolved to its type.

Nodes carry the `file` and `line` where the parser found them.

## Helpers it exports

The tree-sitter helpers other packages build on: `parseGo`, `walk`, `receiverTypeName`, `bareTypeName`, `functionParamTypes`, `findFunctionDecls`; and the file scanner `findGoFiles` / `readGoProjectFiles` (option `includeTests` to include `_test.go`). `@kidkender/archmind-lens` uses them for its call graph.

## Configuration

`archmind.json` at the project root:

```json
{
  "authorization": { "ownershipSources": ["currentCharacter", "UserId"] },
  "isolation": { "tenantSignals": ["tenant", "organization_id"], "tenantContextKeys": ["tenant", "organization"] },
  "ignoreFindings": ["missing_authorization"]
}
```

`isolation` matches identifier and string tokens, ignoring case and `_`: `tenant` matches `tenant_id`, `TenantID` and `TenantScope`. `tenantSignals` mark a query as constrained (in its `Where` / `Scopes` / `Joins` arguments, or, for a write, in the statements that build the record); `tenantContextKeys` mark where the request's tenant comes from. The values shown are the defaults (`org_id` is in both lists too).

## Limits

- Scoped to the Gin + GORM + `internal/{handler,service,middleware,model,dto}` layout it was built against, and checked on other public Gin repositories. Some architectures still return no routes (an engine held in a struct field and mutated by a method, a custom wrapper type with its own `.GET()`, deeply functional-options setups, Wire-style injection).
- Tenant isolation is syntactic: a GORM global scope, a callback (`db.Callback()`), a plugin, or a `Scopes(fn)` whose name carries no tenant signal is not seen, so a query constrained that way reads as unscoped. Queries more than two calls below the handler, or behind an interface whose implementation is not named `T`, `t`, `TImpl` or `tImpl`, are not found. At most 25 query nodes per route.

## License

MIT
