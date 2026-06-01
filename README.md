# ArchMind

**Catch breaking changes in your Laravel execution flow before they ship.**

```bash
npm install -g @kidkender/archmind
archmind verify --project .
```

No AI model. No API key. Works offline. CI-ready.

---

## The problem

Your tests pass. Your code review looks fine. But somewhere in the diff:

- Someone removed `DB::transaction()` from an order creation flow
- A middleware was accidentally dropped from an admin route  
- A tenant `where` clause got removed from a model query

These don't cause test failures. They cause **production incidents**.

---

## What ArchMind does

Parses your Laravel app into an execution graph, saves a baseline, and **fails your CI if the execution topology changes unexpectedly**.

```
POST /orders  [before refactor]           POST /orders  [after refactor]
├─ 🔑 auth:sanctum                        ├─ 🔑 auth:sanctum
├─ ⚙ ResolveTenant                        └─ 📋 OrderController::store
├─ 📋 OrderController::store
│   └─ 🔄 DB::transaction          ←   GONE
│       ├─ Order::create
│       └─ OrderCreated (event)
```

```
✘ TOPOLOGY REGRESSION: POST /orders
  lost: [transaction_boundary]

If this is intentional, run: archmind verify --project . --update
```

---

## Commands

```bash
# Trace the execution graph of any route
archmind trace --project . "POST /orders"

# Find security gaps across all routes
archmind findings --project .

# Save baseline, then verify on every PR
archmind verify --project . --update   # save
archmind verify --project .            # check (exit 1 if regression)

# What routes are affected if I change this service?
archmind deps --project . OrderService
```

### Example: findings output

```
POST /api/vaults
  ! HIGH    missing_authorization
            Route is authenticated but has no policy or gate — any logged-in user can create vaults

DELETE /api/vaults/{id}
  ! HIGH    missing_authorization
            Route is authenticated but has no policy or gate — any logged-in user can delete vaults

4 finding(s) across 4 route(s)
```

### Example: trace output

```
POST /api/orders
└─ 🔑 auth:sanctum  [authentication_gate]
   └─ ⚙ ResolveTenant::handle  [middleware]
      └─ 📋 OrderController::store  [controller_action]
         ├─ ✅ StoreOrderRequest  [form_request]
         └─ ⚡ OrderService::createOrder  [service_call]
            └─ 🔄 DB::transaction  [transaction_boundary]
               ├─ Order::create  [transactional_write]
               └─ ⚡ OrderCreated → NotifyUser  [transaction_escape]
```

---

## CI Integration

```yaml
# .github/workflows/topology-guard.yml
- uses: actions/setup-node@v4
  with:
    node-version: '20'

- name: Install archmind
  run: npm install -g @kidkender/archmind

- name: Verify topology
  run: archmind verify --project .
  # Fails if DB::transaction, auth middleware, or tenant scope disappears from any route
```

First-time setup (run once, commit the result):

```bash
archmind verify --project . --update
git add .archmind/baselines/
git commit -m "chore: add topology baseline"
```

See [docs/ci/](docs/ci/) for full workflow templates including findings check.

---

## What it catches

| Scenario | How it's detected |
|----------|------------------|
| `DB::transaction()` removed from a route | `transaction_boundary` lost → CI fails |
| Auth middleware accidentally dropped | `authentication_gate` lost → CI fails |
| Tenant scope removed from model query | `unscoped_write` gained → CI fails |
| Route with auth but no policy/gate | `missing_authorization` finding |
| Policy class referenced but file missing | `missing_policy` finding |

---

## Supported Laravel patterns

- Route groups with nested middleware inheritance
- `Route::apiResource()` / `Route::resource()` with `.only()` / `.except()`
- Constructor-injected services (PHP 8 promoted properties)
- `DB::transaction()` blocks with event dispatches and after-commit listeners
- Tenant isolation (`tenant_id`, `app('tenant')`, `whereTenantId`)
- Event → listener tracing via `EventServiceProvider::$listen`
- Kernel aliases (Laravel ≤10) and `bootstrap/app.php` (Laravel 11/12)

---

## MCP Server (Claude Code / AI assistants)

ArchMind ships an MCP server that gives AI assistants structured execution graph access instead of raw file dumps.

```json
{
  "archmind": {
    "command": "node",
    "args": ["./packages/mcp-server/dist/index.js"]
  }
}
```

Ask Claude: *"Why is authorization checked twice on POST /orders?"* — it calls `archmind_get_execution_graph` and reasons over the actual execution path.

---

## Requirements

- Node.js ≥ 18
- A Laravel project (≥8, tested on 10/11/12)

## License

MIT
