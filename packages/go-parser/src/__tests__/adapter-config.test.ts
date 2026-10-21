import { describe, test, expect, beforeEach, afterEach } from "@jest/globals"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join, dirname } from "path"
import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"
import { parseGinProjectAt } from "../adapter.js"

// The adapter reads archmind.json itself (like the Spring Boot and NestJS
// adapters), so every consumer — CLI, MCP server, LSP — gets the project's
// settings without wiring them through separately.

const FILES: Record<string, string> = {
  "go.mod": "module example.com/shop\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.9.1\n",
  "cmd/server/main.go": `
package main

func main() {
	r := gin.Default()
	v1 := r.Group("/api/v1")
	shopHandler := handler.NewShopHandler(c.ShopService)
	v1.POST("/shop/buy", shopHandler.Buy)
}
`,
  "internal/handler/shop.go": `
package handler

func (h *ShopHandler) Buy(c *gin.Context) {
	char, ok := currentCharacter(c, h.characters)
	if !ok {
		return
	}
	_ = char
}
`,
}

let root: string

const write = (rel: string, content: string) => {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

const hasOwnership = () =>
  parseGinProjectAt(root)[0].nodes.some((n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "archmind-go-"))
  for (const [rel, content] of Object.entries(FILES)) write(rel, content)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("parseGinProjectAt — archmind.json", () => {
  test("no config file: no ownership check is inferred", () => {
    expect(hasOwnership()).toBe(false)
  })

  test("authorization.ownershipSources turns a matching handler into an authz_check", () => {
    write("archmind.json", JSON.stringify({ authorization: { ownershipSources: ["currentCharacter"] } }))
    expect(hasOwnership()).toBe(true)
  })

  test("a malformed archmind.json is ignored instead of failing the parse", () => {
    write("archmind.json", "{ not json")
    expect(hasOwnership()).toBe(false)
  })

  test("explicit options win over the file", () => {
    write("archmind.json", JSON.stringify({ authorization: { ownershipSources: ["currentCharacter"] } }))
    const graphs = parseGinProjectAt(root, { ownershipSources: ["somethingElse"] })
    expect(graphs[0].nodes.some((n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK)).toBe(false)
  })
})
