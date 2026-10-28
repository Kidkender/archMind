import { describe, test, expect } from "@jest/globals"
import { extractRoutes, type GoSourceFile } from "../route-parser.js"

// Groups are often built and used in one expression: `r.Group("/api").Use(mw)`, or passed straight to a registrar:
// `users.Register(v1.Group("/users"))`.

const file = (content: string): GoSourceFile => ({ path: "main.go", content })
const routes = (content: string) => extractRoutes([file(content)]).map((r) => `${r.method} ${r.path} [${r.middleware.map((m) => m.text).join(",")}]`)

describe("groups built in one expression", () => {
  test("keeps a group created with Group(...).Use(...)", () => {
    expect(routes(`package main
func main() {
	r := gin.Default()
	api := r.Group("/api").Use(audit())
	api.GET("/a", h)
}`)).toEqual(["GET /api/a [audit()]"])
  })

  test("keeps the middleware of every Use in a chain", () => {
    expect(routes(`package main
func main() {
	r := gin.Default()
	api := r.Group("/api").Use(one()).Use(two())
	api.GET("/a", h)
}`)).toEqual(["GET /api/a [one(),two()]"])
  })

  test("keeps a group created from a chained group", () => {
    expect(routes(`package main
func main() {
	r := gin.Default()
	api := r.Group("/api").Use(one())
	v1 := api.Group("/v1")
	v1.GET("/a", h)
}`)).toEqual(["GET /api/v1/a [one()]"])
  })
})

describe("a group passed to a registrar as an expression", () => {
  const registrar = `
func Register(g *gin.RouterGroup) {
	g.GET("/list", list)
}`

  test("follows a Group(...) call given as the argument", () => {
    expect(routes(`package main
func main() {
	r := gin.Default()
	v1 := r.Group("/api")
	Register(v1.Group("/users"))
}` + registrar)).toEqual(["GET /api/users/list []"])
  })

  test("follows a group with middleware given as the argument", () => {
    expect(routes(`package main
func main() {
	r := gin.Default()
	Register(r.Group("/x").Use(mw()))
}` + registrar)).toEqual(["GET /x/list [mw()]"])
  })

  test("still follows a group passed as a variable", () => {
    expect(routes(`package main
func main() {
	r := gin.Default()
	g := r.Group("/g")
	Register(g)
}` + registrar)).toEqual(["GET /g/list []"])
  })

  test("ignores an argument that is not a group", () => {
    expect(routes(`package main
func main() {
	r := gin.Default()
	Register(other.Group("/x"))
}` + registrar)).toEqual([])
  })
})
