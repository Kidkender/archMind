# @kidkender/archmind-graph-query

**A fluent query API over ArchMind execution graphs.** Replaces ad-hoc `graph.nodes.filter(...)` code with named, composable facts: does this route authenticate, is it inside a transaction, does it dispatch a job.

---

## Install

```bash
npm install @kidkender/archmind-graph-query @kidkender/archmind-protocol
```

## One route: `query(graph)`

```ts
import { query } from "@kidkender/archmind-graph-query"

const q = query(graph)               // graph: IntermediateExecutionGraph

q.isMutation()                       // POST, PUT, PATCH, DELETE
q.security().hasAuthentication()
q.security().hasAuthorization()
q.transaction().exists()
q.transaction().hasEscape()          // a side effect that escapes the transaction
q.messaging().hasDispatch()          // queue / event / job dispatch
q.data().hasTenantContext()
q.data().hasUnscopedAccess()

// Lower level
q.nodes().ofType("ir:auth_gate").exists()
q.edges().from(nodeId).toNodes().toArray()
```

`query` only exposes **facts** about a graph. Turning facts into findings is the job of the detectors, not of this package.

## Many routes: `queryRoutes(graphs)`

```ts
import { queryRoutes } from "@kidkender/archmind-graph-query"

queryRoutes(graphs).withAuth().withoutTransaction().toArray()
queryRoutes(graphs).isMutation().withoutAuthorization().count()
```

Each filter returns a new `RouteQuery`, so they chain.

## Layers

| Layer | What |
|---|---|
| 1 | `graph.nodes` / `graph.edges`: raw structure |
| 2 | `query(graph)`: semantic facts (this package) |
| 3 | detectors: combine facts into findings |

`@kidkender/archmind-aql` (the query language) and `@kidkender/archmind-context` are built on this package.

## License

MIT
