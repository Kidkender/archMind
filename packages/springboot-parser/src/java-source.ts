import { readFileSync } from "fs"
import type Parser from "tree-sitter"

/**
 * tree-sitter 0.21 parses a string through a fixed-size buffer (32 KiB by
 * default) and throws "Invalid argument" for longer input. Size the buffer to
 * the source so large files (big controllers, generated code) are parsed instead
 * of failing.
 */
export function parseOptionsFor(source: string): { bufferSize: number } | undefined {
  return source.length >= 32 * 1024 ? { bufferSize: source.length * 2 } : undefined
}

/**
 * Parses `source` with `parser`. A parse failure is reported on stderr with the
 * file path and yields null, so the caller skips the file — it no longer reads
 * as "this file has nothing in it".
 */
export function parseSource(parser: Parser, source: string, filePath: string): Parser.Tree | null {
  try {
    return parser.parse(source, undefined, parseOptionsFor(source))
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(`[archmind] springboot-parser: could not parse ${filePath}: ${reason} (file skipped)`)
    return null
  }
}

/** Reads a file. A file that cannot be read (missing, a directory, no access) yields null. */
export function readSource(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf-8")
  } catch {
    return null
  }
}

/** Reads and parses a Java file; null when it cannot be read or parsed (see parseSource). */
export function parseJavaFile(parser: Parser, filePath: string): { source: string; tree: Parser.Tree } | null {
  const source = readSource(filePath)
  if (source === null) return null
  const tree = parseSource(parser, source, filePath)
  if (!tree) return null
  return { source, tree }
}
