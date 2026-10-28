# Changelog

## [0.9.1] - 2026-10-28

### Added
- **`@kidkender/archmind-lens` 0.2.0: say when an answer may be incomplete.** `archmind_symbol_context` now prints `not attributed: <symbol> called from <caller> @file:line` for calls of a same-named method that the call graph could not tie to a definition (untyped or interface receiver); no such line means every call was resolved. A handler on the path whose route could not be resolved is flagged `[route of X not resolved]`. Calls are also followed through map and slice elements (`s.providers[code].Cancel(...)`), interface implementations declared in other packages, values built in place (`(&T{}).M()`), and closure parameters.
- `lens` reports unscoped resource access in services and unscoped reads in handlers.
- READMEs for `lens`, `go-parser`, `analysis`, `aql`, `constraints`, `context` and `graph-query` reach npm with each package's next release (`aql`, `constraints`, `context` and `graph-query` are not re-released here).

### Fixed
- **`@kidkender/archmind-go-parser` 0.3.0: routes were missing for several common Gin layouts.** Measured on eight public Gin applications (route registration sites counted with the Go AST, an approximation): before, five of eight returned 0 or 1 routes; now `golang-gin-realworld-example-app` 27 of 27, `go-gin-example` 15 of 15, `one-api` 123 of 124, `answer` 231 of 232, `go-admin` 99 of 109, `new-api` 349 (337 sites, `Any` and loops), `alist` 307 (the site count undercounts helpers called per prefix), `gin-vue-admin` 201 of roughly 250. What changed: routes are found when the engine is built several calls away from `main`; a function that receives `*gin.Engine` and that nothing reached is a starting point; groups written as `r.Group("/api").Use(mw)` or passed inline as `register(v1.Group("/x"))` are followed; registrars appended to a package-level slice in `init()` and called in a loop are followed; calls resolve to a function in the caller's own directory first; a project whose `go.mod` is one directory down (`server/`) is recognised. Graphs for four other Gin projects are byte-identical before and after.
- `lens` resolves a handler registered as `h.Cancel` to its type when mapping routes (route coverage on four Gin projects: 194/196, 263/267, 59/62, 149/150).
- `analysis` and the MCP server no longer take a Gin project whose `go.mod` is one directory down for a Laravel one.

### Changed
- `@kidkender/archmind-go-parser`: parsing a project is much faster (a 196-route project went from 24.5 s to 2.7 s) because struct definitions are indexed once per file instead of being searched again for every route; tree walks use an explicit stack. `lens` tracks callbacks during the walk instead of climbing parents (call graph for the same project 3.96 s to 2.94 s). The first `archmind_symbol_context` call on a project now takes about 6 s instead of about 30 s; later calls take well under a second.

### Measured, with limits
- `archmind_symbol_context` against a type-checked call graph (Go SSA + VTA): handler recall 346/346 on one private Gin project (247 symbols; tuned on that project) and 381/381 on a second one that was not used for tuning; precision 100% on both. Symbols reached through more than 25 handlers or through transaction closures are not scored.
- With an agent answering "which handlers reach this function": equal accuracy with and without the tool in two rounds (10 and 15 handlers; plain grep also reached 100% on these shallow call chains); the tool used 43% and 49% fewer tool calls and 3% and 5% fewer tokens (one run per cell, six symbols per round); a fresh first call is slower than grep. The tool's value is the "not attributed" warning and deep or interface-heavy chains, not a measured accuracy gain on ordinary Gin code.

### Release notes
- Versions: `go-parser` 0.3.0, `lens` 0.2.0 (needs `go-parser` ^0.3.0), `mcp-server` 0.7.1, `analysis` 0.2.3, CLI 0.9.1 (no CLI source change; it resolves the workspace packages at install time).
- Publish order: `go-parser`, `lens`, `analysis`, `mcp-server`, CLI. The MCP server runs `dist/index.cjs`: run `npm run build` in `packages/mcp-server` and reconnect (`/mcp`) after changing code.

## [0.9.0] - 2026-10-22

### Added
- **Ownership authorization for self-service APIs (Go/Gin).** The `missing_authorization` heuristic assumes authorization means a role or policy, so a game or personal app that scopes every query to the caller flagged every authenticated mutation (55 of 119 routes on a real Gin+GORM game API). `archmind.json` now accepts `authorization.ownershipSources`, the names of the functions that resolve the calling user's own record (e.g. `["currentCharacter", "UserId"]`). A handler that calls one — in its own body or one hop into a helper method on the same receiver — gets an `ir:authz_check` node (`ownership:<name>`), so the detector no longer fires; a handler that acts on a URL `:id` without resolving the caller still does. Measured on that API: 57 findings → 5, and the remaining `missing_authorization` is a handler that really never resolves the caller.
- `archmind.json` `ignoreFindings`: finding types to drop from the report, honored by `archmind findings`, the MCP `archmind_get_findings` tool and the LSP analysis.
- `@kidkender/archmind-protocol`: `loadUserConfig(projectRoot)`, one shared reader for `archmind.json` (a missing or malformed file yields `undefined`, never an error). Used by the Go adapter, `analysis`, the CLI and the MCP server; the Spring Boot and NestJS adapters still carry their own copies.
- `@kidkender/archmind-explainer`: `explain(graph, query?, { ignore })`; trace nodes carry `file` and `line` when the parser recorded them.
- **`@kidkender/archmind-lens` 0.1.0 (new package): start from any Go function, not from a route.** Given a function or method (a service, a repository, a helper), it walks the call graph upward to the HTTP routes, goroutines started with `go`, callbacks and startup code that reach it, and reports whether the call runs inside a `.Transaction(func...)` closure. Calls are resolved from types, not names: receivers, struct fields, typed parameters and locals, package-level variables, interfaces (by method set and signature), generic calls with explicit type arguments, functions and methods used as values, and functions stored in fields through setters, assignments and composite literals. It also reports shared in-memory state changed inside a transaction by a function that has no undo step. Measured on a private Gin+GORM game API against a type-checker call graph (Go SSA + VTA) over 552 functions: route set exact for 98.4% of the functions, every route found was real (precision 100%), and 98.5% of the real routes were found. Limits: Go only, no GDScript; interface matching ignores embedded interfaces and does not tell apart two types with the same name in different packages; the transaction check flags only direct writes on mutex-guarded types, so an empty list is not proof of safety.
- MCP `archmind_symbol_context` (Go): symbol in, compact text out. One line per route or other entry that reaches it, with the path from the entry to the symbol, the `file:line` of the call that reaches it, and flags for transaction, goroutine and indirect links (`[via ref]`, `[via callback]`); callers nobody calls are only counted. `format=json` returns the same facts as an object.
- MCP `archmind_co_changed_files`: files that usually change in the same commit as a given file or directory, from git history (language independent).
- MCP `archmind_list_entrypoints` and `archmind_trace` return the handler `file:line`; `list_entrypoints` takes a `filter`.
- READMEs for `lens`, `go-parser`, `analysis`, `aql`, `constraints`, `context` and `graph-query` (they were missing; they reach npm with each package's next release).
- `@kidkender/archmind-go-parser`: exports the AST helpers (`parseGo`, `walk`, `receiverTypeName`, `bareTypeName`, `functionParamTypes`, `findFunctionDecls`) and a scan option `includeTests` for `findGoFiles` / `readGoProjectFiles`.

### Fixed
- `@kidkender/archmind-go-parser`: a handler wired up as a local variable — `h := handler.NewXxxHandler(...)` or `h := &handler.Xxx{}` inside the registrar — was never resolved to its type (only typed function parameters were), so its `validation_gate`, `txn_boundary` and ownership check were silently missing. Both forms are now resolved; on the Gin game API above, routes like `POST /npcs/:npcId/buy` now show their `NPCService.Buy` transaction.

### Changed
- MCP `archmind_co_changed_files`: files changed together once are listed by default (`min_count` 1 instead of 2); the history showed that `min_count` 2 dropped most of the useful companions (tests, DTOs, docs).

### Release notes
- Versions: `protocol` 0.5.1, `go-parser` 0.2.0, `lens` 0.1.1 (new; 0.1.0 had no README), `explainer` 0.3.3, `analysis` 0.2.2, `mcp-server` 0.7.0, CLI 0.9.0 (0.8.2 was published first from the same code; 0.9.0 aligns the CLI with this release).
- Publish order: `protocol`, `go-parser`, `lens`, `explainer`, `analysis`, `mcp-server`, CLI. `lens` and `go-parser` must be on npm before `mcp-server`, which leaves them as external dependencies of its bundle.
- `visualize` still calls `explain()` without the config.

## [0.8.2] - 2026-09-03

### Fixed
- `@kidkender/archmind-go-parser` 0.1.1: spot-checked against 10 real, previously-unseen public Gin repos (found via `gh search repos`, not cherry-picked) to test generalization beyond the 3 private repos the parser was originally scoped to. Found and fixed two real bugs:
  - A leading comment as the first line inside a `{ ... }` block (function body or a bare scoping block) made the block parse as having zero statements — `block.namedChildren[0]` is the comment node in that case, not the `statement_list`, so every statement after it was silently skipped. This is a general Go AST-walking bug, not Gin-specific; likely present anywhere source has a comment before the first statement in a block. Fixed by locating `statement_list` by node type instead of a fixed index.
  - The router-factory pattern (`func NewRouter() *gin.Engine { r := gin.New(); ...; return r }`, called as `r := NewRouter()`) wasn't recognized — only the inject-the-engine-as-a-parameter style (`func RegisterRoutes(r *gin.Engine)`) was. Confirmed via the 10-repo check as at least as common as the injection style in public code. `walkFunctionBody` now propagates a function's returned group state back to the caller when it returns a bare identifier that was itself a tracked group.
  - Net effect on the spot-check: eddycjy/go-gin-example went from 3/15 routes found to 15/15; smart-clinic-api (one of the 3 original private repos) went from 265 to 280 (the missing 15 were behind the same comment-in-block bug). 4 of the 10 public repos still return 0 routes — each hits a distinct, harder architectural pattern not yet handled (engine held in a struct field and mutated via a receiver method with no return value; the engine wrapped in a custom type with its own `.GET()`/`.POST()` methods; deep functional-options-style nested call chains; Wire-style dependency injection) — tracked as known gaps, not silently claimed as working.

## [0.8.1] - 2026-09-03

### Added
- **Go/Gin support** (`@kidkender/archmind-go-parser` 0.1.0, new package): route + auth-gate + authz-check + validation-gate + transaction-boundary extraction for Gin projects, scoped to the Gin+GORM+`internal/{handler,service,middleware,model,dto}` architecture surveyed across 3 real repos. Handles route registration spanning multiple function-call layers (`main()` → `RegisterRoutes()` → `RegisterXRoutes()`), a globally-applied auth middleware exempting specific routes via a runtime `map[method+path]bool` skip-list read from the middleware's own body (not just its registration site), Go const resolution for role/permission arguments (`model.RoleAdmin` → `"admin"`), `ShouldBindJSON`/`Query`/`Uri` → DTO struct `binding` tag extraction, and GORM `.Transaction()` closure detection with one hop into a directly-called service method. Isolation (tenant scoping) is not yet implemented — flagged as an open question needing further investigation, not guessed at. Wired into `packages/analysis`, the MCP server (`archmind_get_execution_graph` etc. now auto-detect Go via `go.mod` + a `gin-gonic/gin` require), and the CLI (`archmind trace`/`findings`/`verify` all work against a Gin project — `findings`' static detectors fire correctly for Go for free, since they operate on the shared `RouteInfo` shape rather than framework-specific logic). Validated against all 3 surveyed repos end-to-end (full auto-scan, zero manual file listing): 62, 265, and 191 routes respectively, zero crashes.

### Fixed
- **Critical: the published CLI and MCP server could not start, from two compounding bugs.** `@kidkender/archmind` and `@kidkender/archmind-mcp` have statically imported `@kidkender/archmind-retrieval` since the AQL/Architecture Constraints release (v0.6.0), and the CLI also statically imports `@kidkender/archmind-scorer` and `@kidkender/archmind-orchestrator`. First: none of `archmind-retrieval`, `archmind-scorer`, `archmind-orchestrator`, `archmind-prompt-builder`, `archmind-llm-client`, `archmind-runtime-ingest`, or `archmind-runtime-correlator` had ever been published — all 7 were marked `"private": true` in package.json despite being hard runtime dependencies of already-published packages; all 7 published for the first time in this release. Second, separately: `apps/cli`, `packages/mcp-server`, and `packages/analysis` all listed their own `@kidkender/archmind-*` runtime imports under `devDependencies` instead of `dependencies` — npm does not install `devDependencies` for a package's consumers, only for its own contributors, so fixing the first bug alone would not have been enough. Both binaries have been throwing `Cannot find module` on startup for any fresh install since v0.6.0. Caught by running the release-process audit script (`.claude/RELEASE.md` step 0) against every package, not just the ones this release set out to touch; verified fixed against the live registry (`npm install @kidkender/archmind@latest` in a throwaway directory, ran `archmind trace` against a real repo and `archmind-mcp` standalone — both work with no `MODULE_NOT_FOUND`).
- `@kidkender/archmind-laravel-parser` 0.5.2: permission-constant reachability (added in v0.7.1/v0.7.2's `graph-augmenter.ts` fix) only matched a constant referenced by class name in a reachable file — but the common `->middleware('permission:task.delete')` pattern passes only the literal string value, never the class name, so the constant was never included. Now also matches by literal value against `args` already captured on an `auth_gate`/`authz_check` node in the graph. Confirmed via the `retrieval` package's own benchmark suite: `AUTH-002` recall was silently stuck at 0.50 (should be 1.00) for a full release cycle — invisible because `retrieval` was never in CI (see the flaky-test fix below) and never published, so nothing ran its benchmark tests outside a workstation.
- `@kidkender/archmind-graph-query` 0.2.1 / `@kidkender/archmind-explainer` 0.3.2: `hasTenantContext()` checked for an `ir:tenant_context` node type that no parser has ever emitted — tenant presence is always signaled via a `runtime_injection` node instead. `detectMissingTenantScope` and the isolation trace in `trace-engine.ts` have therefore never fired for any real graph. Now also matches a `runtime_injection` node whose symbol names a tenant binding.
- `@kidkender/archmind-retrieval` (first publish, 0.1.0): `classifyNode()` looked up node relevance by raw `node.type` without normalizing legacy (pre-IR) type strings first, so any legacy-typed node classified as `LOW` and was pruned away entirely under a non-`"all"` focus, zeroing out `token_estimate`.
- Flaky test suite root-caused and fixed: Jest reusing one worker process across a package's test files, combined with a module-level `tree-sitter` `Parser` singleton per parser module, caused intermittent silently-swallowed parse failures (`laravel-parser`, `springboot-parser`) — not, as first suspected, a `tree-sitter`/grammar version mismatch (disproved: 500 heavy parses of the same singleton in plain Node, zero failures). Fixed via `maxWorkers` set high enough in both packages' `jest.config.js` that every test file always gets its own process; `go-parser`'s `jest.config.js` ships with the same setting from day one. This is very likely why the repo has never had CI on `main` — a result that changes every run isn't a gate anyone can trust — and directly explains how the `AUTH-002` and `hasTenantContext` regressions above went unnoticed for a full release cycle.
- Added `.github/workflows/ci.yml` (build + test on push/PR to `main`) — previously absent entirely.

### Changed
- `@kidkender/archmind-analysis` 0.2.1: added the Go/Gin branch to `analyzeProject()`, checked via `go.mod` + `isGinProject()` ahead of the branches that assume PHP/JS/Java.
- `@kidkender/archmind-mcp` 0.6.1, `@kidkender/archmind` (CLI) 0.8.1: Go/Gin wiring described above, plus the dependency-section fix.

## [0.7.2] - 2026-07-18

Catch-up release: publishes real fixes that had already landed on `main` (source-only, never version-bumped) before this release process caught the gap.

### Fixed
- `@kidkender/archmind-analysis` 0.1.1: wired Spring Boot detection (`isSpringBootProject`/`parseSpringBootProject`) into `analyzeProject()` — previously any Spring Boot project silently fell through to the Laravel analyzer and returned zero routes. Confirmed on eladmin/litemall/mall: 0 routes before, 133/223/247 after, with auth gates, service calls, and findings all populated.
- `@kidkender/archmind-laravel-parser` 0.5.1: resolves the implicit `/api` path prefix from `withRouting()`/`mapApiRoutes()` (Laravel 11/12 style bootstrapping); scopes permission-constant nodes to files actually reachable from the route graph instead of every file in the project.
- `@kidkender/archmind-nestjs-parser` 0.7.1: route-constants object references in decorator args (e.g. `@Controller(routesV1.version)`) now resolve to their literal value instead of being emitted as raw expression text — includes a recursive identifier → declaration → object-literal resolver that follows `tsconfig.json` path aliases across files. Confirmed on `domain-driven-hexagon`: routes went from `"/routesV1.version/routesV1.user.root"` to the correct `"/v1/users"`.
- `@kidkender/archmind-mcp-server` (`@kidkender/archmind-mcp`) 0.5.1: cache layer wiring updated for the RouteServiceProvider middleware/namespace and route-constants fixes above.
- `@kidkender/archmind-lsp` 0.1.3: fixed a build break introduced by `archmind-analysis`'s new `tree-sitter-java` dependency — esbuild had no loader configured for the native `.node` prebuild binaries pulled in transitively via the bundled `archmind-analysis` → `archmind-springboot-parser` chain. `tree-sitter-java` is now external (matching the same fix already applied to `archmind-analysis`'s own build) and declared as a runtime dependency.
- `@kidkender/archmind` CLI 0.7.2: rebuilt and republished — no source change, ships the `archmind-laravel-parser`/`archmind-nestjs-parser` fixes above, already present in its bundle since they predate this release's build.

## [0.7.1] - 2026-07-18

### Added
- Spring Boot (`@kidkender/archmind-springboot-parser` 0.4.0): unrecognized-but-auth-shaped annotations (SpringBlade's `@PreAuth`, Apache Shiro's `@RequiresRoles`/`@RequiresPermissions`/`@RequiresUser`/`@RequiresAuthentication`, and other common custom-framework security annotations) are now emitted as `ir:unknown_middleware` instead of being silently dropped — surfaces "there IS a security check here, but its exact shape is unknown" instead of the LLM reading absence-of-a-known-node as no-auth.
- `@kidkender/archmind-explainer` 0.3.1: `buildEvidencePackage()` now surfaces `ir:unknown_middleware` as a fact (`unknown_security`, HIGH relevance for the `auth` intent). This node type already existed in the protocol (used by Laravel's middleware-mapper for unresolved middleware) but was never read by fact extraction — evidence packages silently swallowed every "honest don't know" signal before this fix, for both Laravel and Spring Boot.

### Fixed
- Spring Boot (`@kidkender/archmind-springboot-parser` 0.4.0): multi-module Maven scanner (`findJavaFiles`) now recurses to arbitrary depth instead of one level below the root — real multi-module repos nest modules deeper (e.g. `blade-service/blade-demo/src/main/java`). Confirmed on `chillzhuang/SpringBlade`: route extraction went from 9 to 182 routes (15 of 18 `src/main/java` trees were previously unscanned).
- Spring Boot: controller classes using a custom stereotype instead of `@RestController`/`@Controller` (e.g. Spring Boot Admin's `@AdminController`, a plain marker annotation wired through a project-specific `HandlerMapping`) are now detected via method-level HTTP mapping annotations (`@GetMapping`/`@PostMapping`/etc.), which are a reliable signal on their own. Confirmed on `codecentric/spring-boot-admin`: 0 → 21 routes.
- Spring Boot: `SecurityFilterChain` rule matching, `@Transactional` service-layer resolution, and inherited base-class URL-prefix resolution are now all scoped per Maven module (keyed by module root + simple name, not bare simple name). Fixes real cross-module leakage found via QA benchmarking: a demo/sample module's `SecurityFilterChain` was incorrectly gating controllers in an unrelated library module purely because both lived under the same multi-module repo root; the same unscoped-lookup pattern existed for `@Transactional` resolution and base-class path inheritance (confirmed via duplicate simple class names — e.g. two unrelated `NoticeServiceImpl` classes — in `SpringBlade`).
- Spring Boot: `isSpringBootProject()` now follows the build manifest's own declared `<modules>` (Maven, recursively through nested aggregator POMs) / Gradle `include(...)` when the root `pom.xml`/`build.gradle` doesn't mention Spring at all, instead of only trusting the root file. Does not walk the filesystem generically — only manifest-declared module paths are checked, so an unrelated nested Java tool using Spring incidentally cannot misclassify a non-Spring-Boot repo.
- `@kidkender/archmind` CLI: rebuilt and republished to ship the `archmind-springboot-parser` 0.4.0 and `archmind-explainer` 0.3.1 fixes above (both are bundled into the CLI's single build artifact).

## [0.7.0] - 2026-07-08

### Added
- **IR v1.5 — Semantic Fidelity** (`@kidkender/archmind-protocol` 0.5.0, `@kidkender/archmind-laravel-parser` 0.5.0): closes the gaps identified in `research/semantic-ir/v1.5-semantic-fidelity-plan.md`, all regression-checked against real koel/BookStack/InvoiceNinja/Monica/Akaunting source, not just unit fixtures:
  - Middleware group wrapping resolved to concrete FQCNs from `RouteServiceProvider.php`/`Kernel.php`, instead of falling back to bare group names.
  - Mutation chains folded into service-call nodes, exposed via a new `ExecutionNode.mutates` flag.
  - Transaction containment made explicit via a new `ir:wraps` edge relation — a mutating call with no `ir:wraps` edge now renders as a positive, visible "NOT wrapped in a transaction" statement instead of something the LLM has to infer.
  - Guard clauses (`if (...) throw/abort`) and the calls they protect are classified as `ir:guard_clause`.
  - Audit/activity-log sinks (`Activity::add`, `activity()->log`, configurable via `conventions.auditSinks`) classified as `ir:audit_log` instead of a generic service call.
  - Control-flow forks driven by request parameters are emitted as `ir:conditional_branch` nodes, carrying the driving param name in `node.detail`.
  - Relative sub-namespace controller resolution and RouteServiceProvider-level `->namespace($this->namespace)` wrapping — fixes Akaunting's `Route::resource('invoices', 'Sales\Invoices', ...)` pattern, previously mis-resolved as an already-complete FQCN. Also broadens RouteServiceProvider discovery to custom-named providers (e.g. `app/Providers/Route.php`).
- Laravel: standalone Bus/Action dispatch detection — `Bus::dispatch()`, `ClassName::dispatch()/dispatchSync()/dispatchNow()`, and the `laravel-actions` `Action::run()` pattern are now recognized as job/event dispatches, not just constructor-injected service calls.
- Laravel: method-scoped parsing applied consistently across isolation/transaction/audit-log parsing, fixing a file-wide contamination bug where one method's writes/queries leaked into a sibling method's graph.
- New `queue-job-parser.ts` and `schedule-parser.ts` — queued job dispatch and console `Schedule::command()`/`Schedule::call()` extraction as first-class entrypoints.
- `serialize-graph` (`@kidkender/archmind-prompt-builder` 0.2.0): renders `[MUTATES]`, `node.detail`, and a new "Unwrapped mutations" summary section reflecting the new IR v1.5 node/edge types.

### Fixed
- All three bugs found via blind-testing archMind against real repos outside the benchmark suite (InvoiceNinja, Monica, Akaunting): method-scoped isolation analysis no longer leaks a sibling method's writes/queries into the current method's graph; CQRS-style static dispatch (`ClassName::dispatchSync()`) is now detected; and relative sub-namespace controller strings resolve against the enclosing namespace instead of being treated as already-complete FQCNs.

## [0.6.0] - 2026-07-04

### Added
- **`archmind verify --constraints <path.yml>`** — run custom Architecture Constraints (AQL rules) in CI, not just the built-in topology invariants. Missing file/package is a hard error (exit 2) when the flag is explicitly passed, vs. silent skip when unset and no default `.archmind/constraints.yml` exists.
- Test suite for `@kidkender/archmind-constraints` (`loadConstraints`, `checkConstraints`) — first coverage for this package.
- `docs/architecture-constraints.md` — predicate reference and example rule sets (RBAC coverage, transaction-escape, tenant isolation).
- **Non-HTTP entrypoints**: Spring Boot now detects `@KafkaListener`/`@RabbitListener`/`@JmsListener` (as `type: "queue"`) and `@Scheduled` jobs (as `type: "cron"`) as first-class entrypoints, not just `@RestController` routes. Detection runs on `@Service`/`@Component` classes too, not only classes annotated `@Controller`. New `EntrypointDetector` abstraction (`@kidkender/archmind-springboot-parser` 0.3.0) makes adding further kinds additive.
- NestJS: `@Cron` (`@nestjs/schedule`) jobs are now detected as `cron` entrypoints on `@Injectable()` services, not just HTTP routes (`@kidkender/archmind-nestjs-parser` 0.7.0).
- `EntrypointDescriptor.trigger` (`@kidkender/archmind-protocol` 0.4.0) — a normalized, human-readable "what causes this" string with the same meaning across every adapter for a given entrypoint `type` (HTTP: `"METHOD /path"`, queue: destination name, cron: raw schedule expression). Fixes an inconsistency where Spring Boot and NestJS used different metadata key names for the same `type: "cron"` shape.
- Cross-framework conformance test proving Spring `@Scheduled + @Transactional` and NestJS `@Cron` + `dataSource.transaction(...)` produce equivalent IR shape (`cron` entrypoint + `txn_boundary` + `txn_write`).

### Fixed
- Spring Boot: role/permission checks (`hasRole`, `hasAnyRole`, `hasAuthority`, `@Secured`, `@RolesAllowed`, role-based `@PreAuthorize`) now emit BOTH an `auth_gate` and `authz_check` node instead of only `authz_check`. A role check inherently requires authentication first — the previous behavior made `no-auth`/`public` AQL predicates false-positive on every role-protected route. Found by running ArchMind against a real 15-module, 1128-file production Spring Boot monorepo, where it affected 391/400 (98%) of parsed routes. First test coverage added for `@kidkender/archmind-springboot-parser`.
- Spring Boot: transaction boundary detection now resolves `@Transactional` through the service layer, not just the controller. New `service-transaction-index.ts` bridges the interface/impl split (`@Transactional` on `FooServiceImpl`, injected as `FooService`) so a service call from a controller correctly emits `ir:txn_boundary`. Previously 0/400 routes in the same real monorepo showed a transaction boundary despite 108 service files using `@Transactional` — after the fix, 373/400 (93%) do.
- CLI: `archmind verify`/`trace`/etc. no longer report `"Parsed N routes from 0 file(s)"` for Spring Boot and NestJS projects — `fileCount` was hardcoded to 0 for both frameworks; it now reflects the real controller file count.

### Changed
- **Known limitation**: NestJS global guards (`APP_GUARD`) are currently applied uniformly to `cron` entrypoints. The real NestJS runtime only evaluates guards inside HTTP/RPC execution contexts, so this doesn't reflect actual runtime behavior for scheduled jobs. Does not affect graph generation; may affect auth analysis accuracy for cron routes specifically.

## [0.5.0] - 2026-07-01

### Added
- **Spring Boot parser** (`@kidkender/archmind-springboot-parser` 0.2.0) — SecurityFilterChain path-based auth parsing, base-class `@RequestMapping` inheritance resolution, multi-module Maven project support
- **`archmind visualize`** — Execution Timeline HTML report, shows layer-by-layer flow (Auth → Validation → Handler → Transaction → Services → Side Effects) for every route
- **`archmind_get_context` MCP tool** (`@kidkender/archmind-mcp` 0.5.0) — returns a compact semantic context object (security posture, transaction state, risk level) instead of raw graph nodes
- **AQL** (`@kidkender/archmind-aql` 0.2.0) — Architecture Query Language for querying execution graphs
- **Architecture Constraints** (`@kidkender/archmind-constraints` 0.2.0) — define and enforce structural rules on execution graphs
- **AI Context API** (`@kidkender/archmind-context` 0.2.0) — `buildSemanticContext()` for LLM-ready route summaries
- **GraphQuery extensions** (`@kidkender/archmind-graph-query` 0.2.0) — `toNodes()`, `fromNodes()`, `byId()`, `byIds()`, `toMap()` on EdgeQuery/NodeQuery
- **CI/CD release workflow** — GitHub Actions auto-publishes changed packages on tag push with topological ordering and npm provenance

### Fixed
- `findings --json` stdout truncation on large projects — replaced `process.exit()` with `process.exitCode` so stdout flushes before process terminates
- Spring Boot: `superclass` field in tree-sitter Java grammar includes "extends " prefix — stripped before base class lookup

### Changed
- Detectors fully migrated to GraphQuery API — no more direct `graph.nodes.find/filter` access in any detector
- `@kidkender/archmind-explainer` 0.3.0 — `event-before-commit`, `missing-tenant-scope`, `resource-mismatch`, `privilege-hierarchy`, `circular-dependency`, `double-permission-check` detectors now use fluent GraphQuery API

## [0.4.0] - 2026-06-15

### Added
- NestJS incremental parsing — cached ts-morph Project + module file staleness tracking
- Laravel incremental parsing
- IR v2 stable — `validateGraph()` + parser conformance tests
- Behavior diff — semantic change descriptions

### Changed
- `@kidkender/archmind-protocol` 0.3.0 — stable IR v2 schema
- `@kidkender/archmind-explainer` 0.2.0
- `@kidkender/archmind` CLI 0.4.0
