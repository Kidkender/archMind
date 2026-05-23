import { describe, test, expect } from "@jest/globals"
import { validateLLMResponse } from "../validate-response.js"
import type { LLMResponse, ValidationError } from "../types.js"

const VALID: LLMResponse = {
  finding_type: "duplicate_authorization",
  severity: "CRITICAL",
  confidence: "HIGH",
  explanation: "CheckPermission and TaskPolicy both call PermissionService with the same args.",
  key_nodes: ["CheckPermission::handle", "TaskPolicy::update"],
  recommendations: ["Remove middleware check"],
  uncertainty: null,
}

describe("validateLLMResponse", () => {
  test("valid response passes", () => {
    expect(validateLLMResponse(VALID).valid).toBe(true)
  })

  test("missing finding_type fails", () => {
    const { finding_type: _, ...rest } = VALID
    const result = validateLLMResponse(rest as unknown as LLMResponse)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e: ValidationError) => e.field === "finding_type")).toBe(true)
  })

  test("invalid severity fails", () => {
    const result = validateLLMResponse({ ...VALID, severity: "BLOCKER" as LLMResponse["severity"] })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e: ValidationError) => e.field === "severity")).toBe(true)
  })

  test("invalid confidence fails", () => {
    const result = validateLLMResponse({ ...VALID, confidence: "UNKNOWN" as LLMResponse["confidence"] })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e: ValidationError) => e.field === "confidence")).toBe(true)
  })

  test("empty explanation fails", () => {
    const result = validateLLMResponse({ ...VALID, explanation: "" })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e: ValidationError) => e.field === "explanation")).toBe(true)
  })

  test("non-array key_nodes fails", () => {
    const result = validateLLMResponse({ ...VALID, key_nodes: "not-an-array" as unknown as string[] })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e: ValidationError) => e.field === "key_nodes")).toBe(true)
  })

  test("non-array recommendations fails", () => {
    const result = validateLLMResponse({ ...VALID, recommendations: null as unknown as string[] })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e: ValidationError) => e.field === "recommendations")).toBe(true)
  })

  test("uncertainty can be null", () => {
    expect(validateLLMResponse({ ...VALID, uncertainty: null }).valid).toBe(true)
  })

  test("uncertainty can be a string", () => {
    expect(validateLLMResponse({ ...VALID, uncertainty: "may diverge at runtime" }).valid).toBe(true)
  })

  test("uncertainty that is a number fails", () => {
    const result = validateLLMResponse({ ...VALID, uncertainty: 42 as unknown as string })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e: ValidationError) => e.field === "uncertainty")).toBe(true)
  })

  test("non-object input fails gracefully", () => {
    const result = validateLLMResponse(null as unknown as LLMResponse)
    expect(result.valid).toBe(false)
  })
})
