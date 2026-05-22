import { createHash } from "node:crypto"

export function stableHash(parts: string[]): string {
  const input = [...parts].sort().join("|")
  return createHash("sha256").update(input).digest("hex").slice(0, 8)
}
