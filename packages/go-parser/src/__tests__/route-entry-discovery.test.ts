import { describe, test, expect } from "@jest/globals"
import { extractRoutes, type GoSourceFile } from "../route-parser.js"

// A server often builds its engine a few calls away from main (main -> core.RunServer -> initialize.Routers),
// so the routes are not found by following main alone.

const file = (path: string, content: string): GoSourceFile => ({ path, content })

const deepMain = file("main.go", `package main
func main() { core.RunServer() }
`)
const runServer = file("core/server.go", `package core
func RunServer() {
	router := initialize.Routers()
	router.Run(":8080")
}
`)
const routers = file("initialize/router.go", `package initialize
func Routers() *gin.Engine {
	r := gin.New()
	api := r.Group("/api")
	api.GET("/ping", ping)
	api.POST("/orders", createOrder)
	return r
}
`)

const summary = (files: GoSourceFile[], opts = {}) => extractRoutes(files, opts).map((r) => `${r.method} ${r.path}`)

describe("finding the function that builds the engine", () => {
  test("finds routes registered by an engine built several calls away from main", () => {
    expect(summary([deepMain, runServer, routers])).toEqual(["GET /api/ping", "POST /api/orders"])
  })

  test("does not list a route twice when main also reaches the function that builds the engine", () => {
    const main = file("main.go", `package main
func main() { r := initialize.Routers(); r.Run(":8080") }
`)
    expect(summary([main, routers])).toEqual(["GET /api/ping", "POST /api/orders"])
  })

  test("keeps the routes main reaches directly", () => {
    const main = file("main.go", `package main
func main() {
	r := gin.Default()
	r.GET("/health", health)
	r.Run(":8080")
}
`)
    expect(summary([main, runServer, routers])).toEqual(["GET /health", "GET /api/ping", "POST /api/orders"])
  })

  test("starts only from the named function when an entry function is given", () => {
    const other = file("other.go", `package other
func Other() *gin.Engine {
	r := gin.New()
	r.GET("/other", h)
	return r
}
`)
    expect(summary([deepMain, runServer, routers, other], { entryFunction: "Other" })).toEqual(["GET /other"])
  })

  test("finds nothing when no function builds an engine", () => {
    const main = file("main.go", `package main
func main() { println("hi") }
`)
    expect(summary([main])).toEqual([])
  })
})
