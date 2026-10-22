import type { CallGraph, FuncDef } from "./callgraph.js"

export interface TransactionEffect {
  kind: "effect_in_transaction"
  /** The function that opens the transaction and has no undo step. */
  function: string
  /** File and line of the call that changes shared state. */
  file: string
  line: number
  /** The state-changing method, e.g. "CreatureEffects.Slow". */
  callee: string
  /** Functions from the one that opened the transaction down to the one that makes the call. */
  via: string[]
}

const MAX_DEPTH = 4

/**
 * True for a method on a lock-guarded type that writes state itself and does not work with the caller's
 * transaction handle. Only direct writes count: a method that locks and calls a helper which writes is
 * not reported, because the same shape describes read methods that sweep expired entries.
 */
function changesSharedState(def: FuncDef, graph: CallGraph): boolean {
  return !!def.recv && def.mutatesState && !def.takesTx && graph.typeHasMutex(def.recv)
}

/**
 * Calls made while a database transaction is open that change in-memory state a rollback cannot undo,
 * in functions that have no undo step. The call may be in the closure itself or in a helper it calls.
 */
export function findTransactionEffects(graph: CallGraph): TransactionEffect[] {
  const out = new Map<string, TransactionEffect>()
  for (const opener of graph.defs.values()) {
    if (!opener.opensTransaction || opener.compensates) continue
    const queue = graph
      .edgesFrom(opener.id)
      .filter((e) => e.inTxn && e.via === "call")
      .map((e) => ({ edge: e, via: [opener.key], depth: 1 }))
    const seen = new Set<string>()
    while (queue.length > 0) {
      const { edge, via, depth } = queue.shift()!
      const callee = graph.defs.get(edge.to)
      const caller = graph.defs.get(edge.from)
      if (!callee || !caller) continue
      if (changesSharedState(callee, graph)) {
        const key = `${opener.id}|${caller.file}|${edge.line}|${callee.id}`
        if (!out.has(key)) out.set(key, { kind: "effect_in_transaction", function: opener.key, file: caller.file, line: edge.line, callee: callee.key, via })
        continue // what the object does inside itself is part of the same effect
      }
      if (depth >= MAX_DEPTH || seen.has(callee.id)) continue
      seen.add(callee.id)
      for (const next of graph.edgesFrom(callee.id)) {
        if (next.via === "call") queue.push({ edge: next, via: [...via, callee.key], depth: depth + 1 })
      }
    }
  }
  return [...out.values()]
}
