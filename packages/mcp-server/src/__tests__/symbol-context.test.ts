import { buildCallGraph, type GoFile } from "@kidkender/archmind-lens"
import { describeSymbol, renderSymbolContext } from "../symbol-context.js"

const f = (path: string, content: string): GoFile => ({ path, content })

const FILES = [
  f(
    "internal/fx/fx.go",
    `package fx
import "sync"
type Fx struct{ mu sync.Mutex; by map[string]int }
func (f *Fx) Mark(k string) { f.mu.Lock(); defer f.mu.Unlock(); f.by[k] = 1 }
func (f *Fx) Marked(k string) bool { f.mu.Lock(); defer f.mu.Unlock(); return f.by[k] > 0 }
`
  ),
  f(
    "internal/service/s.go",
    `package service
import "x/internal/fx"
type DB struct{}
func (d *DB) Transaction(fn func(tx *DB) error) error { return fn(d) }
type S struct{ db *DB; fx *fx.Fx }
func (s *S) Run() error { return s.db.Transaction(func(tx *DB) error { s.fx.Mark("a"); return nil }) }
func (s *S) Peek() bool { return s.fx.Marked("a") }
`
  ),
  f(
    "internal/handler/h.go",
    `package handler
import "x/internal/service"
type H struct{ s *service.S }
func (h *H) Do() { h.s.Run() }
func (h *H) Look() { h.s.Peek() }
`
  ),
]

const graph = buildCallGraph(FILES)
const handlerRoutes = new Map([
  ["h.do", ["POST /api/do"]],
  ["h.look", ["GET /api/look"]],
])

describe("describeSymbol", () => {
  it("lists the routes that reach a service-layer symbol", () => {
    const out = describeSymbol(graph, handlerRoutes, "S.Peek")
    expect(out.found).toBe(true)
    expect(out.reached_from.map((e) => e.route)).toEqual(["GET /api/look"])
  })

  it("returns the definition site with file and line", () => {
    const out = describeSymbol(graph, handlerRoutes, "S.Run")
    expect(out.definitions).toEqual([
      expect.objectContaining({ key: "S.Run", file: "internal/service/s.go", line: expect.any(Number), opens_transaction: true }),
    ])
  })

  it("marks an entry whose path runs inside a transaction", () => {
    const out = describeSymbol(graph, handlerRoutes, "Fx.Mark")
    expect(out.reached_from).toEqual([expect.objectContaining({ route: "POST /api/do", in_transaction: true })])
  })

  it("reports an effect-in-transaction issue that involves the symbol", () => {
    const out = describeSymbol(graph, handlerRoutes, "Fx.Mark")
    expect(out.transaction_issues).toEqual([
      expect.objectContaining({ function: "S.Run", callee: "Fx.Mark", file: "internal/service/s.go" }),
    ])
  })

  it("reports no transaction issue for a symbol the issue does not involve", () => {
    expect(describeSymbol(graph, handlerRoutes, "S.Peek").transaction_issues).toEqual([])
  })

  it("says so when the symbol is not defined", () => {
    const out = describeSymbol(graph, handlerRoutes, "Nope.Missing")
    expect(out).toMatchObject({ found: false, definitions: [], reached_from: [] })
    expect(out.note).toMatch(/not found/i)
  })

  it("caps the number of entries and says how many were left out", () => {
    const out = describeSymbol(graph, handlerRoutes, "Fx.Mark", { maxEntries: 0 })
    expect(out.reached_from).toEqual([])
    expect(out.entries_omitted).toBe(1)
  })
})

describe("renderSymbolContext", () => {
  const text = (symbol: string, opts = {}) => renderSymbolContext(describeSymbol(graph, handlerRoutes, symbol, opts))

  it("starts with the symbol and where it is defined", () => {
    expect(text("S.Peek").split("\n")[0]).toBe("S.Peek  internal/service/s.go:7")
  })

  it("puts one line per route with the path to the symbol and the call site", () => {
    expect(text("S.Peek")).toContain("GET /api/look  H.Look>S.Peek  @internal/handler/h.go:5")
  })

  it("marks a path that runs inside a transaction", () => {
    expect(text("Fx.Mark")).toContain("POST /api/do [txn]  H.Do>S.Run>Fx.Mark  @internal/service/s.go:6")
  })

  it("lists a transaction issue on its own line", () => {
    expect(text("Fx.Mark")).toMatch(/txn issue: S\.Run -> Fx\.Mark internal\/service\/s\.go:6/)
  })

  it("says how many entries were left out", () => {
    expect(text("Fx.Mark", { maxEntries: 0 })).toContain("1 more entries not shown")
  })

  it("is much shorter than the JSON form", () => {
    const ctx = describeSymbol(graph, handlerRoutes, "Fx.Mark")
    expect(renderSymbolContext(ctx).length).toBeLessThan(JSON.stringify(ctx, null, 2).length / 2)
  })

  it("says so when the symbol is not found", () => {
    expect(text("Nope.Missing")).toMatch(/^Nope\.Missing: not found/)
  })

  it("groups non-route entries and collapses callers nobody calls into a count", () => {
    const out = renderSymbolContext({
      symbol: "X", found: true, entries_omitted: 0, transaction_issues: [],
      definitions: [{ key: "X", file: "a.go", line: 1, opens_transaction: false, mutates_state: false }],
      reached_from: [
        { kind: "background", label: "Sim.Run", in_transaction: false, path: ["Sim.Run", "X"] },
        { kind: "unreferenced", label: "A", in_transaction: false, path: ["A", "X"] },
        { kind: "unreferenced", label: "B", in_transaction: false, path: ["B", "X"] },
      ],
    })
    expect(out).toContain("background  Sim.Run>X".replace(">X", ""))
    expect(out).toContain("2 unreferenced callers (A, B)")
  })

  it("flags an indirect link on the path", () => {
    const out = renderSymbolContext({
      symbol: "X", found: true, entries_omitted: 0, transaction_issues: [],
      definitions: [{ key: "X", file: "a.go", line: 1, opens_transaction: false, mutates_state: false }],
      reached_from: [{ kind: "http", label: "H.Do", route: "GET /x", in_transaction: false, indirect: ["ref"], path: ["H.Do", "X"] }],
    })
    expect(out).toContain("GET /x [via ref]  H.Do")
  })
})
