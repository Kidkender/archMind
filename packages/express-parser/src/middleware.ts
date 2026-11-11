import { Node } from "ts-morph"
import type { ChainEntry } from "./routes.js"
import type { Value } from "./evaluator.js"

/**
 * What a middleware does, as far as the IR is concerned.
 *  - auth_gate / authz_check / validation_gate: a security control, with the
 *    matching IR node (an auth factory called with roles or permissions —
 *    `auth("manageUsers")`, `authorize(ADMIN)` — is both an auth gate and an
 *    authorization check).
 *  - rate_limit / optional_auth / csrf: a control the IR has no node type for;
 *    emitted as ir:unknown_middleware with that role.
 *  - unknown: not recognised; ir:unknown_middleware, an honest "don't know".
 *  - infrastructure / error_handler: body parsing, logging, CORS, static files,
 *    `(err, req, res, next)` handlers — left out of the graph.
 */
export type MiddlewareKind =
  | "auth_gate" | "authz_check" | "validation_gate"
  | "rate_limit" | "optional_auth" | "csrf" | "unknown"
  | "infrastructure" | "error_handler"

export interface Classification {
  kinds:  MiddlewareKind[]
  /** How it was decided, for diagnostics: "config", "package:express-jwt", "name", "body". */
  source: string
}

export interface ClassifyOptions {
  authGates?:   string[]
  authzChecks?: string[]
}

// ---------------------------------------------------------------------------
// Packages (matched on the npm name behind a value, the most precise signal)
// ---------------------------------------------------------------------------

const PACKAGE_KINDS: [string, MiddlewareKind][] = [
  // authentication
  ["passport.authenticate", "auth_gate"],
  ["passport.authorize", "auth_gate"],
  ["express-jwt", "auth_gate"],
  ["express-oauth2-jwt-bearer", "auth_gate"],
  ["express-openid-connect.requiresAuth", "auth_gate"],
  ["express-basic-auth", "auth_gate"],
  ["@clerk/express.requireAuth", "auth_gate"],
  ["keycloak-connect", "auth_gate"],
  // authorization
  ["express-jwt-authz", "authz_check"],
  ["express-jwt-permissions", "authz_check"],
  // validation
  ["celebrate", "validation_gate"],
  ["express-validator", "validation_gate"],
  ["express-validation", "validation_gate"],
  ["express-joi-validation", "validation_gate"],
  ["express-openapi-validator", "validation_gate"],
  ["zod-express-middleware", "validation_gate"],
  ["express-zod-safe", "validation_gate"],
  // rate limiting / CSRF
  ["express-rate-limit", "rate_limit"],
  ["express-slow-down", "rate_limit"],
  ["rate-limiter-flexible", "rate_limit"],
  ["express-brute", "rate_limit"],
  ["csurf", "csrf"],
  ["lusca.csrf", "csrf"],
  // infrastructure
  ["express.json", "infrastructure"], ["express.urlencoded", "infrastructure"], ["express.raw", "infrastructure"],
  ["express.text", "infrastructure"], ["express.static", "infrastructure"],
  ["passport.initialize", "infrastructure"], ["passport.session", "infrastructure"],
  ["body-parser", "infrastructure"], ["cookie-parser", "infrastructure"], ["express-session", "infrastructure"],
  ["helmet", "infrastructure"], ["cors", "infrastructure"], ["compression", "infrastructure"],
  ["morgan", "infrastructure"], ["pino-http", "infrastructure"], ["express-winston", "infrastructure"],
  ["method-override", "infrastructure"], ["express-mongo-sanitize", "infrastructure"], ["xss-clean", "infrastructure"],
  ["hpp", "infrastructure"], ["lusca", "infrastructure"], ["connect-flash", "infrastructure"],
  ["serve-favicon", "infrastructure"], ["response-time", "infrastructure"], ["connect-timeout", "infrastructure"],
  ["swagger-ui-express", "infrastructure"], ["multer", "infrastructure"],
  ["express-ejs-layouts", "infrastructure"], ["express-status-monitor", "infrastructure"], ["nocache", "infrastructure"],
  ["cookie-session", "infrastructure"],
]

/**
 * `expressValidator()` — the default export of express-validator before v6 —
 * only installs `req.checkBody()` and friends on every request; the validation
 * itself happens in the handler. Its members (`body()`, `check()`, ...) are the
 * per-route validation.
 */
const INSTALLERS = new Set(["express-validator"])

function packageKind(values: Value[]): { kind: MiddlewareKind; pkg: string } | null {
  for (const v of values) {
    if (v.kind !== "external" && v.kind !== "externalCall") continue
    if (v.kind === "externalCall" && INSTALLERS.has(v.name)) return { kind: "infrastructure", pkg: v.name }
    // longest matching prefix: "lusca.csrf" before "lusca", "passport.authenticate" before nothing
    let best: [string, MiddlewareKind] | null = null
    for (const entry of PACKAGE_KINDS) {
      const [pkg] = entry
      if ((v.name === pkg || v.name.startsWith(`${pkg}.`)) && (!best || pkg.length > best[0].length)) best = entry
    }
    if (best) return { kind: best[1], pkg: best[0] }
  }
  return null
}

// ---------------------------------------------------------------------------
// Names (the last identifier of the reference or callee)
// ---------------------------------------------------------------------------

/** Auth factories: called with roles or permissions they are also an authorization check. */
const AUTH_FACTORY = /^(auth|authenticate|authorize|authorise|protect|requireAuth)$/i

const AUTHZ_NAME = new RegExp(
  "^(" + [
    "authori[sz]e", "isAuthorized", "permit", "can", "guard",
    "(check|require|has|ensure|verify|restrict|allow|only|is)?(Any)?(Roles?|Permissions?|Admin|Scopes?|Owner|Ownership|Privileges?|Rights?|Access)(Middleware|Guard|Auth|Only|Check|Required)?",
    "(admin|role|roles|owner|permission)(Middleware|Guard|Auth|Only|Check)",
    // isAdminUser, isSuperUser, requireStaff, onlyModerator, isOwnerOrAdmin
    "(is|has|require|ensure|check|only)(Admin|Super|SuperUser|SuperAdmin|Staff|Moderator|Manager|Owner|Root)\\w*",
    "restrictTo", "grantAccess",
  ].join("|") + ")$",
  "i",
)

const AUTH_NAME = new RegExp(
  "^(" + [
    "auth", "authenticate[d]?", "protect(ed)?", "withAuth", "loggedIn",
    "(require|requires|ensure|verify|check|validate|is|has)?(Auth|Authentication|Authenticated|Jwt|Token|Login|LoggedIn|SignedIn|Signin|Session|User|ApiKey)(Middleware|Guard|Handler)?",
    "(auth|jwt|token|apiKey|bearer)(Middleware|Guard|Handler|Check|Required)",
    "authenticate(Token|Jwt|User|Request)",
    // verifyAuthToken, checkAccessToken, validateJwtToken, requireApiKey
    "(verify|check|validate|require|ensure|authenticate)(Auth|Access|Bearer|Id|Api|Jwt|User)?(Token|Jwt|JWT|Key|ApiKey|Session)",
  ].join("|") + ")$",
  "i",
)

const VALIDATION_NAME = /^(validate\w*|validator|validation|\w*Validat(e|or|ion)|schemaValidator|celebrate|checkSchema|zodValidate)$/i
const RATE_LIMIT_NAME = /(limit(er)?|throttle|slowDown|brute(force)?)$/i

const INFRASTRUCTURE_NAMES = new Set([
  "json", "urlencoded", "raw", "text", "static", "helmet", "cors", "compression", "compress",
  "morgan", "logger", "morganLogger", "requestLogger", "httpLogger", "pinoHttp", "successHandler", "errorHandler",
  "cookieParser", "session", "methodOverride", "xss", "xssClean", "mongoSanitize", "hpp", "initialize", "flash",
  "serve", "favicon", "responseTime", "timeout", "xframe", "xssProtection", "nosniff", "hsts",
])

// ---------------------------------------------------------------------------
// Bodies (project-defined middleware the name does not give away)
// ---------------------------------------------------------------------------

const BODY_AUTH = new RegExp([
  "\\b(jwt|jsonwebtoken)\\.verify\\s*\\(",
  "\\bverify(Token|Jwt|JWT|IdToken|AccessToken)\\s*\\(",
  "passport\\.authenticate\\s*\\(",
  "\\.isAuthenticated\\s*\\(\\s*\\)",
  "headers\\.authorization",
  "headers\\[\\s*['\"`](authorization|x-token|x-access-token|x-api-key|x-auth-token)['\"`]\\s*\\]",
  "\\.get\\(\\s*['\"`](authorization|x-api-key)['\"`]\\s*\\)",
  // const { authorization } = req.headers
  "\\{[^}]*\\bauthorization\\b[^}]*\\}\\s*=\\s*\\w+\\.headers",
  "['\"`]Bearer\\s",
].join("|"), "i")

// a role / permission read off the user or token, not any word like "scope" (`User.scope("withSecrets")` is an ORM call)
const BODY_ROLE = /\.(role|roles|isAdmin|admin|permissions?|rights|scopes|privileges?)\b|\b(roles|isAdmin|hasRole|hasAnyRole|hasPermission|permissions|requiredRights)\b|\.(is|has)(Super|Admin|Staff|Owner|Moderator|Manager|Root)\w*/
const BODY_DENY = /\b40[13]\b|forbidden|unauthori[sz]ed/i

const BODY_CSRF = /csrf/i
/** Ways a middleware ends the request instead of passing it on. */
const BODY_STOPS = /\bres\.(status|sendStatus|send|json|end|redirect|render|sendFile)\s*\(|\bthrow\b|\bnext\s*\(\s*[^)\s]/

/**
 * A middleware whose last top-level statement is a plain `next()` lets the
 * request through whatever happened above it: reading a token there makes it
 * optional authentication, not a gate (calling it a gate would hide routes that
 * are really open).
 */
function endsWithUnconditionalNext(fn: Node): boolean {
  const body = (fn as unknown as { getBody?: () => Node | undefined }).getBody?.()
  if (!body || !Node.isBlock(body)) return false
  const statements = body.getStatements()
  const last = statements.at(-1)
  if (!last || !/^(return\s+)?(await\s+)?next\s*\(\s*\)\s*;?$/.test(last.getText().trim())) return false
  // `if (!token) return res.status(401).end()` at the top level still blocks a request without a token
  return !statements.some(isTopLevelExit)
}

/** A top-level statement that ends the request: an unconditional stop, or an `if` whose branch stops directly. */
function isTopLevelExit(stmt: Node): boolean {
  if (Node.isThrowStatement(stmt)) return true
  if (Node.isExpressionStatement(stmt) || Node.isReturnStatement(stmt)) return BODY_STOPS_CALL.test(stmt.getText())
  if (Node.isIfStatement(stmt)) {
    for (const branch of [stmt.getThenStatement(), stmt.getElseStatement()]) {
      if (!branch) continue
      const direct = Node.isBlock(branch) ? branch.getStatements() : [branch]
      if (direct.some((s) => Node.isThrowStatement(s) || ((Node.isReturnStatement(s) || Node.isExpressionStatement(s)) && BODY_STOPS_CALL.test(s.getText())))) {
        return true
      }
    }
  }
  return false
}

const BODY_STOPS_CALL = /\bres\.(status|sendStatus|send|json|end|redirect|render)\s*\(|\bnext\s*\(\s*[^)\s]/

function bodyKinds(fn: Node): MiddlewareKind[] {
  const text = fn.getText()
  const kinds: MiddlewareKind[] = []
  if (BODY_AUTH.test(text)) {
    if (endsWithUnconditionalNext(fn)) return ["optional_auth"]
    kinds.push("auth_gate")
  }
  if (BODY_ROLE.test(text) && BODY_DENY.test(text)) kinds.push("authz_check")
  if (kinds.length > 0) return kinds
  if (BODY_CSRF.test(text)) return ["csrf"]
  // never stops a request (sets res.locals, remembers a URL, then next()): not a control
  if (!BODY_STOPS.test(text)) return ["infrastructure"]
  return []
}

// ---------------------------------------------------------------------------

export function classifyMiddleware(entry: ChainEntry, opts: ClassifyOptions = {}): Classification {
  const callee = calleeText(entry.node)

  // archmind.json guards: the project knows best
  const configured = (list?: string[]) => !!list && (list.includes(entry.name) || list.includes(callee))
  if (configured(opts.authzChecks)) return { kinds: ["authz_check"], source: "config" }
  if (configured(opts.authGates)) return { kinds: ["auth_gate"], source: "config" }

  const fn = functionOf(entry.values)
  if (fn && isErrorHandler(fn)) return { kinds: ["error_handler"], source: "signature" }

  // `auth.optional` / jwt({ credentialsRequired: false }): resolves the user if present, blocks nothing
  if (/\boptional$/i.test(callee) || /credentialsRequired\s*:\s*false/.test(entry.node.getText())) {
    return { kinds: ["optional_auth"], source: "name" }
  }

  const pkg = packageKind(entry.values)
  if (pkg) return { kinds: [pkg.kind], source: `package:${pkg.pkg}` }

  const name = entry.name
  const hasArgs = entry.args.length > 0
  if (/\bauth\w*\.required$/i.test(callee)) return { kinds: ["auth_gate"], source: "name" }
  if (AUTH_FACTORY.test(name)) {
    return { kinds: hasArgs ? ["auth_gate", "authz_check"] : ["auth_gate"], source: "name" }
  }
  if (AUTHZ_NAME.test(name)) return { kinds: ["authz_check"], source: "name" }
  if (AUTH_NAME.test(name)) return { kinds: ["auth_gate"], source: "name" }
  if (VALIDATION_NAME.test(name)) return { kinds: ["validation_gate"], source: "name" }
  if (RATE_LIMIT_NAME.test(name)) return { kinds: ["rate_limit"], source: "name" }
  if (INFRASTRUCTURE_NAMES.has(name)) return { kinds: ["infrastructure"], source: "name" }

  if (fn) {
    const kinds = bodyKinds(fn)
    if (kinds.length > 0) return { kinds, source: "body" }
  }
  return { kinds: ["unknown"], source: "none" }
}

function calleeText(node: Node): string {
  const target = Node.isCallExpression(node) ? node.getExpression() : node
  return target.getText().replace(/\s+/g, "")
}

function functionOf(values: Value[]): Node | null {
  const fn = values.find((v) => v.kind === "function")
  return fn && fn.kind === "function" ? fn.node : null
}

/** Express runs a 4-parameter function only for errors: `(err, req, res, next)`. */
function isErrorHandler(fn: Node): boolean {
  const params = (fn as unknown as { getParameters?: () => unknown[] }).getParameters?.()
  return !!params && params.length === 4
}
