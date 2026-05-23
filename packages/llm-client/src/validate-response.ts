import type { LLMResponse, ValidationResult, ValidationError } from "./types.js"

const VALID_SEVERITIES = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW"])
const VALID_CONFIDENCES = new Set(["HIGH", "MEDIUM", "LOW"])

export function validateLLMResponse(response: LLMResponse): ValidationResult {
  const errors: ValidationError[] = []

  if (response === null || typeof response !== "object") {
    return { valid: false, errors: [{ field: "root", reason: "response is not an object" }] }
  }

  if (!response.finding_type || typeof response.finding_type !== "string") {
    errors.push({ field: "finding_type", reason: "missing or not a string" })
  }

  if (!VALID_SEVERITIES.has(response.severity)) {
    errors.push({ field: "severity", reason: `must be one of ${[...VALID_SEVERITIES].join(", ")}` })
  }

  if (!VALID_CONFIDENCES.has(response.confidence)) {
    errors.push({ field: "confidence", reason: `must be one of ${[...VALID_CONFIDENCES].join(", ")}` })
  }

  if (!response.explanation || typeof response.explanation !== "string") {
    errors.push({ field: "explanation", reason: "missing or empty string" })
  }

  if (!Array.isArray(response.key_nodes)) {
    errors.push({ field: "key_nodes", reason: "must be an array" })
  }

  if (!Array.isArray(response.recommendations)) {
    errors.push({ field: "recommendations", reason: "must be an array" })
  }

  if (response.uncertainty !== null && typeof response.uncertainty !== "string") {
    errors.push({ field: "uncertainty", reason: "must be null or a string" })
  }

  return { valid: errors.length === 0, errors }
}
