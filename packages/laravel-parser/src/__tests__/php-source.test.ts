import { describe, test, expect, jest, beforeEach, afterEach } from "@jest/globals"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type Parser from "tree-sitter"
import { parseOptionsFor, parseSource, parsePhpFile } from "../php-source.js"
import { parseTransactions } from "../transaction-parser.js"

// A controller well past tree-sitter 0.21's default 32 KiB parse buffer: the
// transaction sits after ~40 KB of filler methods.
function largeController(): string {
  const filler = Array.from({ length: 400 }, (_, i) =>
    `    public function helper${i}()\n    {\n        return ['key${i}' => 'value value value value value value value value value'];\n    }\n`,
  ).join("\n")
  return `<?php
namespace App\\Http\\Controllers;

use Illuminate\\Support\\Facades\\DB;

class BigController extends Controller
{
${filler}
    public function store()
    {
        DB::transaction(function () {
            Order::create([]);
        });
    }
}
`
}

describe("php-source", () => {
  let dir: string
  let warn: ReturnType<typeof jest.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "archmind-php-source-"))
    warn = jest.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  test("sizes the parse buffer only for sources of 32 KiB or more", () => {
    expect(parseOptionsFor("<?php echo 1;")).toBeUndefined()
    const big = "x".repeat(40_000)
    expect(parseOptionsFor(big)!.bufferSize).toBeGreaterThan(big.length)
  })

  test("a controller larger than 32 KiB is parsed, not silently empty", () => {
    const source = largeController()
    expect(source.length).toBeGreaterThan(32 * 1024)
    const file = join(dir, "BigController.php")
    writeFileSync(file, source)

    const result = parseTransactions(file, "store")

    expect(result.hasTransaction).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  test("a missing file yields null without a warning", () => {
    const fakeParser = { parse: () => { throw new Error("should not be called") } } as unknown as Parser
    expect(parsePhpFile(fakeParser, join(dir, "Missing.php"))).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  test("a parse failure is reported with the file path and yields null", () => {
    const failing = { parse: () => { throw new Error("Invalid argument") } } as unknown as Parser

    expect(parseSource(failing, "<?php", "/app/Http/Controllers/X.php")).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0]![0])
    expect(message).toContain("/app/Http/Controllers/X.php")
    expect(message).toContain("Invalid argument")
  })
})
