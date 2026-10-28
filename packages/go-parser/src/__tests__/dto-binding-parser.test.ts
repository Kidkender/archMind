import { describe, test, expect } from "@jest/globals"
import { parseGo } from "../ast.js"
import { findStructFields, findStructFieldTypes, resolveDtoBinding } from "../dto-binding-parser.js"

const source = `package p

type Order struct {
	Name  string \`binding:"required"\`
	Total int
}

type Order2 interface{ Run() }

type Service struct {
	orders *OrderService
	db     DB
}

func f() {
	type local struct{ id int }
}
`

describe("struct lookup", () => {
  const root = parseGo(source)

  test("reads a struct's bound fields", () => {
    expect(findStructFields(root, "Order")).toEqual([
      { name: "Name", bindingTag: "required" },
      { name: "Total", bindingTag: null },
    ])
  })

  test("reads a struct's field types by bare type name", () => {
    expect([...(findStructFieldTypes(root, "Service") ?? [])]).toEqual([
      ["orders", "OrderService"],
      ["db", "DB"],
    ])
  })

  test("finds a struct declared inside a function", () => {
    expect([...(findStructFieldTypes(root, "local") ?? [])]).toEqual([["id", "int"]])
  })

  test("returns null for a name that is not a struct", () => {
    expect(findStructFields(root, "Order2")).toBeNull()
    expect(findStructFieldTypes(root, "Missing")).toBeNull()
  })

  test("takes the first struct when a name is declared twice", () => {
    const twice = parseGo(`package p
type T struct{ a int }
type T struct{ b string }
`)
    expect([...(findStructFieldTypes(twice, "T") ?? [])]).toEqual([["a", "int"]])
  })

  test("skips a same-named declaration that is not a struct", () => {
    const mixed = parseGo(`package p
type T interface{ Run() }
type T struct{ a int }
`)
    expect([...(findStructFieldTypes(mixed, "T") ?? [])]).toEqual([["a", "int"]])
  })

  test("gives the same answer on repeated lookups and for separate roots", () => {
    const other = parseGo(`package p
type Order struct{ Only string }
`)
    expect(findStructFields(root, "Order")).toEqual(findStructFields(root, "Order"))
    expect(findStructFields(other, "Order")).toEqual([{ name: "Only", bindingTag: null }])
    expect(findStructFields(root, "Order")?.length).toBe(2)
  })

  test("resolves a type across files and names the file that declares it", () => {
    const files = [
      { path: "a.go", root: parseGo("package p\ntype A struct{ x int }\n") },
      { path: "b.go", root: root },
    ]
    expect(resolveDtoBinding("Order", files)?.file).toBe("b.go")
    expect(resolveDtoBinding("Nope", files)).toBeNull()
  })
})
