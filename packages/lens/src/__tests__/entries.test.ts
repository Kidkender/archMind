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
