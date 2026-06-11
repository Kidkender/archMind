# @kidkender/archmind

CLI for ArchMind — catch breaking changes in your Laravel execution flow before they ship.

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

## What it does

Parses your Laravel app into a semantic execution graph, saves a baseline, and **fails your CI if the execution topology changes unexpectedly**.

```
POST /orders  [before]                    POST /orders  [after]
├─ auth:sanctum                           ├─ auth:sanctum
├─ ResolveTenant                          └─ OrderController::store
└─ OrderController::store
   └─ DB::transaction          ←  GONE
      ├─ Order::create
      └─ OrderCreated (event)
```

```
✘ TOPOLOGY REGRESSION: POST /orders
  lost: [transaction_boundary]

If intentional, run: archmind verify --project . --update
```

---

## Commands

```bash
# Trace the execution graph of a route
archmind trace --project /path/to/app "POST /orders"

# Find security gaps across all routes
archmind findings --project /path/to/app

# Save baseline then verify on every PR
archmind verify --project /path/to/app --update   # save baseline
archmind verify --project /path/to/app            # check (exit 1 on regression)

# What routes are affected if I change this service?
archmind deps --project /path/to/app OrderService
```

---

## Example: findings output

```
POST /api/vaults
  ! HIGH    missing_authorization
            Route is authenticated but has no policy or gate
            Any logged-in user can create vaults

GET /api/products/{product}
  ! MEDIUM  exposed_read_endpoint
            GET route with business logic and no authentication

PUT /api/orders/{order}
  ! MEDIUM  fat_controller
            OrderController depends on 7 distinct services
```

---

## Example: trace output

```
POST /api/orders
└─ auth:sanctum  [authentication_gate]
   └─ ResolveTenant::handle  [middleware]
      └─ OrderController::store  [controller]
         ├─ StoreOrderRequest  [form_request]
         └─ OrderService::createOrder  [service_call]
            └─ DB::transaction  [transaction_boundary]
               ├─ Order::create  [transactional_write]
               └─ OrderCreated → NotifyUser  [transaction_escape ⚠]
```

---

## Detectors

| Finding | Severity | Description |
|---------|----------|-------------|
| `missing_authorization` | HIGH | Authenticated route with no policy or gate check |
| `missing_policy` | HIGH | Controller calls `authorize()` but Policy class missing |
| `resource_unprotected` | CRITICAL | Route-model-binding with no ownership check |
| `resource_mismatch` | HIGH | Auth guards a different resource than the one accessed |
| `fat_controller` | LOW | Controller depends on 5+ distinct service classes |
| `exposed_read_endpoint` | MEDIUM | GET route with business logic and no authentication |
| `over_authorized_route` | INFO | 3+ separate authorization layers on one route |
| `dead_middleware` | MEDIUM | Middleware registered but not connected to pipeline |
| `circular_dependency` | HIGH | Service class dependency cycle (A → B → A) |
| `event_before_commit` | HIGH | Event dispatched inside transaction before commit |
| `missing_tenant_scope` | HIGH | Model query without tenant constraint |

---

## CI integration

```yaml
# .github/workflows/topology-guard.yml
- name: Install archmind
  run: npm install -g @kidkender/archmind

- name: Verify topology
  run: archmind verify --project .
```

First-time setup (run once, commit the result):

```bash
archmind verify --project . --update
git add .archmind/baselines/
git commit -m "chore: add topology baseline"
```

---

## MCP server

For AI assistant integration (Claude Code), use the companion package:

```bash
npm install -g @kidkender/archmind-mcp
```

See [@kidkender/archmind-mcp](https://www.npmjs.com/package/@kidkender/archmind-mcp).

---

## Requirements

- Node.js ≥ 18
- Laravel project (≥ 8, tested on 10/11/12)

## License

MIT
