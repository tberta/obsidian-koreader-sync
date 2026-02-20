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

## Architecture

This is an **Obsidian plugin** that syncs KOReader e-reader highlights and annotations into Obsidian vault notes.

**Entry point:** `src/main.ts` — contains the main plugin class `KOReader` (~1400 lines), settings tab `KoreaderSettingTab`, and UI helpers `FolderSuggest`/`FileSuggest`.

**Metadata parser:** `src/koreader-metadata.ts` — scans KOReader device filesystem for `metadata.*.lua` files, parses them with `lua-json`, and normalizes into a `Books` structure. Handles both old KOReader format (`bookmarks` array) and new format (`annotations` array).

**Types:** `src/types.d.ts` — core interfaces: `Book`, `Bookmark`, `FrontMatter`.

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
  uniqueId: "<md5>"            # derived from title + authors + position
  data:                        # note content: title, authors, chapter, page, highlight, datetime
  metadata:
    body_hash: "<md5>"         # detects user edits to note body
    keep_in_sync: true         # if false, plugin skips this note
    yet_to_be_edited: true     # flipped to false when user edits the note
    managed_book_title: "..."
    percent_finished: 0.0
```

Sync safety: a note is only updated if both `keep_in_sync=true` AND `yet_to_be_edited=true`. The plugin watches `metadataCache` changes to detect user edits and set `yet_to_be_edited=false`.

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
