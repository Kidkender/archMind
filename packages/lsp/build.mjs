import { build } from "esbuild"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [join(__dirname, "src/server.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: join(__dirname, "dist/lsp.cjs"),
  // analysis is loaded at runtime from its own install: it pulls in go-parser,
  // which needs tree-sitter 0.25 and tree-sitter-go (a native module esbuild
  // cannot bundle), while lsp itself runs tree-sitter 0.21.
  external: ["tree-sitter", "tree-sitter-php", "tree-sitter-java", "ts-morph", "@kidkender/archmind-analysis"],
  banner: { js: "#!/usr/bin/env node" },
  minify: false,
})

console.log("Done → dist/lsp.cjs")
