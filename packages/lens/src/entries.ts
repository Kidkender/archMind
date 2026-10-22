import type { CallEdge, CallGraph, FuncDef } from "./callgraph.js"

export type EntryKind = "http" | "background" | "startup" | "unreferenced"

export interface Entry {
  kind: EntryKind
  /** The function the path starts from (a handler, a `go` target, or a startup function). */
  label: string
  /** Set for kind "http". */
  route?: string
  /** Keys from the entry down to the target. */
  path: string[]
  /** True when some call on the path is inside a `.Transaction(func...)` closure. */
  inTxn: boolean
  /** True when the path passes through a `go` statement: the work runs after the entry has returned. */
  async?: boolean
}

export interface FindOptions {
  /** Handler key ("Recv.Method") to the routes it serves. A lower-cased key also matches. */
  handlerRoutes: Map<string, string[]>
  maxDepth?: number
}

const DEFAULT_MAX_DEPTH = 14
const MAX_VISITED = 20000

interface Step {
  def: FuncDef
  /** Keys from this def down to the target. */
  path: string[]
  inTxn: boolean
  async: boolean
}

function routesOf(def: FuncDef, opts: FindOptions): string[] {
  return opts.handlerRoutes.get(def.key) ?? opts.handlerRoutes.get(def.key.toLowerCase()) ?? []
}

function isStartup(def: FuncDef): boolean {
  return def.key === "main" || def.dir.includes("/container/") || def.dir.startsWith("cmd/") || def.dir.startsWith("container/")
}

/**
 * Where a function is reached from: HTTP handlers, goroutines started with `go`,
 * startup code, walking the call graph upward from `symbol`.
 */
export function findEntries(graph: CallGraph, symbol: string, opts: FindOptions): Entry[] {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH
  const found = new Map<string, Entry>()
  const add = (e: Entry): void => {
    const k = `${e.kind}|${e.label}|${e.route ?? ""}`
    const prev = found.get(k)
    if (!prev || e.path.length < prev.path.length) found.set(k, e)
  }

  for (const target of graph.findDefs(symbol)) {
    const seen = new Set<string>([target.id])
    const queue: Step[] = [{ def: target, path: [target.key], inTxn: false, async: false }]
    while (queue.length > 0 && seen.size < MAX_VISITED) {
      const step = queue.shift()!
      const routes = routesOf(step.def, opts)
      if (routes.length > 0) {
        for (const route of routes) {
          add({ kind: "http", label: step.def.key, route, path: step.path, inTxn: step.inTxn, ...(step.async && { async: true }) })
        }
        continue
      }
      const incoming: CallEdge[] = graph.edgesTo(step.def.id)
      if (incoming.some((e) => e.via === "go")) {
        add({ kind: "background", label: step.def.key, path: step.path, inTxn: step.inTxn })
      } else if (incoming.length === 0) {
        add({ kind: isStartup(step.def) ? "startup" : "unreferenced", label: step.def.key, path: step.path, inTxn: step.inTxn })
        continue
      }
      if (step.path.length >= maxDepth) continue
      for (const e of incoming) {
        const caller = graph.defs.get(e.from)
        if (!caller || seen.has(caller.id)) continue
        seen.add(caller.id)
        queue.push({ def: caller, path: [caller.key, ...step.path], inTxn: step.inTxn || e.inTxn, async: step.async || e.via === "go" })
      }
    }
  }
  return [...found.values()]
}
