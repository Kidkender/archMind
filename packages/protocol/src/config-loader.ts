import { existsSync, readFileSync } from "fs"
import { join } from "path"
import type { ArchMindUserConfig } from "./config.js"

/**
 * Reads `archmind.json` from a project root. Returns undefined when the file
 * is absent or is not valid JSON — a bad config must never fail a parse.
 */
export function loadUserConfig(projectRoot: string): ArchMindUserConfig | undefined {
  const configPath = join(projectRoot, "archmind.json")
  if (!existsSync(configPath)) return undefined
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as ArchMindUserConfig
  } catch {
    return undefined
  }
}
