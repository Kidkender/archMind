import { describe, test, expect } from "@jest/globals"
import { parseGo, walk } from "../ast.js"

describe("walk", () => {
  const root = parseGo(`package p
func f(a int) int {
	if a > 0 {
		return g(a)
	}
	return 0
}
`)

  test("visits the node itself first", () => {
    expect([...walk(root)][0].type).toBe("source_file")
  })

  test("visits named descendants in source order, parents before children", () => {
    const types = [...walk(root)].map((n) => n.type)
    expect(types.indexOf("function_declaration")).toBeLessThan(types.indexOf("if_statement"))
    expect(types.indexOf("if_statement")).toBeLessThan(types.indexOf("call_expression"))
    const calls = [...walk(root)].filter((n) => n.type === "return_statement").map((n) => n.startPosition.row)
    expect(calls).toEqual([3, 5])
  })

  test("visits exactly the named nodes that a recursive walk would", () => {
    const recursive: string[] = []
    const visit = (n: ReturnType<typeof parseGo>): void => {
      recursive.push(`${n.type}@${n.startIndex}`)
      for (const c of n.namedChildren) visit(c)
    }
    visit(root)
    expect([...walk(root)].map((n) => `${n.type}@${n.startIndex}`)).toEqual(recursive)
  })

  test("can be stopped early without visiting the rest", () => {
    const seen: string[] = []
    for (const n of walk(root)) { seen.push(n.type); if (n.type === "function_declaration") break }
    expect(seen).toEqual(["source_file", "package_clause", "package_identifier", "function_declaration"])
  })
})
