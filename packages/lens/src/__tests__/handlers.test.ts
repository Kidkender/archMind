import type { GoFile } from "../callgraph.js"
import { findUnscopedHandlers } from "../handlers.js"

const f = (path: string, content: string): GoFile => ({ path, content })
const flagged = (body: string) =>
  findUnscopedHandlers([f("h/h.go", PRELUDE + body)]).map((x) => x.function)

const PRELUDE = `package h
type Context struct{}
func (c *Context) Param(k string) string { return "" }
func (c *Context) JSON(code int, v any) {}
func (c *Context) Status(code int) {}
type Order struct{ ID uint; BranchID uint; OwnerID uint }
type Svc struct{}
func (s *Svc) GetByID(id uint) (*Order, error) { return nil, nil }
func (s *Svc) Cancel(id uint) error { return nil }
type H struct{ svc *Svc }
`

describe("findUnscopedHandlers", () => {
  it("reports a handler that loads by path id and serves the record with no scope check", () => {
    expect(flagged(`func (h *H) GetByID(c *Context) {
  id, ok := ParseParamUint(c, "id")
  if !ok { return }
  out, err := h.svc.GetByID(id)
  if err != nil { return }
  c.JSON(200, out)
}`)).toEqual(["H.GetByID"])
  })

  it("accepts a scope call on a field of the loaded record", () => {
    expect(flagged(`func InScope(c *Context, branch uint) bool { return true }
func (h *H) GetByID(c *Context) {
  id, _ := ParseParamUint(c, "id")
  out, err := h.svc.GetByID(id)
  if err != nil { return }
  if !InScope(c, out.BranchID) { return }
  c.JSON(200, out)
}`)).toEqual([])
  })

  it("accepts a comparison of the loaded record with a value taken from the context", () => {
    expect(flagged(`func UserId(c *Context) uint { return 0 }
func (h *H) GetByID(c *Context) {
  id, _ := ParseParamUint(c, "id")
  out, _ := h.svc.GetByID(id)
  if out.OwnerID != UserId(c) { return }
  c.JSON(200, out)
}`)).toEqual([])
  })

  it("does not accept a comparison with nil as scope evidence", () => {
    expect(flagged(`func (h *H) GetByID(c *Context) {
  id, _ := ParseParamUint(c, "id")
  out, err := h.svc.GetByID(id)
  if err != nil || out == nil { return }
  c.JSON(200, out)
}`)).toEqual(["H.GetByID"])
  })

  it("follows a path id read with c.Param and converted before the load", () => {
    expect(flagged(`func conv(s string) uint { return 0 }
func (h *H) GetByID(c *Context) {
  raw := c.Param("id")
  id := conv(raw)
  out, _ := h.svc.GetByID(id)
  c.JSON(200, out)
}`)).toEqual(["H.GetByID"])
  })

  it("ignores a handler that serves nothing loaded from the path id", () => {
    expect(flagged(`func (h *H) Cancel(c *Context) {
  id, _ := ParseParamUint(c, "id")
  _ = h.svc.Cancel(id)
  c.Status(204)
}`)).toEqual([])
  })

  it("ignores a function without a path id source", () => {
    expect(flagged(`func (h *H) List(c *Context) {
  out, _ := h.svc.GetByID(1)
  c.JSON(200, out)
}`)).toEqual([])
  })

  it("lets a re-assigned variable drop the path tag", () => {
    expect(flagged(`func (h *H) GetByID(c *Context) {
  id, _ := ParseParamUint(c, "id")
  _ = id
  id = 7
  out, _ := h.svc.GetByID(id)
  c.JSON(200, out)
}`)).toEqual([])
  })

  it("skips test files", () => {
    expect(findUnscopedHandlers([f("h/h_test.go", PRELUDE + `func (h *H) GetByID(c *Context) {
  id, _ := ParseParamUint(c, "id")
  out, _ := h.svc.GetByID(id)
  c.JSON(200, out)
}`)])).toEqual([])
  })
})
