#!/usr/bin/env node
import { build } from "esbuild"

console.log("Bundling MCP server...")
await build({
  entryPoints: ["src/index.ts"],
  bundle:      true,
  platform:    "node",
  format:      "cjs",
  outfile:     "dist/index.cjs",
  // Native modules + large packages kept as real npm deps
  external: [
    "tree-sitter",
    "tree-sitter-php",
    "ts-morph",         // ships TypeScript compiler (~20MB) — too large to bundle
    "typescript",       // ts-morph peer dep
  ],
  logLevel: "warning",
})

console.log("Done → dist/index.cjs")
