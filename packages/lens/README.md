# @kidkender/archmind-lens

**Start from any Go function, not from a route.** Given a service method, a repository call or a helper, `lens` walks the call graph upward and tells you which HTTP routes, goroutines and startup code reach it, and whether the call runs inside a database transaction.

An AI agent rarely begins at a route. It greps a keyword and lands in a service or a repository. `lens` answers the question that comes next: *who calls this, and through which path?*

---

## Install

```bash
npm install @kidkender/archmind-lens @kidkender/archmind-go-parser
```

Go only (Gin projects get route names; plain Go code gets the call graph without routes).

---

## Usage

```ts
import { buildCallGraph, findEntries, findTransactionEffects, handlerRouteIndex } from "@kidkender/archmind-lens"
import { readGoProjectFiles, parseGinProjectAt } from "@kidkender/archmind-go-parser"

const root = "/path/to/go-project"
const graph = buildCallGraph(readGoProjectFiles(root))
const handlerRoutes = handlerRouteIndex(parseGinProjectAt(root))

// Who reaches this function?
for (const e of findEntries(graph, "CombatService.AttackCast", { handlerRoutes })) {
  console.log(e.kind, e.route ?? e.label, e.path.join(">"), e.callSite, e.inTxn ? "[txn]" : "")
}

// Shared state changed inside a transaction by a function with no undo step
console.log(findTransactionEffects(graph))
```

`findEntries` returns one entry per way into the symbol:

| Field | Meaning |
|---|---|
| `kind` | `http`, `background` (target of a `go` statement), `startup` (`main`, container, `cmd/`) or `unreferenced` (nobody calls it) |
| `route` | `METHOD /path`, for `http` entries |
| `path` | function keys from the entry down to the symbol |
| `inTxn` | some call on the path is inside a `.Transaction(func...)` closure |
| `async` | the path goes through a `go` statement: the work outlives the request |
| `callSite` | `{ file, line }` of the call that reaches the symbol |
| `indirect` | links that are not a written call: `callback` (a func stored in a field) or `ref` (a function or method used as a value). Worth checking by hand |

Symbols are written as `Type.Method` or `Func`, as declared in Go.

---

## As an MCP tool

`@kidkender/archmind-mcp` (0.7.0 and later) exposes this as **`archmind_symbol_context`**: symbol in, compact text out, one line per route with the path, the call site and the flags above. About a third of the size of the JSON form.

---

## What it resolves

Calls are resolved from types, not from method names:

- receivers, struct fields, typed parameters, local variables (composite literals, constructors, `var x T`, `range` values) and package-level variables;
- interfaces: a call on an interface value reaches every type that declares all of the interface's methods with the same parameter and result types;
- generic calls with explicit type arguments (`bindJSON[Req](c)`);
- functions and methods used as values (`h.respond(h.svc.Accept)`, `return s.hub.In`);
- functions stored in fields: through a setter (`g.SetBlock(func...)`), an assignment (`hub.OnChat = svc.SendFromWS`) or a composite literal (`&G{sight: terrain}`);
- `go` statements and calls inside `.Transaction(...)` closures.

When a call cannot be resolved by type, `lens` links it only if exactly one method in the project has that name. It never picks among several.

---

## Transaction check

`findTransactionEffects` reports a call made while a transaction is open (in the closure, or up to four calls deep) when the callee is a method of a mutex-guarded type that writes its own state, and the function that opened the transaction has no call named rollback, undo, revert or compensate. A rollback cannot undo in-memory state, so such a call is a candidate bug.

It is a heuristic: it counts direct writes only, an undo step is recognised by name only, and an empty list is **not** proof of safety.

---

## How accurate is it

Measured on one private Gin + GORM game API (552 functions), against a type-checker call graph (Go SSA + VTA) used as the reference:

- the route set was exact for 98.4% of the functions;
- every route `lens` reported was real (precision 100%) and 98.5% of the real routes were found.

One codebase, one reference tool that has blind spots of its own, and the tuning done along the way is described in the benchmark notes of the repository. Treat the numbers as a measurement on that project, not a guarantee.

## Limits

- Go only. No GDScript or other languages.
- Interface matching does not follow embedded interfaces, and two types with the same name in different packages are not told apart.
- Dynamic dispatch the types cannot show (reflection, function values built at runtime) is not followed.
- A route is only named for Gin handlers the route parser can resolve.

## License

MIT
