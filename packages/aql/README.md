# @kidkender/archmind-aql

**AQL, the Architecture Query Language.** Ask structural questions about your routes in one line:

```
FIND routes WHERE auth AND NOT transaction
```

---

## Install

```bash
npm install @kidkender/archmind-aql @kidkender/archmind-protocol
```

## Usage

```ts
import { aql } from "@kidkender/archmind-aql"

const result = aql("FIND routes WHERE mutation AND missing-authorization", graphs)
console.log(result.count, result.entrypoints)   // result.routes holds the matching graphs
```

`graphs` is the `IntermediateExecutionGraph[]` that a parser produces (for example `parseGinProjectAt(root)` from `@kidkender/archmind-go-parser`). Lower-level pieces are exported too: `tokenize`, `parse`, `evaluate`, `knownPredicates()`.

## Grammar

```
statement := FIND ROUTES WHERE expr
           | MATCH path_expr
expr      := or_expr
or_expr   := and_expr ( OR and_expr )*
and_expr  := unary ( AND unary )*
unary     := NOT unary | primary
primary   := PREDICATE | ( expr )
path_expr := PREDICATE ( -> PREDICATE )+
```

## Predicates

| Group | Predicates |
|---|---|
| Authentication | `auth`, `authenticated`, `no-auth`, `public`, `unauthenticated` |
| Authorization | `authorization`, `policy`, `no-authorization`, `no-policy`, `missing-authorization` (authenticated but not authorized) |
| HTTP method | `mutation`, `write`, `readonly`, `read` |
| Transactions | `transaction`, `no-transaction`, `transaction-escape` |
| Tenant isolation | `tenant-scoped`, `tenant`, `unscoped`, `unscoped-access` |
| Async side effects | `async`, `async-dispatch`, `queue`, `event` |

`knownPredicates()` returns the current list.

## Examples

```
FIND routes WHERE mutation AND no-transaction
FIND routes WHERE public AND write
FIND routes WHERE (auth OR policy) AND NOT tenant-scoped
```

Used by `@kidkender/archmind-constraints` to enforce rules in CI.

## License

MIT
