import { findEntries, findTransactionEffects, type CallGraph, type TransactionEffect } from "@kidkender/archmind-lens"

export interface SymbolContextOptions {
  /** Most entries to return; the rest are counted in `entries_omitted`. */
  maxEntries?: number
}

export interface SymbolDefinition {
  key: string
  file: string
  line: number
  opens_transaction: boolean
  mutates_state: boolean
}

export interface SymbolEntry {
  kind: "http" | "background" | "startup" | "unreferenced"
  /** The handler, goroutine target or startup function the path starts from. */
  label: string
  route?: string
  /** Some call on the path runs inside a `.Transaction(func...)` closure. */
  in_transaction: boolean
  /** The path goes through a `go` statement, so the work outlives the request. */
  async?: boolean
  /** Entry first, symbol last. */
  path: string[]
}

export interface SymbolContext {
  symbol: string
  found: boolean
  definitions: SymbolDefinition[]
  reached_from: SymbolEntry[]
  entries_omitted: number
  transaction_issues: TransactionEffect[]
  note?: string
}

const DEFAULT_MAX_ENTRIES = 20

/** HTTP routes first (by route), then the other kinds, so a cut keeps the most useful rows. */
const KIND_ORDER: Record<SymbolEntry["kind"], number> = { http: 0, background: 1, startup: 2, unreferenced: 3 }

/**
 * Where a Go symbol is defined, which routes, goroutines and startup code reach it, whether those
 * calls run inside a database transaction, and any effect-in-transaction issue that involves it.
 */
export function describeSymbol(
  graph: CallGraph,
  handlerRoutes: Map<string, string[]>,
  symbol: string,
  opts: SymbolContextOptions = {}
): SymbolContext {
  const defs = graph.findDefs(symbol)
  if (defs.length === 0) {
    return {
      symbol,
      found: false,
      definitions: [],
      reached_from: [],
      entries_omitted: 0,
      transaction_issues: [],
      note: `Symbol not found. Use "Type.Method" or a function name as it is declared in Go (e.g. "BossService.Swing").`,
    }
  }

  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
  const entries = findEntries(graph, symbol, { handlerRoutes })
    .map(
      (e): SymbolEntry => ({
        kind: e.kind,
        label: e.label,
        ...(e.route !== undefined && { route: e.route }),
        in_transaction: e.inTxn,
        ...(e.async && { async: true }),
        path: e.path,
      })
    )
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.route ?? a.label).localeCompare(b.route ?? b.label))

  const keys = new Set(defs.map((d) => d.key))
  const issues = findTransactionEffects(graph).filter((x) => keys.has(x.function) || keys.has(x.callee) || x.via.some((v) => keys.has(v)))

  return {
    symbol,
    found: true,
    definitions: defs.map((d) => ({
      key: d.key,
      file: d.file,
      line: d.line,
      opens_transaction: d.opensTransaction,
      mutates_state: d.mutatesState,
    })),
    reached_from: entries.slice(0, maxEntries),
    entries_omitted: Math.max(0, entries.length - maxEntries),
    transaction_issues: issues,
  }
}
