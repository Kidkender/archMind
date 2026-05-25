# @archmind/runtime-ingest

**Turns raw OpenTelemetry JSON exports into clean, structured trace sessions — the first step in ArchMind's runtime intelligence pipeline.**

---

## The gap it fills

Static code analysis tells you what an endpoint *can* do. It cannot tell you what it *actually* did during a real request — how many database queries fired, which service calls ran, how long each one took.

OpenTelemetry captures exactly that. But raw OTLP JSON is verbose, deeply nested, and uses typed attribute containers that are awkward to work with. `@archmind/runtime-ingest` handles the parsing and normalization so the rest of the system works with clean, flat `OtelSpan` objects.

It is deliberately framework-agnostic. The same ingestor works regardless of whether the spans came from Laravel, Express, Django, or a custom OTel exporter.

---

## What it produces

A `TraceSession` — the complete normalized picture of a single HTTP request:

```
{
  sessionId:   the traceId of the root span
  entrypoint:  e.g. "PUT /tasks/{id}"  (from http.route attribute)
  durationMs:  total request duration
  spans:       OtelSpan[]  (normalized, flat attributes)
  recordedAt:  ISO timestamp
}
```

Attributes are flattened from OTLP's typed format (`{ key, value: { stringValue } }`) into plain `Record<string, string | number | boolean>` — so `span.attributes["db.statement"]` just works.

---

## Key features

**Span partitioning**
`partitionSpans()` splits spans into two groups: *candidates* (application-level spans that can be correlated to graph nodes) and *infra* (database queries, outbound HTTP calls, cache operations). This separation is critical for the runtime detectors — N+1 detection works on infra spans grouped under their candidate parent.

**Entrypoint extraction**
Automatically finds the root HTTP span and extracts the `http.route` attribute, normalizing it to the `"METHOD /path/{param}"` format that matches the static graph's entrypoint strings.

**Zero configuration**
No schema registration, no OTel collector, no server. Point it at a JSON file and get back a `TraceSession`.

---

## Usage

```typescript
import { ingestOtlpFile, partitionSpans } from "@archmind/runtime-ingest"

// Parse a recorded trace file
const session = ingestOtlpFile("/path/to/trace.json")

session.entrypoint    // "GET /tasks"
session.durationMs    // 800
session.spans.length  // 24

// Split into application spans vs. DB/cache/HTTP spans
const { candidates, infra } = partitionSpans(session.spans)
```

To record traces from a Laravel application, add the [OpenTelemetry PHP SDK](https://github.com/open-telemetry/opentelemetry-php) with a file exporter. The OTLP JSON format is the standard export format — any OTel-compatible exporter will produce files this ingestor can handle.

---

## Running tests

```bash
cd packages/runtime-ingest
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js
```
