import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import type { GoFile } from "../parse.js"
import { handlerRouteIndex } from "../routes.js"

function graph(entrypoint: string, handlerSymbol?: string, loc?: { file: string; line: number }): IntermediateExecutionGraph {
  return {
    entrypoint, method: entrypoint.split(" ")[0], path: entrypoint.split(" ")[1],
    framework: "go", adapter_ver: "0.1.0", ir_ver: "1.5",
    nodes: handlerSymbol ? [{ id: "h", type: "ir:business_handler", symbol: handlerSymbol, ...loc }] : [],
    edges: [], annotations: [],
  }
}

describe("handlerRouteIndex", () => {
  it("maps a handler to its route, lower-cased so a variable name matches its type", () => {
    const idx = handlerRouteIndex([graph("GET /mail/:id", "mailHandler.Get")])
    expect(idx.get("mailhandler.get")).toEqual(["GET /mail/:id"])
  })

  it("collects every route one handler method serves", () => {
    const idx = handlerRouteIndex([graph("GET /a", "h.Do"), graph("GET /b", "h.Do")])
    expect(idx.get("h.do")).toEqual(["GET /a", "GET /b"])
  })

  it("skips routes without a handler node", () => {
    expect(handlerRouteIndex([graph("GET /health")]).size).toBe(0)
  })

  describe("with Go sources", () => {
    const f = (path: string, content: string): GoFile => ({ path, content })

    it("keys a handler registered through a parameter by the parameter's type", () => {
      const files = [f("routes/ship.go", `package routes
func RegisterShip(r *Router, h *handler.ShipmentHandler) {
  r.POST("/ship/:id/cancel", h.Cancel)
}`)]
      const idx = handlerRouteIndex([graph("POST /ship/:id/cancel", "h.Cancel", { file: "routes/ship.go", line: 3 })], files)
      expect(idx.get("shipmenthandler.cancel")).toEqual(["POST /ship/:id/cancel"])
      expect(idx.has("h.cancel")).toBe(false)
    })

    it("keeps same-named variables in different files apart", () => {
      const files = [
        f("routes/a.go", `package routes
func RegisterA(r *Router, h *handler.AHandler) {
  r.GET("/a", h.Do)
}`),
        f("routes/b.go", `package routes
func RegisterB(r *Router, h *handler.BHandler) {
  r.GET("/b", h.Do)
}`),
      ]
      const idx = handlerRouteIndex([
        graph("GET /a", "h.Do", { file: "routes/a.go", line: 3 }),
        graph("GET /b", "h.Do", { file: "routes/b.go", line: 3 }),
      ], files)
      expect(idx.get("ahandler.do")).toEqual(["GET /a"])
      expect(idx.get("bhandler.do")).toEqual(["GET /b"])
    })

    it("resolves a local built by a constructor through the constructor's result type", () => {
      const files = [
        f("handler/c.go", `package handler
type CartHandler struct{}
func NewCartHandler(s int) *CartHandler { return nil }`),
        f("routes/c.go", `package routes
func RegisterCart(r *Router) {
  h := handler.NewCartHandler(1)
  r.GET("/cart", h.Get)
}`),
      ]
      const idx = handlerRouteIndex([graph("GET /cart", "h.Get", { file: "routes/c.go", line: 4 })], files)
      expect(idx.get("carthandler.get")).toEqual(["GET /cart"])
    })

    it("resolves a local built from a composite literal", () => {
      const files = [f("routes/d.go", `package routes
func RegisterD(r *Router) {
  h := &handler.DHandler{}
  r.GET("/d", h.Get)
}`)]
      const idx = handlerRouteIndex([graph("GET /d", "h.Get", { file: "routes/d.go", line: 4 })], files)
      expect(idx.get("dhandler.get")).toEqual(["GET /d"])
    })

    it("falls back to the registered symbol when the variable's type cannot be resolved", () => {
      const files = [f("routes/e.go", `package routes
func RegisterE(r *Router) {
  r.GET("/e", mystery.Get)
}`)]
      const idx = handlerRouteIndex([graph("GET /e", "mystery.Get", { file: "routes/e.go", line: 3 })], files)
      expect(idx.get("mystery.get")).toEqual(["GET /e"])
    })
  })
})
