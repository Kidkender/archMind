# @kidkender/archmind-express-parser

**Express.js adapter for ArchMind.** Turns an Express project — JavaScript or TypeScript — into one execution graph per route: the route, its authentication, authorization and validation middleware, the services its handler calls, and the database transactions it opens.

Uses ts-morph to read the code; nothing in the project is installed or run.

---

## Install

```bash
npm install @kidkender/archmind-express-parser
```

## Usage

```ts
import { isExpressProject, parseExpressProjectAt } from "@kidkender/archmind-express-parser"

if (isExpressProject(root)) {
  const graphs = parseExpressProjectAt(root)   // IntermediateExecutionGraph[], one per route
  for (const g of graphs) console.log(g.entrypoint, g.nodes.map((n) => n.type))
}
```

`parseExpressProjectAt` reads the project's `archmind.json` itself. `parseExpressSources(files, options)` takes already-read files (used in tests). `extractRoutes` and `classifyMiddleware` are exported for tools that want the routes and middleware before they become graphs.

Most of ArchMind uses it through `@kidkender/archmind-analysis`, the CLI (`archmind trace`, `archmind findings`) and the MCP server.

---

## Detection

A project is Express when its `package.json` depends on `express` and not on NestJS — at the root, or in one directory below it (`server/`, `backend/`) when the root is not itself another backend (`artisan`, `composer.json`, `go.mod`, `pom.xml`, `build.gradle`, `nest-cli.json`). The CLI and MCP server check every other framework first.

## What it extracts

- **Routes**: `app.get/post/put/patch/delete/all/options/head`, `router.route("/x").get(...).post(...)`, path arrays; routers created with `express()`, `express.Router()`, `Router()` or `require("express").Router()`.
- **Mounts across files**: `app.use("/api", router)` with the router imported through `require` / `module.exports`, `exports.x`, ES `import` / `export default`, re-exports, or built in one expression (`export default Router().use("/api", api)`); routers mounted from an array in a `forEach` (each path stays with its own router); registrar functions handed the app (`require("./routes")(app)`); factory functions that return a router. Path constants, concatenation and template literals resolve; a path that does not is reported, not guessed.
- **Middleware chain** in Express order: `app.use` / `router.use` before the route, path-scoped `use("/admin", mw)`, parent middleware before a mount, `use(path, mw, router)`, middleware passed as arrays or constants holding one.
- **Middleware kinds**, decided in this order:
  1. `archmind.json` `guards.auth_gate` / `guards.authz_check`;
  2. `(err, req, res, next)` error handlers (left out);
  3. optional auth (`auth.optional`, `credentialsRequired: false`) — resolves a user if present, blocks nothing;
  4. the npm package behind the value: passport, express-jwt, express-oauth2-jwt-bearer, celebrate, express-validator, express-validation, express-rate-limit, csurf, helmet, cors, body parsers, ...;
  5. the name: `checkJwt`, `requireAuth`, `verifyAuthToken`, `checkRole`, `isAdmin`, `isAdminUser`, `validate*`, `*Limiter`; `auth(...)` / `authorize(...)` called with roles is both an auth gate and an authorization check;
  6. the body of project middleware: `jwt.verify` or the `authorization` header → authentication (optional when the function always ends in `next()`); a role or permission read off the user and answered with 401/403 → authorization; `csrf`; a middleware that never stops the request → infrastructure.

  Auth, authorization and validation become `ir:auth_gate`, `ir:authz_check`, `ir:validation_gate`. Rate limiting, optional auth and CSRF are `ir:unknown_middleware` with that `role` (the IR has no type for them yet). Infrastructure (body parsing, logging, CORS, static files, sessions) is left out of the graph.
- **Handler**: written inline, a function or controller method from another module, a class static or instance method (`ctrl.list.bind(ctrl)`), looked through wrappers (`catchAsync(fn)`, `asyncHandler(...)`).
- **Service calls**: calls from the handler into project functions in service-like files (service, repository, provider, model, ...) or reached through a module or instance (`userService.createUser` → `userService::createUser`), including `this.users.findAll()` in class controllers whose services come in through the constructor. Utility modules, helpers in the handler's own file and `req` / `res` / `next` calls are not service calls.
- **Transactions**, in the handler or one call below it: `$transaction`, `withTransaction`, `startTransaction`, and `x.transaction(...)` when `x` is a database handle (`sequelize`, `dataSource`, `prisma`, `knex`, `getManager()`, ...) or comes from an ORM package. Writes inside it become `ir:txn_write` (`Order::save`): TypeORM `manager.save(Order, ...)`, Sequelize / Mongoose `Order.create(...)`, Prisma `tx.order.create(...)` and the array form, and for an unmanaged transaction the calls that pass it (`{ transaction: t }`, `{ session }`).
- **Ownership**: a call to one of `archmind.json` `authorization.ownershipSources`, in the handler or one call below → `ir:authz_check` `ownership:<name>`.

Nodes carry the `file` and `line` where the parser found them, relative to the project root.

## Configuration

`archmind.json` at the project root:

```json
{
  "guards": { "auth_gate": ["gatekeeper"], "authz_check": ["requireTeamMember"] },
  "authorization": { "ownershipSources": ["currentUser"] },
  "ignoreFindings": []
}
```

## Measured

On six projects read while building it: 163 of 163 route registration sites. On six projects it had not seen: 101 of 101 real registrations, every transaction-opening route of a production Sequelize app, and 15 of 15 security middleware classified after fixes made on that set (9 of 15 blind). Details, commits and method: [`research/express-corpus`](../../research/express-corpus/README.md).

## Limits

- **Decorator-based routing** (routing-controllers, tsoa, inversify-express-utils) is not read: such a project yields no routes.
- Paths computed at runtime (from a `Map`, a config file, a loop over values that are not array literals) are reported as unresolved.
- Registration order across files is approximate: a route registered by a function in another file than the app is ordered after every middleware of the app's file, so middleware registered after that call is over-applied to it.
- Middleware classification is heuristic. A middleware with an uninformative name and a body that reads no token and no role is `ir:unknown_middleware`; name it in `archmind.json` `guards`.
- One call below the handler is followed for transactions and ownership; a graph shows the route's first transaction.
- Not extracted: tenant isolation, side effects (events, queues, mail), response shaping.
