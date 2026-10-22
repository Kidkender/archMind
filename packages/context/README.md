# @kidkender/archmind-context

**The AI Context API.** Turns an execution graph into a compact, structured description of what a route does: who can call it, what it checks, whether it writes inside a transaction, what it dispatches, and what is wrong with it. Meant to be handed to an LLM instead of the source files.

---

## Install

```bash
npm install @kidkender/archmind-context @kidkender/archmind-protocol
```

## Usage

```ts
import { buildSemanticContext, buildProjectContext } from "@kidkender/archmind-context"

// One route
const ctx = buildSemanticContext(graph, findings)   // findings: optional ContextFinding[]
console.log(ctx.summary)        // one sentence, readable by a person or an LLM
console.log(ctx.is_mutation)

// A whole project: entrypoint -> context
const all = buildProjectContext(graphs, findingsByEntrypoint)
```

`SemanticContext` carries the entrypoint (`method`, `path`), `is_mutation`, a one-sentence `summary`, and these sections:

| Field | Content |
|---|---|
| `security` | `is_public`, `auth_gates`, an `authorization` block (`enforced`, `checks`), the findings you pass in and a `risk_level` (`NONE` to `CRITICAL`) |
| `transaction` | `has_boundary`, `escape_risks` |
| `validation` | `has_form_request`, `classes` |
| `services`, `middleware`, `async_side_effects`, `node_count` | what the route calls, its middleware chain, queued jobs / events / mail, and graph size |

The MCP server exposes it as the `archmind_get_context` tool.

## Built on

`@kidkender/archmind-graph-query` for the facts and `@kidkender/archmind-protocol` for the node types.

## License

MIT
