# Obsidian KOReader Plugin

Sync [KOReader][1] notes in your [Obsidian][2] vault. The KOReader device must be connected to the device running Obsidian to let the plugin scan through its files.

In the beginning of each note there is a series of YAML data known as Frontmatter. Those data are mainly used by the plugin itself (you can use them as shown in [Templates & queries](#templates--queries)) but messing with them will cause unexpected behaviour, so use the provided [commands](#commands) to properly interact with them.

When you're comfy reading your notes in Obsidian think about how useful this plugin is to you and express your gratitude with a tweet or with a coffee :coffee:

[![Twitter URL](https://img.shields.io/twitter/url?style=social&url=https%3A%2F%2Ftwitter.com%2Fintent%2Ftweet%3Ftext%3DI%2527m%2520enjoying%2520%2540Edo78%2527s%2520%2523Obsidian%2520plugin%2520to%2520sync%2520my%2520%2523KOReader%2520notes.%250AThank%2520you%2520for%2520your%2520great%2520work.%250A%250Ahttps%253A%252F%252Fgithub.com%252FEdo78%252Fobsidian-koreader-sync)](https://twitter.com/intent/tweet?text=I%27m%20enjoying%20%40Edo78%27s%20%23Obsidian%20plugin%20to%20sync%20my%20%23KOReader%20notes.%0AThank%20you%20for%20your%20great%20work.%0A%0Ahttps%3A%2F%2Fgithub.com%2FEdo78%2Fobsidian-koreader-sync)
<a href="https://www.buymeacoffee.com/Edo78" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/default-orange.png" alt="Buy Me A Coffee" height="41" width="174"></a>

## Configuration

### Device connection

- `KOReader mounted path` — **must** be set to the path where KOReader is mounted (e.g. `/media/user/KOBOeReader`)

### Vault storage

- `Highlights folder location` — vault folder where notes are written (default: `/`)
- `Book organisation` — controls whether books get their own subfolder:
  - **None** — all notes in the highlights folder
  - **One folder per book** — new notes go into a subfolder named after the book
  - **Custom path template** — use `{{title}}` and `{{authors}}` variables to define the folder structure (e.g. `{{authors}}/{{title}}` groups books in per-author subfolders); `{{title}}` respects the Book title formatting settings below

### Note creation mode

Choose how highlights are saved:
- **Per-highlight notes** (default) — one `.md` file per highlight/bookmark
- **Combined book file** — one `.md` file per book containing all its highlights

See [Sync Modes](#sync-modes) for details on each mode.

### Sync behavior

`Keep in sync` controls the default sync behaviour for newly imported notes:

| Value | Behaviour |
|-------|-----------|
| **Never** (default) | Notes are imported once and never overwritten |
| **Always** | Notes are re-imported and updated on every sync |
| **Unfinished books only** | Notes are updated until the book is marked as finished (100% progress) |

You can override this setting per note using the [Enable/Disable Sync commands](#commands).

### Advanced

The **Reset sync list** button clears the plugin's record of which notes have already been imported. After resetting, the next sync will re-import all highlights from KOReader — including notes that were previously deleted from your vault. Use this if you want to re-import all notes, including the ones you removed from Obsidian.

---

## Sync Modes

### Per-highlight notes

One `.md` file is created per highlight or bookmark. This is the default mode.

**Available template variables:**

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

**Note title formatting** — you can configure a prefix, suffix, maximum word count, and maximum character length for the generated note filenames.

**Custom template** — enable the toggle and point the `Template file` setting to any `.md` file in your vault. Use the **Export default** button to export the built-in template as a starting point. See [default template](#per-highlight-note-template).

#### Dataview summary note per book

When enabled (toggle in the Per-highlight notes section), the plugin also creates one summary note per book containing a Dataview query that embeds all per-highlight notes for that book. See [Dataview summary note](#dataview-summary-note) for details.

---

### Combined book file

One `.md` file per book containing **all** its highlights in sequence. Enabled via the **Note creation mode** dropdown.

**Available template variables:**

| Variable | Description |
|----------|-------------|
| `it.title` | Book title |
| `it.authors` | Array of author names |
| `it.percent_finished` | Reading progress (0–100) |
| `it.bookmarks` | Array of all bookmark objects |

Each bookmark `b` in the loop exposes: `b.chapter`, `b.page`, `b.highlight`, `b.text`, `b.datetime`.

**Custom template** — enable the toggle and point `Template file` to any `.md` in your vault. See [default template](#combined-book-file-template).

---

### Dataview summary note

Available only in **per-highlight** mode. When enabled, one summary note is created per book. It contains a `dataviewjs` block that dynamically lists and embeds all per-highlight notes for that book.

**Requires:** the [Dataview](https://github.com/blacksmithgu/obsidian-dataview) plugin with **Enable JavaScript Queries** turned on.

**Available template variables (`it` is the note's `koreader-sync` frontmatter block):**

| Variable | Description |
|----------|-------------|
| `it.data.title` | Book title |
| `it.data.authors` | Authors string |
| `it.metadata.percent_finished` | Reading progress (0–100) |
| `it.metadata.managed_title` | Internal key that links this summary to its per-highlight notes; used in the `dataviewjs` query to filter notes belonging to this book |

The note can be freely moved or renamed in Obsidian — links update automatically.

**Book title formatting** — prefix, suffix, max words, and max length for the book note filename and for `managed_title`.

**Custom dataview template** — enable the toggle and point `Template file` to your template. See [default template](#dataview-summary-note-template).

---

## Usage

Once the plugin is configured, connect your KOReader device and click the icon with two documents (tooltip: `Sync your KOReader highlights`). The plugin will create one file per highlight (or one per book in combined mode).

---

## Commands

**Note:** editor commands are only available when a KOReader-synced note is open.

| Command | Description |
|---------|-------------|
| `Sync` | Same as clicking the plugin icon — triggers a full import |
| `Enable Sync for this note` | Sets `koreader_keep_in_sync: true` in this note's frontmatter |
| `Disable Sync for this note` | Sets `koreader_keep_in_sync: false` in this note's frontmatter |

---

## Sync

The `koreader_keep_in_sync` top-level frontmatter property controls whether a note is updated on future syncs. Its default value is determined by the **Keep in sync** setting (never / always / unfinished books only) and can be overridden per note with the commands above or by enabling / disabling the checkbox in the frontmatter properties.

**WARNING:** When a note is synced it is overwritten. Anything you added inside the plugin-managed section will be lost. See [Note Editing](#note-editing) for how to safely annotate synced notes.

---

## Note Editing

Each synced note contains a separator line:

```
%% koreader-user-notes %%
```

Everything **above** this line is managed by the plugin and may be overwritten on sync. Everything **below** it is yours — the plugin never touches it.

The plugin automatically detects whether the plugin-managed section has been edited (using a body hash). If it has, the note is treated as manually edited and will be skipped on future syncs, even if `koreader_keep_in_sync` is `true`. Use `Mark this note as NOT Edited` to re-enable sync and allow the plugin to overwrite it.

Use `Mark this note as Edited` to manually flag a note as edited (for example, if you changed something other than the body text).

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

---

## Templates & queries

### Per-highlight note template

```
## Title: [[<%= it.bookPath %>|<%= it.title %>]]

### by: [[<%= it.authors.join(']], [[') %>]]

### Chapter: <%= it.chapter %>

Page: <%= it.page %>

> <%= it.highlight.split('\n').join('\n> ') %>

<%= it.text %>
```

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

---

### Dataview query examples

Thanks to the frontmatter data in each note you can use Dataview to query your highlights.

#### Books

~~~markdown
```dataview
list
where koreader-sync
group by koreader-sync.data.title
```
~~~

#### Chapters of a specific book (with notes in them)

~~~markdown
```dataview
list
where koreader-sync.data.title = "How to Take Smart Notes"
group by koreader-sync.data.chapter
```
~~~

#### Notes of a specific chapter of a specific book

~~~markdown
```dataview
list
where koreader-sync.data.title = "How to Take Smart Notes" and koreader-sync.data.chapter = "Introduction"
```
~~~

#### Text of notes of a specific book (only where annotation is present)

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

[1]: https://koreader.rocks/
[2]: https://obsidian.md
