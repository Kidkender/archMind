# ArchMind

Execution topology intelligence for Laravel — trace routes, detect regressions, find security gaps. No LLM required.

```bash
npm install -g @kidkender/archmind
archmind verify --project ./your-laravel-app
```

## What it does

ArchMind parses your Laravel application into an **execution graph** — not files, but execution nodes and edges — then lets you:

- **Detect architectural regressions** before they merge (transaction removed, auth bypassed, tenant scope leaked)
- **Surface security gaps** statically (missing authorization, unscoped writes)
- **Trace execution paths** for any route
- **Analyze cross-route impact** when changing a service class

All deterministic. No AI model, no API key, no internet connection needed.

## Commands

```bash
# Show execution graph for a route
archmind trace --project . "POST /orders"

# Check for topology regressions vs baseline
archmind verify --project . --label topology-main

# List static security findings
archmind findings --project .

# What routes break if I change this service?
archmind deps --project . OrderService

# Save/update baseline
archmind verify --project . --update
```

## CI Integration

```yaml
# .github/workflows/topology-guard.yml
- name: Verify topology
  run: |
    npm install -g @kidkender/archmind
    archmind verify --project .
```

Fails CI when `transaction_boundary`, `authentication_gate`, or `tenant_scoped_query` nodes disappear from routes. See [docs/ci/](docs/ci/) for full workflow templates.

## What it detects

| Finding | Severity | Description |
|---------|----------|-------------|
| `missing_authorization` | HIGH | Route authenticated but no policy/gate |
| `missing_policy` | HIGH | Policy class referenced but file not found |
| `unscoped_write` | HIGH | Model write without tenant constraint |
| `transaction_boundary` lost | REGRESSION | DB::transaction removed from route |
| `authentication_gate` lost | REGRESSION | Auth middleware removed from route |

## How it works

```
PHP source
  → tree-sitter AST
  → Execution graph (nodes + edges)
  → Topology baseline comparison
  → Findings / regression report
```

The execution graph captures: middleware chain → controller → form requests → policies → services → transactions → events → listeners.

## Supported Laravel patterns

- Route groups with middleware inheritance
- `Route::apiResource()` / `Route::resource()`
- Constructor-injected services (PHP 8 promoted properties)
- `DB::transaction()` blocks with event dispatches
- Tenant isolation patterns (`tenant_id`, `app('tenant')`)
- Event → listener tracing via `EventServiceProvider`
- Kernel middleware aliases (Laravel ≤10) and `bootstrap/app.php` (Laravel 11/12)

## MCP Server

ArchMind ships an MCP server for use with Claude Code and other AI assistants:

```json
{
  "archmind": {
    "command": "node",
    "args": ["./packages/mcp-server/dist/index.js"]
  }
}
```

Tools: `archmind_list_entrypoints`, `archmind_get_execution_graph`, `archmind_get_findings`, `archmind_get_dependents`

## Install

```bash
npm install -g @kidkender/archmind
```

Requires Node.js ≥ 18.

## License

MIT
