#!/usr/bin/env node
/**
 * Comparative Reasoning Benchmark v2 — LLM comparison
 *
 * Compares two modes for each Q&A pair:
 *   Mode A (naive):    Claude + raw graph node list (no curation)
 *   Mode B (archmind): Claude + curated EvidencePackage
 *
 * Scoring uses an LLM judge (Claude) that rates each answer 0.0–1.0
 * against the golden_answer for the pair.
 *
 * Metrics per pair:
 *   - reasoning_accuracy_a / reasoning_accuracy_b  (judge score)
 *   - prompt_tokens_a / prompt_tokens_b             (token efficiency)
 *   - latency_ms_a / latency_ms_b                  (response latency)
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 *
 * Usage (from repo root):
 *   node --loader ts-node/esm packages/retrieval/src/scripts/run-llm-comparison.ts \
 *     <project-name> [label]
 *
 * Examples:
 *   ANTHROPIC_API_KEY=sk-... node --loader ts-node/esm \
 *     packages/retrieval/src/scripts/run-llm-comparison.ts ecomerce-api ecomerce-v2
 *
 *   ANTHROPIC_API_KEY=sk-... node --loader ts-node/esm \
 *     packages/retrieval/src/scripts/run-llm-comparison.ts laravel-b2b-ecommerce b2b-v2
 */
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from "fs"
import yaml from "js-yaml"
import Anthropic from "@anthropic-ai/sdk"
import { parseRouteFile, augmentGraph, loadProjectConfig, resolveAliasMap } from "@archmind/laravel-parser"
import { buildEvidencePackage } from "@archmind/explainer"
import type { IntermediateExecutionGraph } from "@archmind/protocol"
import type { EvidencePackage } from "@archmind/explainer"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const REPO_ROOT  = join(__dirname, "../../../..")
const SNAP_DIR   = join(REPO_ROOT, "benchmarks/snapshots")

// ─── Config ────────────────────────────────────────────────────────────────

const PROJECT_PATHS: Record<string, string> = {
  "ecomerce-api":          "C:/Users/Admin/Desktop/DuckCode/New folder/laravel/ecomerce-api",
  "laravel-b2b-ecommerce": "C:/Users/Admin/Desktop/DuckCode/New folder/laravel/laravel-b2b-ecommerce",
}

const projectName = process.argv[2]
const label       = process.argv[3] ?? `${projectName}-llm-v2`

if (!projectName) {
  console.error("Usage: run-llm-comparison.ts <project-name> [label]")
  console.error("Available projects: " + Object.keys(PROJECT_PATHS).join(", "))
  process.exit(1)
}

const projectRoot = PROJECT_PATHS[projectName]
if (!projectRoot) {
  console.error(`Unknown project: ${projectName}. Available: ${Object.keys(PROJECT_PATHS).join(", ")}`)
  process.exit(1)
}

const apiKey = process.env["ANTHROPIC_API_KEY"]
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY environment variable is required")
  process.exit(1)
}

const client  = new Anthropic({ apiKey })
const QA_DIR  = join(REPO_ROOT, "research/golden-qa", projectName)
const MODEL   = "claude-haiku-4-5-20251001"  // cheaper for candidate answers
const JUDGE   = "claude-sonnet-4-6"           // better reasoning for judge

// ─── Types ─────────────────────────────────────────────────────────────────

interface GoldenQA {
  id: string
  route: string
  question: string
  expected_finding: string
  expected_intent: string
  expected_evidence_nodes: Array<{ symbol: string; type: string; role: string }>
  golden_answer: string
}

interface LLMCallResult {
  answer:           string
  prompt_tokens:    number
  completion_tokens: number
  latency_ms:       number
}

interface JudgeResult {
  score:      number   // 0.0–1.0
  reasoning:  string
}

interface PairResult {
  id:                  string
  route:               string
  question:            string
  mode_a: {
    answer:             string
    prompt_tokens:      number
    completion_tokens:  number
    latency_ms:         number
    judge_score:        number
    judge_reasoning:    string
  }
  mode_b: {
    answer:             string
    prompt_tokens:      number
    completion_tokens:  number
    latency_ms:         number
    judge_score:        number
    judge_reasoning:    string
  }
  delta_score:         number   // mode_b.judge_score - mode_a.judge_score
  token_savings_pct:   number   // (mode_a.prompt_tokens - mode_b.prompt_tokens) / mode_a.prompt_tokens * 100
}

interface ComparisonSnapshot {
  label:      string
  timestamp:  string
  project:    string
  model:      string
  judge:      string
  summary: {
    total_pairs:          number
    avg_score_a:          number
    avg_score_b:          number
    avg_delta:            number
    avg_token_savings_pct: number
    archmind_wins:        number
    naive_wins:           number
    ties:                 number
  }
  results: PairResult[]
}

// ─── Build prompts ─────────────────────────────────────────────────────────

function buildNaivePrompt(question: string, graph: IntermediateExecutionGraph): string {
  const nodeList = graph.nodes.map((n) =>
    `- [${n.type}] ${n.symbol}${n.role ? ` (${n.role})` : ""}`
  ).join("\n")

  return `You are a Laravel security expert. Answer the following question about this route.

Route: ${graph.entrypoint}

Graph nodes (raw):
${nodeList}

Question: ${question}

Answer concisely and accurately based on the graph data above.`
}

function buildArchmindPrompt(question: string, pkg: EvidencePackage): string {
  const evidenceList = pkg.evidence.map((e) =>
    `- [${e.type}] ${e.symbol} (${e.role})`
  ).join("\n")

  return `You are a Laravel security expert. Answer the following question using the structured evidence package below.

Question: ${question}

Intent: ${pkg.intent}
Top Finding: ${pkg.finding} (${pkg.severity}, confidence: ${pkg.confidence})
Finding Summary: ${pkg.supporting_text}

Execution Path: ${pkg.execution_path.join(" → ")}

Evidence:
${evidenceList}

Answer concisely and accurately based on the evidence package above.`
}

function buildJudgePrompt(question: string, goldenAnswer: string, candidateAnswer: string): string {
  return `You are an expert code reviewer evaluating an answer about Laravel security.

Question: ${question}

Golden Answer (ground truth):
${goldenAnswer}

Candidate Answer:
${candidateAnswer}

Rate the candidate answer from 0.0 to 1.0 based on:
- Factual accuracy (does it identify the correct security issue?)
- Completeness (does it cover the key points in the golden answer?)
- Specificity (does it mention specific classes/methods where relevant?)

Respond ONLY with a JSON object:
{"score": <0.0 to 1.0>, "reasoning": "<one sentence>"}`
}

// ─── LLM calls ─────────────────────────────────────────────────────────────

async function callLLM(prompt: string, model: string): Promise<LLMCallResult> {
  const start = Date.now()
  const response = await client.messages.create({
    model,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  })
  const latency_ms = Date.now() - start

  const answer = response.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("")

  return {
    answer,
    prompt_tokens:     response.usage.input_tokens,
    completion_tokens: response.usage.output_tokens,
    latency_ms,
  }
}

async function callJudge(
  question: string,
  goldenAnswer: string,
  candidateAnswer: string
): Promise<JudgeResult> {
  const prompt = buildJudgePrompt(question, goldenAnswer, candidateAnswer)
  const result = await callLLM(prompt, JUDGE)

  try {
    const parsed = JSON.parse(result.answer.match(/\{[\s\S]*\}/)?.[0] ?? "{}")
    return {
      score:     Math.min(1, Math.max(0, Number(parsed.score) || 0)),
      reasoning: String(parsed.reasoning || ""),
    }
  } catch {
    // If judge response is malformed, score 0 conservatively
    return { score: 0, reasoning: "judge parse error" }
  }
}

// ─── Parse project ─────────────────────────────────────────────────────────

console.log(`Parsing project: ${projectRoot}`)
const config = loadProjectConfig(projectRoot)
const { aliasMap, routeFiles } = resolveAliasMap(projectRoot, config)

const allGraphs: IntermediateExecutionGraph[] = []
for (const relFile of routeFiles) {
  const skeletons = parseRouteFile(join(projectRoot, relFile), { aliasMap })
  for (const g of skeletons) {
    allGraphs.push(augmentGraph(g, { projectRoot, config }))
  }
}
console.log(`Extracted ${allGraphs.length} graphs\n`)

// ─── Load Q&A pairs ─────────────────────────────────────────────────────────

const qaFiles = readdirSync(QA_DIR).filter((f) => f.endsWith(".yaml"))
const qaPairs: GoldenQA[] = qaFiles.map(
  (f) => yaml.load(readFileSync(join(QA_DIR, f), "utf-8")) as GoldenQA
)
console.log(`Loaded ${qaPairs.length} Q&A pairs\n`)

// ─── Run comparison ─────────────────────────────────────────────────────────

const results: PairResult[] = []

for (const qa of qaPairs) {
  const graph = allGraphs.find(
    (g) => g.entrypoint?.toLowerCase() === qa.route.toLowerCase()
  )
  if (!graph) {
    console.warn(`  SKIP [${qa.id}]: no graph for route "${qa.route}"`)
    continue
  }

  console.log(`[${qa.id}] "${qa.question}"`)

  // Mode A: naive (raw graph)
  const promptA = buildNaivePrompt(qa.question, graph)
  const resultA = await callLLM(promptA, MODEL)
  const judgeA  = await callJudge(qa.question, qa.golden_answer, resultA.answer)

  // Mode B: ArchMind evidence package
  const pkg     = buildEvidencePackage(qa.question, graph)
  const promptB = buildArchmindPrompt(qa.question, pkg)
  const resultB = await callLLM(promptB, MODEL)
  const judgeB  = await callJudge(qa.question, qa.golden_answer, resultB.answer)

  const delta          = judgeB.score - judgeA.score
  const tokenSavingsPct = resultA.prompt_tokens > 0
    ? ((resultA.prompt_tokens - resultB.prompt_tokens) / resultA.prompt_tokens) * 100
    : 0

  console.log(`  Mode A (naive):    score=${judgeA.score.toFixed(3)}  tokens=${resultA.prompt_tokens}  ${judgeA.reasoning}`)
  console.log(`  Mode B (archmind): score=${judgeB.score.toFixed(3)}  tokens=${resultB.prompt_tokens}  ${judgeB.reasoning}`)
  console.log(`  delta=${delta >= 0 ? "+" : ""}${delta.toFixed(3)}  token_savings=${tokenSavingsPct.toFixed(1)}%\n`)

  results.push({
    id:    qa.id,
    route: qa.route,
    question: qa.question,
    mode_a: { answer: resultA.answer, prompt_tokens: resultA.prompt_tokens, completion_tokens: resultA.completion_tokens, latency_ms: resultA.latency_ms, judge_score: judgeA.score, judge_reasoning: judgeA.reasoning },
    mode_b: { answer: resultB.answer, prompt_tokens: resultB.prompt_tokens, completion_tokens: resultB.completion_tokens, latency_ms: resultB.latency_ms, judge_score: judgeB.score, judge_reasoning: judgeB.reasoning },
    delta_score:       delta,
    token_savings_pct: tokenSavingsPct,
  })
}

// ─── Snapshot ───────────────────────────────────────────────────────────────

const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0

const snapshot: ComparisonSnapshot = {
  label,
  timestamp:  new Date().toISOString(),
  project:    projectName,
  model:      MODEL,
  judge:      JUDGE,
  summary: {
    total_pairs:          results.length,
    avg_score_a:          avg(results.map((r) => r.mode_a.judge_score)),
    avg_score_b:          avg(results.map((r) => r.mode_b.judge_score)),
    avg_delta:            avg(results.map((r) => r.delta_score)),
    avg_token_savings_pct: avg(results.map((r) => r.token_savings_pct)),
    archmind_wins:        results.filter((r) => r.delta_score > 0.05).length,
    naive_wins:           results.filter((r) => r.delta_score < -0.05).length,
    ties:                 results.filter((r) => Math.abs(r.delta_score) <= 0.05).length,
  },
  results,
}

mkdirSync(SNAP_DIR, { recursive: true })
const outPath = join(SNAP_DIR, `${label}.json`)
writeFileSync(outPath, JSON.stringify(snapshot, null, 2))

console.log("=== Summary ===")
console.log(`  total_pairs           = ${snapshot.summary.total_pairs}`)
console.log(`  avg_score_a (naive)   = ${snapshot.summary.avg_score_a.toFixed(3)}`)
console.log(`  avg_score_b (archmind)= ${snapshot.summary.avg_score_b.toFixed(3)}`)
console.log(`  avg_delta             = ${snapshot.summary.avg_delta >= 0 ? "+" : ""}${snapshot.summary.avg_delta.toFixed(3)}`)
console.log(`  avg_token_savings     = ${snapshot.summary.avg_token_savings_pct.toFixed(1)}%`)
console.log(`  archmind_wins=${snapshot.summary.archmind_wins}  naive_wins=${snapshot.summary.naive_wins}  ties=${snapshot.summary.ties}`)
console.log(`\nSaved: ${outPath}`)
