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
- A handler wired up as a local variable (`h := handler.NewXxx(...)`) is resolved to its type.

Nodes carry the `file` and `line` where the parser found them.

## Helpers it exports

The tree-sitter helpers other packages build on: `parseGo`, `walk`, `receiverTypeName`, `bareTypeName`, `functionParamTypes`, `findFunctionDecls`; and the file scanner `findGoFiles` / `readGoProjectFiles` (option `includeTests` to include `_test.go`). `@kidkender/archmind-lens` uses them for its call graph.

## Configuration

`archmind.json` at the project root:

```json
{
  "authorization": { "ownershipSources": ["currentCharacter", "UserId"] },
  "ignoreFindings": ["missing_authorization"]
}
```

## Limits

- Scoped to the Gin + GORM + `internal/{handler,service,middleware,model,dto}` layout it was built against, and checked on other public Gin repositories. Some architectures still return no routes (an engine held in a struct field and mutated by a method, a custom wrapper type with its own `.GET()`, deeply functional-options setups, Wire-style injection).
- Tenant isolation is not implemented for Go.

## License

MIT
