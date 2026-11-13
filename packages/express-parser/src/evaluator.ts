import { Node, SyntaxKind, type SourceFile, type ParameterDeclaration, type CallExpression } from "ts-morph"
import { lookupName, type Binding } from "./scope.js"
import { relativePath, type ExpressProject } from "./project.js"

/**
 * What an expression can evaluate to, as far as routing is concerned. Evaluation
 * is demand-driven and returns every value an expression may have (a parameter
 * bound at several call sites, both arms of a conditional).
 */
export type Value =
  /** An Express app (`express()`) or router (`express.Router()`); `id` is its creation site. */
  | { kind: "router"; id: string; isApp: boolean; file: string; line: number }
  /** `router.route("/x")` and the verbs chained on it. */
  | { kind: "routeChain"; router: Extract<Value, { kind: "router" }>; paths: string[] }
  | { kind: "function"; node: Node; name: string | null }
  | { kind: "class"; node: Node }
  | { kind: "instance"; classNode: Node }
  /** A project file used as a value: a namespace import, or require() of a file without module.exports. */
  | { kind: "module"; file: SourceFile }
  /** An npm package or a member of one: "express", "express.Router", "passport.authenticate". */
  | { kind: "external"; name: string }
  /**
   * The result of calling a package member other than express itself:
   * `helmet()` → "helmet", `rateLimit({...})` → "express-rate-limit",
   * `body("email").isEmail()` → "express-validator.body" (methods called on
   * the result keep its name).
   */
  | { kind: "externalCall"; name: string }
  | { kind: "object"; node: Node }
  | { kind: "array"; node: Node }
  | { kind: "string"; value: string }

export type RouterValue = Extract<Value, { kind: "router" }>

/** Parameter → values, for evaluating inside a loop callback element by element. */
export type Env = ReadonlyMap<ParameterDeclaration, Value[]>
const EMPTY_ENV: Env = new Map()

const MAX_VALUES = 64
const MODULE_EXTENSIONS = ["", ".ts", ".js", ".mts", ".cts", ".mjs", ".cjs", "/index.ts", "/index.js", "/index.mjs", "/index.cjs"]

export class Evaluator {
  private readonly memo = new Map<Node, Value[]>()
  private readonly inProgress = new Set<Node>()
  private callSites: Map<Node, CallExpression[]> | null = null

  constructor(private readonly ep: ExpressProject) {}

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  evaluate(node: Node | undefined, env: Env = EMPTY_ENV): Value[] {
    if (!node) return []
    const cacheable = env.size === 0
    if (cacheable) {
      const cached = this.memo.get(node)
      if (cached) return cached
    }
    if (this.inProgress.has(node)) return []
    this.inProgress.add(node)
    let result: Value[]
    try {
      result = dedupe(this.evaluateUncached(node, env)).slice(0, MAX_VALUES)
    } finally {
      this.inProgress.delete(node)
    }
    if (cacheable) this.memo.set(node, result)
    return result
  }

  private evaluateUncached(node: Node, env: Env): Value[] {
    if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isNonNullExpression(node) ||
        Node.isTypeAssertion(node) || Node.isSatisfiesExpression(node) || Node.isAwaitExpression(node)) {
      return this.evaluate(node.getExpression(), env)
    }
    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
      return [{ kind: "string", value: node.getLiteralValue() }]
    }
    if (Node.isTemplateExpression(node)) return this.evaluateTemplate(node, env)
    if (Node.isBinaryExpression(node)) {
      const op = node.getOperatorToken().getKind()
      if (op === SyntaxKind.PlusToken) return concat(this.evaluate(node.getLeft(), env), this.evaluate(node.getRight(), env))
      if (op === SyntaxKind.BarBarToken || op === SyntaxKind.QuestionQuestionToken) {
        return [...this.evaluate(node.getLeft(), env), ...this.evaluate(node.getRight(), env)]
      }
      return []
    }
    if (Node.isConditionalExpression(node)) {
      return [...this.evaluate(node.getWhenTrue(), env), ...this.evaluate(node.getWhenFalse(), env)]
    }
    if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
      return [{ kind: "function", node, name: functionName(node) }]
    }
    if (Node.isFunctionDeclaration(node)) return [{ kind: "function", node, name: node.getName() ?? null }]
    if (Node.isClassDeclaration(node) || Node.isClassExpression(node)) return [{ kind: "class", node }]
    if (Node.isObjectLiteralExpression(node)) return [{ kind: "object", node }]
    if (Node.isArrayLiteralExpression(node)) return [{ kind: "array", node }]
    if (Node.isIdentifier(node)) return this.evaluateIdentifier(node, env)
    if (node.getKind() === SyntaxKind.ThisKeyword) {
      // `this` inside a class method: an instance of that class (static methods: the class)
      const cls = node.getFirstAncestor((a) => Node.isClassDeclaration(a) || Node.isClassExpression(a))
      if (!cls) return []
      const method = node.getFirstAncestor((a) => Node.isMethodDeclaration(a) || Node.isPropertyDeclaration(a))
      const isStatic = !!method && (Node.isMethodDeclaration(method) || Node.isPropertyDeclaration(method)) && method.isStatic()
      return [isStatic ? { kind: "class", node: cls } : { kind: "instance", classNode: cls }]
    }
    if (Node.isPropertyAccessExpression(node)) {
      return this.member(this.evaluate(node.getExpression(), env), node.getName(), env)
    }
    if (Node.isElementAccessExpression(node)) {
      const keys = this.evaluate(node.getArgumentExpression(), env).filter(isString)
      const objects = this.evaluate(node.getExpression(), env)
      return keys.flatMap((k) => this.member(objects, k.value, env))
    }
    if (Node.isCallExpression(node)) return this.evaluateCall(node, env)
    if (Node.isNewExpression(node)) {
      return this.evaluate(node.getExpression(), env).flatMap((v): Value[] => {
        if (v.kind === "class") return [{ kind: "instance", classNode: v.node }]
        if (v.kind === "external" && (v.name === "express.Router" || v.name === "express")) {
          return [this.newRouter(node, v.name === "express")]
        }
        return []
      })
    }
    return []
  }

  private evaluateTemplate(node: Node, env: Env): Value[] {
    if (!Node.isTemplateExpression(node)) return []
    let acc: Value[] = [{ kind: "string", value: node.getHead().getLiteralText() }]
    for (const span of node.getTemplateSpans()) {
      acc = concat(acc, this.evaluate(span.getExpression(), env))
      acc = concat(acc, [{ kind: "string", value: span.getLiteral().getLiteralText() }])
    }
    return acc
  }

  private evaluateIdentifier(node: Node, env: Env): Value[] {
    const name = node.getText()
    const binding = lookupName(node, name)
    return binding ? this.evaluateBinding(binding, env) : []
  }

  evaluateBinding(binding: Binding, env: Env = EMPTY_ENV): Value[] {
    switch (binding.kind) {
      case "var":
        return this.select(this.evaluate(binding.init, env), binding.path, env)
      case "param": {
        const bound = env.get(binding.param) ?? this.parameterValues(binding.param)
        return this.select(bound, binding.path, env)
      }
      case "function":
        return [{ kind: "function", node: binding.node, name: Node.isFunctionDeclaration(binding.node) ? binding.node.getName() ?? null : null }]
      case "class":
        return [{ kind: "class", node: binding.node }]
      case "import":
        return this.importValue(binding.file, binding.specifier, binding.imported)
    }
  }

  /** Follows a destructuring path (`const { a: { b } } = x`) into values. */
  private select(values: Value[], path: string[], env: Env): Value[] {
    let current = values
    for (const key of path) current = this.member(current, key, env)
    return current
  }

  /** `obj.key` for every value obj may have. */
  member(objects: Value[], key: string, env: Env = EMPTY_ENV): Value[] {
    return objects.flatMap((obj): Value[] => {
      switch (obj.kind) {
        case "module":
          return this.exportValue(obj.file, key)
        case "external":
          return [{ kind: "external", name: `${obj.name}.${key}` }]
        case "externalCall":
          return [obj]
        case "object":
          return this.objectProperty(obj.node, key, env)
        case "array": {
          if (!Node.isArrayLiteralExpression(obj.node)) return []
          const index = Number(key)
          return Number.isInteger(index) ? this.evaluate(obj.node.getElements()[index], env) : []
        }
        case "class":
          return this.classMember(obj.node, key, true)
        case "instance":
          return this.classMember(obj.classNode, key, false)
        default:
          return []
      }
    })
  }

  private objectProperty(node: Node, key: string, env: Env): Value[] {
    if (!Node.isObjectLiteralExpression(node)) return []
    const out: Value[] = []
    for (const prop of node.getProperties()) {
      if (Node.isPropertyAssignment(prop) && propName(prop.getNameNode()) === key) {
        out.push(...this.evaluate(prop.getInitializer(), env))
      } else if (Node.isShorthandPropertyAssignment(prop) && prop.getName() === key) {
        out.push(...this.evaluate(prop.getNameNode(), env))
      } else if (Node.isMethodDeclaration(prop) && prop.getName() === key) {
        out.push({ kind: "function", node: prop, name: key })
      } else if (Node.isSpreadAssignment(prop)) {
        out.push(...this.member(this.evaluate(prop.getExpression(), env), key, env))
      }
    }
    return out
  }

  private classMember(classNode: Node, key: string, isStatic: boolean): Value[] {
    if (!Node.isClassDeclaration(classNode) && !Node.isClassExpression(classNode)) return []
    for (const member of classNode.getMembers()) {
      if (!Node.isMethodDeclaration(member) && !Node.isPropertyDeclaration(member)) continue
      if (member.getName() !== key || member.isStatic() !== isStatic) continue
      if (Node.isMethodDeclaration(member)) return [{ kind: "function", node: member, name: key }]
      const init = member.getInitializer()
      if (init) return this.evaluate(init)
      const typed = this.instanceOfType(member.getTypeNode())
      if (typed.length > 0) return typed
    }
    if (isStatic) {
      const base = this.baseClass(classNode)
      return base ? this.classMember(base, key, true) : []
    }
    // constructor parameter properties (`constructor(private users: UserService)`)
    // and `this.users = new UserService()` / `this.users = users` in the constructor
    for (const ctor of classNode.getConstructors()) {
      for (const param of ctor.getParameters()) {
        if (param.getName() === key && param.getScope() !== undefined) return this.instanceOfType(param.getTypeNode())
        if (param.getName() === key && param.isReadonly()) return this.instanceOfType(param.getTypeNode())
      }
      for (const assign of ctor.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
        const left = assign.getLeft()
        if (assign.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue
        if (Node.isPropertyAccessExpression(left) && left.getExpression().getKind() === SyntaxKind.ThisKeyword && left.getName() === key) {
          const right = this.evaluate(assign.getRight())
          if (right.length > 0) return right
          const param = Node.isIdentifier(assign.getRight())
            ? ctor.getParameters().find((p) => p.getName() === assign.getRight().getText())
            : undefined
          if (param) return this.instanceOfType(param.getTypeNode())
        }
      }
    }
    const base = this.baseClass(classNode)
    return base ? this.classMember(base, key, false) : []
  }

  /** An instance of the class a type annotation names (`users: UserService`), when it resolves to a project class. */
  private instanceOfType(typeNode: Node | undefined): Value[] {
    if (!typeNode || !Node.isTypeReference(typeNode)) return []
    const name = typeNode.getTypeName()
    if (!Node.isIdentifier(name)) return []
    return this.evaluate(name).flatMap((v): Value[] => v.kind === "class" ? [{ kind: "instance", classNode: v.node }] : [])
  }

  private baseClass(classNode: Node): Node | null {
    if (!Node.isClassDeclaration(classNode) && !Node.isClassExpression(classNode)) return null
    const ext = classNode.getExtends()
    if (!ext) return null
    const base = this.evaluate(ext.getExpression()).find((v) => v.kind === "class")
    return base && base.kind === "class" ? base.node : null
  }

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------

  private evaluateCall(node: CallExpression, env: Env): Value[] {
    const callee = node.getExpression()

    // require("m") / require("m").x is handled through the property access above
    if (Node.isIdentifier(callee) && callee.getText() === "require" && !lookupName(callee, "require")) {
      const arg = node.getArguments()[0]
      if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
        return this.requireValue(node.getSourceFile(), arg.getLiteralValue())
      }
      return []
    }

    if (Node.isPropertyAccessExpression(callee)) {
      const method = callee.getName()
      const receivers = this.evaluate(callee.getExpression(), env)
      const out: Value[] = []
      for (const r of receivers) {
        if (r.kind === "router") {
          if (method === "route") {
            const paths = this.evaluate(node.getArguments()[0], env).filter(isString).map((s) => s.value)
            out.push({ kind: "routeChain", router: r, paths })
          } else if (CHAINING_METHODS.has(method)) {
            out.push(r)   // app.use(...) / router.get(...) return the app / router
          }
        } else if (r.kind === "routeChain" && VERBS.has(method)) {
          out.push(r)
        } else if (r.kind === "externalCall") {
          out.push(r)   // body("email").isEmail().withMessage(...)
        } else if (method === "bind" && r.kind === "function") {
          out.push(r)   // handler.bind(ctrl)
        }
      }
      if (out.length > 0) return out
    }

    return this.evaluate(callee, env).flatMap((fn): Value[] => {
      if (fn.kind === "external") {
        if (fn.name === "express") return [this.newRouter(node, true)]
        if (fn.name === "express.Router" || fn.name === "express.default.Router") return [this.newRouter(node, false)]
        return [{ kind: "externalCall", name: fn.name }]
      }
      if (fn.kind === "externalCall") return [fn]
      if (fn.kind === "function") {
        const returned = this.returnValues(fn.node)
        // A wrapper — a function returning a closure of its own, called with a
        // function (`catchAsync(async (req, res) => ...)`, `asyncHandler(ctrl.list)`)
        // — stands for the function it wraps: that is the code that handles the request.
        const returnsClosure = returned.some((v) => v.kind === "function" && isInside(v.node, fn.node))
        if (returnsClosure) {
          const wrapped = node.getArguments().flatMap((a) => this.evaluate(a, env)).filter((v) => v.kind === "function")
          if (wrapped.length > 0) return wrapped
        }
        return returned
      }
      return []
    })
  }

  private newRouter(node: Node, isApp: boolean): RouterValue {
    const file = relativePath(node.getSourceFile())
    return { kind: "router", id: `${file}:${node.getStart()}`, isApp, file, line: node.getStartLineNumber() }
  }

  /** What a function returns, for factory functions (`function createRouter() { const r = Router(); ...; return r }`). */
  private returnValues(fn: Node): Value[] {
    if (Node.isArrowFunction(fn)) {
      const body = fn.getBody()
      if (!Node.isBlock(body)) return this.evaluate(body)
    }
    const out: Value[] = []
    for (const ret of fn.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
      if (enclosingFunction(ret) !== fn) continue
      out.push(...this.evaluate(ret.getExpression()))
    }
    return out
  }

  // -------------------------------------------------------------------------
  // Parameters
  // -------------------------------------------------------------------------

  /**
   * Values a parameter is bound to: the matching argument at every call site of
   * its function (a registrar `function routes(app) {...}` called as
   * `routes(app)`), or the elements of the array when the function is a
   * `forEach` / `map` callback.
   */
  parameterValues(param: ParameterDeclaration): Value[] {
    const fn = param.getParent() as unknown as Node & { getParameters(): ParameterDeclaration[] }
    const index = fn.getParameters().indexOf(param)
    const out: Value[] = []

    const parent = fn.getParent()
    if (parent && Node.isCallExpression(parent) && parent.getArguments().includes(fn as Node)) {
      const callee = parent.getExpression()
      if (Node.isPropertyAccessExpression(callee) && ITERATORS.has(callee.getName()) && index === 0) {
        for (const arr of this.evaluate(callee.getExpression())) {
          if (arr.kind === "array" && Node.isArrayLiteralExpression(arr.node)) {
            for (const el of arr.node.getElements()) out.push(...this.evaluate(el))
          }
        }
        return out
      }
    }

    for (const call of this.callSitesOf(fn)) {
      const arg = call.getArguments()[index]
      if (arg) out.push(...this.evaluate(arg))
    }
    return out
  }

  /** Every call in the project whose callee evaluates to `fn`. Built once, on first need. */
  private callSitesOf(fn: Node): CallExpression[] {
    if (!this.callSites) {
      this.callSites = new Map()
      for (const file of this.ep.files.values()) {
        for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          const callee = call.getExpression()
          // only plain calls `f(x)` / `m.f(x)` / `require("./r")(x)` — not router methods, and not
          // callees rooted in a parameter (`res.json`), whose values depend on this very index
          if (Node.isPropertyAccessExpression(callee) && (VERBS.has(callee.getName()) || CHAINING_METHODS.has(callee.getName()))) continue
          if (rootIsParameter(callee)) continue
          for (const v of this.evaluate(callee)) {
            if (v.kind !== "function") continue
            const list = this.callSites.get(v.node) ?? []
            list.push(call)
            this.callSites.set(v.node, list)
          }
        }
      }
    }
    return this.callSites.get(fn) ?? []
  }

  // -------------------------------------------------------------------------
  // Modules
  // -------------------------------------------------------------------------

  /** The project file a relative specifier points to, or null for a package / unknown file. */
  resolveModule(from: SourceFile, specifier: string): SourceFile | null {
    if (!specifier.startsWith(".")) return null
    const base = relativePath(from).split("/").slice(0, -1)
    for (const part of specifier.split("/")) {
      if (part === "." || part === "") continue
      if (part === "..") base.pop()
      else base.push(part)
    }
    const target = base.join("/")
    const stripped = target.replace(/\.(js|mjs|cjs)$/, "")   // TS sources imported as "./x.js"
    for (const candidate of [target, stripped]) {
      for (const ext of MODULE_EXTENSIONS) {
        const file = this.ep.files.get(candidate + ext)
        if (file) return file
      }
    }
    return null
  }

  /** `require("m")`: module.exports when the file assigns it, else the module's named exports. */
  requireValue(from: SourceFile, specifier: string): Value[] {
    const file = this.resolveModule(from, specifier)
    if (!file) return specifier.startsWith(".") ? [] : [{ kind: "external", name: specifier }]
    const cjs = this.moduleExportsAssignment(file)
    if (cjs) return this.evaluate(cjs)
    return [{ kind: "module", file }]
  }

  private importValue(from: SourceFile, specifier: string, imported: string): Value[] {
    const file = this.resolveModule(from, specifier)
    if (!file) {
      if (specifier.startsWith(".")) return []
      if (imported === "default" || imported === "*" || imported === "=") return [{ kind: "external", name: specifier }]
      return [{ kind: "external", name: `${specifier}.${imported}` }]
    }
    if (imported === "*") return [{ kind: "module", file }]
    if (imported === "=") return this.requireValue(from, specifier)
    return this.exportValue(file, imported)
  }

  /** A named export ("default" for the default export) of a project file, ES or CommonJS. */
  exportValue(file: SourceFile, name: string): Value[] {
    const out: Value[] = []
    const cjs = this.moduleExportsAssignment(file)
    for (const stmt of file.getStatements()) {
      if (name === "default" && Node.isExportAssignment(stmt)) out.push(...this.evaluate(stmt.getExpression()))
      if (Node.isFunctionDeclaration(stmt) || Node.isClassDeclaration(stmt)) {
        const exported = stmt.isExported() && (name === "default" ? stmt.isDefaultExport() : stmt.getName() === name && !stmt.isDefaultExport())
        if (exported) out.push(...this.evaluate(stmt))
      }
      if (Node.isVariableStatement(stmt) && stmt.isExported() && name !== "default") {
        for (const decl of stmt.getDeclarations()) {
          if (decl.getName() === name) out.push(...this.evaluate(decl.getInitializer()))
        }
      }
      if (Node.isExportDeclaration(stmt)) {
        const target = stmt.getModuleSpecifierValue()
        for (const spec of stmt.getNamedExports()) {
          const exportedAs = spec.getAliasNode()?.getText() ?? spec.getName()
          if (exportedAs !== name) continue
          if (target) {
            const resolved = this.resolveModule(file, target)
            if (resolved) out.push(...this.exportValue(resolved, spec.getName()))
          } else {
            const binding = lookupName(stmt, spec.getName())
            if (binding) out.push(...this.evaluateBinding(binding))
          }
        }
        if (target && stmt.isNamespaceExport() && name !== "default") {
          const resolved = this.resolveModule(file, target)
          if (resolved) out.push(...this.exportValue(resolved, name))
        }
      }
      // exports.name = x / module.exports.name = x
      if (Node.isExpressionStatement(stmt)) {
        const expr = stmt.getExpression()
        if (Node.isBinaryExpression(expr) && expr.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
          const left = expr.getLeft()
          if (Node.isPropertyAccessExpression(left) && left.getName() === name && isExportsObject(left.getExpression())) {
            out.push(...this.evaluate(expr.getRight()))
          }
        }
      }
    }
    if (cjs) {
      if (name === "default") out.push(...this.evaluate(cjs))
      else out.push(...this.member(this.evaluate(cjs), name))
    }
    return out
  }

  /** The right side of `module.exports = x` in a file, if any. */
  private moduleExportsAssignment(file: SourceFile): Node | null {
    for (const stmt of file.getStatements()) {
      if (!Node.isExpressionStatement(stmt)) continue
      const expr = stmt.getExpression()
      if (!Node.isBinaryExpression(expr) || expr.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue
      if (expr.getLeft().getText().replace(/\s/g, "") === "module.exports") return expr.getRight()
    }
    return null
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const VERBS = new Set(["get", "post", "put", "patch", "delete", "all", "options", "head"])
/** Router methods that return the router itself, so calls can be chained. */
const CHAINING_METHODS = new Set([...VERBS, "use", "param", "set", "enable", "disable", "engine"])
const ITERATORS = new Set(["forEach", "map", "flatMap"])

export function isString(v: Value): v is Extract<Value, { kind: "string" }> {
  return v.kind === "string"
}

function isExportsObject(node: Node): boolean {
  const text = node.getText().replace(/\s/g, "")
  return text === "exports" || text === "module.exports"
}

function concat(left: Value[], right: Value[]): Value[] {
  const out: Value[] = []
  for (const l of left) {
    if (l.kind !== "string") continue
    for (const r of right) {
      if (r.kind === "string") out.push({ kind: "string", value: l.value + r.value })
    }
  }
  return out.slice(0, MAX_VALUES)
}

function propName(node: Node): string | null {
  if (Node.isIdentifier(node) || Node.isPrivateIdentifier(node)) return node.getText()
  if (Node.isStringLiteral(node) || Node.isNumericLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText()
  return null
}

function functionName(node: Node): string | null {
  const parent = node.getParent()
  if (parent && Node.isVariableDeclaration(parent)) return parent.getName()
  if (parent && Node.isPropertyAssignment(parent)) return propName(parent.getNameNode())
  return null
}

function isInside(node: Node, container: Node): boolean {
  return node.getSourceFile() === container.getSourceFile() &&
    node.getStart() >= container.getStart() && node.getEnd() <= container.getEnd() && node !== container
}

export function isFunctionNode(n: Node): boolean {
  return Node.isFunctionLikeDeclaration(n) || Node.isArrowFunction(n) || Node.isFunctionExpression(n)
}

export function enclosingFunction(node: Node): Node | undefined {
  for (let p = node.getParent(); p; p = p.getParent()) {
    if (isFunctionNode(p)) return p
  }
  return undefined
}

/** True when an expression's leftmost identifier is a function parameter (`res.json`, `req.body.x`). */
function rootIsParameter(node: Node): boolean {
  let base: Node = node
  while (Node.isPropertyAccessExpression(base) || Node.isElementAccessExpression(base) || Node.isCallExpression(base)) {
    base = base.getExpression()
  }
  if (!Node.isIdentifier(base)) return false
  return lookupName(base, base.getText())?.kind === "param"
}

function valueKey(v: Value): string {
  switch (v.kind) {
    case "router": return `r:${v.id}`
    case "routeChain": return `c:${v.router.id}:${v.paths.join("|")}`
    case "function": return `f:${v.node.getSourceFile().getFilePath()}:${v.node.getStart()}`
    case "class": return `k:${v.node.getSourceFile().getFilePath()}:${v.node.getStart()}`
    case "instance": return `i:${v.classNode.getSourceFile().getFilePath()}:${v.classNode.getStart()}`
    case "module": return `m:${v.file.getFilePath()}`
    case "external": return `e:${v.name}`
    case "externalCall": return `x:${v.name}`
    case "object": return `o:${v.node.getSourceFile().getFilePath()}:${v.node.getStart()}`
    case "array": return `a:${v.node.getSourceFile().getFilePath()}:${v.node.getStart()}`
    case "string": return `s:${v.value}`
  }
}

function dedupe(values: Value[]): Value[] {
  const seen = new Set<string>()
  return values.filter((v) => {
    const k = valueKey(v)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
