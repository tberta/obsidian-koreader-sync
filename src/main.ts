import { Eta } from 'eta';

import {
  Editor,
  MarkdownView,
  Plugin,
  TAbstractFile,
  TFile,
  normalizePath,
  Notice,
} from 'obsidian';
import matter from 'gray-matter';
import { Book, Bookmark, Books, ScanResult } from './types';
import { KOREADER_KEY, KOREADER_USER_SECTION_SEPARATOR, NoteType } from './constants';
import { md5, safeResolvePath, getPageNumber, getNoteText, bookmarkContentHash } from './utils';
import { KOReaderSettings, TitleOptions, DEFAULT_SETTINGS } from './settings';
import { DEFAULT_NOTE_TEMPLATE, DEFAULT_BOOK_HIGHLIGHTS_TEMPLATE, DEFAULT_DATAVIEW_TEMPLATE } from './templates';
import { KoreaderSettingTab } from './settings-tab';
import { KOReaderMetadata } from './koreader-metadata';

function computeKeepInSync(
  mode: KOReaderSettings['keepInSyncMode'],
  percentFinished: number
): boolean {
  if (mode === 'always') return true;
  if (mode === 'unfinished') return percentFinished < 100;
  return false;
}

export default class KOReader extends Plugin {
  settings: KOReaderSettings;
  private eta: Eta;

  private manageTitle(title: string, options: TitleOptions = {}): string {
    if (!title) {
      return `${options.prefix || ''}${options.suffix || ''}`;
    }
    // replace characters forbidden on Windows/macOS/Linux filesystems with _
    title = title.replace(/[\\/:*?"<>|]/g, '_');
    // strip non-printable control characters, excluding whitespace (\t \n \r)
    title = title.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    // replace multiple underscores with one underscore
    title = title.replace(/_+/g, '_');
    // remove leading and trailing whitespace
    title = title.trim();
    // remove leading and trailing underscores or dots (Windows rejects trailing dots)
    title = title.replace(/^[_.]+|[_.]+$/g, '');
    // replace multiple spaces with one space
    title = title.replace(/\s+/g, ' ');
    // if options.maxLength is set, trim the title to that length and add '...'
    if (options.maxLength && title.length > options.maxLength) {
      title = `${title.substring(0, options.maxLength)}...`;
    }
    // if options.maxWords is set, trim the title to that number of words and add '...'
    if (options.maxWords && title.split(' ').length > options.maxWords) {
      title = `${title.split(' ').slice(0, options.maxWords).join(' ')}...`;
    }

    return `${options.prefix || ''}${title}${options.suffix || ''}`;
  }

  private resolveBookPath(book: Book): { folder: string; basename: string } {
    const tpl = this.settings.bookFolderTemplate?.trim();
    if (!tpl) {
      // backward-compat: honour aFolderForEachBook
      const managedTitle = `${this.manageTitle(book.title, this.settings.bookTitleOptions)}-${this.manageTitle(book.authors?.split('\n').map(a => a.trim()).filter(a => a).join(' & ') ?? '', {})}`;
      return this.settings.aFolderForEachBook
        ? { folder: managedTitle, basename: managedTitle }
        : { folder: '', basename: managedTitle };
    }
    const sanitizedTitle   = this.manageTitle(book.title,   this.settings.bookTitleOptions);
    const sanitizedAuthors = this.manageTitle(book.authors?.split('\n').map(a => a.trim()).filter(a => a).join(' & ') ?? '', {});
    const resolved = safeResolvePath(tpl, { title: sanitizedTitle, authors: sanitizedAuthors });
    const lastSlash = resolved.lastIndexOf('/');
    return lastSlash >= 0
      ? { folder: resolved.slice(0, lastSlash), basename: resolved.slice(lastSlash + 1) }
      : { folder: '', basename: resolved };
  }

  private async ensureFolder(folderPath: string) {
    if (!folderPath) return;
    const parts = normalizePath(folderPath).split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private async renderTemplate(
    template: string,
    data: object
  ): Promise<{ body: string; extraFrontmatter: Record<string, any> }> {
    // koreader-fm-template approach: template file has a YAML block-scalar key
    // containing the Eta frontmatter template, keeping the file itself valid YAML.
    // Normalize: ensure a blank line before closing --- so gray-matter/js-yaml correctly
    // terminates the block scalar regardless of whether the user included one.
    const normalizedTemplate = template.replace(/([^\n])\n---/g, '$1\n\n---');
    const { data: templateFileFm, content: bodyTemplate } = matter(normalizedTemplate, {});
    if (templateFileFm['koreader-fm-template']) {
      const renderedFm = this.eta.renderString(templateFileFm['koreader-fm-template'], data) as string;
      const { data: extraFrontmatter } = matter(`---\n${renderedFm}\n---`, {});
      const body = this.eta.renderString(bodyTemplate, data) as string;
      return { body, extraFrontmatter };
    }

    // Legacy approach: rendered output starts with ---, parse it as frontmatter + body.
    const rendered = this.eta.renderString(template, data) as string;
    if (rendered.trimStart().startsWith('---')) {
      const { data: extraFrontmatter, content: body } = matter(rendered, {});
      return { body, extraFrontmatter };
    }
    return { body: rendered, extraFrontmatter: {} };
  }

  async onload() {
    this.eta = new Eta({
      cache: true,
      autoEscape: false,
      rmWhitespace: false,
    });
    await this.loadSettings();

    const ribbonIconEl = this.addRibbonIcon(
      'documents',
      'Sync your KOReader highlights',
      this.importNotes.bind(this)
    );

    this.addCommand({
      id: 'obsidian-koreader-plugin-sync',
      name: 'Sync',
      callback: () => {
        this.importNotes();
      },
    });

    this.addCommand({
      id: 'obsidian-koreader-plugin-set-sync',
      name: 'Enable Sync for this note',
      editorCheckCallback: (
        checking: boolean,
        editor: Editor,
        view: MarkdownView
      ) => {
        // Check new top-level property, fall back to old nested location
        const val =
          this.getFrontmatterProperty('koreader_keep_in_sync', view) ??
          this.getFrontmatterProperty(`${KOREADER_KEY}.metadata.keep_in_sync`, view);
        if (checking) {
          return val === false;
        }
        this.setFrontmatterProperty('koreader_keep_in_sync', true, view);
      },
    });

    this.addCommand({
      id: 'obsidian-koreader-plugin-clear-sync',
      name: 'Disable Sync for this note',
      editorCheckCallback: (
        checking: boolean,
        editor: Editor,
        view: MarkdownView
      ) => {
        const val =
          this.getFrontmatterProperty('koreader_keep_in_sync', view) ??
          this.getFrontmatterProperty(`${KOREADER_KEY}.metadata.keep_in_sync`, view);
        if (checking) {
          return val === true;
        }
        this.setFrontmatterProperty('koreader_keep_in_sync', false, view);
      },
    });

    this.addSettingTab(new KoreaderSettingTab(this.app, this));
  }

  onunload() {}

  async loadSettings() {
    const loaded = await this.loadData() as Partial<KOReaderSettings> & { keepInSync?: boolean } | null;
    this.settings = { ...DEFAULT_SETTINGS, ...loaded };
    // Migrate old keepInSync boolean to keepInSyncMode
    if (!loaded?.keepInSyncMode && 'keepInSync' in (loaded ?? {})) {
      this.settings.keepInSyncMode = loaded.keepInSync ? 'always' : 'never';
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private getObjectProperty(object: { [x: string]: any }, path: string) {
    if (path === undefined || path === null) {
      return object;
    }
    const parts = path.split('.');
    for (let i = 0; i < parts.length; ++i) {
      if (object === undefined || object === null) {
        return undefined;
      }
      const key = parts[i];
      object = object[key];
    }
    return object;
  }

  private setObjectProperty(
    object: { [x: string]: any },
    path: string,
    value: any
  ) {
    const parts = path.split('.');
    const limit = parts.length - 1;
    for (let i = 0; i < limit; ++i) {
      const key = parts[i];
      object = object[key] ?? (object[key] = {});
    }
    const key = parts[limit];
    object[key] = value;
  }

  setFrontmatterProperty(property: string, value: any, view: MarkdownView) {
    const { data, content } = matter(view.data, {});
    this.setObjectProperty(data, property, value);
    const note = matter.stringify(content, data);
    view.setViewData(note, false);
    view.requestSave();
  }

  getFrontmatterProperty(property: string, view: MarkdownView): any {
    const { data, content } = matter(view.data, {});
    return this.getObjectProperty(data, property);
  }

  private async getTemplate(
    customEnabled: boolean,
    templatePath: string | undefined,
    defaultTemplate: string,
  ): Promise<string> {
    if (!customEnabled || !templatePath) return defaultTemplate;
    const f = this.app.vault.getAbstractFileByPath(templatePath);
    if (!(f instanceof TFile)) return defaultTemplate;
    return this.app.vault.read(f);
  }

  private async createNote(note: {
    path: string;
    uniqueId: string;
    bookmark: Bookmark;
    managedBookTitle: string;
    book: Book;
    keepInSync?: boolean;
  }) {
    const { path, uniqueId, bookmark, managedBookTitle, book, keepInSync } =
      note;
    // Old format: page is the first number in the formatted text string.
    // New format: text is empty; page number was stored directly in bookmark.page.
    const page = getPageNumber(bookmark);
    const noteItself = getNoteText(bookmark);
    const noteTitle = noteItself
      ? this.manageTitle(noteItself, this.settings.noteTitleOptions)
      : `${this.manageTitle(
          bookmark.highlightText || '',
          this.settings.noteTitleOptions
        )} - ${this.manageTitle(book.authors?.split('\n').map(a => a.trim()).filter(a => a).join(' & ') ?? '', {})}`;
    const notePath = normalizePath(`${path}/${noteTitle}`);

    const template = await this.getTemplate(this.settings.customTemplate, this.settings.templatePath, DEFAULT_NOTE_TEMPLATE);
    const bookPath = normalizePath(`${path}/${managedBookTitle}`);
    const { body, extraFrontmatter } = await this.renderTemplate(template, {
      bookPath,
      title: book.title,
      authors: book.authors?.split('\n').map(a => a.trim()).filter(a => a) ?? [],
      chapter: bookmark.chapter,
      highlightText: bookmark.highlightText,
      text: noteItself,
      datetime: bookmark.datetime,
      page,
    });

    const computedKeepInSync = keepInSync ?? computeKeepInSync(this.settings.keepInSyncMode, book.percent_finished);
    const frontmatterData = {
      koreader_keep_in_sync: computedKeepInSync,
      ...extraFrontmatter,
      [KOREADER_KEY]: {
        type: NoteType.SINGLE_NOTE,
        uniqueId,
        data: {
          title: book.title ?? '',
          authors: book.authors?.split('\n').map(a => a.trim()).filter(a => a) ?? [],
          chapter: bookmark.chapter ?? '',
          page,
          highlightText: bookmark.highlightText ?? '',
          datetime: bookmark.datetime ?? '',
        },
        metadata: {
          body_hash: md5(body),
          managed_book_title: managedBookTitle,
          last_read_date: book.last_read_date,
          status: book.status,
        },
      },
    };

    return { content: body + KOREADER_USER_SECTION_SEPARATOR, frontmatterData, notePath };
  }

  private async createBookHighlightsNote(params: {
    path: string;
    managedBookTitle: string;
    book: Book;
    uniqueIds: string[];
    contentHashes?: Record<string, string>;
    keepInSync?: boolean;
  }): Promise<{ content: string; frontmatterData: object; notePath: string }> {
    const { path, managedBookTitle, book, uniqueIds, contentHashes, keepInSync } = params;

    // Build sorted bookmarks array
    const bookmarks = Object.values(book.bookmarks)
      .map((bookmark: Bookmark) => {
        const page = getPageNumber(bookmark);
        const text = getNoteText(bookmark);
        return {
          chapter: bookmark.chapter ?? '',
          highlightText: bookmark.highlightText ?? '',
          text,
          datetime: bookmark.datetime ?? '',
          page,
        };
      })
      .sort((a, b) => a.page - b.page);

    const template = await this.getTemplate(this.settings.customSingleFileTemplate, this.settings.singleFileTemplatePath, DEFAULT_BOOK_HIGHLIGHTS_TEMPLATE);

    const { body, extraFrontmatter } = await this.renderTemplate(template, {
      title: book.title,
      authors: book.authors?.split('\n').map(a => a.trim()).filter(a => a) ?? [],
      percent_finished: book.percent_finished,
      bookmarks,
    });

    const notePath = normalizePath(`${path}/${managedBookTitle}`);
    const bodyWithSeparator = body + KOREADER_USER_SECTION_SEPARATOR;

    const computedKeepInSync = keepInSync ?? computeKeepInSync(this.settings.keepInSyncMode, book.percent_finished);
    const frontmatterData = {
      koreader_keep_in_sync: computedKeepInSync,
      ...extraFrontmatter,
      [KOREADER_KEY]: {
        type: NoteType.BOOK_HIGHLIGHTS,
        uniqueIds,
        ...(contentHashes ? { contentHashes } : {}),
        data: {
          title: book.title ?? '',
          authors: book.authors?.split('\n').map(a => a.trim()).filter(a => a) ?? [],
        },
        metadata: {
          body_hash: md5(body),
          percent_finished: book.percent_finished,
          managed_book_title: managedBookTitle,
          last_read_date: book.last_read_date,
          status: book.status,
          book_checksum: book.checksum,
        },
      },
    };

    return { content: bodyWithSeparator, frontmatterData, notePath };
  }

  async createDataviewQueryPerBook(
    dataview: {
      path: string;
      managedBookTitle: string;
      book: Book;
    },
    updateNote?: TFile
  ) {
    const { path, book, managedBookTitle } = dataview;
    let keepInSync = computeKeepInSync(this.settings.keepInSyncMode, book.percent_finished);
    let rawExisting: string | undefined;
    if (updateNote) {
      rawExisting = await this.app.vault.read(updateNote);
      const { data } = matter(rawExisting, {});
      keepInSync = data.koreader_keep_in_sync ?? data[KOREADER_KEY]?.metadata?.keep_in_sync ?? false;
      if (!keepInSync) {
        return;
      }
    }
    const frontMatter = {
      koreader_keep_in_sync: keepInSync,
      cssclass: NoteType.BOOK_NOTE,
      [KOREADER_KEY]: {
        uniqueId: md5(`${book.title} - ${book.authors}`),
        type: NoteType.BOOK_NOTE,
        data: {
          title: book.title,
          authors: book.authors?.split('\n').map(a => a.trim()).filter(a => a) ?? [],
        },
        metadata: {
          percent_finished: book.percent_finished,
          managed_title: managedBookTitle,
          last_read_date: book.last_read_date,
          status: book.status,
          book_checksum: book.checksum,
        },
      },
    };

    const template = await this.getTemplate(this.settings.customDataviewTemplate, this.settings.dataviewTemplatePath, DEFAULT_DATAVIEW_TEMPLATE);
    const { body, extraFrontmatter } = await this.renderTemplate(
      template,
      frontMatter[KOREADER_KEY]
    );
    const mergedFrontmatter = {
      koreader_keep_in_sync: keepInSync,
      ...extraFrontmatter,
      cssclass: NoteType.BOOK_NOTE,
      [KOREADER_KEY]: frontMatter[KOREADER_KEY],
    };
    if (updateNote) {
      // Skip the write when nothing meaningful has changed.
      //
      // We compare the rendered body text directly rather than via a stored
      // hash, because matter.stringify always appends a trailing '\n' to the
      // body when the file is written, and other frontmatter plugins (e.g.
      // "Update time on edit") may reformat the YAML on every save — making
      // hash-based or full-string comparisons unreliable.
      const existingParsed = matter(rawExisting!, {});
      const existingMeta  = existingParsed.data?.[KOREADER_KEY]?.metadata;
      // matter.stringify adds a trailing '\n' if the body lacks one; normalise
      // to that same form so the comparison is stable.
      const expectedBody  = body.endsWith('\n') ? body : body + '\n';
      // Obsidian's YAML parser converts bare YYYY-MM-DD scalars to JS Date
      // objects, which serialise back as full ISO strings ("2026-02-10T00:00:00.000Z").
      // Compare only the date portion so the forms always match.
      // Obsidian's YAML parser may return a JS Date object instead of a string.
      const datePrefix = (d?: unknown): string | undefined => {
        if (!d) return undefined;
        if (d instanceof Date) return d.toISOString().slice(0, 10);
        return String(d).slice(0, 10);
      };
      const bodyMatch          = existingParsed.content        === expectedBody;
      const percentMatch       = existingMeta?.percent_finished === book.percent_finished;
      const lastReadMatch      = datePrefix(existingMeta?.last_read_date) === datePrefix(book.last_read_date);
      const statusMatch        = existingMeta?.status           === book.status;
      const managedTitleMatch  = existingMeta?.managed_title    === managedBookTitle;
      const unchanged = bodyMatch && percentMatch && lastReadMatch && statusMatch && managedTitleMatch;
      if (!unchanged) {
        console.debug('[KOReader] dataview note update triggered for', updateNote.path, {
          bodyMatch,
          percentMatch,     percentStored: existingMeta?.percent_finished, percentLive: book.percent_finished,
          lastReadMatch,    lastReadStored: existingMeta?.last_read_date,  lastReadLive: book.last_read_date,
          statusMatch,      statusStored: existingMeta?.status,            statusLive: book.status,
          managedTitleMatch, managedTitleStored: existingMeta?.managed_title, managedTitleLive: managedBookTitle,
          bodyDiff: !bodyMatch ? {
            existingLength: existingParsed.content.length,
            expectedLength: expectedBody.length,
            existingTail: JSON.stringify(existingParsed.content.slice(-30)),
            expectedTail: JSON.stringify(expectedBody.slice(-30)),
          } : undefined,
        });
        await this.app.vault.modify(updateNote, matter.stringify(body, mergedFrontmatter));
      }
    } else {
      this.app.vault.create(
        `${path}/${managedBookTitle}.md`,
        matter.stringify(body, mergedFrontmatter)
      );
    }
  }

  private findNoteByChecksum(checksum: string, type: NoteType): TFile | null {
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (
        fm?.[KOREADER_KEY]?.type === type &&
        fm[KOREADER_KEY]?.metadata?.book_checksum === checksum
      ) {
        return f;
      }
    }
    return null;
  }

  async importNotes() {
    new Notice('KOReader: sync started…');
    const metadata = new KOReaderMetadata(this.settings.koreaderBasePath);
    const { books: data, errors }: ScanResult = await metadata.scan();
    if (errors.length > 0) {
      new Notice(`KOReader: ${errors.length} file(s) failed to parse — check the developer console`);
    }

    // Migration pass: promote nested keep_in_sync to root-level koreader_keep_in_sync
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (
        fm?.[KOREADER_KEY] &&
        fm.koreader_keep_in_sync === undefined &&
        fm[KOREADER_KEY].metadata?.keep_in_sync !== undefined
      ) {
        const nestedValue = fm[KOREADER_KEY].metadata.keep_in_sync;
        await this.app.fileManager.processFrontMatter(f, (fmObj) => {
          fmObj.koreader_keep_in_sync = nestedValue;
          if (fmObj[KOREADER_KEY]?.metadata) {
            delete fmObj[KOREADER_KEY].metadata.keep_in_sync;
          }
        });
      }
    }

    // create a list of notes already imported in obsidian
    const existingNotes: {
      [key: string]: {
        keep_in_sync: boolean;
        note: TAbstractFile;
      };
    } = {};
    this.app.vault.getMarkdownFiles().forEach((f) => {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (fm?.[KOREADER_KEY]?.uniqueId) {
        existingNotes[fm[KOREADER_KEY].uniqueId] = {
          // Read from top-level property; fall back to old nested location for older notes
          keep_in_sync: fm.koreader_keep_in_sync ?? fm[KOREADER_KEY].metadata?.keep_in_sync ?? false,
          note: f,
        };
      }
    });

    // Use a Set for O(1) membership checks instead of Object.keys().includes()
    const importedSet = new Set(Object.keys(this.settings.importedNotes));

    // Migration: fix stale uniqueIds for PDF per-highlight notes.
    // Before the pos normalization fix, PDF pos0/pos1 coordinate objects were
    // serialized as "[object Object]" in template literals, so every bookmark in
    // a PDF book collapsed to the same uniqueId. We repair those stored
    // uniqueIds now, updating both the vault frontmatter and the in-memory maps
    // so the rest of this sync runs with correct data immediately.
    {
      // Build (title|datetime) → correct uniqueId from the freshly-scanned data.
      const correctIdByKey = new Map<string, string>();
      for (const bookKey in data) {
        const book = data[bookKey];
        for (const bmKey in book.bookmarks) {
          const bm = book.bookmarks[bmKey as any];
          if (!bm.datetime) continue;
          const key = `${book.title}|${bm.datetime}`;
          // pos0/pos1 are already proper strings thanks to normalizePos() in the parser.
          // Use datetime fallback when both pos values are empty (navigation bookmarks).
          const posKey = (bm.pos0 || bm.pos1) ? `${bm.pos0} - ${bm.pos1}` : bm.datetime;
          correctIdByKey.set(key, md5(`${book.title} - ${book.authors} - ${posKey}`));
        }
      }
      // Scan SINGLE_NOTEs; repair any whose stored uniqueId is stale.
      for (const f of this.app.vault.getMarkdownFiles()) {
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
        if (fm?.[KOREADER_KEY]?.type !== NoteType.SINGLE_NOTE) continue;
        const staleId        = fm[KOREADER_KEY]?.uniqueId as string | undefined;
        const storedTitle    = fm[KOREADER_KEY]?.data?.title as string | undefined;
        const storedDatetime = fm[KOREADER_KEY]?.data?.datetime as string | undefined;
        if (!staleId || !storedTitle || !storedDatetime) continue;
        const correctId = correctIdByKey.get(`${storedTitle}|${storedDatetime}`);
        if (!correctId || correctId === staleId) continue;

        console.log(`[KOReader] migrating uniqueId for ${f.path}: ${staleId} → ${correctId}`);
        // Update the vault file.
        await this.app.fileManager.processFrontMatter(f, (fmObj) => {
          if (fmObj[KOREADER_KEY]) fmObj[KOREADER_KEY].uniqueId = correctId;
        });
        // Update in-memory maps so the rest of this sync sees the correct id.
        const entry = existingNotes[staleId];
        if (entry) {
          existingNotes[correctId] = entry;
          delete existingNotes[staleId];
        }
        if (importedSet.has(staleId)) {
          importedSet.delete(staleId);
          importedSet.add(correctId);
          delete this.settings.importedNotes[staleId];
          this.settings.importedNotes[correctId] = true;
        }
      }
    }

    for (const book in data) {
      const { folder, basename } = this.resolveBookPath(data[book]);
      const managedBookTitle = basename;
      const path = folder
        ? `${this.settings.obsidianNoteFolder}/${folder}`
        : this.settings.obsidianNoteFolder;
      await this.ensureFolder(path);

      // Compute keep-in-sync value for this book based on the global mode setting
      const bookKeepInSync = computeKeepInSync(this.settings.keepInSyncMode, data[book].percent_finished);

      // Single-file-per-book mode: one combined note per book
      if (this.settings.singleFilePerBook) {
        const filePath = `${path}/${managedBookTitle}.md`;
        const bookmarkKeys = Object.keys(data[book].bookmarks);
        const uniqueIds = bookmarkKeys.map((bk) => {
          const bm = data[book].bookmarks[bk as any];
          const posKey = (bm.pos0 || bm.pos1) ? `${bm.pos0} - ${bm.pos1}` : bm.datetime;
          return md5(`${data[book].title} - ${data[book].authors} - ${posKey}`);
        });

        // Build a map from uniqueId → bookmark and compute fresh content hashes
        const bookmarkByUniqueId: Record<string, Bookmark> = {};
        const contentHashes: Record<string, string> = {};
        bookmarkKeys.forEach((bk, i) => {
          const bookmark = data[book].bookmarks[bk as any];
          bookmarkByUniqueId[uniqueIds[i]] = bookmark;
          contentHashes[uniqueIds[i]] = bookmarkContentHash(bookmark);
        });

        const existingFile = (data[book].checksum
          ? (this.findNoteByChecksum(data[book].checksum, NoteType.BOOK_HIGHLIGHTS)
              ?? this.app.vault.getAbstractFileByPath(filePath) as TFile | null)
          : this.app.vault.getAbstractFileByPath(filePath) as TFile | null);
        if (!existingFile) {
          const { content, frontmatterData } = await this.createBookHighlightsNote({
            path,
            managedBookTitle,
            book: data[book],
            uniqueIds,
            contentHashes,
            keepInSync: bookKeepInSync,
          });
          try {
            await this.app.vault.create(filePath, matter.stringify(content, frontmatterData));
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`KOReader: failed to create book highlights note ${filePath}:`, e);
            new Notice(`KOReader: failed to create book highlights note "${filePath}": ${msg}`);
          }
        } else {
          // File exists — check if any uniqueId is new or any content has changed
          const raw = await this.app.vault.read(existingFile);
          const { data: fmData, content: existingContent } = matter(raw, {});
          const existingFm = fmData[KOREADER_KEY];
          if (existingFm?.type === NoteType.BOOK_HIGHLIGHTS) {
            // Migrate older notes that predate the top-level koreader_keep_in_sync property
            if (fmData.koreader_keep_in_sync === undefined) {
              await this.app.fileManager.processFrontMatter(existingFile, (fm) => {
                fm.koreader_keep_in_sync = bookKeepInSync;
              });
            }
            const existingIds: string[] = existingFm?.uniqueIds ?? [];
            const existingHashes: Record<string, string> = existingFm?.contentHashes ?? {};
            const hasNew = uniqueIds.some((id) => !existingIds.includes(id));
            // Only detect content changes when existingHashes is populated (migration safety)
            const hasChanged = Object.keys(existingHashes).length > 0 &&
              uniqueIds.some(
                (id) => existingIds.includes(id) && contentHashes[id] !== existingHashes[id]
              );
            if (hasNew || hasChanged) {
              const keepInSync = fmData.koreader_keep_in_sync ?? existingFm?.metadata?.keep_in_sync ?? false;
              if (keepInSync) {
                // Preserve any user text added after the separator
                const separatorIdx = existingContent.indexOf(KOREADER_USER_SECTION_SEPARATOR);
                const userContent = separatorIdx !== -1
                  ? existingContent.slice(separatorIdx + KOREADER_USER_SECTION_SEPARATOR.length)
                  : '';
                const { content: newContent, frontmatterData } = await this.createBookHighlightsNote({
                  path,
                  managedBookTitle,
                  book: data[book],
                  uniqueIds,
                  contentHashes,
                  keepInSync,
                });
                const finalContent = userContent
                  ? newContent + userContent
                  : newContent;
                await this.app.vault.modify(existingFile, matter.stringify(finalContent, frontmatterData));
              }
            } else if (!existingFm?.metadata?.book_checksum) {
              // No content change, but metadata fields added in a later version are missing — patch them.
              await this.app.fileManager.processFrontMatter(existingFile, (fm) => {
                if (!fm[KOREADER_KEY]?.metadata) return;
                const book_ = data[book];
                fm[KOREADER_KEY].metadata.book_checksum = book_.checksum;
                fm[KOREADER_KEY].metadata.last_read_date = book_.last_read_date;
                fm[KOREADER_KEY].metadata.status = book_.status;
              });
            }
          }
        }

        // Mark all uniqueIds as imported
        for (const id of uniqueIds) {
          this.settings.importedNotes[id] = true;
        }
        continue;
      }

      // if createDataviewQuery is set, create a dataview query, for each book, with the book's managed title (if it doesn't exist)
      if (this.settings.createDataviewQuery) {
        const dvFilePath = `${path}/${managedBookTitle}.md`;
        const dvFile = data[book].checksum
          ? (this.findNoteByChecksum(data[book].checksum, NoteType.BOOK_NOTE)
              ?? (this.app.vault.getAbstractFileByPath(dvFilePath) instanceof TFile
                ? this.app.vault.getAbstractFileByPath(dvFilePath) as TFile
                : null))
          : this.app.vault.getAbstractFileByPath(dvFilePath) instanceof TFile
            ? this.app.vault.getAbstractFileByPath(dvFilePath) as TFile
            : null;
        await this.createDataviewQueryPerBook(
          { path, managedBookTitle, book: data[book] },
          dvFile ?? undefined,
        );
      }

      for (const bookmark in data[book].bookmarks) {
        const bm_ = data[book].bookmarks[bookmark];
        const posKey_ = (bm_.pos0 || bm_.pos1) ? `${bm_.pos0} - ${bm_.pos1}` : bm_.datetime;
        const uniqueId = md5(`${data[book].title} - ${data[book].authors} - ${posKey_}`);

        // if the note is not yet imported, we create it
        if (!importedSet.has(uniqueId)) {
          if (!existingNotes[uniqueId]) {
            const { content, frontmatterData, notePath } =
              await this.createNote({
                path,
                uniqueId,
                bookmark: data[book].bookmarks[bookmark],
                managedBookTitle,
                book: data[book],
                keepInSync: bookKeepInSync,
              });

            // If a file already exists at this path, check whether it is the
            // same note before deciding what to do.  After an importedNotes
            // reset the metadata cache may be stale, so the note won't appear
            // in existingNotes even though it already lives on disk.
            let finalNotePath = notePath;
            const fileAtExpectedPath = this.app.vault.getAbstractFileByPath(`${finalNotePath}.md`);
            if (fileAtExpectedPath instanceof TFile) {
              // Try to confirm identity via the metadata cache first (fast path).
              let storedUniqueId = this.app.metadataCache.getFileCache(fileAtExpectedPath)?.frontmatter?.[KOREADER_KEY]?.uniqueId;
              // Fall back to reading the file directly when the cache is stale.
              if (!storedUniqueId) {
                const raw = await this.app.vault.read(fileAtExpectedPath);
                storedUniqueId = matter(raw).data?.[KOREADER_KEY]?.uniqueId;
              }
              if (storedUniqueId === uniqueId) {
                // Same note — the metadata cache was stale.  Skip creation to
                // avoid creating a duplicate, then fall through to re-register
                // the uniqueId in importedNotes below.
              } else {
                // A genuinely different note occupies this path (title
                // collision).  Disambiguate with a short uniqueId suffix.
                finalNotePath = `${notePath}_${uniqueId.substring(0, 6)}`;
                try {
                  await this.app.vault.create(
                    `${finalNotePath}.md`,
                    matter.stringify(content, frontmatterData)
                  );
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  console.error(`KOReader: failed to create note ${finalNotePath}:`, e);
                  new Notice(`KOReader: failed to create note "${finalNotePath}": ${msg}`);
                  continue;
                }
              }
            } else {
              try {
                await this.app.vault.create(
                  `${finalNotePath}.md`,
                  matter.stringify(content, frontmatterData)
                );
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                console.error(`KOReader: failed to create note ${finalNotePath}:`, e);
                new Notice(`KOReader: failed to create note "${finalNotePath}": ${msg}`);
                continue;
              }
            }
          } else {
            // Note exists in vault but is not tracked in importedNotes
            // (e.g. prefix/suffix/path settings changed). Rename to expected path if needed.
            const existingNote = existingNotes[uniqueId].note;
            if (existingNote instanceof TFile) {
              const { notePath } = await this.createNote({
                path,
                uniqueId,
                bookmark: data[book].bookmarks[bookmark],
                managedBookTitle,
                book: data[book],
                keepInSync: bookKeepInSync,
              });
              const expectedPath = `${notePath}.md`;
              if (existingNote.path !== expectedPath && !this.app.vault.getAbstractFileByPath(expectedPath)) {
                const parentFolder = notePath.lastIndexOf('/') >= 0
                  ? notePath.slice(0, notePath.lastIndexOf('/'))
                  : '';
                await this.ensureFolder(parentFolder);
                try {
                  await this.app.fileManager.renameFile(existingNote, expectedPath);
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  console.error(`KOReader: failed to rename note to ${expectedPath}:`, e);
                  new Notice(`KOReader: failed to rename note to "${expectedPath}": ${msg}`);
                }
              }
            }
          }
          this.settings.importedNotes[uniqueId] = true;
          importedSet.add(uniqueId);
          // else if the note exists and keep_in_sync is true, update if rendered content changed
        } else if (existingNotes[uniqueId] && existingNotes[uniqueId].keep_in_sync) {
          const note = existingNotes[uniqueId].note;
          if (!(note instanceof TFile)) continue;
          const { content: newContent, frontmatterData } = await this.createNote({
            path,
            uniqueId,
            bookmark: data[book].bookmarks[bookmark],
            managedBookTitle,
            book: data[book],
            keepInSync: existingNotes[uniqueId].keep_in_sync,
          });
          // Skip write if rendered content hasn't changed.
          // Compare against the hash of the actual on-disk body rather than the
          // stored body_hash to handle cases where body_hash is stale (e.g. after
          // a processFrontMatter call that didn't update it).
          const rawExisting = await this.app.vault.read(note);
          const { data: existingFmData, content: existingContent } = matter(rawExisting, {});
          const normalizedExisting = existingContent.startsWith('\n') ? existingContent.slice(1) : existingContent;
          const separatorIdx = normalizedExisting.indexOf(KOREADER_USER_SECTION_SEPARATOR);
          const bodyOnDisk = separatorIdx !== -1
            ? normalizedExisting.slice(0, separatorIdx)
            : normalizedExisting;
          const onDiskHash = md5(bodyOnDisk);
          const newBodyHash = md5(newContent.includes(KOREADER_USER_SECTION_SEPARATOR)
            ? newContent.slice(0, newContent.indexOf(KOREADER_USER_SECTION_SEPARATOR))
            : newContent);
          if (newBodyHash === onDiskHash) {
            // Body unchanged. Repair any stale metadata in a single frontmatter pass.
            const storedBodyHash = existingFmData[KOREADER_KEY]?.metadata?.body_hash;
            const needsHashRepair    = storedBodyHash !== onDiskHash;
            const needsChecksumPatch = !existingFmData[KOREADER_KEY]?.metadata?.book_checksum;
            if (needsHashRepair || needsChecksumPatch) {
              await this.app.fileManager.processFrontMatter(note, (fm) => {
                if (!fm[KOREADER_KEY]?.metadata) return;
                if (needsHashRepair) fm[KOREADER_KEY].metadata.body_hash = onDiskHash;
                if (needsChecksumPatch) {
                  const book_ = data[book];
                  fm[KOREADER_KEY].metadata.book_checksum = book_.checksum;
                  fm[KOREADER_KEY].metadata.last_read_date = book_.last_read_date;
                  fm[KOREADER_KEY].metadata.status = book_.status;
                }
              });
            }
            continue;
          }
          // Body genuinely changed — preserve user content below the separator.
          const userContent = separatorIdx !== -1
            ? normalizedExisting.slice(separatorIdx + KOREADER_USER_SECTION_SEPARATOR.length)
            : '';
          const finalContent = userContent ? newContent + userContent : newContent;
          try {
            await this.app.vault.modify(note, matter.stringify(finalContent, frontmatterData));
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`KOReader: failed to update note ${note.path}:`, e);
            new Notice(`KOReader: failed to update note "${note.path}": ${msg}`);
          }
        }
      }
    }
    await this.saveSettings();
    new Notice(`KOReader: sync complete — ${Object.keys(data).length} ebook(s) processed`);
  }
}
