# @kidkender/archmind-mcp

MCP server for ArchMind — semantic execution graph intelligence for Laravel and NestJS projects.

Gives Claude Code (and any MCP-compatible AI client) structured tools to understand your codebase's execution flow, authorization paths, and architectural patterns — without dumping raw source files.

## Setup

```bash
npm install -g @kidkender/archmind-mcp
```

Add to your Claude Code MCP settings (`~/.claude/claude_desktop_config.json` or equivalent):

```json
{
  "mcpServers": {
    "archmind": {
      "command": "archmind-mcp"
    }
  }
}
```

Or use `npx` without a global install:

```json
{
  "mcpServers": {
    "archmind": {
      "command": "npx",
      "args": ["-y", "@kidkender/archmind-mcp"]
    }
  }
}
```

No API key required. Works fully offline. Requires Node.js ≥ 18.

---

## What it enables

With the MCP server running, you can ask Claude Code questions like:

> *"Does `PUT /tasks/{id}` verify the user owns this task?"*
> *"Are there any authorization gaps in the order approval flow?"*
> *"What database writes happen inside a transaction when processing a refund?"*
> *"Which routes would break if I change OrderService::process?"*

And get back structured, evidence-backed answers — not guesses based on reading random source files.

The server parses the project on first call, caches the result in-process, and answers subsequent queries from the in-memory graph. No database, no server process, no configuration beyond pointing it at your project root.

---

## Available tools

### `archmind_detect_framework`
Auto-detect whether a project is Laravel or NestJS, and return the framework version if available.

### `archmind_list_entrypoints`
Discover all HTTP routes in a project — method, path, and complexity (node and edge count).

Useful as a first step to understand what's worth investigating.

### `archmind_get_execution_graph`
Return the full or focused semantic execution graph for a specific route.

Use the `focus` parameter to narrow to just the authorization path (`auth`), validation path (`validation`), transaction semantics (`transaction`), or tenant isolation patterns (`isolation`). Focused results use significantly fewer tokens.

### `archmind_get_findings`
Run static and runtime detectors on an endpoint and return structured findings.

**Static findings** — deterministic, no LLM call:
- Authorization: `missing_authorization`, `missing_policy`, `duplicate_authorization`, `resource_unprotected`, `resource_mismatch`
- Architecture: `fat_controller`, `exposed_read_endpoint`, `over_authorized_route`, `dead_middleware`, `circular_dependency`
- Transactions: `event_before_commit`, `missing_tenant_scope`
- And more

**Runtime findings** (provide `trace_session_path` with an OTLP JSON trace):
- `n_plus_one` — N+1 query patterns detected from real request traces
- `slow_query` — database queries exceeding threshold

```
// Static only
archmind_get_findings(project_root, entrypoint)

// Static + runtime correlation
archmind_get_findings(project_root, entrypoint, trace_session_path)
```

### `archmind_get_evidence_package`
Build a structured evidence package for a natural-language question about a route.

Returns intent-classified facts (auth, validation, transaction, isolation), execution path, and relevant evidence nodes — optimized as LLM context. Use this when you need to answer a specific question about a route rather than a full graph dump.

### `archmind_trace`
Trace the execution graph by semantic pattern.

Patterns: `auth` (full authorization chain), `event` (event→listener flow), `transaction` (transaction boundaries and writes), `isolation` (tenant scope and unscoped queries), `request` (full request pipeline).

### `archmind_get_dependents`
Cross-route impact analysis — find all routes that would be affected if a service class or method changes.

Pass a class name (`OrderService`) or a fully-qualified method (`OrderService::process`) to get back every route that calls it, directly or transitively.

### `archmind_invalidate_cache`
Force a fresh parse. Call this after modifying PHP or TypeScript source files.

---

## Supported frameworks

| Framework | Status |
|-----------|--------|
| Laravel | Full support — routes, middleware, FormRequest, policies, events, transactions, tenant isolation |
| NestJS | Support — guards, decorators, middleware, dependency injection |

---

## Why not just read the files?

For a 50-route Laravel app with middleware groups, nested policies, FormRequest delegation, and constructor-injected services, answering "who can access this endpoint?" requires reading 8–15 files and mentally joining them. That's 3,000–8,000 tokens of context that still might miss a middleware alias defined in Kernel.php.

ArchMind pre-computes the semantic graph once, then retrieves only the subgraph relevant to your question — typically 100–400 tokens with full recall.

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
