# @kidkender/archmind-analysis

**One call from a project directory to its routes and findings.** The shared analysis pipeline behind the ArchMind CLI and language server: detect the framework, parse the routes, attach the findings.

---

## Install

```bash
npm install @kidkender/archmind-analysis
```

## Usage

```ts
import { analyzeProject } from "@kidkender/archmind-analysis"

const routes = await analyzeProject("/path/to/project")
for (const r of routes) {
  console.log(r.method, r.path, r.findings.map((f) => f.type))
}
```

`analyzeProject(projectRoot)` returns `RouteInfo[]` (from `@kidkender/archmind-protocol`): each route with its guards, validation, transaction and the detected findings.

`detectFindings` is exported too, for callers that already hold the routes.

## Which framework

Detected from the project files, in this order:

| Signal | Parser |
|---|---|
| `nest-cli.json` | `@kidkender/archmind-nestjs-parser` |
| a Spring Boot project | `@kidkender/archmind-springboot-parser` |
| `go.mod` of a Gin project | `@kidkender/archmind-go-parser` |
| otherwise | `@kidkender/archmind-laravel-parser` |

## Configuration

Reads the project's `archmind.json` (through `loadUserConfig` in `@kidkender/archmind-protocol`), for example `ignoreFindings` and, for Go, `authorization.ownershipSources`.

## Notes

The parsers load native tree-sitter addons, so they are required at runtime and are not bundled.

## License

MIT
