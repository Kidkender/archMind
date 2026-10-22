# @kidkender/archmind-constraints

**Architectural rules as code, checked in CI.** Write a rule as an AQL query that must match **no** route, and fail the build when one does.

---

## Install

```bash
npm install @kidkender/archmind-constraints @kidkender/archmind-protocol
```

## Rules file

`.archmind/constraints.yml` at the project root:

```yaml
version: 1
rules:
  - name: mutations-must-be-transactional
    query: FIND routes WHERE mutation AND no-transaction
    severity: HIGH
    message: A write endpoint runs outside a transaction

  - name: no-public-writes
    query: FIND routes WHERE public AND write
    severity: CRITICAL
```

Each rule needs `name`, `query` (an [AQL](../aql) string) and `severity` (`INFO`, `LOW`, `MEDIUM`, `HIGH` or `CRITICAL`). `message` is optional. The query describes the **violation**: any route it matches breaks the rule.

## Usage

```ts
import { loadConstraints, checkConstraints } from "@kidkender/archmind-constraints"

const config = loadConstraints(projectRoot)            // null when the file is absent
if (config) {
  const report = checkConstraints(config, graphs)
  if (!report.ok) {
    for (const v of report.violations) console.error(v.rule.name, v.routes)
    process.exit(1)
  }
}
```

`ConstraintReport` has `ok`, `violations` (each with the `rule` and the `routes` that match), `total_violations` and `checked` (rules evaluated). A rule whose AQL does not parse is reported as a violation with the error text instead of throwing.

`loadConstraints(projectRoot, file)` takes another path as the second argument. The YAML reader is deliberately minimal: the four keys above, no anchors or nested structures.

## License

MIT
