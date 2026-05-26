import { readFileSync } from "fs"
import Parser from "tree-sitter"
// @ts-ignore
import PHP from "tree-sitter-php"

const _parser = new Parser()
_parser.setLanguage((PHP as { php?: unknown }).php ?? PHP)

// ---- Public API -------------------------------------------------------

export interface ModelQueryCall {
  /** e.g. "Task" */
  model: string
  /** "find" | "first" | "all" | "where" | "paginate" | "get" */
  operation: string
  /** true if a tenant-like constraint was detected in the call chain */
  hastenantConstraint: boolean
  callText: string
}

export interface IsolationParseResult {
  /** Model queries found in the file */
  modelQueries: ModelQueryCall[]
  /** true if the file reads tenant from container: app('tenant') */
  readsTenantFromContainer: boolean
}

export interface IsolationOptions {
  tenantSignals?: string[]
  tenantContainerKeys?: string[]
}

const DEFAULT_TENANT_SIGNALS = [
  "tenant_id", "tenantId", "tenant",
  "organization_id", "organizationId",
  "whereTenant", "whereTenantId", "forTenant",
  "whereOrganization", "whereOrganizationId",
]

const DEFAULT_TENANT_CONTAINER_KEYS = ["tenant", "organization"]

export function parseIsolation(filePath: string, opts: IsolationOptions = {}): IsolationParseResult {
  const tenantSignals = new Set(opts.tenantSignals ?? DEFAULT_TENANT_SIGNALS)
  const tenantContainerKeys = opts.tenantContainerKeys ?? DEFAULT_TENANT_CONTAINER_KEYS

  let source: string
  try {
    source = readFileSync(filePath, "utf-8")
  } catch {
    return { modelQueries: [], readsTenantFromContainer: false }
  }

  const tree  = _parser.parse(source)
  const root  = tree.rootNode

  const modelQueries: ModelQueryCall[]    = []
  const readsTenantFromContainer          = detectTenantContainerRead(root, tenantContainerKeys)

  gatherModelQueries(root, modelQueries, tenantSignals)

  return { modelQueries, readsTenantFromContainer }
}

// ---- Container read detection -----------------------------------------

// Detects: app('tenant') / app()->make('tenant') / resolve('tenant')
function detectTenantContainerRead(root: Parser.SyntaxNode, containerKeys: string[]): boolean {
  return containsPattern(root, (node) => {
    if (node.type === "function_call_expression") {
      const fn = node.childForFieldName("function")
      if (fn?.text === "app" || fn?.text === "resolve") {
        const args = node.childForFieldName("arguments")
        if (args) {
          const text = args.text.toLowerCase()
          if (containerKeys.some((k) => text.includes(k.toLowerCase()))) return true
        }
      }
    }
    return false
  })
}

// ---- Model query detection --------------------------------------------

function gatherModelQueries(
  node: Parser.SyntaxNode,
  results: ModelQueryCall[],
  tenantSignals: Set<string>
): void {
  // member_call_expression: handles Model::where(...)->find() / Model::whereTenantId()->find()
  // Capture at the outermost read-op in a chain — prevents double-counting inner scoped_call.
  if (node.type === "member_call_expression") {
    const name = node.childForFieldName("name")
    if (name && isReadOp(name.text)) {
      const rootModel = extractRootModel(node)
      if (rootModel) {
        results.push({
          model:               rootModel,
          operation:           name.text,
          hastenantConstraint: chainHasTenantConstraint(node, tenantSignals),
          callText:            node.text.slice(0, 120),
        })
        return // captured — don't descend into inner scoped_call_expression
      }
    }
    descend(node, results, tenantSignals)
    return
  }

  // scoped_call_expression: handles Model::find() direct (no chaining above)
  if (node.type === "scoped_call_expression") {
    const cls  = (node.children as Parser.SyntaxNode[])[0]
    const name = node.childForFieldName("name")
    if (cls && name) {
      const clsText = cls.text.replace(/^\\/, "")
      if (isModelClass(clsText) && isReadOp(name.text)) {
        results.push({
          model:               clsText,
          operation:           name.text,
          hastenantConstraint: chainHasTenantConstraint(node, tenantSignals),
          callText:            node.text.slice(0, 120),
        })
        return
      }
    }
  }

  descend(node, results, tenantSignals)
}

function descend(node: Parser.SyntaxNode, results: ModelQueryCall[], tenantSignals: Set<string>): void {
  for (const child of node.children as Parser.SyntaxNode[]) {
    gatherModelQueries(child, results, tenantSignals)
  }
}

// Walk to the root scoped_call_expression to extract the model class name
function extractRootModel(node: Parser.SyntaxNode): string | null {
  if (node.type === "scoped_call_expression") {
    const cls     = (node.children as Parser.SyntaxNode[])[0]
    const clsText = cls?.text.replace(/^\\/, "")
    return clsText && isModelClass(clsText) ? clsText : null
  }
  if (node.type === "member_call_expression") {
    const obj = node.childForFieldName("object")
    return obj ? extractRootModel(obj) : null
  }
  return null
}

// Walk the full method chain to find tenant signal
// e.g. Task::where('tenant_id', $id)->find($id) → has constraint
function chainHasTenantConstraint(node: Parser.SyntaxNode, tenantSignals: Set<string>): boolean {
  const text = node.text
  for (const signal of tenantSignals) {
    if (text.includes(signal)) return true
  }
  return false
}

// ---- Heuristics -------------------------------------------------------

function isModelClass(name: string): boolean {
  // Must start uppercase, not a facade (DB, Auth, Cache, etc.)
  const FACADES = new Set(["DB", "Auth", "Cache", "Session", "Queue", "Event",
    "Log", "Mail", "Bus", "Gate", "Hash", "Storage", "Validator"])
  if (FACADES.has(name)) return false
  if (!/^[A-Z]/.test(name)) return false
  return true
}

function isReadOp(op: string): boolean {
  return ["find", "findOrFail", "first", "firstOrFail", "get",
    "all", "paginate", "where", "latest", "oldest", "pluck"].includes(op)
}

// ---- Utility ----------------------------------------------------------

function containsPattern(
  node: Parser.SyntaxNode,
  predicate: (n: Parser.SyntaxNode) => boolean
): boolean {
  if (predicate(node)) return true
  for (const child of node.children as Parser.SyntaxNode[]) {
    if (containsPattern(child, predicate)) return true
  }
  return false
}
