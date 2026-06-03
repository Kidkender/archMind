import { existsSync, readFileSync } from "fs"
import path from "path"

// Scan main.ts for app.useGlobalPipes(new ValidationPipe(...))
// APP_PIPE module token is a known gap — deferred to Phase 2.
export function scanGlobalPipes(projectRoot: string): boolean {
  const candidates = [
    path.join(projectRoot, "src/main.ts"),
    path.join(projectRoot, "main.ts"),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const text = readFileSync(candidate, "utf8")
    if (text.includes("useGlobalPipes") && text.includes("ValidationPipe")) return true
  }
  return false
}
