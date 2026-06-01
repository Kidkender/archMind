# ArchMind CI Integration

Two workflow templates for Laravel projects.

## topology-guard.yml — Regression detection

Blocks PRs that remove critical execution nodes from routes:
- `transaction_boundary` removed → potential data integrity bug
- `authentication_gate` removed → potential auth bypass
- `unscoped_write` appeared → potential tenant isolation leak
- Route deleted entirely

**Setup (one-time):**

```bash
# 1. Install archmind
npm install -g archmind

# 2. Create baseline from your current codebase
archmind verify --project /path/to/your-laravel-app --update

# 3. Commit the baseline
cd /path/to/your-laravel-app
git add .archmind/baselines/topology-main.json
git commit -m "chore: add archmind topology baseline"

# 4. Copy workflow to your project
cp topology-guard.yml /path/to/your-laravel-app/.github/workflows/
```

**How it works:**

```
PR opens
  → archmind parses all routes
  → compares execution topology to baseline
  → EXIT 1 if transaction/auth/tenant nodes disappeared
  → EXIT 0 if no regressions
```

**Accepting intentional changes:**

```bash
archmind verify --project . --update
git add .archmind/baselines/ && git commit -m "chore: update topology baseline"
```

---

## findings-check.yml — Static security findings

Reports per-route security issues on every PR. Non-blocking by default (`continue-on-error: true`). Remove that line to make it block merge.

**Finding types reported:**

| Type | Severity | Meaning |
|------|----------|---------|
| `missing_authorization` | HIGH | Route is authenticated but no policy/gate checks authorization |
| `missing_policy` | HIGH | Policy class referenced but file not found on disk |
| `unscoped_write` | HIGH | Model write without tenant_id — potential cross-tenant leak |
| `duplicate_authorization` | MEDIUM | Auth checked twice on same route |
| `delegated_validation` | INFO | FormRequest delegates authorization upstream |

---

## Baseline storage

Baselines are stored at `.archmind/baselines/<label>.json` inside your Laravel project.
Commit this file — it's the ground truth for regression detection.

Add to your `.gitignore` if you don't want to track it (topology-guard will skip if missing).
