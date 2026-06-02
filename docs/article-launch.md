# Tests verify behavior. ArchMind verifies architecture.

The PR was 14 lines.

The incident cost two days.

---

Tests passed. Code review approved. Production corrupted customer orders anyway.

Someone refactored `OrderService`. One method call moved outside `DB::transaction()`. The email notification failed mid-request. Half the order was written. Half wasn't.

The diff was clean. The types were correct. The logic was "the same."

The architecture was not.

---

## Your tests don't check this

```
POST /orders  [before]           POST /orders  [after]
├─ auth:sanctum                  ├─ auth:sanctum
├─ ResolveTenant                 ├─ ResolveTenant
└─ OrderController::store        └─ OrderController::store
   └─ 🔄 DB::transaction    ←        └─ OrderService::create
       ├─ Order::create                   └─ Order::create  ← DB::transaction GONE
       └─ OrderCreated (event)
```

```
✘ TOPOLOGY REGRESSION: POST /orders
  lost: [transaction_boundary]

  If this change is intentional, run: archmind verify --update
```

CI fails. PR blocked. Incident prevented.

That's what ArchMind does.

It doesn't test behavior.

It protects architecture.

---

Think of it as **snapshot testing for architecture**.

The same way frontend teams snapshot UIs to catch visual regressions, ArchMind snapshots your execution topology to catch architectural ones.

---

## Install it now

```bash
npm install -g @kidkender/archmind
archmind findings --project /path/to/your/laravel/app
```

No config. No API key. No PHP required. Results in under 60 seconds.

---

## What it found on real projects

**Koel** — music streaming app, 15,000+ GitHub stars:

```
POST /api/themes
  ! HIGH    missing_authorization
            Route is authenticated but has no policy or gate
            Any logged-in user can modify system themes

GET /lastfm/callback
  ! HIGH    missing_authorization
            Route is authenticated but has no policy or gate
```

**Monica CRM** — personal relationship manager used in production:

```
POST /vaults
  ! HIGH    missing_authorization
            Any logged-in user can create vaults

DELETE /vaults/{id}
  ! HIGH    missing_authorization
            Any logged-in user can delete any vault
```

Both are public repos. These are findings any developer could catch with the right tool.

---

## The "holy shit" moment

Run this against your own app:

```bash
archmind trace --project . "POST /orders"
```

```
POST /orders
└─ 🔑 auth:sanctum  [authentication_gate]
   └─ ⚙ ResolveTenant::handle  [middleware]
      └─ 📋 OrderController::store  [controller_action]
         ├─ ✅ StoreOrderRequest  [form_request]
         └─ ⚡ OrderService::createOrder  [service_call]
            └─ 🔄 DB::transaction  [transaction_boundary]
               ├─ ✍ Order::create  [transactional_write]
               └─ ⚠ OrderCreated → NotifyUser  [transaction_escape]
```

Your entire execution path — middleware, auth, form validation, policy checks, transaction boundaries, event dispatches — in one view. From a single command.

Now ask: *does your code reviewer see this when reviewing a PR?*

---

## Who is this for

You probably **don't** need ArchMind if:
- Your app has fewer than 30 routes
- Business logic lives entirely in controllers
- You have a dedicated QA team running integration tests

You probably **do** if:
- Your app has 100+ routes with nested middleware groups
- Business logic spans services, events, and listeners
- You've had a production incident that passed code review

---

## CI in 3 minutes

```bash
# Once — save the baseline:
archmind verify --project . --update
git add .archmind/baselines/ && git commit -m "chore: topology baseline"
```

```yaml
# Every PR:
- run: npm install -g @kidkender/archmind && archmind verify --project .
```

From now on: if `DB::transaction()` disappears, if auth middleware gets dropped, if tenant scope leaks — CI fails with exactly which route changed and what was lost.

---

## Bonus: AI context

The same execution graph that powers `verify` also gives AI assistants structured context instead of raw file dumps.

```
Question: "Why does this payment endpoint sometimes double-charge customers?"

Context sent to LLM (318 tokens):
- transaction_boundary: DB::transaction wraps the charge
- transaction_escape: payment event dispatched inside
- after-commit listener: sends receipt after transaction commits

vs. file dump: 4,972 tokens. Same question. Better answer. 15x less cost.
```

Architecture QA benchmark (questions written by project maintainer, scored by LLM judge):

| | ArchMind | File dump |
|---|---|---|
| Correct answers | **3/3** | 1/3 |
| Tokens per query | **~700** | ~9,000 |

---

## Try it

```bash
npm install -g @kidkender/archmind
archmind findings --project /path/to/your/laravel/app
```

Run this against your Laravel app.

If ArchMind doesn't find anything interesting in under a minute, come back and tell me.

→ [github.com/Kidkender/archMind](https://github.com/Kidkender/archMind)
