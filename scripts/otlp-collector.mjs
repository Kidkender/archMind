/**
 * Minimal OTLP HTTP/JSON collector.
 * Listens on port 4318, saves each trace batch to research/corpus/traces/<service>/<timestamp>.json
 *
 * Usage: node scripts/otlp-collector.mjs
 */

import { createServer } from "http"
import { mkdirSync, writeFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const TRACES_DIR = join(ROOT, "research", "corpus", "traces")

mkdirSync(TRACES_DIR, { recursive: true })

const server = createServer((req, res) => {
  if (req.method !== "POST" || !req.url.startsWith("/v1/traces")) {
    res.writeHead(404).end()
    return
  }

  let body = ""
  req.on("data", chunk => { body += chunk })
  req.on("end", () => {
    try {
      const payload = JSON.parse(body)

      // Extract service name from resource attributes
      const serviceName = payload?.resourceSpans?.[0]?.resource?.attributes
        ?.find(a => a.key === "service.name")?.value?.stringValue
        ?? "unknown"

      const dir = join(TRACES_DIR, serviceName)
      mkdirSync(dir, { recursive: true })

      const filename = `${Date.now()}.json`
      writeFileSync(join(dir, filename), JSON.stringify(payload, null, 2))

      console.log(`[collector] saved ${filename} for service=${serviceName}`)
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}")
    } catch (e) {
      console.error("[collector] parse error:", e.message)
      res.writeHead(400).end()
    }
  })
})

server.listen(4318, () => {
  console.log("[otlp-collector] Listening on http://localhost:4318")
  console.log("[otlp-collector] Traces will be saved to research/corpus/traces/<service>/")
  console.log("[otlp-collector] Press Ctrl+C to stop")
})
