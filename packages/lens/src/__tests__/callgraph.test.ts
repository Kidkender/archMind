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


/** Callers of `target` as "Key" strings, sorted. */
function callersOf(files: GoFile[], target: string): string[] {
  const graph = buildCallGraph(files)
  return graph
    .findDefs(target)
    .flatMap((d) => graph.edgesTo(d.id))
    .map((e) => graph.defs.get(e.from)!.key)
    .sort()
}

describe("calls through a func-typed struct field", () => {
  const IMMUNITY = `package s
type Immunity struct{}
func (i *Immunity) Grant(id uint) {}
type Tmpl struct{ Grant func(n int) bool }
`

  it("does not resolve a call on a field of the known type to the only method with that name", () => {
    const files = [f("s/s.go", IMMUNITY + `type S struct{ t Tmpl }
func (s *S) Run() { s.t.Grant(1) }
`)]
    expect(callersOf(files, "Immunity.Grant")).toEqual([])
  })

  it("does not resolve it through a ranged package-level map of structs either", () => {
    const files = [f("s/s.go", IMMUNITY + `var templates = map[string]Tmpl{"a": {Grant: func(n int) bool { return true }}}
func Eval() { for _, t := range templates { t.Grant(1) } }
`)]
    expect(callersOf(files, "Immunity.Grant")).toEqual([])
  })

  it("still resolves a call to the only method of that name when the receiver type is unknown", () => {
    const files = [f("s/s.go", IMMUNITY + `func Use(x Granter) { x.Grant(1) }
`)]
    expect(callersOf(files, "Immunity.Grant")).toEqual(["Use"])
  })
})

describe("package-level variables", () => {
  const TWO = `package s
type A struct{}
func (a *A) Run() {}
type B struct{}
func (b *B) Run() {}
`

  it("types the value of a range over a package-level map", () => {
    const files = [f("s/s.go", TWO + `var table = map[string]*A{}
func Go() { for _, v := range table { v.Run() } }
`)]
    expect(callersOf(files, "A.Run")).toEqual(["Go"])
    expect(callersOf(files, "B.Run")).toEqual([])
  })

  it("types a package-level variable declared with a type, in a different file of the same package", () => {
    const files = [
      f("s/vars.go", `package s
var all []*B
`),
      f("s/s.go", TWO + `func Go() { for _, v := range all { v.Run() } }
`),
    ]
    expect(callersOf(files, "B.Run")).toEqual(["Go"])
    expect(callersOf(files, "A.Run")).toEqual([])
  })

  it("lets a local variable shadow a package-level one", () => {
    const files = [f("s/s.go", TWO + `var table = map[string]*A{}
func Go() { table := []*B{}; for _, v := range table { v.Run() } }
`)]
    expect(callersOf(files, "B.Run")).toEqual(["Go"])
    expect(callersOf(files, "A.Run")).toEqual([])
  })
})

describe("func literals stored through a composite literal", () => {
  const route = { "H.Do": ["GET /do"] }

  it("links a call through the field to the literal set in the constructor", () => {
    const files = [f("s/s.go", `package s
type G struct{ sight func(z string) int }
func NewG() *G { return &G{sight: func(z string) int { return helper(z) }, n: 2} }
func helper(z string) int { return 1 }
func (g *G) Pick() int { return g.sight("a") }
type H struct{ g *G }
func (h *H) Do() { h.g.Pick() }
`)]
    expect(httpRoutes(entriesOf(files, "helper", route))).toEqual(["GET /do"])
  })

  it("keeps the callbacks of two types that share a field name apart", () => {
    const files = [f("s/s.go", `package s
type A struct{ sight func() }
type B struct{ sight func() }
func NewA() *A { return &A{sight: func() { onlyA() }} }
func NewB() *B { return &B{sight: func() { onlyB() }} }
func onlyA() {}
func onlyB() {}
type H struct{ a *A }
func (h *H) Do() { h.a.sight() }
`)]
    expect(httpRoutes(entriesOf(files, "onlyA", route))).toEqual(["GET /do"])
    expect(httpRoutes(entriesOf(files, "onlyB", route))).toEqual([])
  })
})

describe("functions and methods used as values", () => {
  const route = (h: string) => ({ [h]: ["POST /x"] })

  it("links a method value passed as an argument that the callee calls through its parameter", () => {
    const files = [f("s/s.go", `package s
type FS struct{}
func (f *FS) Accept(id uint) error { return nil }
type H struct{ fs *FS }
func (h *H) respond(act func(uint) error) { act(1) }
func (h *H) Accept() { h.respond(h.fs.Accept) }
`)]
    expect(httpRoutes(entriesOf(files, "FS.Accept", route("H.Accept")))).toEqual(["POST /x"])
  })

  it("links a method value that a function returns", () => {
    const files = [f("s/s.go", `package s
type Hub struct{}
func (h *Hub) In(z string) bool { return true }
type S struct{ hub *Hub }
func (s *S) presence() func(string) bool { return s.hub.In }
func (s *S) Do() { use(s.presence()) }
func use(f func(string) bool) { f("a") }
type H struct{ s *S }
func (h *H) Go() { h.s.Do() }
`)]
    expect(httpRoutes(entriesOf(files, "Hub.In", route("H.Go")))).toEqual(["POST /x"])
  })

  it("links a package function passed as an argument", () => {
    const files = [f("s/s.go", `package s
func worker() {}
func run(f func()) { f() }
type H struct{}
func (h *H) Go() { run(worker) }
`)]
    expect(httpRoutes(entriesOf(files, "worker", route("H.Go")))).toEqual(["POST /x"])
  })

  it("does not link a parameter that has the name of a function", () => {
    const files = [f("s/s.go", `package s
func worker() {}
func sink(n int) {}
type H struct{}
func (h *H) Go(worker int) { sink(worker) }
`)]
    expect(httpRoutes(entriesOf(files, "worker", route("H.Go")))).toEqual([])
  })

  it("does not link a method that is only named in a selector read, not used as a value of a call or return", () => {
    const files = [f("s/s.go", `package s
type FS struct{ Accept int }
type S struct{}
func (s *S) Accept() {}
type H struct{ fs *FS }
func (h *H) Go() int { n := h.fs.Accept; return n }
`)]
    expect(httpRoutes(entriesOf(files, "S.Accept", route("H.Go")))).toEqual([])
  })
})

describe("calls to a generic function with explicit type arguments", () => {
  const route = { "H.Do": ["GET /do"] }

  it("resolves f[T](...) like f(...)", () => {
    const files = [f("s/s.go", `package s
type Req struct{}
func bind[T any](c int) (T, bool) { check(c); var t T; return t, true }
func check(c int) {}
type H struct{}
func (h *H) Do() { bind[Req](1) }
`)]
    expect(httpRoutes(entriesOf(files, "check", route))).toEqual(["GET /do"])
  })

  it("resolves f[T](a, b) with several arguments too", () => {
    const files = [f("s/s.go", `package s
type Req struct{}
func bind[T any](c int, d int) { check(c) }
func check(c int) {}
type H struct{}
func (h *H) Do() { bind[Req](1, 2) }
`)]
    expect(httpRoutes(entriesOf(files, "check", route))).toEqual(["GET /do"])
  })

  it("does not take a conversion to a generic type for a call", () => {
    const files = [f("s/s.go", `package s
type List[T any] []T
func visit() {}
type H struct{}
func (h *H) Do() { _ = List[int](nil) }
`)]
    expect(httpRoutes(entriesOf(files, "visit", route))).toEqual([])
  })

  it("resolves pkg.F[T](...) through the package name", () => {
    const files = [
      f("util/util.go", `package util
func Map[T any](x T) { visit() }
func visit() {}
`),
      f("s/s.go", `package s
import "x/util"
type H struct{}
func (h *H) Do() { util.Map[int](1) }
`),
    ]
    expect(httpRoutes(entriesOf(files, "visit", route))).toEqual(["GET /do"])
  })

  it("does not treat an indexed value that is not a function name as a call target", () => {
    const files = [f("s/s.go", `package s
func visit() {}
type H struct{ fns []func() }
func (h *H) Do() { h.fns[0]() }
`)]
    expect(httpRoutes(entriesOf(files, "visit", route))).toEqual([])
  })
})

describe("calls through an interface", () => {
  const IFACE = `package s
type PS interface { Pos(id uint, z string) (x float64, ok bool) }
type Hub struct{}
func (h *Hub) Pos(id uint, z string) (float64, bool) { return 0, false }
`

  it("resolves to the type whose method has the interface's signature, not another method of the same name", () => {
    const files = [f("s/s.go", IFACE + `type Boss struct{}
func (b *Boss) Pos(ctx int, e string, extra int) float64 { return 0 }
func guard(p PS) { p.Pos(1, "a") }
`)]
    expect(callersOf(files, "Hub.Pos")).toEqual(["guard"])
    expect(callersOf(files, "Boss.Pos")).toEqual([])
  })

  it("links every type that satisfies the interface", () => {
    const files = [f("s/s.go", IFACE + `type Fake struct{}
func (x *Fake) Pos(id uint, z string) (float64, bool) { return 1, true }
func guard(p PS) { p.Pos(1, "a") }
`)]
    expect(callersOf(files, "Hub.Pos")).toEqual(["guard"])
    expect(callersOf(files, "Fake.Pos")).toEqual(["guard"])
  })

  it("does not count a type that lacks one of the interface's methods", () => {
    const files = [f("s/s.go", `package s
type PS interface { Pos(id uint) bool; Done() }
type Full struct{}
func (x *Full) Pos(id uint) bool { return true }
func (x *Full) Done() {}
type Half struct{}
func (x *Half) Pos(id uint) bool { return true }
func guard(p PS) { p.Pos(1) }
`)]
    expect(callersOf(files, "Full.Pos")).toEqual(["guard"])
    expect(callersOf(files, "Half.Pos")).toEqual([])
  })

  it("resolves a call on a struct field whose type is an interface", () => {
    const files = [f("s/s.go", IFACE + `type Boss struct{}
func (b *Boss) Pos(ctx int, e string, extra int) float64 { return 0 }
type S struct{ p PS }
func (s *S) Run() { s.p.Pos(1, "a") }
`)]
    expect(callersOf(files, "Hub.Pos")).toEqual(["S.Run"])
    expect(callersOf(files, "Boss.Pos")).toEqual([])
  })
})
