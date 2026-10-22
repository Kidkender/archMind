import { buildCallGraph, type GoFile } from "@kidkender/archmind-lens"
import { describeSymbol } from "../symbol-context.js"

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
