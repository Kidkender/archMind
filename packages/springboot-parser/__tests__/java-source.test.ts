import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"
import { parseSpringBootProject } from "../src/adapter.js"

// A controller well past tree-sitter 0.21's default 32 KiB parse buffer; the
// mapped, secured method comes after ~40 KB of filler.
function largeController(): string {
  const filler = Array.from({ length: 400 }, (_, i) =>
    `  private String helper${i}() { return "value value value value value value value value value ${i}"; }`,
  ).join("\n")
  return `
package com.example.web;
import org.springframework.web.bind.annotation.*;
import org.springframework.security.access.prepost.PreAuthorize;

@RestController
@RequestMapping("/api/reports")
public class ReportController {
${filler}

  @PreAuthorize("hasRole('ADMIN')")
  @DeleteMapping("/{id}")
  public void remove(@PathVariable Long id) { }
}
`
}

describe("parseSpringBootProject — large source files", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "archmind-sb-large-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("a controller larger than 32 KiB is parsed with its auth annotations", () => {
    const source = largeController()
    expect(source.length).toBeGreaterThan(32 * 1024)
    writeFileSync(join(dir, "ReportController.java"), source)

    const graphs = parseSpringBootProject(dir)

    expect(graphs).toHaveLength(1)
    expect(graphs[0]!.path).toContain("/api/reports")
    expect(graphs[0]!.nodes.map((n) => n.type)).toContain(IR_NODE_TYPES.AUTHZ_CHECK)
  })
})
