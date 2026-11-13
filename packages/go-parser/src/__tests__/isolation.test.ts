import { describe, test, expect } from "@jest/globals"
import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { parseGinProject } from "../graph-builder.js"
import type { GoSourceFile } from "../route-parser.js"
import { tokenMatcher } from "../isolation-parser.js"

// A multi-tenant Gin + GORM API: the handler reads the tenant from the Gin
// context, the service passes it on, the repository runs the query. Each GORM
// query on a route that resolves a tenant becomes scoped or unscoped.

function mainGo(globalMiddleware: string): GoSourceFile {
  return {
    path: "cmd/server/main.go",
    content: `
package main

func main() {
	r := gin.Default()
	${globalMiddleware}
	api := r.Group("/api/v1")
	RegisterOrderRoutes(api, orderHandler)
}
`,
  }
}

const ROUTES_GO: GoSourceFile = {
  path: "routes/order.go",
  content: `
package routes

func RegisterOrderRoutes(router gin.IRouter, handler *handler.OrderHandler) {
	orders := router.Group("/orders")
	orders.GET("/:id", handler.Get)
	orders.GET("/:id/raw", handler.GetRaw)
	orders.DELETE("/:id", handler.Delete)
	orders.POST("", handler.Create)
}
`,
}

const MIDDLEWARE_GO: GoSourceFile = {
  path: "internal/middleware/tenant.go",
  content: `
package middleware

func TenantMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set("tenant_id", c.GetHeader("X-Tenant"))
		c.Next()
	}
}
`,
}

function handlerGo(readsTenant: boolean): GoSourceFile {
  const tenant = readsTenant ? `tenantID := c.GetString("tenant_id")` : `tenantID := ""`
  return {
    path: "internal/handler/order.go",
    content: `
package handler

type OrderHandler struct {
	orderService *service.OrderService
}

func (h *OrderHandler) Get(c *gin.Context) {
	${tenant}
	h.orderService.Get(tenantID, c.Param("id"))
}

func (h *OrderHandler) GetRaw(c *gin.Context) {
	${tenant}
	h.orderService.GetRaw(c.Param("id"))
}

func (h *OrderHandler) Delete(c *gin.Context) {
	${tenant}
	h.orderService.Delete(c.Param("id"))
}

func (h *OrderHandler) Create(c *gin.Context) {
	${tenant}
	h.orderService.Create(tenantID)
}
`,
  }
}

const SERVICE_GO: GoSourceFile = {
  path: "internal/service/order.go",
  content: `
package service

type OrderService struct {
	repo *repository.OrderRepository
}

func (s *OrderService) Get(tenantID string, id string) (*model.Order, error) {
	return s.repo.FindForTenant(tenantID, id)
}

func (s *OrderService) GetRaw(id string) (*model.Order, error) {
	return s.repo.FindByID(id)
}

func (s *OrderService) Delete(id string) error {
	return s.repo.Delete(id)
}

func (s *OrderService) Create(tenantID string) error {
	return s.repo.Create(tenantID)
}
`,
}

const REPOSITORY_GO: GoSourceFile = {
  path: "internal/repository/order.go",
  content: `
package repository

type OrderRepository struct {
	db *gorm.DB
}

func (r *OrderRepository) FindForTenant(tenantID string, id string) (*model.Order, error) {
	var order model.Order
	err := r.db.Where("tenant_id = ? AND id = ?", tenantID, id).First(&order).Error
	return &order, err
}

func (r *OrderRepository) FindByID(id string) (*model.Order, error) {
	var order model.Order
	err := r.db.First(&order, id).Error
	return &order, err
}

func (r *OrderRepository) Delete(id string) error {
	return r.db.Delete(&model.Order{}, id).Error
}

func (r *OrderRepository) Create(tenantID string) error {
	order := model.Order{TenantID: tenantID, Status: "new"}
	return r.db.Create(&order).Error
}
`,
}

function graphFor(graphs: IntermediateExecutionGraph[], entry: string): IntermediateExecutionGraph {
  const g = graphs.find((x) => x.entrypoint === entry)
  if (!g) throw new Error(`no graph for ${entry}; have ${graphs.map((x) => x.entrypoint).join(", ")}`)
  return g
}

function typesOf(g: IntermediateExecutionGraph): string[] {
  return g.nodes.map((n) => n.type)
}

describe("parseGinProject — tenant isolation", () => {
  const tenantApp = [mainGo(""), ROUTES_GO, MIDDLEWARE_GO, handlerGo(true), SERVICE_GO, REPOSITORY_GO]

  test("a query constrained by tenant_id two calls below the handler is ir:scoped_query", () => {
    const g = graphFor(parseGinProject(tenantApp), "GET /api/v1/orders/:id")

    const ctx = g.nodes.find((n) => n.type === IR_NODE_TYPES.TENANT_CONTEXT)
    expect(ctx?.symbol).toContain("tenant")
    expect(ctx?.symbol).toContain(`c.GetString("tenant_id")`)

    const scoped = g.nodes.filter((n) => n.type === IR_NODE_TYPES.SCOPED_QUERY)
    expect(scoped.map((n) => n.symbol)).toEqual(["Order::First"])
    expect(scoped[0]!.file).toBe("internal/repository/order.go")
    expect(typesOf(g)).not.toContain(IR_NODE_TYPES.UNSCOPED_QUERY)
    expect(g.edges.some((e) => e.relation === "missing_tenant_scope")).toBe(false)
  })

  test("a lookup by id alone is ir:unscoped_query with a missing_tenant_scope edge", () => {
    const g = graphFor(parseGinProject(tenantApp), "GET /api/v1/orders/:id/raw")

    const unscoped = g.nodes.find((n) => n.type === IR_NODE_TYPES.UNSCOPED_QUERY)
    expect(unscoped?.symbol).toBe("Order::First")
    const ctx = g.nodes.find((n) => n.type === IR_NODE_TYPES.TENANT_CONTEXT)!
    expect(g.edges).toContainEqual(expect.objectContaining({
      from: unscoped!.id, to: ctx.id, relation: "missing_tenant_scope",
    }))
  })

  test("a delete by id alone is ir:unscoped_write", () => {
    const g = graphFor(parseGinProject(tenantApp), "DELETE /api/v1/orders/:id")

    const write = g.nodes.find((n) => n.type === IR_NODE_TYPES.UNSCOPED_WRITE)
    expect(write?.symbol).toBe("Order::Delete")
  })

  test("a create whose struct literal sets TenantID is scoped and gets no node", () => {
    const g = graphFor(parseGinProject(tenantApp), "POST /api/v1/orders")

    expect(typesOf(g)).toContain(IR_NODE_TYPES.TENANT_CONTEXT)
    expect(typesOf(g)).not.toContain(IR_NODE_TYPES.UNSCOPED_WRITE)
  })

  test("a single-tenant app gets no isolation nodes at all", () => {
    const graphs = parseGinProject([mainGo(""), ROUTES_GO, handlerGo(false), SERVICE_GO, REPOSITORY_GO])

    for (const g of graphs) {
      expect(typesOf(g)).not.toContain(IR_NODE_TYPES.TENANT_CONTEXT)
      expect(typesOf(g)).not.toContain(IR_NODE_TYPES.UNSCOPED_QUERY)
      expect(typesOf(g)).not.toContain(IR_NODE_TYPES.UNSCOPED_WRITE)
      expect(typesOf(g)).not.toContain(IR_NODE_TYPES.SCOPED_QUERY)
    }
  })

  test("a tenant middleware on the route is enough to mark the tenant context", () => {
    const graphs = parseGinProject([
      mainGo("r.Use(middleware.TenantMiddleware())"), ROUTES_GO, MIDDLEWARE_GO, handlerGo(false), SERVICE_GO, REPOSITORY_GO,
    ])
    const g = graphFor(graphs, "GET /api/v1/orders/:id/raw")

    const ctx = g.nodes.find((n) => n.type === IR_NODE_TYPES.TENANT_CONTEXT)
    expect(ctx?.symbol).toContain("TenantMiddleware")
    expect(typesOf(g)).toContain(IR_NODE_TYPES.UNSCOPED_QUERY)
  })

  test("archmind.json isolation signals replace the defaults", () => {
    const handler: GoSourceFile = {
      path: "internal/handler/order.go",
      content: handlerGo(true).content.replace(/c\.GetString\("tenant_id"\)/g, `c.GetString("workspace_id")`),
    }
    const repository: GoSourceFile = {
      path: REPOSITORY_GO.path,
      content: REPOSITORY_GO.content.replace(`"tenant_id = ? AND id = ?"`, `"workspace_id = ? AND id = ?"`),
    }
    const graphs = parseGinProject(
      [mainGo(""), ROUTES_GO, handler, SERVICE_GO, repository],
      { isolation: { tenantSignals: ["workspace_id"], tenantContextKeys: ["workspace"] } },
    )

    expect(typesOf(graphFor(graphs, "GET /api/v1/orders/:id"))).toContain(IR_NODE_TYPES.SCOPED_QUERY)
    expect(typesOf(graphFor(graphs, "GET /api/v1/orders/:id/raw"))).toContain(IR_NODE_TYPES.UNSCOPED_QUERY)
  })
})

describe("tokenMatcher", () => {
  test("matches identifier and string tokens, ignoring case and underscores", () => {
    const match = tokenMatcher(["tenant", "org_id"])
    expect(match(`Where("tenant_id = ?", id)`)).toBe(true)
    expect(match("order.TenantID")).toBe(true)
    expect(match("Scopes(TenantScope(t))")).toBe(true)
    expect(match(`Where("OrgID = ?", x)`)).toBe(true)
    expect(match(`Where("org", id)`)).toBe(false)
    expect(match("First(&order, id)")).toBe(false)
  })
})
