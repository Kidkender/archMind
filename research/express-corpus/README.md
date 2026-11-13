# Express parser — measurement corpus

How `@kidkender/archmind-express-parser` was measured, on which projects, and what it found. Measured 2026-11-11 on parser 0.1.0.

## Method

1. Shallow-clone each project at the commit below. Nothing in them is installed or run.
2. Denominator: `node count-routes.mjs <project>` — a regex count of route registration sites (`x.get('/p', ...)`, chained `x.route('/p').get(...)`).
3. Parser: `node measure.mjs <project> [--routes] [--middleware] [--graph]` after `npm run build -w packages/express-parser`.
4. Every difference between the two counts, and every middleware classification, was checked by reading the project's source.

The regex count is an approximation: it over-counts HTTP client calls with the same shape (`axios.post('/x', data)`) and misses paths built at runtime.

## Tuning set (used while building the parser)

These six projects were read while the parser was written, so the numbers below are on data it was tuned against.

| Project | Commit | Lang / ORM | Regex sites | Routes found |
|---|---|---|---|---|
| hagopj13/node-express-boilerplate | 179ae84 | JS / Mongoose | 15 | 15 |
| danielfsousa/express-rest-boilerplate | b8bed6d | JS / Mongoose | 15 | 15 |
| binitghetiya/express-sequelize-api-boilerplate | 1bc3f4f | JS / Sequelize | 5 | 5 |
| sahat/hackathon-starter | b4f25d7 | JS / Mongoose | 101 | 101 |
| andregardi/jwt-express-typeorm | 9b4db23 | TS / TypeORM | 7 | 7 |
| gothinkster/node-express-realworld-example-app | 30b68e1 | TS / Prisma | 20 | 20 |

Two further registrations in hackathon-starter take their path from a `Map` iterated at startup; the parser reports them as unresolved instead of guessing a path.

## Unseen set (not read before measuring)

Measured once with the parser as it stood (commit 29044d8), before anything was changed for them.

| Project | Commit | Lang / ORM | Regex sites | Routes found |
|---|---|---|---|---|
| sfbrigade/bats-server | c0f2616 | JS / Sequelize (a production app) | 66 | 63 |
| GeekyAnts/express-typescript | 6b9bb70 | TS / Mongoose | 15 | 15 |
| sidhantpanda/docker-express-typescript-boilerplate | 4c7c586 | TS | 6 | 6 |
| antonio-lazaro/prisma-express-typescript-boilerplate | 346d60f | TS / Prisma | 15 | 15 |
| ascii-16/expressjs-typescript-prisma-boilerplate | c27ad65 | TS / Prisma | 2 | 2 |
| w3tecch/express-typescript-boilerplate | 1772701 | TS, routing-controllers | 0 | 0 |

- **Routes: 101 of 101 real registrations.** The three bats-server sites the regex counted and the parser did not are HTTP client calls (`axios.post(...)` in `routes/webhooks/sffd.js`, an axios instance's `.get('/api/users/me')` in `auth/peak.js`); the parser skips them because their receiver is not an Express router.
- **routing-controllers is not supported.** w3tecch/express-typescript-boilerplate declares its routes with decorators (`@JsonController`, `@Get`). Neither the regex nor the parser sees them; the parser returns no routes rather than guessing. That is a gap, not a match.
- **Transactions (bats-server): every route that opens one was found** — 27 routes, from 28 `.transaction(` sites in `routes/`. The 28th is in a helper (`resetMciCapacities`) called only from routes that open their own transaction; a graph shows the first transaction of a route.

### Middleware classification

22 distinct middleware across the unseen projects, labelled by reading their code.

| | Blind (commit 29044d8) | After fixes |
|---|---|---|
| All 22 | 9 correct | 19 correct |
| 15 security middleware (auth, authorization, optional auth, validation, rate limit, CSRF) | 9 correct | 15 correct |
| 7 infrastructure middleware | 0 correct | 4 correct |

Blind misses that mattered: bats-server's `isAdminUser`, `isSuperUser`, `isC4SFUser` and `setParams` (authorization: role flags on the user, answered with 403) were left unknown, which would have reported its admin routes as missing authorization; `checkAuthorizationHeader` (optional auth) and `verifyAuthToken` were unknown; old-style `expressValidator()` was taken for per-route validation.

The fixes are general rules (role-flag names and bodies, `const { authorization } = req.headers`, optional auth when a token read always ends in `next()`, compound token names, more infrastructure packages, `expressValidator()` as an installer). **The "after fixes" column is on the same projects the fixes were made for, so it is no longer a blind number.** The original tuning set classifies exactly as before the fixes.

Still unknown after the fixes (all infrastructure, low impact): a `cookie-session` parser reached through an app property (`app.sessionParser`), an inline HTTPS redirect, and a `memory-cache` wrapper.
