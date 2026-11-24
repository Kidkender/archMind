# Laravel scan: false-positive cleanup (2026-11-23)

Goal: make `archmind findings` trustworthy on real Laravel apps before any public post.

- **Before**: `@kidkender/archmind` 0.10.0 from npm (Test-Project/_archmind-tools) → `raw/<repo>.json`
- **After**: this branch (`fix/laravel-precision`), local build → `after/<repo>.json`
- Repos: the 5 Laravel apps in Test-Project/laravel (commits listed in Test-Project/CLONED.md).
- Command: `archmind findings --project <repo> --json` (all severities).

## Result

| Repo | Before: total | Before: HIGH+CRITICAL | After: total | After: shown by default (≥ MEDIUM) | After: HIGH+CRITICAL |
|---|---|---|---|---|---|
| invoiceninja | 946 | 329 | 596 | 77 | 60 |
| monica | 243 | 243 | 0 | 0 | 0 |
| akaunting | 152 | 95 | 57 | 7 | 0 |
| koel | 358 | 168 | 212 | 7 | 3 |
| BookStack | 122 | 116 | 73 | 1 | 0 |
| **Total** | **1,821** | **951** | **938** | **92** | **63** |

HIGH+CRITICAL findings: **951 → 63 (−93%)**. Default output (what a new user sees): 92 lines across 5 apps.

## Triage of the 63 remaining HIGH/CRITICAL (code read at the cloned commit)

| Verdict | Count | Findings |
|---|---|---|
| **Worth a look** (verified) | 30 | invoiceninja `POST /api/v1/reports/*` ×28 — `GenericReportRequest::authorize()` returns `true`; a non-admin without `view_reports` is not rejected, their input is blanked in `prepareForValidation()` and the report job still runs. invoiceninja `POST /quickbooks/action` — `authorize()` returns `true`, any company user can force-push/pull an invoice to QuickBooks. koel `GET /api/youtube/search/song/{song}` — no `SongPolicy::access` check (only matters for private songs in Plus). |
| **False positive** (verified) | 12 | invoiceninja `system_logs` store/update/destroy ×4 (handlers always return 400, no write); `quickbooks/settings` and client `payment_methods` PUT/PATCH ×2 (routed methods don't exist; controllers use traits so ArchMind can't prove it); `client/subscriptions/{subscription}/purchase` ×3 (public checkout page by design). koel `itunes/song/{album}` (redirects to iTunes, no private data); koel collaboration-invite token (returned to the inviter by design). |
| **Worth a look** (second pass, 2026-11-24) | 8 | invoiceninja: FormRequests returning `true` on company-scoped actions with no `view_*`/`edit_*` permission check (`emails/entityHistory`, `preview`, `preview/purchase_order`, `tasks/sort`), account-level SMS verification open to any user (`verify`, `verify/confirm`), and two flows under private review (`one_time_token`, `reactivate_email/{bounce_id}`). |
| **False positive** (second pass) | 13 | invoiceninja: no-side-effect handlers (`check_subdomain`, `filters/{entity}`, `self-update/check_version`, `subscriptions/steps/check`); actions only on the caller's own user (`feedback`, `connected_account` ×2, `companies/current`, `support/messages/send`); `quickbooks/reconnect_url` (pinned to the stored realm ID); client `payments/credit_response` (unguessable payment hash); client `payment_methods` POST (contact's own client); client `quotes/download` (scoped by `client_contact_id` inside a helper method). |
| **Confirmed vulnerability** | 0 | Two earlier candidates (invoiceninja client/vendor `documents/download_multiple`, company-only query) were withdrawn: `DownloadMultipleDocumentsRequest::authorize()` checks every document with `contactCanAccessDocument()`. Two flows from the second pass are being reported privately to the maintainers; nothing has been confirmed at runtime. |

Precision on all 63: **38 (60%)** are worth a reviewer's attention; **25 (40%)** are false positives.
None is a confirmed vulnerability — do not market this as "found N vulnerabilities".

The 13 second-pass false positives point at four detector gaps (not fixed yet): handlers with no side
effect, actions only on `auth()->user()` or the contact's own client, lookups keyed by an unguessable
secret, and caller-scoped queries inside a called helper method.

## What was wrong, and the fix (each with a test in laravel-parser / explainer)

| Root cause | Example | Fix |
|---|---|---|
| Unresolved class middleware defaulted to **auth gate** | invoiceninja `SessionDomains` made password reset look "authenticated" | classify by name; unknown stays unknown (`middleware-mapper.ts`) |
| `RedirectIfAuthenticated` / `guest` read as auth gate | akaunting `/auth/login` "authenticated but not authorized" | guest-only middleware is never an auth gate |
| Laravel 11+ has no Kernel: `can:`, `role:`, `auth`, `signed:relative` unrecognised | monica `can:vault-viewer,vault` on every vault route (224 findings) | built-in aliases mapped without a Kernel |
| Controller permission helpers not seen | BookStack `checkOwnablePermission()`, `userCan()`, `$user->can()` | helper calls are authz facts (no policy inferred) |
| Constructor middleware arrays / enums / `->only()` | BookStack `Permission::SettingsManage->middleware()` | parsed per entry; non-literal permission entries kept as `can:` |
| `authorizeResource()` in constructor ignored | resource controllers | maps methods → abilities, honours `except`/`only` |
| Policy name inferred from the **controller** | koel `ScrobbleController` → `ScrobblePolicy` (49 missing_policy) | from the model (`$song` → `SongPolicy`), searched in sub-folders and registrations; interfaces skipped |
| Route alias imports not resolved | BookStack `use … as EntityControllers` — no controller file read at all | PHP name resolution of the first segment |
| Any typed param treated as a resource | `SearchResultsFormatter`, `BankIntegrationFilters` (486 CRITICAL) | only Eloquent models, only if the handler uses the param |
| resource_unprotected despite other authz, always CRITICAL, duplicated | — | only when no authz/signed URL at all; HIGH behind login, CRITICAL when public; not duplicated with missing_authorization |
| Service-layer authorization invisible | monica `(new UpdateVault)->execute()` + `permissions()` | inline `new` service calls; `permissions()` rules and Gate/can/403 in the called method |
| Queries scoped to the caller not seen | koel `getOne()` → `withUserContext()` → `accessible()`; invoiceninja `whereClientId(<contact>)`; monica `$request->user()->userTokens()->delete()` | caller-scoped queries/writes are authz facts — shared keys (`company_id`, `account_id`, `team_id`) excluded |
| FormRequest `authorize()` checks ignored | invoiceninja `auth()->user()->can('edit', $this->client)`; per-item `return false` loops | real checks become authz facts; `true` / login-only bodies do not |
| Routes to actions that don't exist | koel `apiResource('artists.songs')` with only `index()` | `handler_not_found` → no findings; nested resource paths fixed |
| Public-by-design routes as gaps | SSO callbacks, invitations, login/password, broadcasting/auth, logout, `/me`, `/preferences` | INFO or not reported |
| Sensitive-field noise | koel `when($isCurrentUser, …)` fields, `has_password` flag | caller-conditional fields and boolean flags are not secrets |
| Output flooded with LOW/INFO | BookStack 62 × fat_controller | default output ≥ MEDIUM, `--all` for the rest; only CRITICAL/HIGH fail CI |

## Also found on the way

- **Published CLI 0.10.0 can't parse Spring Boot**: it bundles the Spring parser but not its native
  `tree-sitter-java` dependency, so every Spring project silently printed "No findings." Fixed by adding
  the dependency; the CLI now also warns (stderr, exit 2) whenever 0 entrypoints are found.
- The MCP server does not support Spring Boot (CLI only) — README and npm description now say so.
- Non-Laravel regression check (0.10.0 vs this branch, same repos): NestJS, Express, Go, RuoYi unchanged except
  ginfast `POST /api/users/logout` (logout, correctly dropped); SpringBlade 0 → 94 (now actually parsed).

## Known limits (not fixed)

- Any `ir:service_call` still counts as an authorization layer in `missing_authorization` (explainer
  fact extraction) — a source of false negatives, not false positives. Changing it affects every framework.
- MEDIUM/LOW findings were not triaged.

## Exit bar status

Set in the first version of this file: "≥ 70% real or worth a look, and no app > ~30 HIGH/CRITICAL without config".
- Precision bar: **not met** — 60% on all 63 (71% on the first 42 read; the last 21 were mostly
  invoiceninja app-level actions with 13 false positives). Closing the four detector gaps above is
  the next step.
- Volume bar: met for 4 of 5 apps; invoiceninja has 60 (28 are one report pattern). An `archmind.json`
  `ignoreFindings` or a per-route ignore would bring it under; not added.
