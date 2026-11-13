import { Node, SyntaxKind, type BindingElement, type ParameterDeclaration, type SourceFile } from "ts-morph"

/**
 * Where a name is declared, found by walking lexical scopes outward from a use
 * site. Done by hand rather than through the TypeScript checker so JavaScript
 * (require, module.exports) and TypeScript resolve the same way and no type
 * checking runs.
 */
export type Binding =
  /** `const x = init`, or `const { a: x } = init` with path ["a"]. */
  | { kind: "var"; init: Node | undefined; path: string[]; node: Node }
  /** A function parameter; `path` selects into a destructured parameter. */
  | { kind: "param"; param: ParameterDeclaration; path: string[] }
  | { kind: "function"; node: Node }
  | { kind: "class"; node: Node }
  /** `import x from "m"` (imported "default"), `import * as x` ("*"), `import { a as x }` ("a"). */
  | { kind: "import"; specifier: string; imported: string; file: SourceFile }

const SCOPE_KINDS = new Set([
  SyntaxKind.SourceFile, SyntaxKind.Block, SyntaxKind.ModuleBlock, SyntaxKind.CaseClause, SyntaxKind.DefaultClause,
  SyntaxKind.FunctionDeclaration, SyntaxKind.FunctionExpression, SyntaxKind.ArrowFunction, SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor, SyntaxKind.GetAccessor, SyntaxKind.SetAccessor,
  SyntaxKind.ForStatement, SyntaxKind.ForOfStatement, SyntaxKind.ForInStatement, SyntaxKind.CatchClause,
])

export function lookupName(from: Node, name: string): Binding | null {
  for (let scope: Node | undefined = from; scope; scope = scope.getParent()) {
    if (!SCOPE_KINDS.has(scope.getKind())) continue
    const found = declaredIn(scope, name)
    if (found) return found
  }
  return null
}

function declaredIn(scope: Node, name: string): Binding | null {
  // parameters of a function-like scope
  if (Node.isFunctionLikeDeclaration(scope) || Node.isArrowFunction(scope) || Node.isFunctionExpression(scope)) {
    for (const param of scope.getParameters()) {
      const path = bindingPath(param.getNameNode(), name)
      if (path) return { kind: "param", param, path }
    }
    // the body is a Block, visited as its own scope on the way out
    return null
  }
  // `for (const x of xs)` / `for (const x in o)` / `for (let i = ...)`
  if (Node.isForOfStatement(scope) || Node.isForInStatement(scope) || Node.isForStatement(scope)) {
    const init = scope.getInitializer()
    if (init && Node.isVariableDeclarationList(init)) {
      for (const decl of init.getDeclarations()) {
        const path = bindingPath(decl.getNameNode(), name)
        if (path) return { kind: "var", init: undefined, path, node: decl }
      }
    }
    return null
  }
  if (Node.isCatchClause(scope)) return null

  if (!(Node.isSourceFile(scope) || Node.isBlock(scope) || Node.isModuleBlock(scope) ||
        Node.isCaseClause(scope) || Node.isDefaultClause(scope))) return null

  for (const stmt of scope.getStatements()) {
    if (Node.isVariableStatement(stmt)) {
      for (const decl of stmt.getDeclarations()) {
        const path = bindingPath(decl.getNameNode(), name)
        if (path) return { kind: "var", init: decl.getInitializer(), path, node: decl }
      }
    } else if (Node.isFunctionDeclaration(stmt) && stmt.getName() === name) {
      return { kind: "function", node: stmt }
    } else if (Node.isClassDeclaration(stmt) && stmt.getName() === name) {
      return { kind: "class", node: stmt }
    } else if (Node.isImportDeclaration(stmt)) {
      const specifier = stmt.getModuleSpecifierValue()
      const file = stmt.getSourceFile()
      if (stmt.getDefaultImport()?.getText() === name) return { kind: "import", specifier, imported: "default", file }
      if (stmt.getNamespaceImport()?.getText() === name) return { kind: "import", specifier, imported: "*", file }
      for (const named of stmt.getNamedImports()) {
        const local = named.getAliasNode()?.getText() ?? named.getName()
        if (local === name) return { kind: "import", specifier, imported: named.getName(), file }
      }
    } else if (Node.isImportEqualsDeclaration(stmt) && stmt.getName() === name) {
      // `import x = require("m")`
      const ref = stmt.getModuleReference()
      if (Node.isExternalModuleReference(ref)) {
        const expr = ref.getExpression()
        if (expr && Node.isStringLiteral(expr)) {
          return { kind: "import", specifier: expr.getLiteralValue(), imported: "=", file: stmt.getSourceFile() }
        }
      }
    }
  }
  return null
}

/**
 * The property path from a binding pattern to `name`: [] for a plain
 * identifier, ["a"] for `{ a }` / `{ a: name }`, ["a", "b"] for `{ a: { b } }`,
 * array elements as their index. Null when `name` is not bound by it.
 */
function bindingPath(nameNode: Node, name: string): string[] | null {
  if (Node.isIdentifier(nameNode)) return nameNode.getText() === name ? [] : null
  if (Node.isObjectBindingPattern(nameNode)) {
    for (const el of nameNode.getElements()) {
      const key = propertyKey(el)
      const inner = bindingPath(el.getNameNode(), name)
      if (inner && key !== null) return [key, ...inner]
    }
    return null
  }
  if (Node.isArrayBindingPattern(nameNode)) {
    const elements = nameNode.getElements()
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      if (!Node.isBindingElement(el)) continue
      const inner = bindingPath(el.getNameNode(), name)
      if (inner) return [String(i), ...inner]
    }
  }
  return null
}

function propertyKey(el: BindingElement): string | null {
  const prop = el.getPropertyNameNode()
  if (!prop) {
    const n = el.getNameNode()
    return Node.isIdentifier(n) ? n.getText() : null
  }
  if (Node.isIdentifier(prop) || Node.isStringLiteral(prop)) {
    return Node.isStringLiteral(prop) ? prop.getLiteralValue() : prop.getText()
  }
  return null
}
