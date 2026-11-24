import Parser from "tree-sitter"
// @ts-ignore
import PHP from "tree-sitter-php"
import { parsePhpFile, findMethod } from "./php-source.js"
import { extractReturnedResources } from "./resource-parser.js"
import { classifyDispatch } from "./transaction-parser.js"
import { isGuardClauseMethodNode } from "./guard-clause-parser.js"

const _parser = new Parser()
_parser.setLanguage((PHP as { php?: unknown }).php ?? PHP)

// ---- Public API -------------------------------------------------------

export interface FormRequestParam {
  shortName: string   // e.g. "UpdateTaskRequest"
  fqcn:      string   // e.g. "App\Modules\Task\Requests\UpdateTaskRequest"
  paramName: string   // e.g. "$request"
}

export interface AuthorizeCall {
  ability:   string   // first string arg, e.g. "update"
  mechanism: string   // full call text, e.g. "$this->authorize('update', $task)"
  modelVar?: string   // second arg variable name, e.g. "$task"
  /**
   * "policy" (default): resolved through a Laravel policy — $this->authorize(),
   * Gate::allows(), authorizeResource(). "helper": an authorization check that
   * isn't a policy lookup — $this->checkPermission(), $user->can(), userCan() —
   * so no policy class is inferred (and no missing_policy can be raised).
   */
  kind?:       "policy" | "helper"
  /** Model class the policy is resolved from (Laravel picks the policy by model, not by controller). */
  modelClass?: string
  /** Helper name for kind "helper", e.g. "checkOwnablePermission". */
  helper?:     string
}

export interface ModelParam {
  className: string   // e.g. "Product"
  classFqcn: string   // e.g. "App\Models\Product"
  paramName: string   // e.g. "$product"
  /**
   * Whether the handler body references the param. A bound model the handler
   * never touches (invoiceninja's ProfileController::edit renders the logged-in
   * contact, not `$client_contact`) can't expose another user's record.
   */
  usedInBody?: boolean
}

export interface ServiceCall {
  propertyName: string   // injected property name, e.g. "permissionService"
  serviceClass: string   // short class name, e.g. "PermissionService"
  serviceFqcn:  string   // FQCN, e.g. "App\Modules\Access\Services\PermissionService"
  method:       string   // called method, e.g. "hasPermission" or "apiTokens()->delete" for a mutating chain
  args:         string[] // string literal args extracted from the call site
  mutates?:     boolean  // true when the call chain terminates in a data-mutating operation
  /**
   * Set when one of this call's arguments is a variable assigned from
   * $request->input()/->has()/->boolean() in the caller. Lets the graph
   * augmenter follow the request parameter one hop into the callee's body
   * to see if IT branches on the corresponding parameter (IR v1.5 Phase 6,
   * cross-method extension) — the shape BookStack's
   * UserApiController::delete -> UserRepo::destroy actually has: the
   * controller reads the request value and hands it to a service method
   * that does the real branching.
   */
  requestParamArg?: { position: number; requestParamName: string }
}

export interface ConstructorMiddleware {
  raw:    string    // e.g. "auth:web,subdealer"
  except: string[]  // method names excluded from this middleware
  only:   string[]  // if non-empty, middleware only applies to these methods
}

export interface ReturnedResource {
  shortName:    string   // e.g. "UserResource"
  fqcn:         string   // e.g. "App\Http\Resources\UserResource"
  isCollection: boolean  // true if ::collection() call
}

export interface StandaloneDispatch {
  className: string            // e.g. "ProcessPaymentJob"
  fqcn:      string            // e.g. "App\Jobs\ProcessPaymentJob"
  kind:      "job" | "event" | "unknown"
  callText:  string
}

export interface NotificationDispatch {
  className: string            // e.g. "WelcomeNotification"
  fqcn:      string            // e.g. "App\Notifications\WelcomeNotification"
  kind:      "notification" | "mail"
  queued:    boolean           // true for Mail::queue() / ->queue()
  callText:  string
}

export interface SelfGuardCall {
  /** Name of the same-class private/protected method that is itself a guard clause. */
  methodName: string
  /** The actual precondition(s) it checks, e.g. "isLastAdmin(); system_name === 'public'". */
  conditionText: string | null
}

export interface ConditionalBranch {
  /** raw condition source text, e.g. "!empty($newOwnerId)" */
  conditionText: string
  /** request parameter name driving the condition, e.g. "migrate_ownership_id" */
  paramName:     string
  /** resolvable calls found in the "then" branch */
  thenCalls:     ServiceCall[]
  /** resolvable calls found in the "else" branch (empty if no else) */
  elseCalls:     ServiceCall[]
}

export interface ControllerL1 {
  useMap:                  Map<string, string>
  formRequests:            FormRequestParam[]
  authorizeCalls:          AuthorizeCall[]
  serviceCalls:            ServiceCall[]
  constructorMiddleware:   ConstructorMiddleware[]
  modelParams:             ModelParam[]
  returnedResources:       ReturnedResource[]
  standaloneDispatches:    StandaloneDispatch[]
  standaloneNotifications: NotificationDispatch[]
  conditionalBranches:     ConditionalBranch[]
  /** Same-class `$this->method()` self-calls whose target is itself a guard clause. */
  selfGuardCalls:          SelfGuardCall[]
  /** 1-indexed line of the method declaration; used for editor CodeLens anchoring */
  methodLine?:             number
}

// Classes that must NOT be treated as FormRequest nodes
const SKIP_FQCN = new Set([
  "Request",
  "Illuminate\\Http\\Request",
  "Illuminate\\Foundation\\Http\\FormRequest",
])

export function parseControllerMethod(
  filePath: string,
  methodName: string
): ControllerL1 | null {
  const parsed = parsePhpFile(_parser, filePath)
  if (!parsed) return null
  const { source, tree } = parsed
  const root  = tree.rootNode
  const useMap = extractUseMap(root)

  const methodNode = findMethod(root, methodName)
  const constructorMiddleware = gatherConstructorMiddleware(root)

  if (!methodNode) {
    return { useMap, formRequests: [], authorizeCalls: [], serviceCalls: [], constructorMiddleware, modelParams: [], returnedResources: [], standaloneDispatches: [], standaloneNotifications: [], conditionalBranches: [], selfGuardCalls: [] }
  }

  const injections = extractConstructorInjections(root, useMap)
  const methodInjections = extractMethodParamInjections(methodNode, useMap)
  // Merge: method params take precedence over constructor for same var name
  const allInjections = new Map([...injections, ...methodInjections])

  // Request-derived local vars ($var = $request->input('name')) — computed
  // once, reused both for same-method branch detection and for tagging
  // service-call arguments that carry a request value into a callee
  // (IR v1.5 Phase 6).
  const requestParamVars = new Map<string, string>()
  const methodBody = methodNode.childForFieldName("body")
  if (methodBody) collectRequestParamVars(methodBody, requestParamVars)

  const formRequests         = extractFormRequests(methodNode, useMap)
  const modelParams          = extractModelParams(methodNode, useMap)
  const authorizeCalls       = [
    ...extractAuthorizeCalls(methodNode, modelParams),
    ...extractAuthorizeResource(root, methodName, modelParams),
  ]
  const serviceCalls       = extractServiceCalls(methodNode, allInjections, useMap, requestParamVars)
  const returnedResources      = extractReturnedResources(methodNode, useMap)
  const standaloneDispatches   = extractStandaloneDispatches(methodNode, useMap)
  const standaloneNotifications = extractNotificationDispatches(methodNode, useMap)
  const conditionalBranches    = requestParamVars.size > 0
    ? gatherConditionalBranchesFromVars(methodNode, requestParamVars, allInjections)
    : []

  // Depth-1 private method traversal: follow $this->helper() calls into the
  // same class, but do not recurse further to avoid graph blow-up.
  //
  // Exception: a private/protected method that is itself a guard clause
  // (e.g. UserRepo::destroy() calling $this->ensureDeletable($user)) must
  // NOT be flattened — flattening drops the fact that a guard clause exists
  // at all, since the guard's own body (an early if/throw) has no calls
  // worth extracting anyway. Emit it as a selfGuardCall instead so the graph
  // augmenter can give it a real ir:guard_clause node (IR v1.5 Phase 4,
  // same-class self-call extension — found via real-repo regression check:
  // BookStack's ensureDeletable() is called this way, not through an
  // injected property, so it was invisible in the graph entirely).
  const privateNames = extractPrivateMethodCallNames(methodNode)
  const selfGuardCalls: SelfGuardCall[] = []
  for (const name of privateNames) {
    const privateMethod = findMethod(root, name)
    if (!privateMethod) continue

    const guardCheck = isGuardClauseMethodNode(privateMethod, name)
    if (guardCheck.isGuardClause) {
      selfGuardCalls.push({ methodName: name, conditionText: guardCheck.conditionText })
      continue
    }

    authorizeCalls.push(...extractAuthorizeCalls(privateMethod, modelParams))
    serviceCalls.push(...extractServiceCalls(privateMethod, allInjections, useMap, requestParamVars))
    standaloneDispatches.push(...extractStandaloneDispatches(privateMethod, useMap))
    standaloneNotifications.push(...extractNotificationDispatches(privateMethod, useMap))
  }

  // Deduplicate service calls by propertyName+method (same call site from two
  // traversal paths should not produce two nodes).
  const seenSvc = new Set<string>()
  const uniqueServiceCalls = serviceCalls.filter((sc) => {
    const key = `${sc.propertyName}::${sc.method}`
    if (seenSvc.has(key)) return false
    seenSvc.add(key)
    return true
  })

  // Calls that live inside a detected conditional branch are only emitted
  // there (scoped under the branch node) — the generic body-wide walk above
  // also finds them, so exclude them here to avoid a duplicate unconditional
  // node for a call that only executes in one branch (IR v1.5 Phase 6).
  const branchOwnedKeys = new Set(
    conditionalBranches
      .flatMap((b) => [...b.thenCalls, ...b.elseCalls])
      .map((sc) => `${sc.propertyName}::${sc.method}`)
  )
  const finalServiceCalls = uniqueServiceCalls.filter(
    (sc) => !branchOwnedKeys.has(`${sc.propertyName}::${sc.method}`)
  )

  return {
    useMap,
    formRequests,
    authorizeCalls,
    serviceCalls: finalServiceCalls,
    constructorMiddleware,
    modelParams,
    returnedResources,
    standaloneDispatches,
    standaloneNotifications,
    conditionalBranches,
    selfGuardCalls,
    methodLine: methodNode.startPosition.row + 1,  // 1-indexed
  }
}

// ---- FormRequest authorize() body extraction --------------------------

/**
 * Parse a FormRequest PHP file and extract the return expression from authorize().
 * Returns the raw PHP expression text, e.g. "$this->user()?->isAdmin()"
 * Returns undefined if the file can't be parsed or has no authorize() method.
 */
export function parseFormRequestAuthorize(filePath: string): string | undefined {
  const parsed = parsePhpFile(_parser, filePath)
  if (!parsed) return undefined
  const { source, tree } = parsed
  const methodNode = findMethod(tree.rootNode, "authorize")
  if (!methodNode) return undefined

  const body = methodNode.childForFieldName("body")
  if (!body) return undefined

  let topReturn: string | undefined
  for (const child of body.children) {
    if (child.type === "return_statement") {
      const expr = child.children.find(
        (c) => c.type !== "return" && c.type !== ";" && c.text.trim() !== ""
      )
      if (expr) { topReturn = expr.text.trim(); break }
    }
  }

  // `if ($this->user()->cannot('edit', $this->client)) { return false; } return true;`
  // — the final `return true` hides a real check made earlier in the body.
  // Report the (compacted) body so the check is not read as a passthrough.
  const bodyText = body.text
  // A conditional `return false` is a deny branch — e.g. invoiceninja's
  // DownloadMultipleDocumentsRequest loops `if (! $this->contactCanAccessDocument(...)) return false;`
  // — unless the only condition is "is someone logged in".
  const authOnlyBody = /^\{\s*(if\s*\(\s*!\s*(auth\(\)->check\(\)|Auth::check\(\)|\$this->user\(\)|auth\(\)->user\(\))\s*\)\s*\{?\s*return\s+false;\s*\}?\s*)?return\s+true;\s*\}$/
  const conditionalDeny = /return\s+false/.test(bodyText) && !authOnlyBody.test(bodyText.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "").trim())
  const checksEarlier = conditionalDeny || /->(can|cannot|cant|hasPermissionTo|hasPermission|hasRole|hasAnyRole|isAdmin|isOwner)\s*\(|Gate::|authorize\s*\(|abort(_if|_unless)?\s*\(/.test(bodyText)
  if ((topReturn === undefined || /^true$/i.test(topReturn)) && checksEarlier) {
    return bodyText.replace(/^\{|\}$/g, "").replace(/\s+/g, " ").trim().slice(0, 240)
  }
  return topReturn
}

// ---- Use-statement extraction -----------------------------------------

/** `use` maps by tree: a cached tree is analysed for many routes, the imports do not change. */
const useMaps = new WeakMap<Parser.Tree, Map<string, string>>()

export function extractUseMap(root: Parser.SyntaxNode): Map<string, string> {
  const isRoot = !root.parent
  const cached = isRoot ? useMaps.get(root.tree) : undefined
  if (cached) return new Map(cached)
  const map = new Map<string, string>()
  gatherUseDecls(root, map)
  if (isRoot) useMaps.set(root.tree, map)
  return new Map(map)
}

function registerUseClause(clause: Parser.SyntaxNode, prefix: string, map: Map<string, string>): void {
  const children = clause.children as Parser.SyntaxNode[]
  const qualName  = children.find(
    (c) => c.type === "qualified_name" || c.type === "name"
  )
  if (!qualName) return
  const raw  = qualName.text.trim()
  if (!raw)  return
  const fqcn = prefix ? `${prefix}\\${raw}` : raw

  // tree-sitter-php puts `as <name>` as direct children of namespace_use_clause,
  // not wrapped in an alias_clause node.
  const asIdx    = children.findIndex((c) => c.type === "as")
  const aliasName = asIdx >= 0 ? children[asIdx + 1]?.text?.trim() : undefined
  const shortName = aliasName ?? lastSegment(fqcn)
  map.set(shortName, fqcn)
}

function gatherUseDecls(node: Parser.SyntaxNode, map: Map<string, string>): void {
  for (const child of node.children as Parser.SyntaxNode[]) {
    if (child.type === "namespace_use_declaration") {
      // Detect PHP 7+ grouped use: `use Ns\{A, B, C};`
      const group  = (child.children as Parser.SyntaxNode[]).find((c) => c.type === "namespace_use_group")
      const prefix = (child.children as Parser.SyntaxNode[]).find((c) => c.type === "namespace_name")?.text ?? ""

      if (group) {
        for (const sub of group.children as Parser.SyntaxNode[]) {
          if (sub.type === "namespace_use_clause") registerUseClause(sub, prefix, map)
        }
      } else {
        for (const sub of child.children as Parser.SyntaxNode[]) {
          if (sub.type === "namespace_use_clause") registerUseClause(sub, "", map)
        }
      }
    } else {
      gatherUseDecls(child, map)
    }
  }
}

function lastSegment(fqcn: string): string {
  return fqcn.split("\\").pop() ?? fqcn
}

// ---- Method finder ----------------------------------------------------



// ---- FormRequest extraction -------------------------------------------

function extractFormRequests(
  methodNode: Parser.SyntaxNode,
  useMap: Map<string, string>
): FormRequestParam[] {
  const results: FormRequestParam[] = []

  const paramsNode = methodNode.childForFieldName("parameters")
  if (!paramsNode) return results

  for (const param of paramsNode.children) {
    if (param.type !== "simple_parameter") continue

    const typeNode = param.childForFieldName("type")
    if (!typeNode) continue

    const typeName = typeNode.text.trim()

    // Skip bare Request (Illuminate's base request)
    if (SKIP_FQCN.has(typeName)) continue

    const fqcn = useMap.get(typeName) ?? typeName
    if (SKIP_FQCN.has(fqcn)) continue

    // Only include classes that look like FormRequests
    if (!typeName.endsWith("Request")) continue

    const varNode =
      param.childForFieldName("variable_name") ??
      param.childForFieldName("name") ??
      (param.children as Parser.SyntaxNode[]).find((c) => c.type === "variable_name")

    results.push({ shortName: typeName, fqcn, paramName: varNode?.text ?? "$request" })
  }

  return results
}

// ---- Model param extraction (route-model-binding) --------------------
// Suffixes that indicate service/infrastructure classes, not Eloquent models.
const SERVICE_LIKE_SUFFIXES = new Set([
  "Service", "Repository", "Manager", "Provider", "Factory",
  "Contract", "Interface", "Middleware", "Policy", "Gate",
  "Guard", "Controller", "Handler", "Listener", "Job", "Event",
  "Mailer", "Notification", "Resource", "Transformer",
])

function extractModelParams(
  methodNode: Parser.SyntaxNode,
  useMap: Map<string, string>
): ModelParam[] {
  const results: ModelParam[] = []
  const paramsNode = methodNode.childForFieldName("parameters")
  if (!paramsNode) return results

  for (const param of paramsNode.children as Parser.SyntaxNode[]) {
    if (param.type !== "simple_parameter") continue
    const typeNode = param.childForFieldName("type")
    const varNode  = (param.children as Parser.SyntaxNode[]).find(
      (c) => c.type === "variable_name"
    )
    if (!typeNode || !varNode) continue

    const typeName = typeNode.text.trim()
    if (!typeName || typeName[0] !== typeName[0].toUpperCase() || typeName[0] === typeName[0].toLowerCase()) continue
    if (SKIP_FQCN.has(typeName)) continue
    if (typeName.endsWith("Request")) continue

    const suffix = typeName.replace(/.*([A-Z][a-z]+)$/, "$1")
    if (SERVICE_LIKE_SUFFIXES.has(suffix)) continue

    const classFqcn = useMap.get(typeName) ?? typeName
    if (SKIP_FQCN.has(classFqcn)) continue

    const bodyText = methodNode.childForFieldName("body")?.text ?? ""
    const usedInBody = new RegExp(`\\${varNode.text}\\b`).test(bodyText)
    results.push({ className: typeName, classFqcn, paramName: varNode.text, usedInBody })
  }

  return results
}

// ---- authorize() extraction -------------------------------------------

function extractAuthorizeCalls(methodNode: Parser.SyntaxNode, modelParams: ModelParam[]): AuthorizeCall[] {
  const results: AuthorizeCall[] = []
  const body = methodNode.childForFieldName("body")
  if (!body) return results
  gatherAuthorizeCalls(body, results, modelParams)
  return results
}

// Gate facade methods that resolve an ability (policy or Gate::define)
const GATE_METHODS = new Set(["authorize", "allows", "check", "denies", "any", "none", "inspect"])

// $this->helper(...) names that perform an authorization check, e.g.
// BookStack's checkOwnablePermission() / checkPermission(), ensureCanEdit(),
// authorizeOwner(). Plain "authorize" is the policy call handled above.
const SELF_HELPER_RE =
  /^(authorize\w+|check\w*(permission|access|abilit|role|owner|admin|can)\w*|ensure\w*(permission|access|can|owner|role|admin|allowed|authori)\w*|require\w*(permission|role|admin|owner|access)\w*|deny\w*|abortUnless\w*|abortIf(Not|Cannot)\w*)$/i

// ->method(...) on any object: $request->user()->can('x'), Gate::forUser($u)->allows(...),
// spatie/laravel-permission's hasPermissionTo / hasRole.
const MEMBER_CHECK_METHODS = new Set([
  "can", "cannot", "cant", "allows", "denies",
  "hasPermissionTo", "hasPermission", "hasAnyPermission", "hasAllPermissions", "checkPermissionTo",
  "hasRole", "hasAnyRole", "hasAllRoles", "isAdmin", "isSuperAdmin", "isOwner", "isOwnerOf",
])

const SELF_WRITE_METHODS = new Set(["delete", "update", "save", "create", "updateOrCreate", "forceDelete", "attach", "detach", "sync", "toggle"])
// current user, optionally followed by ONE relation call: group 2 = relation name
const CALLER_CHAIN_RE = /^(\$request->user\(\)|auth\(\)->user\(\)|Auth::user\(\)|\$this->user\(\)|request\(\)->user\(\))(?:\s*->\s*(\w+)\s*\(\))?/
const SHARED_PARENT_RE = /^(company|companies|account|team|teams|organi[sz]ation|tenant|workspace|vault|vaults|group|project|currentTeam)$/i
// An expression that yields the caller: auth()->user(), auth()->guard('x')->user(), $request->user(), Auth::id()…
const CALLER_EXPR_RE = /auth\(\)(->guard\([^)]*\))?->(user|id)\(\)|Auth::(user|id)\(\)|\$request->user\(\)|request\(\)->user\(\)|\$this->user\(\)/
const SHARED_KEY_RE = /^(company|account|team|tenant|organi[sz]ation|workspace|group|project)_id$/

// Global helper functions that check permissions (BookStack's userCan()).
const FUNCTION_HELPER_RE = /^(userCan\w*|user_can|authorize\w*|check\w*Permission\w*)$/

function gatherAuthorizeCalls(node: Parser.SyntaxNode, results: AuthorizeCall[], modelParams: ModelParam[]): void {
  if (node.type === "member_call_expression") {
    const obj  = node.childForFieldName("object")
    const name = node.childForFieldName("name")?.text
    if (obj?.text === "$this" && (name === "authorize" || name === "authorizeForUser")) {
      // $this->authorize('ability', $model) — a policy lookup
      pushAuthorizeCall(node, results, modelParams, "policy", name === "authorizeForUser" ? 1 : 0)
    } else if (obj?.text === "$this" && name && SELF_HELPER_RE.test(name) && name !== "authorizeResource") {
      pushAuthorizeCall(node, results, modelParams, "helper", 0, name)
    } else if (obj?.text !== "$this" && name && MEMBER_CHECK_METHODS.has(name)) {
      pushAuthorizeCall(node, results, modelParams, "helper", 0, name)
    }
  }

  // Gate::authorize('ability', $model), Gate::allows / denies / check / any / none / inspect
  // tree-sitter-php uses "scoped_call_expression" with field "scope" for the class
  if (node.type === "scoped_call_expression") {
    const cls    = node.childForFieldName("scope")
    const method = node.childForFieldName("name")
    if (cls?.text === "Gate" && method && GATE_METHODS.has(method.text)) {
      pushAuthorizeCall(node, results, modelParams, "policy", 0)
    }
  }

  if (node.type === "function_call_expression") {
    const fn = node.childForFieldName("function")?.text
    if (fn && FUNCTION_HELPER_RE.test(fn)) {
      pushAuthorizeCall(node, results, modelParams, "helper", 0, fn)
    }
  }

  // A query filtered on the caller's own key — `->whereClientId(auth()->guard('contact')
  // ->user()->client_id)` (invoiceninja client portal), `->where('user_id', auth()->id())`
  // — returns only the caller's rows. Filtering on a SHARED key (company_id, account_id,
  // team_id…) does not: other users/clients of the same company still match.
  if (node.type === "member_call_expression") {
    const name = node.childForFieldName("name")?.text ?? ""
    const args = node.childForFieldName("arguments")?.text ?? ""
    const col = /^where[A-Z]\w*Id$/.test(name)
      ? name.slice(5).replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()       // whereClientId → client_id
      : name === "where" ? (args.match(/^\(\s*['"]([\w.]+)['"]/)?.[1]?.split(".").pop() ?? "") : ""
    if (col && /_id$/.test(col) && CALLER_EXPR_RE.test(args) && !SHARED_KEY_RE.test(col)) {
      results.push({
        ability:   col,
        mechanism: node.text.slice(0, 160),
        kind:      "helper",
        helper:    "query scoped to caller",
      })
    }
  }

  // A write that goes through the caller's own record can only touch that
  // caller's data: `$request->user()->userTokens()->where(...)->delete()`
  // (monica), `auth()->user()->update([...])`. Shared parents — the caller's
  // company / account / team — are excluded: writing there still needs a role check.
  if (node.type === "member_call_expression") {
    const name = node.childForFieldName("name")?.text
    if (name && SELF_WRITE_METHODS.has(name)) {
      const m = node.text.match(CALLER_CHAIN_RE)
      if (m && !SHARED_PARENT_RE.test(m[2] ?? "")) {
        results.push({
          ability:   m[2] ? `${m[2]}()->${name}` : name,
          mechanism: node.text.slice(0, 160),
          kind:      "helper",
          helper:    "scoped to caller",
        })
      }
    }
  }

  for (const child of node.children as Parser.SyntaxNode[]) {
    gatherAuthorizeCalls(child, results, modelParams)
  }
}

function pushAuthorizeCall(
  node: Parser.SyntaxNode,
  results: AuthorizeCall[],
  modelParams: ModelParam[],
  kind: "policy" | "helper",
  abilityIndex: number,
  helper?: string,
): void {
  const argsNode = node.childForFieldName("arguments")
  const argValues = argsNode
    ? (argsNode.children as Parser.SyntaxNode[])
        .filter((c) => c.type === "argument")
        .map((c) => c.firstNamedChild)
        .filter((c): c is Parser.SyntaxNode => c !== null)
    : []
  const abilityNode = argValues[abilityIndex]
  // Helpers like isAdmin() take no ability argument — name the check by the helper itself
  const ability = abilityNode ? resolveStringNode(abilityNode) : (helper ?? "unknown")

  // The model the check targets: a typed route-model param passed as any later
  // argument ($this->authorize('update', $task)), or Model::class.
  let modelVar:   string | undefined
  let modelClass: string | undefined
  for (const arg of argValues.slice(abilityIndex + 1)) {
    if (arg.type === "variable_name") {
      const mp = modelParams.find((p) => p.paramName === arg.text)
      if (mp) { modelVar = mp.paramName; modelClass = mp.className; break }
    }
    if (arg.type === "class_constant_access_expression" && /::class$/.test(arg.text)) {
      modelClass = arg.text.replace(/::class$/, "").split("\\").pop()
      break
    }
  }

  results.push({
    ability,
    mechanism: node.text,
    modelVar,
    kind,
    ...(modelClass ? { modelClass } : {}),
    ...(helper ? { helper } : {}),
  })
}

// ---- authorizeResource() in the constructor ----------------------------

// Controller method → ability, as Laravel's AuthorizesRequests::resourceAbilityMap()
const RESOURCE_ABILITY_MAP: Record<string, string> = {
  index: "viewAny", show: "view", create: "create", store: "create",
  edit: "update", update: "update", destroy: "delete",
}

/**
 * `$this->authorizeResource(Post::class, 'post')` in __construct() authorizes
 * every resource method through PostPolicy (unless excluded via `['except' => …]`).
 */
function extractAuthorizeResource(
  root: Parser.SyntaxNode,
  methodName: string,
  modelParams: ModelParam[],
): AuthorizeCall[] {
  const ability = RESOURCE_ABILITY_MAP[methodName]
  if (!ability) return []
  const ctor = findMethod(root, "__construct")
  const body = ctor?.childForFieldName("body")
  if (!body) return []

  const found: AuthorizeCall[] = []
  const walk = (node: Parser.SyntaxNode): void => {
    if (node.type === "member_call_expression") {
      const obj  = node.childForFieldName("object")
      const name = node.childForFieldName("name")
      if (obj?.text === "$this" && name?.text === "authorizeResource") {
        const text = node.text
        const except = text.match(/['"]except['"]\s*=>\s*\[([^\]]*)\]/)
        const only   = text.match(/['"]only['"]\s*=>\s*\[([^\]]*)\]/)
        const listed = (m: RegExpMatchArray | null) => (m?.[1] ?? "").includes(`'${methodName}'`) || (m?.[1] ?? "").includes(`"${methodName}"`)
        if (except && listed(except)) return
        if (only && !listed(only)) return
        const classArg = text.match(/authorizeResource\(\s*([\w\\]+)::class/)
        const modelClass = classArg?.[1]?.split("\\").pop()
        const mp = modelParams.find((p) => p.className === modelClass)
        found.push({
          ability,
          mechanism: text,
          kind: "policy",
          ...(modelClass ? { modelClass } : {}),
          ...(mp ? { modelVar: mp.paramName } : {}),
        })
        return
      }
    }
    for (const child of node.children as Parser.SyntaxNode[]) walk(child)
  }
  walk(body)
  return found
}

// ---- Private method call extraction ----------------------------------
// Finds $this->methodName() calls (direct, not through a property chain).
// These are candidates for depth-1 traversal into the same class.

function extractPrivateMethodCallNames(methodNode: Parser.SyntaxNode): string[] {
  const names = new Set<string>()
  const body = methodNode.childForFieldName("body")
  if (!body) return []
  gatherPrivateMethodCallNames(body, names)
  return Array.from(names)
}

function gatherPrivateMethodCallNames(node: Parser.SyntaxNode, names: Set<string>): void {
  if (node.type === "member_call_expression") {
    const objNode  = node.childForFieldName("object")
    const nameNode = node.childForFieldName("name")
    // $this->method() — object is "$this" directly (not a property chain)
    if (objNode?.text === "$this" && nameNode) {
      names.add(nameNode.text)
    }
  }
  for (const child of node.children as Parser.SyntaxNode[]) {
    gatherPrivateMethodCallNames(child, names)
  }
}

function resolveStringNode(node: Parser.SyntaxNode): string {
  if (node.type === "string") {
    const content = (node.children as Parser.SyntaxNode[]).find((c) => c.type === "string_content")
    return content?.text ?? node.text.slice(1, -1)
  }
  return node.text
}

// ---- Constructor middleware extraction --------------------------------

/**
 * Parse $this->middleware() calls from the __construct() body.
 *
 * Handles:
 *   $this->middleware('auth:web')
 *   $this->middleware('auth:web,subdealer', ['except' => ['login']])
 *   $this->middleware('auth:api', ['only' => ['store']])
 *
 * Note: method-chaining form ($this->middleware('auth')->except([...]))
 * is not yet supported — treated as middleware with no filters.
 */
function gatherConstructorMiddleware(root: Parser.SyntaxNode): ConstructorMiddleware[] {
  const constructNode = findMethod(root, "__construct")
  if (!constructNode) return []
  const body = constructNode.childForFieldName("body")
  if (!body) return []

  const results: ConstructorMiddleware[] = []
  collectMiddlewareCalls(body, results)
  return results
}

function collectMiddlewareCalls(node: Parser.SyntaxNode, results: ConstructorMiddleware[]): void {
  if (node.type === "member_call_expression") {
    const obj  = node.childForFieldName("object")
    const name = node.childForFieldName("name")

    if (obj?.text === "$this" && name?.text === "middleware") {
      const argsNode = node.childForFieldName("arguments")
      if (argsNode) {
        const argList = (argsNode.children as Parser.SyntaxNode[]).filter(
          (c) => c.type === "argument"
        )
        if (argList.length >= 1) {
          const firstVal = argList[0].firstNamedChild
          if (firstVal) {
            const raw = resolveStringNode(firstVal)
            if (raw) {
              let except: string[] = []
              let only:   string[] = []

              if (argList.length >= 2) {
                const secondVal = argList[1].firstNamedChild
                if (secondVal?.type === "array_creation_expression") {
                  for (const elem of secondVal.namedChildren as Parser.SyntaxNode[]) {
                    if (elem.type !== "array_element_initializer") continue
                    // namedChildren: [key_string, value_array] (=> token is anonymous)
                    const named = elem.namedChildren as Parser.SyntaxNode[]
                    if (named.length < 2) continue
                    const key = resolveStringNode(named[0])
                    const valNode = named[1]
                    if (valNode.type === "array_creation_expression") {
                      const vals = extractStringArrayValues(valNode)
                      if (key === "except") except = vals
                      else if (key === "only") only = vals
                    }
                  }
                }
              }

              // $this->middleware('auth')->only(['edit']) / ->except('index')
              const parent = node.parent
              if (parent?.type === "member_call_expression") {
                const chained = parent.childForFieldName("name")?.text
                const chainArgs = parent.childForFieldName("arguments")
                if ((chained === "only" || chained === "except") && chainArgs) {
                  const vals = [...chainArgs.text.matchAll(/['"]([\w-]+)['"]/g)].map((m) => m[1]!)
                  if (chained === "only") only = vals
                  else except = vals
                }
              }

              // An array of middleware: one entry each. Non-literal entries such as
              // BookStack's `Permission::SettingsManage->middleware()` (an enum that
              // returns 'can:settings-manage') are kept as a `can:` check rather than
              // dropped — they are authorization middleware by construction.
              const raws = firstVal.type === "array_creation_expression"
                ? (firstVal.namedChildren as Parser.SyntaxNode[])
                    .filter((e) => e.type === "array_element_initializer")
                    .map((e) => e.firstNamedChild)
                    .filter((v): v is Parser.SyntaxNode => v !== null)
                    .map((v) => (v.type === "string" || v.type === "encapsed_string")
                      ? resolveStringNode(v)
                      : /->middleware\(\)|Permission|Role|Ability/.test(v.text) ? `can:${v.text}` : v.text)
                : [raw]
              for (const r of raws) if (r) results.push({ raw: r, except, only })
            }
          }
        }
      }
    }
  }

  for (const child of node.children as Parser.SyntaxNode[]) {
    collectMiddlewareCalls(child, results)
  }
}

// ---- Standalone dispatch extraction (18B.2) --------------------------

const THIS_DISPATCH_METHODS = new Set(["dispatch", "dispatchSync", "dispatchNow", "dispatchAfterResponse"])

/**
 * Detect Job::dispatch() / event(new Event()) / dispatch(new Job()) calls
 * in a method body, EXCLUDING those inside DB::transaction() closures
 * (those are already captured as ir:txn_escape nodes by transaction-parser).
 */
function extractStandaloneDispatches(
  methodNode: Parser.SyntaxNode,
  useMap: Map<string, string>
): StandaloneDispatch[] {
  const body = methodNode.childForFieldName("body")
  if (!body) return []
  const results: StandaloneDispatch[] = []
  gatherStandaloneDispatches(body, useMap, results)
  return results
}

function gatherStandaloneDispatches(
  node: Parser.SyntaxNode,
  useMap: Map<string, string>,
  results: StandaloneDispatch[]
): void {
  // Skip DB::transaction() closures — those are handled by transaction-parser
  if (node.type === "scoped_call_expression") {
    const cls  = (node.children as Parser.SyntaxNode[])[0]
    const name = node.childForFieldName("name")
    const clsText = cls?.text.replace(/^\\/, "") ?? ""
    if (clsText === "DB" && name?.text === "transaction") return

    // Bus::dispatch() / Bus::dispatchSync() / Bus::dispatchNow() — the dispatched
    // class is the call argument, not "Bus" itself (unlike Job::dispatch()).
    if (clsText === "Bus" && name && THIS_DISPATCH_METHODS.has(name.text)) {
      const arg = firstArgClassName(node, useMap)
      if (arg) {
        results.push(arg)
        return
      }
    }

    // ClassName::dispatch()/dispatchSync()/dispatchNow() — static dispatch (Job/Action classes)
    // ClassName::run() — laravel-actions execute-inline pattern
    if (clsText && clsText !== "DB" && clsText !== "Bus" && name && (THIS_DISPATCH_METHODS.has(name.text) || name.text === "run")) {
      const fqcn = useMap.get(clsText) ?? clsText
      results.push({ className: clsText, fqcn, kind: classifyDispatch(fqcn), callText: node.text })
      return
    }
  }

  // $this->dispatch(new Job()) / $this->dispatchSync() / $this->dispatchNow() — DispatchesJobs trait
  if (node.type === "member_call_expression") {
    const obj  = node.childForFieldName("object")
    const name = node.childForFieldName("name")
    if (obj?.text === "$this" && name && THIS_DISPATCH_METHODS.has(name.text)) {
      const arg = firstArgClassName(node, useMap)
      if (arg) {
        results.push(arg)
        return
      }
    }
  }

  // dispatch(new ClassName()) — global function helper
  if (node.type === "function_call_expression") {
    const fn = node.childForFieldName("function")
    if (fn?.text === "dispatch" || fn?.text === "event") {
      const arg = firstArgClassName(node, useMap)
      if (arg) {
        results.push(arg)
        return
      }
    }
  }

  for (const child of node.children as Parser.SyntaxNode[]) {
    gatherStandaloneDispatches(child, useMap, results)
  }
}

function firstArgClassName(
  callNode: Parser.SyntaxNode,
  useMap: Map<string, string>
): StandaloneDispatch | null {
  const argsNode = callNode.childForFieldName("arguments")
  if (!argsNode) return null
  for (const arg of argsNode.children as Parser.SyntaxNode[]) {
    if (arg.type !== "argument") continue
    const val = arg.firstNamedChild
    // new ClassName(...) — most common
    if (val?.type === "object_creation_expression") {
      const clsNode = val.childForFieldName("class") ?? val.namedChildren[0]
      const clsText = clsNode?.text.replace(/^\\/, "") ?? ""
      if (!clsText) continue
      const fqcn = useMap.get(clsText) ?? clsText
      return { className: clsText, fqcn, kind: classifyDispatch(fqcn), callText: callNode.text }
    }
    // ClassName::staticFactory(...) — e.g. RegisterUser::fromRequest($req)
    if (val?.type === "scoped_call_expression") {
      const scope   = (val.children as Parser.SyntaxNode[])[0]
      const clsText = scope?.text.replace(/^\\/, "") ?? ""
      if (clsText && clsText !== "DB" && clsText !== "Bus") {
        const fqcn = useMap.get(clsText) ?? clsText
        return { className: clsText, fqcn, kind: classifyDispatch(fqcn), callText: callNode.text }
      }
    }
  }
  return null
}

function extractStringArrayValues(arrayNode: Parser.SyntaxNode): string[] {
  const results: string[] = []
  for (const elem of arrayNode.namedChildren as Parser.SyntaxNode[]) {
    if (elem.type !== "array_element_initializer") continue
    const named = elem.namedChildren as Parser.SyntaxNode[]
    // Simple value (no key): namedChildren has exactly 1 element
    if (named.length === 1 && named[0].type === "string") {
      results.push(resolveStringNode(named[0]))
    }
  }
  return results
}

// ---- Constructor injection extraction --------------------------------

/**
 * Parse __construct parameters to build propertyName → FQCN map.
 * Handles PHP 8 constructor promotion (private/public/protected modifiers).
 */
function extractConstructorInjections(
  root: Parser.SyntaxNode,
  useMap: Map<string, string>
): Map<string, string> {
  const constructNode = findMethod(root, "__construct")
  if (!constructNode) return new Map()

  const paramsNode = constructNode.childForFieldName("parameters")
  if (!paramsNode) return new Map()

  const map = new Map<string, string>()

  for (const param of paramsNode.children as Parser.SyntaxNode[]) {
    // Works for simple_parameter and property_promotion_parameter
    const typeNode = param.childForFieldName("type")
    const varNode  = (param.children as Parser.SyntaxNode[]).find(
      (c) => c.type === "variable_name"
    )
    if (!typeNode || !varNode) continue

    const typeName = typeNode.text.trim()

    // Skip primitive and framework base types
    if (!typeName || typeName[0] === typeName[0].toLowerCase()) continue
    if (["Request", "Closure", "Response"].includes(typeName)) continue

    const fqcn    = useMap.get(typeName) ?? typeName
    const varName = varNode.text.replace(/^\$/, "")
    map.set(varName, fqcn)
  }

  return map
}

/**
 * Extract typed non-primitive method parameters as varName → FQCN injections.
 * Handles patterns like: public function store(OrderService $orderService, ...)
 */
function extractMethodParamInjections(
  methodNode: Parser.SyntaxNode,
  useMap: Map<string, string>
): Map<string, string> {
  const map = new Map<string, string>()
  const paramsNode = methodNode.childForFieldName("parameters")
  if (!paramsNode) return map

  for (const param of paramsNode.children as Parser.SyntaxNode[]) {
    if (param.type !== "simple_parameter") continue
    const typeNode = param.childForFieldName("type")
    const varNode  = (param.children as Parser.SyntaxNode[]).find(
      (c) => c.type === "variable_name"
    )
    if (!typeNode || !varNode) continue

    const typeName = typeNode.text.trim()
    if (!typeName || typeName[0] === typeName[0].toLowerCase()) continue
    if (["Request", "Closure", "Response"].includes(typeName)) continue
    // Skip FormRequest subclasses (already handled by extractFormRequests)
    if (typeName.endsWith("Request")) continue

    const fqcn    = useMap.get(typeName) ?? typeName
    const varName = varNode.text.replace(/^\$/, "")
    map.set(varName, fqcn)
  }

  return map
}

// ---- Service call extraction -----------------------------------------

function extractServiceCalls(
  methodNode: Parser.SyntaxNode,
  injections: Map<string, string>,
  _useMap: Map<string, string>,
  requestParamVars: Map<string, string> = new Map()
): ServiceCall[] {
  const results: ServiceCall[] = []
  const body = methodNode.childForFieldName("body")
  if (!body) return results
  gatherServiceCalls(body, injections, results, requestParamVars, _useMap)
  return results
}

// Terminal mutating calls chained onto a relationship accessor / injected
// service (e.g. $user->apiTokens()->delete()) must be folded into the base
// call's node instead of dropped — see IR v1.5 plan, Phase 2.
const MUTATING_METHODS = new Set([
  "delete", "update", "save", "create", "attach", "detach", "sync", "forceDelete",
])

// Scans a call's argument list for a variable_name argument that matches a
// request-derived var (IR v1.5 Phase 6, cross-method extension) and returns
// its position + the originating request parameter name, if any.
function findRequestParamArg(
  argsNode: Parser.SyntaxNode | null,
  requestParamVars: Map<string, string>
): { position: number; requestParamName: string } | undefined {
  if (!argsNode || requestParamVars.size === 0) return undefined
  const argNodes = (argsNode.children as Parser.SyntaxNode[]).filter((c) => c.type === "argument")
  for (let i = 0; i < argNodes.length; i++) {
    const val = argNodes[i].firstNamedChild
    if (val?.type !== "variable_name") continue
    const varName = val.text.replace(/^\$/, "")
    const requestParamName = requestParamVars.get(varName)
    if (requestParamName) return { position: i, requestParamName }
  }
  return undefined
}

// Matches a member_call_expression against Pattern 1 ($this->prop->method(args))
// or Pattern 2 ($localVar->method(args)) and returns the resolved ServiceCall,
// without pushing it to any results array.
function tryExtractBaseServiceCall(
  callNode: Parser.SyntaxNode,
  injections: Map<string, string>,
  requestParamVars: Map<string, string> = new Map(),
  useMap: Map<string, string> = new Map()
): ServiceCall | null {
  const objNode  = callNode.childForFieldName("object")
  const nameNode = callNode.childForFieldName("name")
  if (!nameNode) return null

  // Pattern 1: $this->propertyName->method(args)
  if (objNode?.type === "member_access_expression") {
    const innerObj = objNode.childForFieldName("object")
    const propNode = objNode.childForFieldName("name")

    if (innerObj?.text === "$this" && propNode) {
      const prop = propNode.text
      const fqcn = injections.get(prop)

      if (fqcn) {
        const shortName  = fqcn.split("\\").pop() ?? fqcn
        const argsNode   = callNode.childForFieldName("arguments")
        const stringArgs = argsNode ? extractStringCallArgs(argsNode) : []
        const requestParamArg = findRequestParamArg(argsNode, requestParamVars)

        return {
          propertyName: prop,
          serviceClass: shortName,
          serviceFqcn:  fqcn,
          method:       nameNode.text,
          args:         stringArgs,
          ...(requestParamArg ? { requestParamArg } : {}),
        }
      }
    }
  }

  // Pattern 2: $localVar->method(args) — method-injected service or model param
  if (objNode?.type === "variable_name") {
    const varName = objNode.text.replace(/^\$/, "")
    const fqcn    = injections.get(varName)

    if (fqcn) {
      const shortName  = fqcn.split("\\").pop() ?? fqcn
      const argsNode   = callNode.childForFieldName("arguments")
      const stringArgs = argsNode ? extractStringCallArgs(argsNode) : []
      const requestParamArg = findRequestParamArg(argsNode, requestParamVars)

      return {
        propertyName: varName,
        serviceClass: shortName,
        serviceFqcn:  fqcn,
        method:       nameNode.text,
        args:         stringArgs,
        ...(requestParamArg ? { requestParamArg } : {}),
      }
    }
  }

  // Pattern 3: (new UpdateVault)->execute($data) — a service built inline
  // (monica's action/service classes). Only project classes imported via `use`
  // count, so (new Carbon)->… and the like stay out.
  const created = objNode?.type === "parenthesized_expression" ? objNode.firstNamedChild : objNode
  if (created?.type === "object_creation_expression") {
    const clsNode = (created.namedChildren as Parser.SyntaxNode[]).find(
      (c) => c.type === "name" || c.type === "qualified_name"
    )
    const short = clsNode?.text.replace(/^\\/, "").split("\\").pop()
    const fqcn  = short ? useMap.get(short) : undefined
    if (short && fqcn && !/^(Illuminate|Carbon|Symfony|GuzzleHttp)\\/.test(fqcn)) {
      const argsNode   = callNode.childForFieldName("arguments")
      const stringArgs = argsNode ? extractStringCallArgs(argsNode) : []
      const requestParamArg = findRequestParamArg(argsNode, requestParamVars)
      return {
        propertyName: `new ${short}`,
        serviceClass: short,
        serviceFqcn:  fqcn,
        method:       nameNode.text,
        args:         stringArgs,
        ...(requestParamArg ? { requestParamArg } : {}),
      }
    }
  }

  return null
}

/** Whether two tree-sitter nodes are the same node of the same tree (wrapper objects may differ). */
function sameNode(a: Parser.SyntaxNode, b: Parser.SyntaxNode): boolean {
  return a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type
}

function gatherServiceCalls(
  node: Parser.SyntaxNode,
  injections: Map<string, string>,
  results: ServiceCall[],
  requestParamVars: Map<string, string> = new Map(),
  useMap: Map<string, string> = new Map()
): void {
  if (node.type === "member_call_expression") {
    const objNode  = node.childForFieldName("object")
    const nameNode = node.childForFieldName("name")

    if (nameNode) {
      // Terminal mutating call chained onto a resolvable base, e.g.
      // $user->apiTokens()->delete() — fold into one node instead of dropping
      // the mutation or double-emitting the base accessor separately.
      if (objNode?.type === "member_call_expression" && MUTATING_METHODS.has(nameNode.text)) {
        const base = tryExtractBaseServiceCall(objNode, injections, requestParamVars, useMap)
        if (base) {
          results.push({
            ...base,
            method:  `${base.method}()->${nameNode.text}`,
            mutates: true,
          })
          // objNode is fully consumed by the combined node above — recurse
          // into the rest of the chain but skip re-visiting it standalone.
          // Compared by position, not `!==`: tree-sitter does not guarantee
          // one JS object per node (it depends on its node cache and on GC),
          // so identity made the base accessor show up again in some runs.
          for (const child of node.children as Parser.SyntaxNode[]) {
            if (!sameNode(child, objNode)) gatherServiceCalls(child, injections, results, requestParamVars, useMap)
          }
          return
        }
      }

      const base = tryExtractBaseServiceCall(node, injections, requestParamVars, useMap)
      if (base) results.push(base)
    }
  }

  for (const child of node.children as Parser.SyntaxNode[]) {
    gatherServiceCalls(child, injections, results, requestParamVars, useMap)
  }
}

function extractStringCallArgs(argsNode: Parser.SyntaxNode): string[] {
  return (argsNode.children as Parser.SyntaxNode[])
    .filter((c) => c.type === "argument")
    .flatMap((c) => {
      const val = c.firstNamedChild
      if (!val) return []
      if (val.type === "string") {
        const content = (val.children as Parser.SyntaxNode[]).find(
          (sc) => sc.type === "string_content"
        )
        return content?.text ? [content.text] : []
      }
      return []
    })
}

// ---- Control-flow branch extraction (IR v1.5 Phase 6, narrow cut) -----
//
// Detects the specific pattern: a request parameter
// ($request->input()/->has()/->boolean()) assigned to a variable, then that
// variable driving an if/else whose branches call different, resolvable
// service methods. Deliberately narrow — does not attempt general CFG/SSA
// modeling (see the plan's "what this phase does not do").

const REQUEST_INPUT_METHODS = new Set(["input", "has", "boolean"])

function gatherConditionalBranchesFromVars(
  methodNode: Parser.SyntaxNode,
  requestParamVars: Map<string, string>,
  injections: Map<string, string>
): ConditionalBranch[] {
  const body = methodNode.childForFieldName("body")
  if (!body) return []

  const branches: ConditionalBranch[] = []
  gatherConditionalBranches(body, requestParamVars, injections, branches)
  return branches
}

// Finds `$var = $request->input('name', ...)` (or ->has()/->boolean()) and
// records var name -> request parameter name.
function collectRequestParamVars(node: Parser.SyntaxNode, out: Map<string, string>): void {
  if (node.type === "assignment_expression") {
    const left  = node.childForFieldName("left")
    const right = node.childForFieldName("right")

    if (left?.type === "variable_name" && right?.type === "member_call_expression") {
      const objNode  = right.childForFieldName("object")
      const nameNode = right.childForFieldName("name")

      if (objNode?.type === "variable_name" && nameNode && REQUEST_INPUT_METHODS.has(nameNode.text)) {
        const argsNode = right.childForFieldName("arguments")
        const paramName = argsNode ? extractStringCallArgs(argsNode)[0] : undefined
        if (paramName) {
          out.set(left.text.replace(/^\$/, ""), paramName)
        }
      }
    }
  }

  for (const child of node.children as Parser.SyntaxNode[]) {
    collectRequestParamVars(child, out)
  }
}

function gatherConditionalBranches(
  node: Parser.SyntaxNode,
  requestParamVars: Map<string, string>,
  injections: Map<string, string>,
  branches: ConditionalBranch[]
): void {
  if (node.type === "if_statement") {
    const conditionNode = node.childForFieldName("condition")
    const conditionText = stripOuterParens(conditionNode?.text ?? "")

    const matchedVar = [...requestParamVars.keys()].find((v) => conditionText.includes(`$${v}`))

    if (matchedVar) {
      const paramName  = requestParamVars.get(matchedVar)!
      const thenBody   = node.childForFieldName("body")
      const altNode    = node.childForFieldName("alternative")
      const elseBody   = altNode?.type === "else_clause" ? altNode.childForFieldName("body") : altNode

      const thenCalls: ServiceCall[] = []
      const elseCalls: ServiceCall[] = []
      if (thenBody) gatherServiceCalls(thenBody, injections, thenCalls)
      if (elseBody) gatherServiceCalls(elseBody, injections, elseCalls)

      branches.push({ conditionText, paramName, thenCalls, elseCalls })
    }
  }

  for (const child of node.children as Parser.SyntaxNode[]) {
    gatherConditionalBranches(child, requestParamVars, injections, branches)
  }
}

function stripOuterParens(text: string): string {
  const m = text.match(/^\((.*)\)$/s)
  return m ? m[1] : text
}

/**
 * Cross-method extension of Phase 6's narrow cut: when a controller reads a
 * request parameter and passes it as an argument to a directly-called
 * service method (e.g. BookStack's
 * `UserApiController::delete` -> `$this->userRepo->destroy($user, $newOwnerId)`
 * where `$newOwnerId` came from `$request->input('migrate_ownership_id')`),
 * the actual if/else often lives one hop away, inside the callee, keyed off
 * its own parameter name rather than a `$request->input()` call the callee
 * never makes. This resolves the callee's parameter name at `argPosition`
 * and looks for an if/else branching on it, same shape as the same-method
 * case but seeded from the caller's request-param name instead of a local
 * `$request->input()` assignment.
 *
 * Still a narrow, single-hop cut — does not chase the value through further
 * calls if the callee re-passes it onward again.
 */
export function detectParamDrivenBranch(
  filePath: string,
  methodName: string,
  argPosition: number,
  requestParamName: string
): ConditionalBranch | null {
  const parsed = parsePhpFile(_parser, filePath)
  if (!parsed) return null
  const { source, tree } = parsed
  const root = tree.rootNode
  const methodNode = findMethod(root, methodName)
  if (!methodNode) return null

  const paramsNode = methodNode.childForFieldName("parameters")
  if (!paramsNode) return null
  const params = (paramsNode.children as Parser.SyntaxNode[]).filter(
    (c) => c.type === "simple_parameter" || c.type === "property_promotion_parameter"
  )
  const targetParam = params[argPosition]
  if (!targetParam) return null
  const varNode = (targetParam.children as Parser.SyntaxNode[]).find((c) => c.type === "variable_name")
  if (!varNode) return null
  const paramVarName = varNode.text.replace(/^\$/, "")

  const useMap = extractUseMap(root)
  const injections = extractConstructorInjections(root, useMap)
  const methodInjections = extractMethodParamInjections(methodNode, useMap)
  const allInjections = new Map([...injections, ...methodInjections])

  const seededVars = new Map<string, string>([[paramVarName, requestParamName]])
  const branches: ConditionalBranch[] = []
  gatherConditionalBranches(methodNode, seededVars, allInjections, branches)
  return branches[0] ?? null
}

// ---- Notification + Mail dispatch extraction (18B.3) -----------------

function extractNotificationDispatches(
  methodNode: Parser.SyntaxNode,
  useMap: Map<string, string>
): NotificationDispatch[] {
  const body = methodNode.childForFieldName("body")
  if (!body) return []
  const results: NotificationDispatch[] = []
  gatherNotificationDispatches(body, useMap, results)
  return results
}

function gatherNotificationDispatches(
  node: Parser.SyntaxNode,
  useMap: Map<string, string>,
  results: NotificationDispatch[]
): void {
  if (node.type === "scoped_call_expression") {
    const cls  = node.childForFieldName("scope")
    const name = node.childForFieldName("name")
    const clsText = cls?.text.replace(/^\\/, "") ?? ""

    // Notification::send($notifiable, new FooNotification())
    if (clsText === "Notification" && name?.text === "send") {
      const argsNode = node.childForFieldName("arguments")
      const argList  = (argsNode?.children as Parser.SyntaxNode[] ?? []).filter(c => c.type === "argument")
      const notifArg = argList[1]?.firstNamedChild
      if (notifArg?.type === "object_creation_expression") {
        const entry = objCreationToDispatch(notifArg, useMap, "notification", false, node.text)
        if (entry) { results.push(entry); return }
      }
    }

    // Mail::queue(new FooMail()) or Mail::send(new FooMail())
    if (clsText === "Mail" && (name?.text === "queue" || name?.text === "send")) {
      const entry = firstArgToDispatch(node, useMap, "mail", name.text === "queue")
      if (entry) { results.push(entry); return }
    }
  }

  if (node.type === "member_call_expression") {
    const name = node.childForFieldName("name")

    // $user->notify(new FooNotification()) or $user->notifyNow(...)
    if (name?.text === "notify" || name?.text === "notifyNow") {
      const entry = firstArgToDispatch(node, useMap, "notification", false)
      if (entry) { results.push(entry); return }
    }

    // Mail::to(...)->send(new FooMail()) or ->queue(new FooMail())
    if (name?.text === "send" || name?.text === "queue") {
      const obj = node.childForFieldName("object")
      if (isMailFluentChain(obj)) {
        const entry = firstArgToDispatch(node, useMap, "mail", name.text === "queue")
        if (entry) { results.push(entry); return }
      }
    }
  }

  for (const child of node.children as Parser.SyntaxNode[]) {
    gatherNotificationDispatches(child, useMap, results)
  }
}

function isMailFluentChain(node: Parser.SyntaxNode | null | undefined): boolean {
  if (!node) return false
  if (node.type === "scoped_call_expression") {
    const cls  = node.childForFieldName("scope")
    const name = node.childForFieldName("name")
    return (cls?.text.replace(/^\\/, "") === "Mail") &&
           (name?.text === "to" || name?.text === "cc" || name?.text === "bcc")
  }
  if (node.type === "member_call_expression") {
    return isMailFluentChain(node.childForFieldName("object"))
  }
  return false
}

function firstArgToDispatch(
  callNode: Parser.SyntaxNode,
  useMap: Map<string, string>,
  kind: "notification" | "mail",
  queued: boolean
): NotificationDispatch | null {
  const argsNode = callNode.childForFieldName("arguments")
  if (!argsNode) return null
  for (const arg of argsNode.children as Parser.SyntaxNode[]) {
    if (arg.type !== "argument") continue
    const val = arg.firstNamedChild
    if (val?.type === "object_creation_expression") {
      return objCreationToDispatch(val, useMap, kind, queued, callNode.text)
    }
  }
  return null
}

function objCreationToDispatch(
  creationNode: Parser.SyntaxNode,
  useMap: Map<string, string>,
  kind: "notification" | "mail",
  queued: boolean,
  callText: string
): NotificationDispatch | null {
  const clsNode = creationNode.childForFieldName("class") ?? creationNode.namedChildren[0]
  const clsText = clsNode?.text.replace(/^\\/, "") ?? ""
  if (!clsText) return null
  return { className: clsText, fqcn: useMap.get(clsText) ?? clsText, kind, queued, callText }
}
