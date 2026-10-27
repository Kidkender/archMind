import { findEntries, findPossibleCallers, findTransactionEffects, type CallGraph, type PossibleCallers, type TransactionEffect } from "@kidkender/archmind-lens"

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
  /** Where the symbol is called from on this path (the last hop). */
  call_site?: { file: string; line: number }
  /** Path links that are not a written call, so worth checking: "callback" (func in a field), "ref" (function or method used as a value). */
  indirect?: ("callback" | "ref")[]
  /** A handler on the path whose route could not be resolved, so the route is missing from this entry rather than absent. */
  unmapped_handler?: string
}

export interface SymbolContext {
  symbol: string
  found: boolean
  definitions: SymbolDefinition[]
  reached_from: SymbolEntry[]
  entries_omitted: number
  transaction_issues: TransactionEffect[]
  /** Calls of same-named methods the graph could not attribute (untyped or interface receiver): routes or callers may be missing. Absent when every call resolved. */
  possible_callers?: PossibleCallers[]
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
        ...(e.callSite && { call_site: e.callSite }),
        ...(e.indirect && { indirect: e.indirect }),
        ...(e.unmappedHandler && { unmapped_handler: e.unmappedHandler }),
      })
    )
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.route ?? a.label).localeCompare(b.route ?? b.label))

  const keys = new Set(defs.map((d) => d.key))
  const issues = findTransactionEffects(graph).filter((x) => keys.has(x.function) || keys.has(x.callee) || x.via.some((v) => keys.has(v)))

  const possible = findPossibleCallers(graph, symbol)
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
    ...(possible.length > 0 && { possible_callers: possible }),
  }
}

const MAX_LISTED_UNREFERENCED = 5
const MAX_LISTED_SITES = 3

function flagsOf(e: SymbolEntry): string {
  const flags = [e.in_transaction && "[txn]", e.async && "[async]", e.indirect && `[via ${e.indirect.join(",")}]`, e.unmapped_handler && `[route of ${e.unmapped_handler} not resolved]`].filter(Boolean)
  return flags.length > 0 ? ` ${flags.join(" ")}` : ""
}

function entryLine(e: SymbolEntry): string {
  const head = e.kind === "http" ? (e.route ?? e.label) : e.kind
  const site = e.call_site ? `  @${e.call_site.file}:${e.call_site.line}` : ""
  return `${head}${flagsOf(e)}  ${e.path.join(">")}${site}`
}

/**
 * The same facts as describeSymbol, as plain lines for a model to read: about a third of the JSON in size.
 * One line per route or other entry; callers that nobody calls are only counted.
 */
export function renderSymbolContext(ctx: SymbolContext): string {
  if (!ctx.found) return `${ctx.symbol}: not found. ${ctx.note ?? ""}`.trim()

  const lines = [`${ctx.symbol}  ${ctx.definitions.map((d) => `${d.file}:${d.line}`).join(" | ")}`]
  const collapsed = (e: SymbolEntry): boolean => e.kind === "unreferenced" && !e.unmapped_handler
  const unreferenced = ctx.reached_from.filter(collapsed)
  for (const e of ctx.reached_from) if (!collapsed(e)) lines.push(entryLine(e))
  if (unreferenced.length > 0) {
    const names = unreferenced.slice(0, MAX_LISTED_UNREFERENCED).map((e) => e.label)
    const more = unreferenced.length > MAX_LISTED_UNREFERENCED ? ", ..." : ""
    lines.push(`${unreferenced.length} unreferenced callers (${names.join(", ")}${more})`)
  }
  if (ctx.entries_omitted > 0) lines.push(`${ctx.entries_omitted} more entries not shown`)
  const sites = (ctx.possible_callers ?? []).flatMap((p) => p.sites.map((s) => ({ symbol: p.symbol, ...s })))
  for (const s of sites.slice(0, MAX_LISTED_SITES)) lines.push(`not attributed: ${s.symbol} called from ${s.caller} @${s.file}:${s.line}`)
  if (sites.length > MAX_LISTED_SITES) lines.push(`not attributed: ${sites.length - MAX_LISTED_SITES} more`)
  for (const x of ctx.transaction_issues) {
    lines.push(`txn issue: ${x.function} -> ${x.callee} ${x.file}:${x.line}${x.via.length > 1 ? ` via ${x.via.join(">")}` : ""}`)
  }
  return lines.join("\n")
}
