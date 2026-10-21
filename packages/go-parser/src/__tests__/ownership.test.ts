import { describe, test, expect } from "@jest/globals"
import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"
import { parseGinProject } from "../graph-builder.js"
import type { GoSourceFile } from "../route-parser.js"

// A self-service API (a game, a personal app) authorizes by ownership, not by
// role: the handler resolves the caller's own record and every query is scoped
// to it. The parser can be told which functions resolve the caller, and then a
// handler that calls one of them gets an authz_check node.

const MAIN_GO: GoSourceFile = {
  path: "cmd/server/main.go",
  content: `
package main

func main() {
	r := gin.Default()
	r.Use(middleware.AuthMiddleware())
	api := r.Group("/api/v1")
	RegisterShopRoutes(api, shopHandler)
}
`,
}

const ROUTES_GO: GoSourceFile = {
  path: "routes/shop.go",
  content: `
package routes

func RegisterShopRoutes(router gin.IRouter, handler *handler.ShopHandler) {
	shop := router.Group("/shop")
	shop.POST("/buy", handler.Buy)
	shop.DELETE("/items/:id", handler.Discard)
	shop.GET("/list", handler.List)
	shop.POST("/refund", handler.Refund)
	shop.POST("/peek", handler.Peek)
}
`,
}

const AUTH_MIDDLEWARE_GO: GoSourceFile = {
  path: "internal/middleware/auth.go",
  content: `
package middleware

func AuthMiddleware() gin.HandlerFunc {
	return func(ctx *gin.Context) {
		ctx.Next()
	}
}
`,
}

const HANDLER_GO: GoSourceFile = {
  path: "internal/handler/shop.go",
  content: `
package handler

type ShopHandler struct {
	shopService *service.ShopService
}

func (h *ShopHandler) Buy(c *gin.Context) {
	char, ok := currentCharacter(c, h.characters)
	if !ok {
		return
	}
	h.shopService.Buy(c.Request.Context(), char.ID)
}

func (h *ShopHandler) Discard(c *gin.Context) {
	h.shopService.Discard(c.Request.Context(), c.Param("id"))
}

func (h *ShopHandler) List(c *gin.Context) {
	char := mustCharacter(c)
	h.shopService.List(char.ID)
}

func (h *ShopHandler) Refund(c *gin.Context) {
	h.act(c, h.shopService.Refund)
}

func (h *ShopHandler) act(c *gin.Context, do func(id uint) error) {
	char, ok := currentCharacter(c, h.characters)
	if !ok {
		return
	}
	do(char.ID)
}

func (h *ShopHandler) Peek(c *gin.Context) {
	h.shopService.Peek(c.Param("id"))
}
`,
}

const FILES = [MAIN_GO, AUTH_MIDDLEWARE_GO, ROUTES_GO, HANDLER_GO]

const route = (graphs: ReturnType<typeof parseGinProject>, entrypoint: string) =>
  graphs.find((g) => g.entrypoint === entrypoint)!

describe("parseGinProject — ownership authorization", () => {
  test("emits no authz_check when no ownership sources are configured", () => {
    const g = route(parseGinProject(FILES), "POST /api/v1/shop/buy")
    expect(g.nodes.some((n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK)).toBe(false)
  })

  test("a handler calling a configured identity function gets an authz_check", () => {
    const g = route(parseGinProject(FILES, { ownershipSources: ["currentCharacter"] }), "POST /api/v1/shop/buy")
    const authz = g.nodes.find((n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK)!
    expect(authz.symbol).toBe("ownership:currentCharacter")
    expect(authz.role).toBe("authorization")
    expect(authz.file).toBe("internal/handler/shop.go")
  })

  test("a handler that never resolves the caller (acts on a URL id) gets none", () => {
    const g = route(parseGinProject(FILES, { ownershipSources: ["currentCharacter"] }), "DELETE /api/v1/shop/items/:id")
    expect(g.nodes.some((n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK)).toBe(false)
  })

  test("only the configured names count — another identity function is ignored", () => {
    const g = route(parseGinProject(FILES, { ownershipSources: ["currentCharacter"] }), "GET /api/v1/shop/list")
    expect(g.nodes.some((n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK)).toBe(false)
  })

  test("several sources can be configured", () => {
    const g = route(
      parseGinProject(FILES, { ownershipSources: ["currentCharacter", "mustCharacter"] }),
      "GET /api/v1/shop/list"
    )
    expect(g.nodes.find((n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK)?.symbol).toBe("ownership:mustCharacter")
  })

  test("follows one hop into a helper method on the same receiver", () => {
    const g = route(parseGinProject(FILES, { ownershipSources: ["currentCharacter"] }), "POST /api/v1/shop/refund")
    const authz = g.nodes.find((n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK)!
    expect(authz.symbol).toBe("ownership:currentCharacter")
  })

  test("a helper that never resolves the caller does not count", () => {
    const g = route(parseGinProject(FILES, { ownershipSources: ["currentCharacter"] }), "POST /api/v1/shop/peek")
    expect(g.nodes.some((n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK)).toBe(false)
  })

  test("the ownership check follows the handler in the edge chain", () => {
    const g = route(parseGinProject(FILES, { ownershipSources: ["currentCharacter"] }), "POST /api/v1/shop/buy")
    const handler = g.nodes.find((n) => n.type === IR_NODE_TYPES.BUSINESS_HANDLER)!
    const authz = g.nodes.find((n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK)!
    expect(g.edges).toContainEqual(expect.objectContaining({ from: handler.id, to: authz.id }))
  })
})

// A handler wired up as a local — `shopHandler := handler.NewShopHandler(...)`
// inside the registrar — rather than received as a typed parameter. Common in
// Go projects that build their handlers from a container.

const CONSTRUCTED_MAIN_GO: GoSourceFile = {
  path: "cmd/server/main.go",
  content: `
package main

func main() {
	r := gin.Default()
	r.Use(middleware.AuthMiddleware())
	routes.Register(r)
}
`,
}

const CONSTRUCTED_ROUTES_GO: GoSourceFile = {
  path: "routes/routes.go",
  content: `
package routes

func Register(r *gin.Engine) {
	v1 := r.Group("/api/v1")
	shopHandler := handler.NewShopHandler(c.ShopService)
	pointerHandler := &handler.ShopHandler{}
	v1.POST("/shop/buy", shopHandler.Buy)
	v1.POST("/shop/pointer-buy", pointerHandler.Buy)
}
`,
}

describe("parseGinProject — handlers built as local variables", () => {
  const files = [CONSTRUCTED_MAIN_GO, AUTH_MIDDLEWARE_GO, CONSTRUCTED_ROUTES_GO, HANDLER_GO]
  const opts = { ownershipSources: ["currentCharacter"] }

  test("resolves the handler type from a NewXxx constructor call", () => {
    const g = route(parseGinProject(files, opts), "POST /api/v1/shop/buy")
    expect(g.nodes.find((n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK)?.symbol).toBe("ownership:currentCharacter")
  })

  test("resolves the handler type from an &pkg.Type{} literal", () => {
    const g = route(parseGinProject(files, opts), "POST /api/v1/shop/pointer-buy")
    expect(g.nodes.some((n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK)).toBe(true)
  })
})
