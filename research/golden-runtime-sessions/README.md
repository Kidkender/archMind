# Golden Runtime Sessions

Ground-truth sessions for runtime intelligence evaluation.

Each YAML file pairs an OTLP fixture with expected findings and correlation assertions.

## Format

```yaml
id: LARAVEL-N1-001            # unique session identifier
entrypoint: "GET /tasks"      # matched against static graph
framework: laravel
description: >
  Human-readable description of what the session demonstrates.

otlp_fixture: spike/sessions/get-tasks-n1.json   # path relative to workspace root

expected_findings:
  - type: n_plus_one          # must match RuntimeFinding.type
    severity: high            # expected severity level
    min_count: 10             # minimum finding.count (for N+1)
    evidence_contains: "users" # substring expected in finding.evidence

correlation:
  expected_rate_gte: 0.8      # minimum acceptable correlation rate
  expected_matches:
    - span_name: "TaskController::index"
      node_type: controller    # expected graph node type for this span
```

## Sessions

| ID | Entrypoint | Finding Type | Notes |
|----|-----------|--------------|-------|
| LARAVEL-N1-001 | GET /tasks | n_plus_one | 12× SELECT FROM users for 12 tasks |
| LARAVEL-SLOW-001 | PUT /tasks/{id} | slow_query | 750ms JOIN on permissions without index |

## Scoring

`runtime_recall` = satisfied expected findings / total expected findings

A finding is satisfied if a detected `RuntimeFinding` matches:
- `type` exactly
- `evidence` contains `evidence_contains` (when specified)
- `count >= min_count` (when specified)

## Out of Scope

- Distributed tracing across services
- Queue / job traces
- Event → listener reconstruction
- Live OTel HTTP ingestion
