# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Local Dev Override (DO NOT COMMIT)

`esbuild.config.mjs` has the `outfile` set to the live Obsidian vault plugin directory for direct testing:
**Never commit this change.** The original value is `'main.js'` (repo root).

## Commands

```bash
npm run dev       # esbuild watch mode with inline sourcemaps (development)
npm run build     # tsc type-check (no emit) + esbuild production bundle
npm run lint      # ESLint
```

There are no automated tests. The build output is `main.js` (single bundled file), which Obsidian loads as the plugin.

Test fixture metadata files live in `test-files/` (copied `metadata.*.lua` from a real device for manual sync testing).

## Architecture

This is an **Obsidian plugin** that syncs KOReader e-reader highlights and annotations into Obsidian vault notes.

**Entry point:** `src/main.ts` — contains the main plugin class `KOReader` (~1400 lines), settings tab `KoreaderSettingTab`, and UI helpers `FolderSuggest`/`FileSuggest`.

**Metadata parser:** `src/koreader-metadata.ts` — scans KOReader device filesystem for `metadata.*.lua` files, parses them with `lua-json`, and normalizes into a `Books` structure. Handles both old KOReader format (`bookmarks` array) and new format (`annotations` array).

**Types:** `src/types.d.ts` — core interfaces: `Book`, `Bookmark`, `FrontMatter`.

**Gotcha:** `Bookmark.pos0`/`pos1` are typed `string` but PDF annotations deliver coordinate objects from `lua-json`. `normalizePos()` in `koreader-metadata.ts` coerces them to strings at parse time.

### Data flow

```
KOReader device filesystem (metadata.*.lua)
  → KOReaderMetadata.scan()         # parse Lua JSON, normalize
  → Books object (title/authors/highlights)
  → importNotes()                   # create/update Obsidian markdown files
  → Markdown files with YAML frontmatter
```

### Note types

The plugin creates three kinds of notes, controlled by settings:
- **Single-note** (default): one `.md` file per highlight/bookmark
- **Book-highlights**: one `.md` file per book containing all highlights
- **Dataview**: creates Dataview query files that link note sets

### Frontmatter schema

Every synced note has a `koreader-sync` YAML block:
```yaml
koreader-sync:
  type: "koreader-sync-note"   # or "book highlights" / "dataview"
  uniqueId: "<md5>"            # md5(title - authors - pos0 - pos1); falls back to datetime when pos empty
  data:                        # note content: title, authors, chapter, page, highlight, datetime
  metadata:
    body_hash: "<md5>"         # md5 of note body (before separator); compared against on-disk body, not stored value
    managed_book_title: "..."
    percent_finished: 0.0
```

Sync safety: `koreader_keep_in_sync` (top-level frontmatter bool) gates all note updates. Notes are skipped if false.

### Templates

Uses **Eta.js v3** for rendering note templates. Templates receive the `Book` and `Bookmark` objects. Module-level defaults are defined in the settings and merged with per-template overrides via `gray-matter`.

### Key dependencies

| Package | Purpose |
|---------|---------|
| `obsidian` | Obsidian plugin API |
| `eta` v3 | Template rendering |
| `gray-matter` | YAML frontmatter parsing/serialization |
| `lua-json` | Parse KOReader's Lua-JSON metadata files |
| `node-find-files` | Recursive filesystem scanning |

### Plugin metadata

- `manifest.json` defines the Obsidian plugin ID, version, and minimum app version (0.13.19)
- Desktop only — requires access to KOReader device filesystem
- Distributed as a single `main.js` bundle (esbuild output)
