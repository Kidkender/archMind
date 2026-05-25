export { ingestOtlpFile, parseOtlpJson } from "./ingest-otlp-json.js"
export {
  normalizeAttributes,
  extractEntrypoint,
  computeDurationMs,
  partitionSpans,
  isInfraSpan,
  isRootSpan,
} from "./normalize-spans.js"
