import { Node, SyntaxKind, type CallExpression } from "ts-morph"
import { Evaluator, isFunctionNode, type Value } from "./evaluator.js"
import { relativePath } from "./project.js"
import type { ExpressRoute } from "./routes.js"

export interface CodeRef {
  symbol: string
  file:   string
  line:   number
}

/** A write to the database made inside a transaction, `Entity::operation`. */
export interface TxnWrite extends CodeRef {
  entity:    string
  operation: string
}

export interface TransactionRef extends CodeRef {
  writes: TxnWrite[]
}

export interface HandlerFacts {
  /** Project functions the handler calls (services, repositories, helpers in other modules). */
  services:     CodeRef[]
  /** Transaction boundaries in the handler, or in a service it calls (one hop). */
  transactions: TransactionRef[]
  /** The first call to a configured ownership source (archmind.json authorization.ownershipSources). */
  ownership:    CodeRef | null
}

export interface HandlerOptions {
  ownershipSources?: string[]
}

/** Service calls kept per route, so a long handler cannot flood the graph. */
const MAX_SERVICES = 15

/** Methods that open a transaction whatever they are called on. */
const TXN_METHODS = new Set(["$transaction", "withTransaction", "startTransaction"])
/** `x.transaction(...)` counts when x is a database handle by name ... */
const DB_RECEIVER = /^(sequelize|db|database|prisma|datasource|appdatasource|connection|conn|manager|entitymanager|em|knex|orm|trx|pool|client|mongoose|session|queryrunner|getmanager\(\)|getconnection\(\))$/i
/** ... or comes from an ORM package. */
const ORM_PACKAGES = ["sequelize", "typeorm", "knex", "mongoose", "@prisma/client", "objection", "@mikro-orm/core", "drizzle-orm"]

export function analyzeHandler(route: ExpressRoute, ev: Evaluator, opts: HandlerOptions = {}): HandlerFacts {
  const facts: HandlerFacts = { services: [], transactions: [], ownership: null }
  const handler = route.handler.node
  if (!handler || !isFunctionNode(handler)) return facts

  const owners = new Set(opts.ownershipSources ?? [])
  const params = new Set(parameterNames(handler))
  const serviceFns: Node[] = []
  const seenServices = new Set<Node>()

  for (const call of callsIn(handler)) {
    const callee = call.getExpression()
    if (rootName(callee) && params.has(rootName(callee)!)) continue   // req.*, res.*, next()

    if (!facts.ownership && owners.has(lastName(callee))) facts.ownership = ref(`ownership:${lastName(callee)}`, call)
    const txn = transactionCall(call, ev)
    if (txn) facts.transactions.push(txn)

    for (const fn of projectFunctions(ev.evaluate(callee))) {
      if (fn === handler || isWithin(fn, handler) || seenServices.has(fn)) continue
      if (!isServiceTarget(callee, fn, handler)) continue
      seenServices.add(fn)
      serviceFns.push(fn)
      if (facts.services.length < MAX_SERVICES) {
        facts.services.push({ symbol: serviceSymbol(callee), file: relativePath(fn.getSourceFile()), line: fn.getStartLineNumber() })
      }
    }
  }

  // one hop: transactions and ownership inside the services the handler calls
  for (const fn of serviceFns) {
    for (const call of callsIn(fn)) {
      const txn = transactionCall(call, ev)
      if (txn) facts.transactions.push(txn)
      const callee = call.getExpression()
      if (!facts.ownership && owners.has(lastName(callee))) facts.ownership = ref(`ownership:${lastName(callee)}`, call)
    }
  }
  return facts
}

/** Calls in a function's body, including in callbacks written inside it. */
function callsIn(fn: Node): CallExpression[] {
  return fn.getDescendantsOfKind(SyntaxKind.CallExpression)
}

function transactionCall(call: CallExpression, ev: Evaluator): TransactionRef | null {
  const callee = call.getExpression()
  if (!Node.isPropertyAccessExpression(callee)) return null
  const method = callee.getName()
  let isTxn = TXN_METHODS.has(method)
  if (!isTxn && method === "transaction") {
    const receiver = callee.getExpression()
    const tail = receiver.getText().replace(/\s/g, "").split(".").pop() ?? ""
    isTxn = DB_RECEIVER.test(tail) || ev.evaluate(receiver).some((v) =>
      (v.kind === "external" || v.kind === "externalCall") &&
      ORM_PACKAGES.some((pkg) => v.name === pkg || v.name.startsWith(`${pkg}.`)))
  }
  if (!isTxn) return null
  return { ...ref(calleeSymbol(callee), call), writes: transactionWrites(call) }
}

// ---------------------------------------------------------------------------
// Writes inside a transaction
// ---------------------------------------------------------------------------

const WRITE_METHODS = new Set([
  "save", "insert", "update", "delete", "remove", "upsert", "softDelete", "recover",
  "create", "createMany", "bulkCreate", "destroy", "updateMany", "deleteMany", "insertMany",
  "updateOne", "deleteOne", "findOneAndUpdate", "findByIdAndUpdate", "findOneAndDelete", "increment", "decrement",
])
/** An options argument that ties a write to an unmanaged transaction or a Mongo session. */
const TXN_OPTION = /\btransaction\s*[:,}]|\{\s*session\b|\bsession\s*:/

/**
 * Writes made inside the transaction: in its callback (`dataSource.transaction(
 * async (manager) => manager.save(Order, dto))`, `prisma.$transaction(async (tx)
 * => tx.order.create(...))`), in its array form (`prisma.$transaction([
 * prisma.order.create(...)])`), or — for an unmanaged transaction
 * (`const t = await sequelize.transaction()`) — calls in the same function that
 * pass it (`Order.create(data, { transaction: t })`).
 */
function transactionWrites(txnCall: CallExpression): TxnWrite[] {
  const scopes: Node[] = []
  for (const arg of txnCall.getArguments()) {
    if (isFunctionNode(arg) || Node.isArrayLiteralExpression(arg)) scopes.push(arg)
  }
  const out: TxnWrite[] = []
  const seen = new Set<Node>()
  const visit = (call: CallExpression, requireOption: boolean) => {
    if (seen.has(call)) return
    const w = writeOf(call)
    if (!w) return
    if (requireOption && !call.getArguments().some((a) => TXN_OPTION.test(a.getText()))) return
    seen.add(call)
    out.push(w)
  }
  for (const scope of scopes) {
    if (Node.isCallExpression(scope)) visit(scope, false)
    for (const call of scope.getDescendantsOfKind(SyntaxKind.CallExpression)) visit(call, false)
  }
  if (scopes.length === 0) {
    const fn = txnCall.getFirstAncestor((a) => isFunctionNode(a))
    for (const call of fn?.getDescendantsOfKind(SyntaxKind.CallExpression) ?? []) visit(call, true)
  }
  return out
}

/** `manager.save(Order, dto)` → Order::save; `Order.create(...)` → Order::create; `tx.order.create(...)` → Order::create. */
function writeOf(call: CallExpression): TxnWrite | null {
  const callee = call.getExpression()
  if (!Node.isPropertyAccessExpression(callee)) return null
  const operation = callee.getName()
  if (!WRITE_METHODS.has(operation)) return null
  const receiver = callee.getExpression()
  const entity = entityFromArgument(call.getArguments()[0]) ?? entityFromReceiver(receiver)
  if (!entity) return null
  return { entity, operation, symbol: `${entity}::${operation}`, file: relativePath(call.getSourceFile()), line: call.getStartLineNumber() }
}

/** TypeORM's EntityManager takes the entity first: `save(Order, dto)`, `save(new Order(...))`. */
function entityFromArgument(arg: Node | undefined): string | null {
  if (!arg) return null
  if (Node.isIdentifier(arg) && /^[A-Z]/.test(arg.getText())) return arg.getText()
  if (Node.isNewExpression(arg)) {
    const name = arg.getExpression().getText()
    return /^[A-Z]/.test(name) ? name : null
  }
  return null
}

function entityFromReceiver(receiver: Node): string | null {
  // Order.create(...) / Order.update(...)
  if (Node.isIdentifier(receiver)) {
    const name = receiver.getText()
    if (/^[A-Z]/.test(name)) return name
    // order.save(...) on an instance: the variable names the entity
    return /^(res|req|next|manager|tx|trx|em|session|t|db|prisma)$/.test(name) ? null : capitalize(name)
  }
  // tx.order.create(...) / prisma.order.create(...)
  if (Node.isPropertyAccessExpression(receiver)) {
    const name = receiver.getName()
    if (/^(res|req|body|query|params)$/.test(name)) return null
    return capitalize(name)
  }
  // manager.getRepository(Order).save(...)
  if (Node.isCallExpression(receiver)) return entityFromArgument(receiver.getArguments()[0])
  return null
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Where services live: a file or folder named for the layer. */
const SERVICE_PATH = /(service|repositor|repo\b|dao|store|provider|manager|usecase|use-case|model|entit|domain|gateway|client)/i
/** Where helpers live: response formatters, pickers, id generators. */
const UTILITY_PATH = /(^|\/)(utils?|helpers?|lib\/utils|common\/utils|shared\/utils)(\/|\.|$)/i

/**
 * Whether a called project function counts as a service call: it lives in a
 * service-like file, or is a method reached through a module, object or
 * instance (`userService.create`, `emailProvider.send`) — but not a utility
 * module, and not a helper in the handler's own file.
 */
function isServiceTarget(callee: Node, fn: Node, handler: Node): boolean {
  const path = relativePath(fn.getSourceFile())
  if (UTILITY_PATH.test(path)) return false
  if (SERVICE_PATH.test(path)) return true
  if (fn.getSourceFile() === handler.getSourceFile()) return false
  return Node.isPropertyAccessExpression(callee)
}

/** Functions defined in the project (not packages) among a callee's values. */
function projectFunctions(values: Value[]): Node[] {
  return values.flatMap((v) => (v.kind === "function" ? [v.node] : []))
}

function ref(symbol: string, node: Node): CodeRef {
  return { symbol, file: relativePath(node.getSourceFile()), line: node.getStartLineNumber() }
}

function calleeSymbol(callee: Node): string {
  return callee.getText().replace(/\s+/g, "").replace(/^this\./, "")
}

/**
 * `userService.createUser` → "userService::createUser", the Owner::method form
 * the other adapters use, so dependents can be looked up by owner name.
 */
function serviceSymbol(callee: Node): string {
  const text = calleeSymbol(callee)
  const dot = text.lastIndexOf(".")
  return dot > 0 && Node.isPropertyAccessExpression(callee) ? `${text.slice(0, dot)}::${text.slice(dot + 1)}` : text
}

function lastName(callee: Node): string {
  if (Node.isPropertyAccessExpression(callee)) return callee.getName()
  return callee.getText()
}

function rootName(callee: Node): string | null {
  let base: Node = callee
  while (Node.isPropertyAccessExpression(base) || Node.isElementAccessExpression(base) || Node.isCallExpression(base)) {
    base = base.getExpression()
  }
  return Node.isIdentifier(base) ? base.getText() : null
}

function parameterNames(fn: Node): string[] {
  const params = (fn as unknown as { getParameters?: () => { getName(): string }[] }).getParameters?.() ?? []
  return params.map((p) => p.getName())
}

function isWithin(node: Node, container: Node): boolean {
  return node.getSourceFile() === container.getSourceFile() &&
    node.getStart() >= container.getStart() && node.getEnd() <= container.getEnd()
}
