# KOReader Lua Metadata Format

KOReader stores per-book metadata in `metadata.<extension>.lua` files inside
`.sdr/` sidecar directories next to each book file. The plugin locates these
files by scanning the KOReader mount path for files matching
`metadata.*.lua`.

## File location

```
/mnt/koreader/
└── Books/
    └── My Book.epub
    └── My Book.sdr/
        └── metadata.epub.lua   ← parsed by this plugin
```

The `.sdr` directory name (without the `.sdr` suffix) is used as a fallback
title when `doc_props.title` is absent.

---

## Top-level structure (both formats)

```lua
return {
  ["doc_props"] = { ... },        -- book metadata (title, authors, …)
  ["percent_finished"] = 0.42,    -- reading progress (0–1)

  -- ONE of the two following keys holds the highlights:
  ["bookmarks"]   = { ... },      -- OLD format (KOReader < ~2024)
  ["annotations"] = { ... },      -- NEW format (KOReader >= ~2024)
}
```

---

## Old format — `bookmarks`

Highlights were stored under the `bookmarks` key. Each entry is a Lua table
indexed by an integer key.

```lua
["bookmarks"] = {
  [1] = {
    ["chapter"]   = "Chapter 3",
    ["text"]      = "Page 42 in "My Book"",  -- pre-formatted location string
    ["notes"]     = "The actual highlighted text",
    ["datetime"]  = "2023-11-04 18:32:00",
    ["highlighted"] = true,
    ["pos0"]      = "1234/5",   -- start position (CFI or page ref)
    ["pos1"]      = "1234/9",   -- end position
    ["page"]      = 42,
  },
  [2] = { ... },
}
```

Key points:
- `text` is a **pre-formatted human-readable string** such as `"Page 42 in «Title»"` — it is **not** the highlight text.
- `notes` holds the **actual highlighted passage**.
- `page` is an integer page number.
- The plugin uses `bookmarks` as-is when `annotations` is absent.

---

## New format — `annotations` (KOReader >= ~2024)

Highlights moved to the `annotations` key. The structure is similar but field
names changed.

```lua
["annotations"] = {
  [1] = {
    ["chapter"]  = "Chapter 3",
    ["text"]     = "The actual highlighted text",  -- highlight lives here now
    ["datetime"] = "2024-03-15 09:12:00",
    ["pos0"]     = "1234/5",
    ["pos1"]     = "1234/9",
    ["pageno"]   = 42,    -- renamed from "page"; integer page number
    -- "notes" field for user notes (optional, may be absent)
  },
  [2] = { ... },
}
```

Key differences from the old format:

| Field | Old (`bookmarks`) | New (`annotations`) |
|---|---|---|
| Highlight text | `notes` | `text` |
| Pre-formatted location string | `text` | *(absent)* |
| Page number field | `page` (integer) | `pageno` (integer) |
| User note field | *(same as text, overloaded)* | `notes` (separate, optional) |

---

## How the plugin normalises both formats

`src/koreader-metadata.ts` converts the new format into the same shape as the
old one so that the rest of the plugin (`main.ts`) only ever sees one
structure:

```typescript
// New format detected when `annotations` key is present and non-empty
normalizedBookmarks[key] = {
  chapter:     ann.chapter   || '',
  text:        '',            // intentionally empty — signals "new format" to createNote()
  notes:       ann.text      || '',   // highlight text moved to notes
  datetime:    ann.datetime  || '',
  highlighted: true,
  pos0:        ann.pos0      || '',
  pos1:        ann.pos1      || '',
  page:        String(ann.pageno ?? -1),
};
```

The empty `text` field is the sentinel: `createNote()` in `main.ts` checks
whether `text` is empty and, if so, reads the page number from `bookmark.page`
directly instead of trying to parse it out of the pre-formatted location string.

---

## `doc_props` — book metadata

Present in both formats. All fields are optional.

```lua
["doc_props"] = {
  ["title"]     = "My Book",
  ["authors"]   = "Jane Doe",
  ["series"]    = "A Series",
  ["language"]  = "en",
  ["description"] = "...",
}
```

If `title` is absent, the plugin falls back to the `.sdr` directory name
(stripped of the `.sdr` suffix). If `authors` is absent it falls back to
`"Unknown"`.
