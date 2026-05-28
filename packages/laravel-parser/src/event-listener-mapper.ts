import { readFileSync, existsSync } from "fs"
import { join } from "path"
// @ts-ignore
import Parser from "tree-sitter"
// @ts-ignore
import PHP from "tree-sitter-php"

import { extractUseMap } from "./controller-parser.js"
import { fqcnToPath } from "./project-config.js"

const _parser = new Parser()
_parser.setLanguage((PHP as { php?: unknown }).php ?? PHP)

// ---- Public API -------------------------------------------------------

export interface ListenerEntry {
  /** e.g. "App\Listeners\SendTaskCreatedNotification" */
  listenerFqcn: string
  /** Relative path, e.g. "app/Listeners/SendTaskCreatedNotification.php" */
  listenerFile: string | undefined
  /**
   * true when the listener implements ShouldHandleEventsAfterCommit or declares
   * public $afterCommit = true — meaning it runs only after the transaction commits
   * and therefore does NOT escape.
   */
  isAfterCommitSafe: boolean
}

/** event short class name → listeners */
export type EventListenerMap = Map<string, ListenerEntry[]>

/**
 * Parse app/Providers/EventServiceProvider.php and return the event→listener map.
 * Only supports the $listen array property (not boot() Event::listen() calls or
 * auto-discovery — note those as known gaps if needed).
 *
 * Returns an empty map when the file is absent, unparseable, or has no $listen.
 */
export function parseEventListeners(
  projectRoot: string,
  namespaces: Record<string, string>
): EventListenerMap {
  const providerPath = join(projectRoot, "app/Providers/EventServiceProvider.php")
  if (!existsSync(providerPath)) return new Map()

  let source: string
  let tree: ReturnType<typeof _parser.parse>
  try {
    source = readFileSync(providerPath, "utf-8")
    tree = _parser.parse(source)
  } catch {
    return new Map()
  }

  const root   = tree.rootNode as AstNode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const useMap = extractUseMap(root as any)
  const listenArray = findListenArray(root)
  if (!listenArray) return new Map()

  const map: EventListenerMap = new Map()

  for (const outerElem of listenArray.children as AstNode[]) {
    if (outerElem.type !== "array_element_initializer") continue

    // namedChildren: [key, value_array]  (=> is anonymous)
    const named = outerElem.namedChildren as AstNode[]
    if (named.length < 2) continue

    const eventShort = resolveClassRef(named[0], useMap)
    if (!eventShort) continue

    const listenerArrayNode = named[1]
    if (listenerArrayNode.type !== "array_creation_expression") continue

    const entries: ListenerEntry[] = []

    for (const innerElem of listenerArrayNode.children as AstNode[]) {
      if (innerElem.type !== "array_element_initializer") continue

      const innerNamed = innerElem.namedChildren as AstNode[]
      if (innerNamed.length < 1) continue

      // Simple value (no key): namedChildren[0] is the listener ref
      const listenerRef = innerNamed.length === 1 ? innerNamed[0] : null
      if (!listenerRef) continue

      const listenerFqcn = resolveClassRefToFqcn(listenerRef, useMap)
      if (!listenerFqcn) continue

      const listenerFile = fqcnToPath(listenerFqcn, namespaces) ?? undefined
      const isAfterCommitSafe = listenerFile
        ? checkAfterCommitSafe(join(projectRoot, listenerFile))
        : false

      entries.push({ listenerFqcn, listenerFile, isAfterCommitSafe })
    }

    if (entries.length > 0) {
      map.set(eventShort, entries)
    }
  }

  return map
}

// ---- Helpers ----------------------------------------------------------

type AstNode = { type: string; text: string; children: AstNode[]; namedChildren: AstNode[] }

/**
 * Find the array_creation_expression value of the `$listen` property declaration.
 */
function findListenArray(root: AstNode): AstNode | null {
  for (const node of walkAll(root)) {
    if (node.type !== "property_declaration") continue
    const elem = (node.namedChildren as AstNode[]).find(
      (c) => c.type === "property_element"
    )
    if (!elem) continue
    const varName = (elem.namedChildren as AstNode[]).find(
      (c) => c.type === "variable_name"
    )
    if (!varName || !varName.text.includes("listen")) continue

    const arrayNode = (elem.namedChildren as AstNode[]).find(
      (c) => c.type === "array_creation_expression"
    )
    return arrayNode ?? null
  }
  return null
}

/**
 * Resolve a ClassName::class expression or string FQCN node to the short class name.
 * Used for event keys where we only need the short name to match against dispatch symbols.
 */
function resolveClassRef(node: AstNode, _useMap: Map<string, string>): string | null {
  if (node.type === "class_constant_access_expression") {
    // children: [ClassName, ::, class]
    const nameNode = (node.children as AstNode[])[0]
    return nameNode?.text ?? null
  }
  if (node.type === "string") {
    // FQCN string: 'App\Events\TaskCreated' → short name
    const content = (node.children as AstNode[]).find(
      (c) => c.type === "string_content"
    )
    const raw = content?.text ?? ""
    return raw.split("\\").pop() ?? null
  }
  return null
}

/**
 * Resolve a listener class ref to its FQCN.
 * Handles ClassName::class (resolved via use map) and FQCN strings.
 */
function resolveClassRefToFqcn(node: AstNode, useMap: Map<string, string>): string | null {
  if (node.type === "class_constant_access_expression") {
    const nameNode = (node.children as AstNode[])[0]
    const short = nameNode?.text
    if (!short) return null
    return useMap.get(short) ?? short
  }
  if (node.type === "string") {
    const content = (node.children as AstNode[]).find(
      (c) => c.type === "string_content"
    )
    return content?.text?.replace(/\\\\/g, "\\") ?? null
  }
  return null
}

/**
 * Check if a listener class declares afterCommit safety, meaning it will only
 * run after the enclosing transaction commits (and therefore does NOT escape).
 *
 * Checks:
 *   1. implements ShouldHandleEventsAfterCommit
 *   2. public $afterCommit = true
 */
function checkAfterCommitSafe(filePath: string): boolean {
  let source: string
  try {
    source = readFileSync(filePath, "utf-8")
  } catch {
    return false
  }
  // Fast string scan — no need to parse AST for this check
  if (/ShouldHandleEventsAfterCommit/.test(source)) return true
  if (/\$afterCommit\s*=\s*true/.test(source)) return true
  return false
}

function* walkAll(node: AstNode): Generator<AstNode> {
  yield node
  for (const child of node.children as AstNode[]) {
    yield* walkAll(child)
  }
}
