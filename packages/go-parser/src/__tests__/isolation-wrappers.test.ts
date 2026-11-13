import { describe, test, expect } from "@jest/globals"
import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { parseGinProject } from "../graph-builder.js"
import type { GoSourceFile } from "../route-parser.js"

// Layouts seen in real multi-tenant Gin apps, where the request reaches the
// query through package-level registries, typed locals and DAO / model wrappers
// rather than struct fields:
//  - "registry": handlers and services hung off package vars of structs that
//    embed them (api.Controllers.BoardApi.X, service.GroupApp.Board.X), the
//    tenant read off JWT claims, gorm-gen DAOs taking conditions as arguments.
//  - "model wrappers": controllers built by constructors, models as named
//    slices with Find(c, scopes...) and the tenant scope passed in by the caller.

function graphFor(graphs: IntermediateExecutionGraph[], route: string): IntermediateExecutionGraph {
  const [method, path] = route.split(" ")
  const g = graphs.find((x) => x.method === method && x.path === path)
  if (!g) throw new Error(`no graph for ${route}; have ${graphs.map((x) => `${x.method} ${x.path}`).join(", ")}`)
  return g
}

function typesOf(g: IntermediateExecutionGraph): string[] {
  return g.nodes.map((n) => n.type)
}

// --- registry layout --------------------------------------------------------

const REGISTRY_APP: GoSourceFile[] = [
  {
    path: "cmd/main.go",
    content: `
package main

func main() {
	r := gin.Default()
	api := r.Group("/api")
	apps.InitBoard(api)
}
`,
  },
  {
    path: "router/apps/board.go",
    content: `
package apps

func InitBoard(Router *gin.RouterGroup) {
	url := Router.Group("/board")
	url.POST("", api.Controllers.BoardApi.CreateBoard)
	url.POST("/raw", api.Controllers.BoardApi.CreateBoardRaw)
	url.GET("/:id", api.Controllers.BoardApi.GetBoard)
	url.GET("/:id/raw", api.Controllers.BoardApi.GetBoardRaw)
}
`,
  },
  {
    path: "internal/api/enter.go",
    content: `
package api

type Controller struct {
	BoardApi // boards
}

var (
	Controllers = new(Controller)
)
`,
  },
  {
    path: "internal/api/board.go",
    content: `
package api

type BoardApi struct{}

func (*BoardApi) CreateBoard(c *gin.Context) {
	var req model.CreateBoardReq
	userClaims := c.MustGet("claims").(*utils.UserClaims)
	req.TenantID = userClaims.TenantID
	service.GroupApp.Board.CreateBoard(c, &req)
}

func (*BoardApi) CreateBoardRaw(c *gin.Context) {
	var req model.CreateBoardReq
	userClaims := c.MustGet("claims").(*utils.UserClaims)
	log.Println(userClaims.TenantID)
	service.GroupApp.Board.CreateBoardRaw(c, &req)
}

func (*BoardApi) GetBoard(c *gin.Context) {
	userClaims := c.MustGet("claims").(*utils.UserClaims)
	service.GroupApp.Board.GetBoard(c, c.Param("id"), userClaims.TenantID)
}

func (*BoardApi) GetBoardRaw(c *gin.Context) {
	userClaims := c.MustGet("claims").(*utils.UserClaims)
	log.Println(userClaims.TenantID)
	service.GroupApp.Board.GetBoardRaw(c, c.Param("id"))
}
`,
  },
  {
    path: "internal/service/enter.go",
    content: `
package service

type ServiceGroup struct {
	Board
}

var GroupApp = new(ServiceGroup)
`,
  },
  {
    path: "internal/service/board.go",
    content: `
package service

type Board struct{}

func (*Board) CreateBoard(ctx context.Context, req *model.CreateBoardReq) error {
	db := dal.BoardQuery{}
	var board model.Board
	board.TenantID = req.TenantID
	board.Name = req.Name
	return db.Create(ctx, &board)
}

func (*Board) CreateBoardRaw(ctx context.Context, req *model.CreateBoardReq) error {
	db := dal.BoardQuery{}
	var board model.Board
	board.Name = req.Name
	return db.Create(ctx, &board)
}

func (*Board) GetBoard(ctx context.Context, id string, tenantID string) (*model.Board, error) {
	db := dal.BoardQuery{}
	return db.First(ctx, query.Board.ID.Eq(id), query.Board.TenantID.Eq(tenantID))
}

func (*Board) GetBoardRaw(ctx context.Context, id string) (*model.Board, error) {
	db := dal.BoardQuery{}
	return db.First(ctx, query.Board.ID.Eq(id))
}
`,
  },
  {
    path: "internal/dal/board.go",
    content: `
package dal

type BoardQuery struct{}

func (BoardQuery) First(ctx context.Context, option ...gen.Condition) (*model.Board, error) {
	return query.Board.WithContext(ctx).Where(option...).First()
}

func (BoardQuery) Create(ctx context.Context, b *model.Board) error {
	return query.Board.WithContext(ctx).Create(b)
}
`,
  },
  {
    path: "internal/model/board.go",
    content: `
package model

type Board struct {
	ID       string
	TenantID string
	Name     string
}
`,
  },
]

const TENANT_HOOK: GoSourceFile = {
  path: "initialize/gorm.go",
  content: `
package initialize

func RegisterHooks(db *gorm.DB) {
	db.Callback().Create().Before("gorm:create").Register("tenant:create", SetTenantOnCreate)
}

func SetTenantOnCreate(db *gorm.DB) {
	db.Statement.SetColumn("TenantID", tenantFrom(db.Statement.Context))
}
`,
}

describe("parseGinProject — tenant isolation through registries and DAOs", () => {
  test("a handler reached through a package var of embedded structs is read; a tenant field off JWT claims marks the tenant", () => {
    const g = graphFor(parseGinProject(REGISTRY_APP), "GET /api/board/:id")
    const ctx = g.nodes.find((n) => n.type === IR_NODE_TYPES.TENANT_CONTEXT)
    expect(ctx?.symbol).toContain("userClaims.TenantID")
    expect(ctx?.file).toBe("internal/api/board.go")
  })

  test("a DAO call given a tenant condition is ir:scoped_query", () => {
    const g = graphFor(parseGinProject(REGISTRY_APP), "GET /api/board/:id")
    const scoped = g.nodes.filter((n) => n.type === IR_NODE_TYPES.SCOPED_QUERY)
    expect(scoped.map((n) => n.symbol)).toEqual(["BoardQuery::First"])
    expect(scoped[0]!.file).toBe("internal/service/board.go")
    expect(typesOf(g)).not.toContain(IR_NODE_TYPES.UNSCOPED_QUERY)
  })

  test("a DAO call by id alone is ir:unscoped_query, judged at the call site", () => {
    const g = graphFor(parseGinProject(REGISTRY_APP), "GET /api/board/:id/raw")
    const unscoped = g.nodes.filter((n) => n.type === IR_NODE_TYPES.UNSCOPED_QUERY)
    expect(unscoped.map((n) => n.symbol)).toEqual(["BoardQuery::First"])
    expect(unscoped[0]!.file).toBe("internal/service/board.go")   // not the generic DAO body
    const ctx = g.nodes.find((n) => n.type === IR_NODE_TYPES.TENANT_CONTEXT)!
    expect(g.edges).toContainEqual(expect.objectContaining({
      from: unscoped[0]!.id, to: ctx.id, relation: "missing_tenant_scope",
    }))
  })

  test("a DAO create of a record tied to the tenant gets no node", () => {
    const g = graphFor(parseGinProject(REGISTRY_APP), "POST /api/board")
    expect(typesOf(g)).toContain(IR_NODE_TYPES.TENANT_CONTEXT)
    expect(typesOf(g)).not.toContain(IR_NODE_TYPES.UNSCOPED_WRITE)
  })

  test("a create without the tenant is ir:unscoped_write, unless a GORM create hook sets it", () => {
    const without = graphFor(parseGinProject(REGISTRY_APP), "POST /api/board/raw")
    const write = without.nodes.find((n) => n.type === IR_NODE_TYPES.UNSCOPED_WRITE)
    expect(write?.symbol).toBe("Board::Create")

    const withHook = graphFor(parseGinProject([...REGISTRY_APP, TENANT_HOOK]), "POST /api/board/raw")
    expect(typesOf(withHook)).not.toContain(IR_NODE_TYPES.UNSCOPED_WRITE)
  })
})

// --- model-wrapper layout ---------------------------------------------------

const MODEL_APP: GoSourceFile[] = [
  {
    path: "main.go",
    content: `
package main

func main() {
	r := gin.Default()
	routes.InitRoutes(r)
}
`,
  },
  {
    path: "app/routes/routes.go",
    content: `
package routes

func InitRoutes(r *gin.Engine) {
	roles := controllers.NewSysRoleController()
	menus := controllers.NewSysMenuController()
	api := r.Group("/api")
	api.GET("/roles", roles.List)
	api.GET("/roles/all", roles.All)
	api.GET("/roles/total", roles.Total)
	api.GET("/roles/total-all", roles.TotalAll)
	api.GET("/roles/:id", roles.Get)
	api.GET("/menus", menus.List)
}
`,
  },
  {
    path: "app/controllers/sysrole.go",
    content: `
package controllers

type SysRoleController struct{}

func NewSysRoleController() *SysRoleController {
	return &SysRoleController{}
}

func (rc *SysRoleController) List(c *gin.Context) {
	list := models.NewSysRoleList()
	list.Find(c, tenanthelper.TenantScope(c))
}

func (rc *SysRoleController) All(c *gin.Context) {
	_ = tenanthelper.GetTenantID(c)
	list := models.NewSysRoleList()
	list.Find(c, func(db *gorm.DB) *gorm.DB { return db })
}

func (rc *SysRoleController) Total(c *gin.Context) {
	list := models.NewSysRoleList()
	list.Total(c, tenanthelper.TenantScope(c))
}

func (rc *SysRoleController) TotalAll(c *gin.Context) {
	_ = tenanthelper.GetTenantID(c)
	list := models.NewSysRoleList()
	list.Total(c)
}

func (rc *SysRoleController) Get(c *gin.Context) {
	_ = tenanthelper.GetTenantID(c)
	role := models.NewSysRole()
	role.FindByID(c, c.Param("id"))
}
`,
  },
  {
    path: "app/controllers/sysmenu.go",
    content: `
package controllers

type SysMenuController struct{}

func NewSysMenuController() *SysMenuController {
	return &SysMenuController{}
}

func (mc *SysMenuController) List(c *gin.Context) {
	_ = tenanthelper.GetTenantID(c)
	list := models.NewSysMenuList()
	list.Find(c)
}
`,
  },
  {
    path: "app/models/sysrole.go",
    content: `
package models

type SysRole struct {
	BaseModel
	Name string
}

type SysRoleList []SysRole

func NewSysRoleList() SysRoleList {
	return SysRoleList{}
}

func NewSysRole() *SysRole {
	return &SysRole{}
}

func (l *SysRoleList) Find(c context.Context, funcs ...func(*gorm.DB) *gorm.DB) error {
	return app.DB().WithContext(c).Scopes(funcs...).Find(l).Error
}

func (l *SysRoleList) Total(c context.Context, funcs ...func(*gorm.DB) *gorm.DB) (total int64, err error) {
	err = app.DB().WithContext(c).Model(&SysRole{}).Scopes(funcs...).Count(&total).Error
	return
}

func (r *SysRole) FindByID(c context.Context, id string) error {
	return app.DB().WithContext(c).Preload("Tenant").Where("id = ?", id).First(r).Error
}
`,
  },
  {
    path: "app/models/base.go",
    content: `
package models

type BaseModel struct {
	ID       uint
	TenantID uint
}
`,
  },
  {
    path: "app/models/sysmenu.go",
    content: `
package models

type SysMenu struct {
	ID    uint
	Title string
}

type SysMenuList []SysMenu

func NewSysMenuList() SysMenuList {
	return SysMenuList{}
}

func (l *SysMenuList) Find(c context.Context, funcs ...func(*gorm.DB) *gorm.DB) error {
	return app.DB().WithContext(c).Scopes(funcs...).Find(l).Error
}
`,
  },
]

describe("parseGinProject — tenant isolation through model wrappers", () => {
  test("a handler on a controller built by a constructor is read; a tenant-named function of the context marks the tenant", () => {
    const g = graphFor(parseGinProject(MODEL_APP), "GET /api/roles")
    const ctx = g.nodes.find((n) => n.type === IR_NODE_TYPES.TENANT_CONTEXT)
    expect(ctx?.symbol).toContain("TenantScope(c)")
    expect(ctx?.file).toBe("app/controllers/sysrole.go")
  })

  test("a wrapper call given the tenant scope is scoped; one without it is not", () => {
    const graphs = parseGinProject(MODEL_APP)

    const scoped = graphFor(graphs, "GET /api/roles")
    expect(scoped.nodes.filter((n) => n.type === IR_NODE_TYPES.SCOPED_QUERY).map((n) => n.symbol))
      .toEqual(["SysRoleList::Find"])
    expect(typesOf(scoped)).not.toContain(IR_NODE_TYPES.UNSCOPED_QUERY)

    const all = graphFor(graphs, "GET /api/roles/all")
    expect(all.nodes.filter((n) => n.type === IR_NODE_TYPES.UNSCOPED_QUERY).map((n) => n.symbol))
      .toEqual(["SysRoleList::Find"])
  })

  test("Scopes(funcs...) inside a followed method is judged by the caller's arguments", () => {
    const graphs = parseGinProject(MODEL_APP)

    const total = graphFor(graphs, "GET /api/roles/total")
    expect(total.nodes.filter((n) => n.type === IR_NODE_TYPES.SCOPED_QUERY).map((n) => n.symbol))
      .toEqual(["SysRole::Count"])

    const totalAll = graphFor(graphs, "GET /api/roles/total-all")
    expect(totalAll.nodes.filter((n) => n.type === IR_NODE_TYPES.UNSCOPED_QUERY).map((n) => n.symbol))
      .toEqual(["SysRole::Count"])
  })

  test("Preload(\"Tenant\") loads a relation and does not scope the query", () => {
    const g = graphFor(parseGinProject(MODEL_APP), "GET /api/roles/:id")
    expect(g.nodes.filter((n) => n.type === IR_NODE_TYPES.UNSCOPED_QUERY).map((n) => n.symbol))
      .toEqual(["SysRole::First"])
  })

  test("a query on a shared table (a model without a tenant field) is not reported", () => {
    const g = graphFor(parseGinProject(MODEL_APP), "GET /api/menus")
    expect(typesOf(g)).toContain(IR_NODE_TYPES.TENANT_CONTEXT)
    expect(typesOf(g)).not.toContain(IR_NODE_TYPES.UNSCOPED_QUERY)
  })
})
