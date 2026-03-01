# Obsidian KOReader Plugin

Sync [KOReader][1] highlights and annotations into your [Obsidian][2] vault. Connect your KOReader device to the computer running Obsidian, run the sync, and the plugin creates Markdown notes from your highlights — one per highlight, or one per book, depending on your preference.

When you're comfy reading your notes in Obsidian think about how useful this plugin is to you and express your gratitude with a tweet or with a coffee :coffee:

[![Twitter URL](https://img.shields.io/twitter/url?style=social&url=https%3A%2F%2Ftwitter.com%2Fintent%2Ftweet%3Ftext%3DI%2527m%2520enjoying%2520%2540Edo78%2527s%2520%2523Obsidian%2520plugin%2520to%2520sync%2520my%2520%2523KOReader%2520notes.%250AThank%2520you%2520for%2520your%2520great%2520work.%250A%250Ahttps%253A%252F%252Fgithub.com%252FEdo78%252Fobsidian-koreader-sync)](https://twitter.com/intent/tweet?text=I%27m%20enjoying%20%40Edo78%27s%20%23Obsidian%20plugin%20to%20sync%20my%20%23KOReader%20notes.%0AThank%20you%20for%20your%20great%20work.%0A%0Ahttps%3A%2F%2Fgithub.com%2FEdo78%2Fobsidian-koreader-sync)
<a href="https://www.buymeacoffee.com/Edo78" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/default-orange.png" alt="Buy Me A Coffee" height="41" width="174"></a>

---

## Quick start

1. Install the plugin and open its settings
2. Set **KOReader mounted path** to the mount point of your device (e.g. `/media/user/KOBOeReader`)
3. Choose and set a folder for your KOReader highlights
4. Connect your KOReader device
5. Click the **two-documents icon** in the left sidebar (tooltip: `Sync your KOReader highlights`)

The plugin scans the device, finds all highlight files, and creates one Markdown note per highlight in your vault. That's it for the default setup.

---

## Configuration

### Device connection

- `KOReader mounted path` — **must** be set to the path where KOReader is mounted (e.g. `/media/user/KOBOeReader`)

### Vault storage

- `Highlights folder location` — vault folder where notes are written (default: `/`)
- `Book organisation` — controls whether books get their own subfolder:
  - **None** — all notes go into the highlights folder
  - **One folder per book** — new notes go into a subfolder named after the book
  - **Custom path template** — use `{{title}}` and `{{authors}}` variables to define the folder structure (e.g. `{{authors}}/{{title}}` groups books in per-author subfolders); `{{title}}` respects the Book title formatting settings

### Note creation mode

Choose how highlights are saved:
- **Per-highlight notes** (default) — one `.md` file per highlight/bookmark
- **Combined book file** — one `.md` file per book containing all its highlights in sequence

See [Note formats](#note-formats) for details on each mode and their customization options.

### Keeping notes in sync

The `Keep in sync` setting sets the default value of the `koreader_keep_in_sync` frontmatter property on newly imported notes:

| Value | Default `koreader_keep_in_sync` |
|-------|-----------|
| **Active books only** (default) | `true` for books not yet finished, `false` for finished books |
| **Always** | `true` for all books |
| **Never** | `false` for all books |

You can also control this per note with the [Enable/Disable Sync commands](#commands).

### Advanced

The **Reset sync list** button clears the plugin's record of which notes have already been imported. After resetting, the next sync will re-import all highlights from KOReader — including notes that were previously deleted from your vault. Existing notes will be refreshed if needed.

---

## Note formats

### Per-highlight notes (default)

One `.md` file per highlight or bookmark. Notes include the book title, author(s), chapter, page number, the highlighted text, and any annotation you added in KOReader.

The note filename is derived from the first words of the highlight. You can configure a **prefix**, **suffix**, maximum **word count**, and maximum **character length** for filenames.

**Custom template** — enable the toggle and point `Template file` to any `.md` in your vault. Use the **Export default** button to get the built-in template as a starting point. See the [default template](#per-highlight-note-template).

#### Dataview summary note per book

An optional companion feature (toggle in the Per-highlight notes settings): when enabled, the plugin also creates one summary note per book containing a Dataview query that collects and embeds all per-highlight notes for that book. See [Dataview summary note](#dataview-summary-note) below.

---

### Combined book file

One `.md` file per book containing **all** its highlights in sequence, grouped by chapter.

**Custom template** — enable the toggle and point `Template file` to any `.md` in your vault. See the [default template](#combined-book-file-template).

---

### Dataview summary note

Available only in **per-highlight** mode. One summary note is created per book. It contains a `dataviewjs` block that dynamically lists and embeds all per-highlight notes for that book, sorted by page number.

**Requires:** the [Dataview](https://github.com/blacksmithgu/obsidian-dataview) plugin with **Enable JavaScript Queries** turned on.

The notes can be freely moved or renamed in Obsidian — links update automatically.

**Book title formatting** — prefix, suffix, max words, and max length control the book note filename.

**Custom dataview template** — enable the toggle and point `Template file` to your template. See the [default template](#dataview-summary-note-template).

---

## Keeping your notes safe during sync

Each synced note contains a separator line:

```
%% koreader-user-notes %%
```

Everything **above** this line is managed by the plugin and may be overwritten on sync. Everything **below** it is yours — the plugin never touches it.

---

## Commands

**Note:** editor commands (marked with †) are only available when a KOReader-synced note is open.

| Command | Description |
|---------|-------------|
| `Sync` | Same as clicking the plugin icon — triggers a full import |
| `Enable Sync for this note` † | Sets `koreader_keep_in_sync: true` in this note's frontmatter |
| `Disable Sync for this note` † | Sets `koreader_keep_in_sync: false` in this note's frontmatter |

---

## Templates & queries

### Per-highlight note template

The plugin uses [Eta.js](https://eta.js.org/) as its template engine. The default template for per-highlight notes is:

```
## Title: [[<%= it.bookPath %>|<%= it.title %>]]

### by: [[<%= it.authors.join(']], [[') %>]]

### Chapter: <%= it.chapter %>

Page: <%= it.page %>

> <%= it.highlight.split('\n').join('\n> ') %>

<%= it.text %>
```

**Available variables:**

| Variable | Description |
|----------|-------------|
| `it.bookPath` | Vault path to the book's dataview note or folder |
| `it.title` | Book title |
| `it.authors` | Array of author names |
| `it.chapter` | Chapter name |
| `it.page` | Page number |
| `it.highlight` | The highlighted passage |
| `it.text` | Your annotation/note on the highlight |
| `it.datetime` | Highlight timestamp |

---

### Combined book file template

```
# <%= it.title %>

### by: [[<%= it.authors.join(']], [[') %>]]

<progress value="<%= it.percent_finished %>" max="100"> </progress>
<% it.bookmarks.forEach(function(b) { %>
---

### Chapter: <%= b.chapter %>

Page: <%= b.page %>

> <%= b.highlight.split('\n').join('\n> ') %>

<% if (b.text) { %>

> [!note]
> <%= b.text.split('\n').join('\n> ') %>

<% } %>
<% }) %>
```

**Available variables:**

| Variable | Description |
|----------|-------------|
| `it.title` | Book title |
| `it.authors` | Array of author names |
| `it.percent_finished` | Reading progress (0–100) |
| `it.bookmarks` | Array of all bookmark objects |

Each bookmark `b` in the loop exposes: `b.chapter`, `b.page`, `b.highlight`, `b.text`, `b.datetime`.

---

### Dataview summary note template

~~~markdown
# Title: <%= it.data.title %>

<progress value="<%= it.metadata.percent_finished %>" max="100"> </progress>
```dataviewjs
const title = dv.current()['koreader-sync'].metadata.managed_title
dv.pages().where(n => {
return n['koreader-sync'] && n['koreader-sync'].type == 'koreader-sync-note' && n['koreader-sync'].metadata.managed_book_title == title
}).sort(p => p['koreader-sync'].data.page).forEach(p => dv.paragraph('![[' + p.file.path + ']]'))
```
~~~

**Available variables (`it` is the note's `koreader-sync` frontmatter block):**

| Variable | Description |
|----------|-------------|
| `it.data.title` | Book title |
| `it.data.authors` | Authors string |
| `it.metadata.percent_finished` | Reading progress (0–100) |
| `it.metadata.managed_title` | Internal key used by the query to find this book's per-highlight notes |

---

### Dataview query examples

The frontmatter on every synced note makes it easy to query your highlights with [Dataview](https://github.com/blacksmithgu/obsidian-dataview).

#### All books

~~~markdown
```dataview
list
where koreader-sync
group by koreader-sync.data.title
```
~~~

#### Chapters of a specific book

~~~markdown
```dataview
list
where koreader-sync.data.title = "How to Take Smart Notes"
group by koreader-sync.data.chapter
```
~~~

#### Notes from a specific chapter

~~~markdown
```dataview
list
where koreader-sync.data.title = "How to Take Smart Notes" and koreader-sync.data.chapter = "Introduction"
```
~~~

#### Annotation text only (no link, only where annotation is present)

~~~markdown
```dataview
list without id koreader-sync.data.text
where koreader-sync.data.title = "How to Take Smart Notes"
where koreader-sync.data.text
```
~~~

#### Notes kept in sync

~~~markdown
```dataview
list
where koreader_keep_in_sync
```
~~~

---

## Frontmatter reference

Every synced note contains a `koreader-sync` YAML block. The exact fields depend on the note type.

```yaml
koreader_keep_in_sync: true       # top-level; controls future sync for this note

koreader-sync:
  type: "koreader-sync-note"      # "koreader-sync-book-highlights" or "koreader-sync-dataview"
  uniqueId: "<md5>"               # per-highlight notes: md5 of title+authors+position
  uniqueIds: ["<md5>", ...]       # combined book notes: one id per highlight
  data:
    title: "..."
    authors: "..."
    chapter: "..."                # per-highlight only
    page: 42                      # per-highlight only
    highlight: "..."              # per-highlight only
    datetime: "..."               # per-highlight only
  metadata:
    body_hash: "<md5>"            # hash of plugin-managed content; changes signal a manual edit
    managed_book_title: "..."     # original book identifier, used to match highlights across syncs
    percent_finished: 75.0        # reading progress from KOReader
```

[1]: https://koreader.rocks/
[2]: https://obsidian.md
