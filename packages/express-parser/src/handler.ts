import { Node, SyntaxKind, type CallExpression } from "ts-morph"
import { Evaluator, isFunctionNode, type Value } from "./evaluator.js"
import { relativePath } from "./project.js"
import type { ExpressRoute } from "./routes.js"

export interface CodeRef {
  symbol: string
  file:   string
  line:   number
}

export interface HandlerFacts {
  /** Project functions the handler calls (services, repositories, helpers in other modules). */
  services:     CodeRef[]
  /** Transaction boundaries in the handler, or in a service it calls (one hop). */
  transactions: CodeRef[]
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
        facts.services.push({ symbol: calleeSymbol(callee), file: relativePath(fn.getSourceFile()), line: fn.getStartLineNumber() })
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

function transactionCall(call: CallExpression, ev: Evaluator): CodeRef | null {
  const callee = call.getExpression()
  if (!Node.isPropertyAccessExpression(callee)) return null
  const method = callee.getName()
  if (TXN_METHODS.has(method)) return ref(calleeSymbol(callee), call)
  if (method !== "transaction") return null
  const receiver = callee.getExpression()
  const tail = receiver.getText().replace(/\s/g, "").split(".").pop() ?? ""
  if (DB_RECEIVER.test(tail)) return ref(calleeSymbol(callee), call)
  const fromOrm = ev.evaluate(receiver).some((v) =>
    (v.kind === "external" || v.kind === "externalCall") &&
    ORM_PACKAGES.some((pkg) => v.name === pkg || v.name.startsWith(`${pkg}.`)))
  return fromOrm ? ref(calleeSymbol(callee), call) : null
}

/** Where services live: a file or folder named for the layer. */
const SERVICE_PATH = /(service|repositor|repo|dao|store|provider|manager|usecase|use-case|model|entit|domain|gateway|client)/i
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
