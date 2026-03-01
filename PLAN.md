# Refactoring Plan

Ordered so that each step's prerequisites are already in place.
The rule: **foundations before consumers**, **correctness before performance**, **structure before cleanup**.

---

## Phase 1 — Housekeeping (no code deps, do first)

These are standalone removals/fixes that cannot break anything else and
unblock later steps by eliminating noise.

### 1.1 Remove unused `diff` dependency
- `package.json`: remove `"diff"` from `dependencies`
- `package.json`: remove `"@types/diff"` from `devDependencies`
- Run `npm install` to update `package-lock.json`

### 1.2 Remove `Book.highlight: any` dead field
- `src/types.d.ts`: delete the `highlight: any;` field from `Book`
- Verify no code references it (grep confirms it is never read)

### 1.3 Remove unused `updateNote` variable
- `src/main.ts:804`: delete `const updateNote: boolean = false;`

### 1.4 Fix missing `await` on vault write
- `src/main.ts:653`: add `await` before `this.app.vault.modify(...)`
- This is a correctness bug — without `await` a failed write is silently lost

---

## Phase 2 — Foundation: constants & refined types

Everything that follows imports from these files.
Create them before touching any business logic.

### 2.1 Create `src/constants.ts`
Extract all magic values from `main.ts` and `koreader-metadata.ts`:
```ts
export const KOREADER_KEY      = 'koreader-sync';   // replaces KOREADERKEY
export const MAX_SUGGESTIONS   = 20;
export const BLUR_CLOSE_DELAY  = 150;               // ms
export const PAGE_NUMBER_RE    = /\d+/g;
```
Update every reference in `main.ts` to import from this file.

### 2.2 Strengthen `src/types.d.ts`

**Add `ParsedLuaMetadata`** (replaces `any` in `koreader-metadata.ts`):
```ts
export interface ParsedLuaAnnotation {
  text?: string; note?: string; chapter?: string;
  datetime?: string; datetime_updated?: string;
  pageno?: number; pos0?: string; pos1?: string;
}
export interface ParsedLuaBookmark {
  text?: string; notes?: string; chapter?: string;
  datetime?: string; highlighted?: boolean;
  pos0?: string; pos1?: string; page?: string;
}
export interface ParsedLuaMetadata {
  doc_props?:        { title?: string; authors?: string };
  percent_finished?: number;
  annotations?:      Record<string, ParsedLuaAnnotation>;
  bookmarks?:        Record<string, ParsedLuaBookmark>;
}
```

**Tighten `FrontMatter`**:
- Change `type: string` → `type: NoteType` (move `NoteType` enum to `types.d.ts` or a shared file so both `main.ts` and future modules can import it)
- Remove deprecated `keep_in_sync?: boolean` from `FrontMatterMetadata` (greenfield — no migration needed)

**Add `ScanResult`** for error-aware scanning:
```ts
export interface ScanResult {
  books:  Books;
  errors: Array<{ file: string; reason: string }>;
}
```

### 2.3 Move `NoteType` enum out of `main.ts`
- Move to `src/types.d.ts` (or a new `src/note-type.ts`)
- Update import in `main.ts`
- This is required before the module split in Phase 4

---

## Phase 3 — Utility extraction (small, safe, high-ROI)

Create helpers that multiple future modules will share.
Each is a pure function or thin class — easy to verify correct.

### 3.1 Create `src/utils.ts` — shared utilities
```ts
import * as crypto from 'crypto';
import { normalizePath } from 'obsidian';

/** MD5 hex digest of a string. */
export function md5(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

/** Safely resolve a book-folder path, guarding against traversal. */
export function safeResolvePath(template: string, vars: Record<string, string>): string {
  const resolved = Object.entries(vars).reduce(
    (tpl, [k, v]) => tpl.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v),
    template
  );
  return normalizePath(resolved);   // Fix: path traversal issue (was raw string concat)
}

/** Extract integer page number from a Bookmark (handles both KOReader formats). */
export function getPageNumber(bookmark: Bookmark): number {
  if (!bookmark.text) return parseInt(bookmark.page, 10) || -1;
  return parseInt(bookmark.text.match(/\d+/g)?.[0] ?? '', 10) || -1;
}

/** Extract the user-visible note text from a Bookmark. */
export function getNoteText(bookmark: Bookmark): string {
  if (!bookmark.text) return bookmark.userNote ?? '';
  return (bookmark.text.split(bookmark.datetime)[1] ?? '').trim();
}
```
Replace all 7 `createHash` call-sites, all 2 page-number extraction sites,
all 2 note-text extraction sites, and the unsafe path-resolution site.

### 3.2 Extract `getTemplate()` helper inside `main.ts`
Before splitting the class, reduce the 3× repeated template-loading pattern
to a single private method:
```ts
private async getTemplate(
  customEnabled: boolean,
  templatePath: string,
  defaultTemplate: string,
): Promise<string> {
  if (!customEnabled) return defaultTemplate;
  const f = this.app.vault.getAbstractFileByPath(templatePath);
  if (!(f instanceof TFile)) return defaultTemplate;  // Fix: safe cast
  return this.app.vault.read(f);
}
```
Replace the three copy-paste blocks at lines ~480, ~553, ~636.

### 3.3 Extract `buildFrontmatter()` helper inside `main.ts`
Deduplicate the two identical frontmatter object construction blocks (~499 and ~571):
```ts
private buildFrontmatter(
  type: NoteType,
  uniqueId: string | string[],
  data: FrontMatterData,
  extra: Record<string, unknown>,
  opts: { keepInSync: boolean; bodyHash: string; managedTitle: string; percent: number },
): Record<string, unknown> { ... }
```

### 3.4 Extract `createExportButton()` helper inside `KoreaderSettingTab`
Deduplicate the 3 identical export-template button blocks (~1287, ~1407, ~1476):
```ts
private createExportButton(
  btn: ButtonComponent,
  defaultContent: string,
  filePath: string,
  onSuccess: (path: string) => Promise<void>,
): void { ... }
```

---

## Phase 4 — Structural split (the big refactor)

Do this after utilities exist so each extracted module is clean from day one.

### 4.1 Extract `src/suggest.ts` — abstract suggest base class
`FolderSuggest` (lines 871–970) and `FileSuggest` (972–1072) share ~95% of code.
Create:
```ts
abstract class AbstractSuggest<T extends TAbstractFile> {
  protected abstract filter(f: TAbstractFile, query: string): f is T;
  // shared: constructor, open, close, render, setSelected, selectItem, event wiring
}
export class FolderSuggest extends AbstractSuggest<TFolder> { ... }
export class FileSuggest  extends AbstractSuggest<TFile>   { ... }
```
Import both into `main.ts` (later into `settings.ts`).

### 4.2 Extract `src/note-factory.ts`
Move out of the plugin class:
- `createNote()`
- `createBookHighlightsNote()`
- `createDataviewQueryPerBook()`
- Template constants (`DEFAULT_NOTE_TEMPLATE`, `DEFAULT_BOOK_HIGHLIGHTS_TEMPLATE`, `DEFAULT_DATAVIEW_TEMPLATE`)

These methods only need the Obsidian `App` and `KOReaderSettings` — pass them in the constructor.

### 4.3 Extract `src/importer.ts`
Move `importNotes()` and its direct helpers:
- `resolveBookPath()`
- `manageTitle()`
- `getObjectProperty()` / `setObjectProperty()` → replace with `src/frontmatter.ts` (see below)

### 4.4 Extract `src/frontmatter.ts`
Move frontmatter-specific logic:
- `updateMetadataText()`
- `getObjectProperty()`
- `setObjectProperty()`

Type the parameters properly using the strengthened interfaces from Phase 2.

### 4.5 Extract `src/settings-tab.ts`
Move `KoreaderSettingTab` (currently ~535 lines inside `main.ts`) to its own file.
At this point `main.ts` should only contain:
- Plugin lifecycle (`onload`, `onunload`)
- `loadSettings()` / `saveSettings()`
- Registration of commands, ribbon, event listeners
- Wiring of `KOReaderMetadata`, `NoteFactory`, `Importer`

---

## Phase 5 — Type safety sweep

Now that the structure is stable, fix remaining type holes.

### 5.1 Type `koreader-metadata.ts` with `ParsedLuaMetadata`
- Replace `const metadatas: any = {}` → `const metadatas: Books = {}`
- Replace `const jsonMetadata: any = parse(content)` → `const jsonMetadata = parse(content) as ParsedLuaMetadata`
- Replace `let normalizedBookmarks: any = null` → `let normalizedBookmarks: Bookmarks | null = null`
- Return `ScanResult` instead of `Books` (carry parse errors to caller)

### 5.2 Fix unsafe casts in note-factory / importer
Every `getAbstractFileByPath(...) as TFile` must become an `instanceof TFile` guard.
Affects the 4 cast sites identified in the analysis.

### 5.3 Generic `getObjectProperty` / `setObjectProperty`
After moving to `frontmatter.ts`, add a type parameter:
```ts
function getProperty<T>(obj: Record<string, unknown>, path: string): T | undefined
```

### 5.4 Type `FrontMatter.type` as `NoteType`
Now that `NoteType` is exported (Phase 2.3), update the interface and all assignments.

---

## Phase 6 — Performance

Safe to do after structure is settled.

### 6.1 Replace `Object.keys().includes()` with `Set`
Three locations in `importer.ts` (was `main.ts:813-846`):
```ts
const importedSet = new Set(Object.keys(this.settings.importedNotes));
if (!importedSet.has(uniqueId)) { ... }
```

### 6.2 Cache `existingNotes` map across syncs
- Build the `existingNotes` map once in `onload()` / after first sync
- Invalidate via `metadataCache.on('changed', ...)` (already used elsewhere in the plugin)
- Avoids iterating all vault files on every sync

### 6.3 Replace `node-find-files` with Node built-in recursive walk
Node 18+ has `fs.readdirSync(dir, { recursive: true })`.
Eliminates one dependency and the event-emitter indirection,
making the scan synchronous and easier to wrap in `ScanResult`.

---

## Phase 7 — Error handling hardening

### 7.1 Surface scan errors to user
`KOReaderMetadata.scan()` now returns `ScanResult`.
In `importer.ts`, after scan, if `result.errors.length > 0`:
```ts
new Notice(`KOReader: ${result.errors.length} file(s) failed to parse — check console`);
```

### 7.2 Wrap all vault operations in consistent try/catch
The note-update path in `importer.ts` (~line 851-863) has no error handling.
Wrap with the same pattern used for note creation.

### 7.3 Harden `catch` blocks against non-Error values
Replace all `e.message` accesses with:
```ts
const msg = e instanceof Error ? e.message : String(e);
```
Affects ~6 catch blocks across settings-tab, importer, note-factory.

---

## Phase 8 — Final cleanup

Cosmetic changes last — they generate the most diff noise and should not
be interleaved with logic changes.

### 8.1 Rename confusing fields
- `Bookmark.notes` → `Bookmark.highlightText` (it stores highlight text, not user notes)
- `Bookmark.userNote` → `Bookmark.annotationText` (clearer semantics)
- Update all read/write sites (now centralized in note-factory and koreader-metadata)

### 8.2 Remove deprecated `keep_in_sync` from `FrontMatterMetadata`
Greenfield project — no migration needed.
Remove the field and all read paths that fall back to the old key.

### 8.3 Consistent naming: `KOREADER_KEY` everywhere
Ensure `src/constants.ts` value is used in every location;
no remaining string literals `'koreader-sync'` outside that file.

### 8.4 Enable `autoEscape` in Eta
```ts
this.eta = new Eta({ cache: true, autoEscape: true });
```
Verify templates still render correctly (the default templates use `<%=` which auto-escapes HTML entities; adjust any template that deliberately outputs HTML like `<progress>`).

---

## File map after refactor

```
src/
  constants.ts          # Phase 2.1
  types.d.ts            # Phase 2.2 (strengthened)
  utils.ts              # Phase 3.1
  suggest.ts            # Phase 4.1
  frontmatter.ts        # Phase 4.4
  note-factory.ts       # Phase 4.2
  importer.ts           # Phase 4.3
  settings-tab.ts       # Phase 4.5
  koreader-metadata.ts  # Phase 5.1 + 6.3
  main.ts               # stripped to lifecycle + wiring
```

---

## Execution notes

- **Build after each phase** (`npm run build`) to catch regressions early.
- **Lint after Phase 8** (`npm run lint`) once naming is stable.
- Phases 1–3 can be committed individually as small, reviewable PRs.
- Phase 4 (structural split) is one large commit — splitting it across commits
  risks leaving the build broken mid-way.
- Phases 5–8 can each be their own commit.
