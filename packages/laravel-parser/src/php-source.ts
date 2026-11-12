import { readFileSync } from "fs"
import type Parser from "tree-sitter"

/**
 * tree-sitter 0.21 parses a string through a fixed-size buffer (32 KiB by
 * default) and throws "Invalid argument" for longer input. Size the buffer to
 * the source so large files (big controllers, fat services) are parsed instead
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
    console.warn(`[archmind] laravel-parser: could not parse ${filePath}: ${reason} (file skipped)`)
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

/**
 * Parsed files, most recently used last. A route is analysed by several modules
 * (controller, transaction, isolation, guard clauses, audit log), each of which
 * used to re-parse the same controller or service for every route — hundreds of
 * parses of one large file per project. An entry is reused only while the file's
 * content is unchanged, so an edited file is parsed again. Trees are only read,
 * never edited, so sharing one between modules is safe.
 */
const parsed = new Map<string, { source: string; tree: Parser.Tree }>()
/** Files kept parsed at once; enough for a route's controller and the services it reaches. */
const PARSE_CACHE_SIZE = 32

/** Reads and parses a PHP file; null when it cannot be read or parsed (see parseSource). */
export function parsePhpFile(parser: Parser, filePath: string): { source: string; tree: Parser.Tree } | null {
  const source = readSource(filePath)
  if (source === null) return null
  const hit = parsed.get(filePath)
  if (hit && hit.source === source) {
    parsed.delete(filePath)
    parsed.set(filePath, hit)
    return hit
  }
  const tree = parseSource(parser, source, filePath)
  if (!tree) return null
  const entry = { source, tree }
  parsed.delete(filePath)
  parsed.set(filePath, entry)
  if (parsed.size > PARSE_CACHE_SIZE) parsed.delete(parsed.keys().next().value as string)
  return entry
}

/**
 * The first method named `name` in document order (as the old recursive walks
 * found it). `descendantsOfType` walks the tree natively and only wraps the
 * matches; walking `.children` recursively built a JS array at every node of
 * every method body, which made each lookup on a large file cost a full-tree
 * allocation.
 */
export function findMethod(root: Parser.SyntaxNode, name: string): Parser.SyntaxNode | null {
  // from a tree's root, look the method up in that tree's index (built once per tree)
  if (!root.parent) {
    let index = methodIndex.get(root.tree)
    if (!index) {
      index = new Map()
      for (const method of root.descendantsOfType("method_declaration")) {
        const methodName = method.childForFieldName("name")?.text
        if (methodName && !index.has(methodName)) index.set(methodName, method)   // first in document order
      }
      methodIndex.set(root.tree, index)
    }
    return index.get(name) ?? null
  }
  for (const method of root.descendantsOfType("method_declaration")) {
    if (method.childForFieldName("name")?.text === name) return method
  }
  return null
}

/** Method name → first method_declaration with that name, per tree. */
const methodIndex = new WeakMap<Parser.Tree, Map<string, Parser.SyntaxNode>>()
