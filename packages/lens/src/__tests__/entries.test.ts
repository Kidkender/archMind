import { buildCallGraph, type GoFile } from "../callgraph.js"
import { findEntries } from "../entries.js"

const f = (path: string, content: string): GoFile => ({ path, content })
const run = (files: GoFile[], target: string, routes: Record<string, string[]> = {}) =>
  findEntries(buildCallGraph(files), target, { handlerRoutes: new Map(Object.entries(routes)) })

describe("entry kinds", () => {
  it("reports a goroutine started with `go` as a background entry", () => {
    const files = [
      f("cmd/server/main.go", `package main
func main() { sim := build(); go sim.Run() }
`),
      f("internal/service/sim.go", `package service
type Sim struct{ combat *Combat }
type Combat struct{}
func (s *Sim) Run() { s.tick() }
func (s *Sim) tick() { s.strike() }
func (s *Sim) strike() { s.combat.MobStrike() }
func (c *Combat) MobStrike() {}
`),
    ]
    const entries = run(files, "Combat.MobStrike")
    const background = entries.filter((e) => e.kind === "background")
    expect(background).toHaveLength(1)
    expect(background[0]).toMatchObject({ label: "Sim.Run" })
    expect(background[0].path).toEqual(["Sim.Run", "Sim.tick", "Sim.strike", "Combat.MobStrike"])
    expect(entries.filter((e) => e.kind === "http")).toEqual([])
  })

  it("reports a function only called from the container or main as startup wiring", () => {
    const files = [
      f("internal/container/container.go", `package container
func New() { p := &PvP{}; p.SetGate(1) }
type PvP struct{}
func (p *PvP) SetGate(g int) {}
`),
    ]
    const entries = run(files, "PvP.SetGate")
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: "startup", label: "New" })
  })

  it("follows a func literal assigned to a struct field into the code that calls the field", () => {
    const files = [
      f("internal/container/c.go", `package container
func wire(hub *Hub, fx *EffectService) {
	hub.MoveControl = func(u uint) bool { return fx.CannotMove(u) }
}
`),
      f("internal/ws/hub.go", `package ws
type Hub struct{ MoveControl func(uint) bool }
func (h *Hub) handle() { h.MoveControl(1) }
type WSHandler struct{ hub *Hub }
func (w *WSHandler) Upgrade() { w.hub.handle() }
`),
      f("internal/service/fx.go", `package service
type EffectService struct{}
func (e *EffectService) CannotMove(u uint) bool { return false }
`),
    ]
    const entries = run(files, "EffectService.CannotMove", { "WSHandler.Upgrade": ["GET /ws"] })
    expect(entries.map((e) => `${e.kind}:${e.route}`)).toEqual(["http:GET /ws"])
    expect(entries[0].path).toContain("callback:MoveControl")
  })

  it("returns an http entry per route when a handler serves several routes", () => {
    const files = [f("a/a.go", `package a
type H struct{ s *S }
type S struct{}
func (h *H) Do() { h.s.Work() }
func (s *S) Work() {}
`)]
    expect(run(files, "S.Work", { "H.Do": ["GET /a", "GET /b"] }).map((e) => e.route).sort()).toEqual(["GET /a", "GET /b"])
  })

  it("returns no entries for a symbol that is not defined", () => {
    expect(run([f("a/a.go", "package a\nfunc A() {}\n")], "Nope")).toEqual([])
  })

  it("marks the entry when any step on its path is inside a Transaction closure", () => {
    const files = [f("a/a.go", `package a
type H struct{ s *S }
type S struct{ db *DB; w *W }
type W struct{}
func (h *H) Do() { h.s.Run() }
func (s *S) Run() { s.db.Transaction(func(tx *DB) error { s.w.Inner(); return nil }) }
func (w *W) Inner() { w.Leaf() }
func (w *W) Leaf() {}
`)]
    expect(run(files, "W.Leaf", { "H.Do": ["GET /do"] })[0].inTxn).toBe(true)
  })

  it("keeps walking past a `go` statement so the route that started the goroutine is reported as async", () => {
    const files = [f("internal/ws/hub.go", `package ws
type Hub struct{ target *Target }
type Target struct{}
type WSHandler struct{ hub *Hub }
func (w *WSHandler) Upgrade() { go w.hub.readPump() }
func (h *Hub) readPump() { h.dispatch() }
func (h *Hub) dispatch() { h.target.Hit() }
func (t *Target) Hit() {}
`)]
    const entries = run(files, "Target.Hit", { "WSHandler.Upgrade": ["GET /ws"] })
    expect(entries.find((e) => e.kind === "background")).toMatchObject({ label: "Hub.readPump" })
    const http = entries.filter((e) => e.kind === "http")
    expect(http).toHaveLength(1)
    expect(http[0]).toMatchObject({ route: "GET /ws", async: true })
  })

  it("does not mark a plain synchronous route as async", () => {
    const files = [f("a/a.go", `package a
type H struct{ s *S }
type S struct{}
func (h *H) Do() { h.s.Work() }
func (s *S) Work() {}
`)]
    expect(run(files, "S.Work", { "H.Do": ["GET /a"] })[0].async).toBeFalsy()
  })
})

describe("where an entry reaches the symbol", () => {
  const route = { "H.Do": ["GET /do"] }

  it("gives the file and line of the call that reaches the symbol", () => {
    const files = [f("s/s.go", `package s
type S struct{}
func (s *S) Run() {}
type H struct{ s *S }
func (h *H) Do() {
	h.s.Run()
}
`)]
    const [entry] = run(files, "S.Run", route)
    expect(entry.callSite).toEqual({ file: "s/s.go", line: 6 })
  })

  it("keeps the call site of the symbol itself when the path is longer", () => {
    const files = [f("s/s.go", `package s
type S struct{}
func (s *S) Run() {}
func (s *S) Mid() {
	s.Run()
}
type H struct{ s *S }
func (h *H) Do() { h.s.Mid() }
`)]
    const [entry] = run(files, "S.Run", route)
    expect(entry.path).toEqual(["H.Do", "S.Mid", "S.Run"])
    expect(entry.callSite).toEqual({ file: "s/s.go", line: 5 })
  })

  it("has no call site when the symbol is the entry itself", () => {
    const files = [f("s/s.go", `package s
type H struct{}
func (h *H) Do() {}
`)]
    expect(run(files, "H.Do", route)[0].callSite).toBeUndefined()
  })

  it("lists the indirect links a path relies on, and nothing for a path of plain calls", () => {
    const viaValue = [f("s/s.go", `package s
type FS struct{}
func (f *FS) Accept() {}
type H struct{ fs *FS }
func (h *H) respond(act func()) { act() }
func (h *H) Do() { h.respond(h.fs.Accept) }
`)]
    expect(run(viaValue, "FS.Accept", route)[0].indirect).toEqual(["ref"])
    const plain = [f("s/s.go", `package s
type S struct{}
func (s *S) Run() {}
type H struct{ s *S }
func (h *H) Do() { h.s.Run() }
`)]
    expect(run(plain, "S.Run", route)[0].indirect).toBeUndefined()
  })
})

describe("handlers whose route is not resolved", () => {
  const files = [
    f("internal/handler/h.go", `package handler
import "github.com/gin-gonic/gin"
type H struct{ s *S }
type S struct{}
func (s *S) Cancel(id uint) {}
func (h *H) Cancel(c *gin.Context) { h.s.Cancel(1) }
func Register(h *H) { _ = h.Cancel }
`),
  ]

  it("marks an entry that passes through a gin handler with no route in the index", () => {
    const entries = run(files, "S.Cancel")
    expect(entries.map((e) => e.unmappedHandler)).toEqual(["H.Cancel"])
  })

  it("does not mark the entry once the handler has a route", () => {
    const entries = run(files, "S.Cancel", { "h.cancel": ["POST /x"] })
    expect(entries).toEqual([expect.objectContaining({ kind: "http", route: "POST /x" })])
    expect(entries[0].unmappedHandler).toBeUndefined()
  })

  it("does not treat a function taking context.Context as a handler", () => {
    const svc = [f("internal/s/s.go", `package s
import "context"
type S struct{}
func (s *S) Cancel(ctx context.Context, id uint) {}
func (s *S) Run(ctx context.Context) { s.Cancel(ctx, 1) }
`)]
    expect(run(svc, "S.Cancel").map((e) => e.unmappedHandler)).toEqual([undefined])
  })
})

