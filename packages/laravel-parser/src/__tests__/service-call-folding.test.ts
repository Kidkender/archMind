import { describe, test, expect, beforeAll, afterAll } from "@jest/globals"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { parseControllerMethod } from "../controller-parser.js"

// A mutating call chained onto a relationship accessor ($folder->playlists()->detach())
// is folded into one service call; the accessor alone must not be emitted again.
// The skip used to compare tree-sitter nodes with `!==`, and tree-sitter does not
// always hand back the same JS object for the same node, so some runs emitted a
// duplicate "PlaylistFolder::playlists" (seen on koel: 6 of 50 runs).

const SERVICE = `<?php
namespace App\\Services;

use App\\Models\\PlaylistFolder;
use Illuminate\\Support\\Facades\\DB;

class PlaylistFolderService
{
    public function addPlaylistsToFolder(PlaylistFolder $folder, array $playlistIds): void
    {
        DB::transaction(static function () use ($folder, $playlistIds): void {
            collect($playlistIds)->each(static function (string $playlistId) use ($folder): void {
                PlaylistFolder::query()
                    ->whereHas('playlists', static fn ($q) => $q->whereKey($playlistId))
                    ->get()
                    ->each(static fn (PlaylistFolder $folder) => $folder->playlists()->detach($playlistId));
            });
            $folder->playlists()->attach($playlistIds);
        });
    }
}
`

describe("parseControllerMethod — folded relationship mutations", () => {
  let dir: string
  let file: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "archmind-folding-"))
    file = join(dir, "PlaylistFolderService.php")
    writeFileSync(file, SERVICE)
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("the accessor is folded into its mutation and not emitted on its own", () => {
    const calls = parseControllerMethod(file, "addPlaylistsToFolder")!.serviceCalls.map((s) => `${s.serviceClass}::${s.method}`)
    expect(calls).toContain("PlaylistFolder::playlists()->attach")
    expect(calls).toContain("PlaylistFolder::playlists()->detach")
    expect(calls).not.toContain("PlaylistFolder::playlists")
  })

  test("repeated runs give the same result", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 60; i++) {
      const calls = parseControllerMethod(file, "addPlaylistsToFolder")!.serviceCalls.map((s) => `${s.serviceClass}::${s.method}`)
      seen.add(JSON.stringify(calls))
    }
    expect(seen.size).toBe(1)
  })
})
