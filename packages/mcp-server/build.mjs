#!/usr/bin/env node
import { build } from "esbuild"

console.log("Bundling MCP server...")
await build({
  entryPoints: ["src/index.ts"],
  bundle:      true,
  platform:    "node",
  format:      "cjs",
  outfile:     "dist/index.cjs",
  // Native modules cannot be bundled — keep as real npm deps
  external: [
    "tree-sitter",
    "tree-sitter-php",
  ],
  logLevel: "warning",
})

console.log("Done → dist/index.cjs")
