# Schemas

Structural TypeScript types for the research corpus.

## Design Principle

**Validate structure, not semantic correctness.**

- `type` fields are `string`, not union/enum — ontology is being discovered
- `semantic_primitives` is `string[]` — names not locked to approved list
- `Confidence` uses enum — useful granularity without fake precision
- No numeric confidence scores until benchmark data exists to calibrate

## Files

| File | Validates |
|---|---|
| `ontology/primitives.ts` | Core types: ExecutionNode, ExecutionEdge, Annotation, PrimitiveRef |
| `traces/golden-trace.ts` | Structure of YAML files in `research/golden-traces/` |
| `pains/pain-case.ts` | Structure of frontmatter in `research/semantic-pains/**/*.md` |

## What schemas enforce

- Required fields are present
- ID format is consistent (`FRAMEWORK-CATEGORY-SEQ`)
- Traceability uses the 4-level enum (STATIC / SEMANTIC / RUNTIME / PROBABILISTIC)
- Confidence uses enum (HIGH / MEDIUM / LOW / UNKNOWN)
- Links between pain files and golden traces exist

## What schemas do NOT enforce

- Whether a `semantic_primitive` name is in the ontology index
- Whether an `ExecutionNode.type` matches known node types
- Whether `expected_nodes` are correct (that's the benchmark's job)
- Semantic truth of any annotation

## Evolution rule

When a new primitive or edge type is discovered:
1. Add it to `research/ontology/*.md`
2. Add a `Known cases` link in the ontology file
3. Reference it in the pain file's `semantic_primitives`
4. Do NOT update the schema enum — keep types as `string`
