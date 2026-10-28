import { describe, test, expect } from "@jest/globals"
import { extractRoutes, type GoSourceFile } from "../route-parser.js"

// Registrars added to a package-level slice in init() and called in a loop:
//   func init() { routers = append(routers, registerUsers) }
//   for _, f := range routers { f(v1) }

const file = (path: string, content: string): GoSourceFile => ({ path, content })
const routes = (files: GoSourceFile[]) => extractRoutes(files).map((r) => `${r.method} ${r.path}`).sort()

const dispatch = (dir: string) => file(`${dir}/router.go`, `package router
var routers = make([]func(*gin.RouterGroup), 0)
func Init(r *gin.Engine) {
	v1 := r.Group("/api/v1")
	for _, f := range routers {
		f(v1)
	}
}
`)
const register = (dir: string, name: string, path: string) => file(`${dir}/${name}.go`, `package router
func init() { routers = append(routers, register${name}) }
func register${name}(g *gin.RouterGroup) {
	g.GET("${path}", h)
}
`)

describe("registrars stored in a slice", () => {
  test("follows every function appended to the slice that the loop ranges over", () => {
    expect(routes([dispatch("admin"), register("admin", "Users", "/users"), register("admin", "Roles", "/roles")])).toEqual([
      "GET /api/v1/roles",
      "GET /api/v1/users",
    ])
  })

  test("follows several functions added by one append", () => {
    const both = file("admin/both.go", `package router
func init() { routers = append(routers, registerA, registerB) }
func registerA(g *gin.RouterGroup) { g.GET("/a", h) }
func registerB(g *gin.RouterGroup) { g.GET("/b", h) }
`)
    expect(routes([dispatch("admin"), both])).toEqual(["GET /api/v1/a", "GET /api/v1/b"])
  })

  test("keeps same-named slices and dispatchers of different packages apart", () => {
    expect(
      routes([dispatch("admin"), register("admin", "Users", "/users"), dispatch("jobs"), register("jobs", "Cron", "/cron")]),
    ).toEqual(["GET /api/v1/cron", "GET /api/v1/users"])
  })

  test("passes the group on when the loop calls the function with more arguments", () => {
    const withAuth = file("admin/router.go", `package router
var routers = make([]func(*gin.RouterGroup, string), 0)
func Init(r *gin.Engine) {
	v1 := r.Group("/api")
	for _, f := range routers {
		f(v1, "auth")
	}
}
`)
    const reg = file("admin/reg.go", `package router
func init() { routers = append(routers, regUsers) }
func regUsers(g *gin.RouterGroup, auth string) { g.GET("/users", h) }
`)
    expect(routes([withAuth, reg])).toEqual(["GET /api/users"])
  })

  test("ignores a slice nothing was appended to", () => {
    expect(routes([dispatch("admin")])).toEqual([])
  })
})
