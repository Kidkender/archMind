import { describe, test, expect } from "@jest/globals"
import { extractRoutes, type GoSourceFile } from "../route-parser.js"

// A function that receives the engine (`func Init(e *gin.Engine)`) is a starting point of its own when nothing
// the walk reached calls it, e.g. when the engine is built inside a command closure in another package.

const file = (path: string, content: string): GoSourceFile => ({ path, content })
const routes = (files: GoSourceFile[]) => extractRoutes(files).map((r) => `${r.method} ${r.path}`)

const init = file("server/router.go", `package server
func Init(e *gin.Engine) {
	api := e.Group("/api")
	api.GET("/ping", ping)
}
`)

describe("functions that receive the engine", () => {
  test("starts from a function that takes the engine when nothing reaches it", () => {
    expect(routes([init])).toEqual(["GET /api/ping"])
  })

  test("lists a route once, with the prefix the caller gave it, when main reaches the function", () => {
    const main = file("main.go", `package main
func main() {
	r := gin.Default()
	server.Init(r)
}
`)
    expect(routes([main, init])).toEqual(["GET /api/ping"])
  })

  test("does not start from a function that takes only a route group, whose prefix is unknown", () => {
    const registrar = file("server/users.go", `package server
func Users(g *gin.RouterGroup) {
	g.GET("/list", list)
}
`)
    expect(routes([registrar])).toEqual([])
  })

  test("does not start from a function that takes an engine of another package", () => {
    const other = file("other/o.go", `package other
func Init(e *echo.Echo) {
	e.GET("/x", h)
}
`)
    expect(routes([other])).toEqual([])
  })
})
