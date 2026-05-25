import { parseOtlpJson } from "../ingest-otlp-json.js"

const MINIMAL_OTLP = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name",    value: { stringValue: "test-api" } },
          { key: "service.version", value: { stringValue: "2.0.0" } },
        ],
      },
      scopeSpans: [
        {
          scope: { name: "laravel" },
          spans: [
            {
              traceId:           "abc123",
              spanId:            "root001",
              parentSpanId:      "",
              name:              "PUT /tasks/{id}",
              kind:              2,
              startTimeUnixNano: "1000000000",
              endTimeUnixNano:   "1200000000",
              attributes: [
                { key: "http.method", value: { stringValue: "PUT" } },
                { key: "http.route",  value: { stringValue: "PUT /tasks/{id}" } },
              ],
            },
            {
              traceId:           "abc123",
              spanId:            "child001",
              parentSpanId:      "root001",
              name:              "TaskController::update",
              kind:              1,
              startTimeUnixNano: "1010000000",
              endTimeUnixNano:   "1190000000",
              attributes: [
                { key: "code.namespace", value: { stringValue: "App\\Controllers\\TaskController" } },
                { key: "code.function",  value: { stringValue: "update" } },
              ],
            },
            {
              traceId:           "abc123",
              spanId:            "db001",
              parentSpanId:      "child001",
              name:              "db.query",
              kind:              3,
              startTimeUnixNano: "1050000000",
              endTimeUnixNano:   "1100000000",
              attributes: [
                { key: "db.system",    value: { stringValue: "mysql" } },
                { key: "db.statement", value: { stringValue: "SELECT * FROM tasks WHERE id = ?" } },
              ],
            },
          ],
        },
      ],
    },
  ],
}

describe("parseOtlpJson", () => {
  test("extracts entrypoint from root http.route span", () => {
    const session = parseOtlpJson(MINIMAL_OTLP)
    expect(session.entrypoint).toBe("PUT /tasks/{id}")
  })

  test("sets sessionId from traceId", () => {
    const session = parseOtlpJson(MINIMAL_OTLP)
    expect(session.sessionId).toBe("abc123")
  })

  test("computes total duration from root span", () => {
    const session = parseOtlpJson(MINIMAL_OTLP)
    // (1200000000 - 1000000000) / 1_000_000 = 200ms
    expect(session.durationMs).toBe(200)
  })

  test("includes all spans", () => {
    const session = parseOtlpJson(MINIMAL_OTLP)
    expect(session.spans).toHaveLength(3)
  })

  test("normalizes attributes to flat Record", () => {
    const session = parseOtlpJson(MINIMAL_OTLP)
    const root = session.spans.find(s => !s.parentSpanId)!
    expect(root.attributes["http.route"]).toBe("PUT /tasks/{id}")
    expect(root.attributes["http.method"]).toBe("PUT")
  })

  test("preserves serviceVersion from resource attributes", () => {
    const session = parseOtlpJson(MINIMAL_OTLP)
    expect(session.serviceVersion).toBe("2.0.0")
  })

  test("empty parentSpanId becomes undefined", () => {
    const session = parseOtlpJson(MINIMAL_OTLP)
    const root = session.spans.find(s => s.spanId === "root001")!
    expect(root.parentSpanId).toBeUndefined()
  })
})
