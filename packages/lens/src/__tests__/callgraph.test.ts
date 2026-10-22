import { buildCallGraph, type GoFile } from "../callgraph.js"
import { findEntries } from "../entries.js"

/** Only the HTTP routes: a symbol nobody calls is reported as "unreferenced", which these tests do not care about. */
const httpRoutes = (entries: { kind: string; route?: string }[]) => entries.filter((e) => e.kind === "http").map((e) => e.route)

const f = (path: string, content: string): GoFile => ({ path, content })

/** Entry labels for `target`, as "kind:label" strings, sorted. */
function entriesOf(files: GoFile[], target: string, routes: Record<string, string[]> = {}) {
  const graph = buildCallGraph(files)
  const handlerRoutes = new Map(Object.entries(routes))
  return findEntries(graph, target, { handlerRoutes })
}

describe("call resolution", () => {
  it("resolves recv.field.Method through the struct field type, not the method name", () => {
    const files = [f("internal/handler/h.go", `package handler
type CombatHandler struct{ svc *CombatService }
type BossHandler struct{ svc *BossService }
func (h *CombatHandler) Attack() { h.svc.Attack() }
func (h *BossHandler) Attack() { h.svc.Attack() }
type CombatService struct{}
func (s *CombatService) Attack() {}
type BossService struct{}
func (s *BossService) Attack() {}
`)]
    const routes = { "CombatHandler.Attack": ["POST /mobs/attack"], "BossHandler.Attack": ["POST /bosses/attack"] }
    expect(entriesOf(files, "CombatService.Attack", routes).map((e) => e.route)).toEqual(["POST /mobs/attack"])
    expect(entriesOf(files, "BossService.Attack", routes).map((e) => e.route)).toEqual(["POST /bosses/attack"])
  })

  it("resolves a call on a typed parameter to that type's method", () => {
    const files = [f("a/a.go", `package a
type H struct{}
type Svc struct{}
type Other struct{}
func (h *H) Do(svc *Svc) { svc.Work() }
func (s *Svc) Work() {}
func (o *Other) Work() {}
`)]
    expect(entriesOf(files, "Svc.Work", { "H.Do": ["GET /do"] }).map((e) => e.route)).toEqual(["GET /do"])
    expect(httpRoutes(entriesOf(files, "Other.Work", { "H.Do": ["GET /do"] }))).toEqual([])
  })

  it("does not guess when an untyped receiver matches several methods", () => {
    const files = [f("a/a.go", `package a
type H struct{}
type A struct{}
type B struct{}
func (h *H) Do() { x := build(); x.Work() }
func (a *A) Work() {}
func (b *B) Work() {}
`)]
    expect(httpRoutes(entriesOf(files, "A.Work", { "H.Do": ["GET /do"] }))).toEqual([])
    expect(httpRoutes(entriesOf(files, "B.Work", { "H.Do": ["GET /do"] }))).toEqual([])
  })

  it("falls back to a unique method name when the receiver type is unknown", () => {
    const files = [f("a/a.go", `package a
type H struct{}
type A struct{}
func (h *H) Do() { x := build(); x.OnlyOne() }
func (a *A) OnlyOne() {}
`)]
    expect(entriesOf(files, "A.OnlyOne", { "H.Do": ["GET /do"] }).map((e) => e.route)).toEqual(["GET /do"])
  })

  it("matches pkg.Func only to a directory named pkg, and bare f() only to the same directory", () => {
    const files = [
      f("internal/container/c.go", `package container
func New() {}
`),
      f("internal/service/s.go", `package service
import (
	"errors"
	"example.com/app/internal/container"
)
func Build() error { return errors.New("x") }
func Other() { container.New() }
`),
    ]
    const g = buildCallGraph(files)
    const callees = (from: string) => [...g.edgesFrom(from)].map((e) => e.to)
    expect(callees("internal/service/s.go:Build")).toEqual([])
    expect(callees("internal/service/s.go:Other")).toEqual(["internal/container/c.go:New"])
  })

  it("does not loop forever on mutual recursion", () => {
    const files = [f("a/a.go", `package a
func A() { B() }
func B() { A() }
`)]
    expect(entriesOf(files, "A", {})).toEqual([])
  })
})

describe("transaction closures", () => {
  const files = [f("a/a.go", `package a
type H struct{ s *S }
type S struct{ db *DB; fx *Fx }
type Fx struct{}
func (h *H) Do() { h.s.Run() }
func (s *S) Run() {
	s.db.Transaction(func(tx *DB) error { s.fx.Mark(); return nil })
	s.fx.After()
}
func (f *Fx) Mark() {}
func (f *Fx) After() {}
`)]
  it("flags a call made inside a Transaction closure", () => {
    expect(entriesOf(files, "Fx.Mark", { "H.Do": ["GET /do"] })[0].inTxn).toBe(true)
  })
  it("does not flag a call made after the closure returned", () => {
    expect(entriesOf(files, "Fx.After", { "H.Do": ["GET /do"] })[0].inTxn).toBe(false)
  })
})

describe("local variable types", () => {
  const routes = { "H.Do": ["GET /do"] }
  const base = `package a
type H struct{}
type Svc struct{}
type Other struct{}
func NewSvc() *Svc { return &Svc{} }
func (s *Svc) Work() {}
func (o *Other) Work() {}
`
  it("types a variable from a constructor's declared return type", () => {
    const files = [f("a/a.go", base + `func (h *H) Do() { x := NewSvc(); x.Work() }\n`)]
    expect(httpRoutes(entriesOf(files, "Svc.Work", routes))).toEqual(["GET /do"])
    expect(httpRoutes(entriesOf(files, "Other.Work", routes))).toEqual([])
  })

  it("types a variable from a composite literal, with or without &", () => {
    const files = [f("a/a.go", base + `func (h *H) Do() { x := &Svc{}; x.Work(); y := Svc{}; y.Work() }\n`)]
    expect(httpRoutes(entriesOf(files, "Svc.Work", routes))).toEqual(["GET /do"])
  })

  it("types a variable from a package-qualified constructor and takes the first of several results", () => {
    const files = [
      f("internal/pkg/p.go", `package pkg
type Svc struct{}
type Other struct{}
func New() (*Svc, error) { return nil, nil }
func (s *Svc) Work() {}
func (o *Other) Work() {}
`),
      f("internal/app/h.go", `package app
import "example.com/app/internal/pkg"
type H struct{}
func (h *H) Do() { x, err := pkg.New(); _ = err; x.Work() }
`),
    ]
    expect(httpRoutes(entriesOf(files, "Svc.Work", routes))).toEqual(["GET /do"])
    expect(httpRoutes(entriesOf(files, "Other.Work", routes))).toEqual([])
  })

  it("lets a func literal use the variables of the function that declares it", () => {
    const files = [
      f("internal/container/c.go", `package container
import "example.com/app/internal/service"
func wire(hub *Hub) {
	fx := service.NewEffects()
	hub.Move = func(u uint) bool { return fx.CannotMove(u) }
}
`),
      f("internal/service/s.go", `package service
type Effects struct{}
type Ledger struct{}
func NewEffects() *Effects { return &Effects{} }
func (e *Effects) CannotMove(u uint) bool { return false }
func (l *Ledger) CannotMove(u uint) bool { return false }
`),
      f("internal/ws/hub.go", `package ws
type Hub struct{ Move func(uint) bool }
func (h *Hub) handle() { h.Move(1) }
type WSHandler struct{ hub *Hub }
func (w *WSHandler) Upgrade() { w.hub.handle() }
`),
    ]
    expect(httpRoutes(entriesOf(files, "Effects.CannotMove", { "WSHandler.Upgrade": ["GET /ws"] }))).toEqual(["GET /ws"])
    expect(httpRoutes(entriesOf(files, "Ledger.CannotMove", { "WSHandler.Upgrade": ["GET /ws"] }))).toEqual([])
  })
})

describe("range variables", () => {
  const routes = { "H.Do": ["GET /do"] }
  const types = `type Rect struct{}
type Other struct{}
func (r *Rect) Work() {}
func (o *Other) Work() {}
`
  const run = (body: string, extra = "") => {
    const files = [f("a/a.go", `package a\n${types}${extra}\ntype H struct{ items []Rect; byName map[string]*Rect }\nfunc (h *H) Do(list []*Rect) {\n${body}\n}\n`)]
    return { rect: httpRoutes(entriesOf(files, "Rect.Work", routes)), other: httpRoutes(entriesOf(files, "Other.Work", routes)) }
  }

  it("types the value variable when ranging over a slice field of the receiver", () => {
    expect(run("for _, r := range h.items { r.Work() }")).toEqual({ rect: ["GET /do"], other: [] })
  })

  it("types the value variable when ranging over a typed slice parameter of pointers", () => {
    expect(run("for _, r := range list { r.Work() }")).toEqual({ rect: ["GET /do"], other: [] })
  })

  it("types the value variable when ranging over a map field", () => {
    expect(run("for _, r := range h.byName { r.Work() }")).toEqual({ rect: ["GET /do"], other: [] })
  })

  it("types the value variable when ranging over a local slice literal or make()", () => {
    expect(run("items := []Rect{{}}\nfor _, r := range items { r.Work() }").rect).toEqual(["GET /do"])
    expect(run("items := make([]*Rect, 0)\nfor _, r := range items { r.Work() }").rect).toEqual(["GET /do"])
  })

  it("types a variable declared with var and a slice type", () => {
    expect(run("var items []Rect\nfor _, r := range items { r.Work() }").rect).toEqual(["GET /do"])
  })

  it("does not type the index variable as the element", () => {
    expect(run("for r := range h.items { r.Work() }")).toEqual({ rect: [], other: [] })
  })

  it("does not guess when the ranged value has no known element type", () => {
    expect(run("for _, r := range build() { r.Work() }")).toEqual({ rect: [], other: [] })
  })
})

