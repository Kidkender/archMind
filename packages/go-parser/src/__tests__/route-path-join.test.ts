import { describe, test, expect } from "@jest/globals"
import { extractRoutes, joinPaths, type GoSourceFile } from "../route-parser.js"

// Gin joins a group's prefix and a route's path with path.Join, so slashes are
// optional on either side: Group("api").Group("v1").POST("device") serves
// /api/v1/device. Plain concatenation produced "apiv1device".

const file = (content: string): GoSourceFile => ({ path: "main.go", content })
const paths = (content: string) => extractRoutes([file(content)]).map((r) => `${r.method} ${r.path}`)

describe("joinPaths", () => {
  test.each([
    ["", "", ""],
    ["", "/", "/"],
    ["", "api", "/api"],
    ["/api", "v1", "/api/v1"],
    ["/api/", "/v1", "/api/v1"],
    ["/api", "", "/api"],
    ["/api", "/", "/api/"],
    ["/api", "users/", "/api/users/"],
    ["/api", "//users", "/api/users"],
    ["/api", ":id", "/api/:id"],
    ["/files", "*filepath", "/files/*filepath"],
  ])("joinPaths(%j, %j) = %j", (base, relative, expected) => {
    expect(joinPaths(base, relative)).toBe(expected)
  })
})

describe("route paths built from groups without slashes", () => {
  test("groups and routes written without leading slashes", () => {
    expect(paths(`package main
func main() {
	r := gin.Default()
	api := r.Group("api")
	v1 := api.Group("v1")
	device := v1.Group("device")
	device.POST("", create)
	device.GET(":id", get)
	device.GET("detail/:id", detail)
}`)).toEqual(["POST /api/v1/device", "GET /api/v1/device/:id", "GET /api/v1/device/detail/:id"])
  })

  test("a trailing slash on the group does not double up", () => {
    expect(paths(`package main
func main() {
	r := gin.Default()
	api := r.Group("/api/")
	api.GET("/users", list)
}`)).toEqual(["GET /api/users"])
  })

  test("a route on the engine with an empty path is /", () => {
    expect(paths(`package main
func main() {
	r := gin.Default()
	r.GET("", home)
}`)).toEqual(["GET /"])
  })
})
