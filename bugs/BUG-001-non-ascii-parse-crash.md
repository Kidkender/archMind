# BUG-001: augmentGraph crashes on PHP files with non-ASCII characters

**Severity**: HIGH  
**Discovered**: 2026-05-27  
**Fixed**: 2026-05-28  
**Status**: FIXED  
**Project**: laravel-b2b-ecommerce  
**Affected component**: `packages/laravel-parser/src/` — all 6 parser files

---

## Summary

`augmentGraph()` throws `Error: Invalid argument` from tree-sitter when the target PHP file contains non-ASCII characters (e.g. Turkish: ı, ş, ç, ğ, ü, ö).

## Impact

- 52 out of 326 execution graphs fail to augment (16% error rate)
- All `/sepet/` (cart) routes affected — `CartController.php` is 42KB with Turkish variable names/comments
- `SyncCartCampaign.php` also affected (smaller file, same crash path)
- Errors are silent — the eval/benchmark script currently crashes hard unless wrapped in try/catch

## Root Cause

`parser.parse(source)` in each of the 6 parser files was NOT wrapped in try-catch. When tree-sitter's PHP parser encounters certain non-ASCII character sequences in a large file, it throws `Error: Invalid argument`. This exception propagated up and crashed the entire `augmentGraph()` call.

**Important note on encoding**: The tree-sitter Node.js binding uses **character offsets** (UTF-16) internally — not byte offsets. Passing a `Buffer` directly to `parser.parse()` does NOT work (throws `Input must be a function`). Using a callback that maps byte offsets also fails because tree-sitter passes character offsets to the callback, causing position mismatch for files with multi-byte UTF-8 characters. The correct fix is graceful error handling, not encoding changes.

## Fix (2026-05-28)

Merged `readFileSync` and `parser.parse()` into a single try-catch block in all 6 parser files:

- `controller-parser.ts`
- `bootstrap-parser.ts`
- `constant-resolver.ts`
- `isolation-parser.ts`
- `kernel-parser.ts`
- `route-parser.ts`
- `transaction-parser.ts`

```ts
// Before: parse errors propagate up and crash augmentGraph
let source: string
try {
  source = readFileSync(filePath, "utf-8")
} catch {
  return null
}
const tree = _parser.parse(source)  // could throw for non-ASCII files

// After: both read and parse are guarded
let source: string
let tree: ReturnType<typeof _parser.parse>
try {
  source = readFileSync(filePath, "utf-8")
  tree = _parser.parse(source)
} catch {
  return null  // graceful failure — caller skips this file
}
```

All 133 existing tests pass after this change.

## Reproduction

```
project: C:/Users/Admin/Desktop/DuckCode/New folder/laravel-b2b-ecommerce
files:
  - app/Http/Controllers/CartController.php  (42820 bytes, contains ı/ş/ç/ç chars)
  - app/Http/Middleware/SyncCartCampaign.php (500 bytes)
non-ASCII char codes found: [305, 351, 351, 231, 231]
```

## Workaround (was active before fix)

Wrap `augmentGraph()` calls in try/catch and skip failing graphs. The benchmark currently does this, so 274/326 graphs are still analyzed. The fix makes this workaround no longer necessary at the parser level.

## Affected golden traces

None — no golden traces exist for laravel-b2b-ecommerce.
