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
    // replace \ / and : with _
    title = title.replace(/\\|\/|:/g, '_');
    // replace multiple underscores with one underscore
    title = title.replace(/_+/g, '_');
    // remove leading and trailing whitespace
    title = title.trim();
    // remove leading and trailing underscores
    title = title.replace(/^_+|_+$/g, '');
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
      const managedTitle = `${this.manageTitle(book.title, this.settings.bookTitleOptions)}-${book.authors}`;
      return this.settings.aFolderForEachBook
        ? { folder: managedTitle, basename: managedTitle }
        : { folder: '', basename: managedTitle };
    }
    const sanitizedTitle   = this.manageTitle(book.title,   this.settings.bookTitleOptions);
    const sanitizedAuthors = this.manageTitle(book.authors, {});
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

    this.addCommand({
      id: 'obsidian-koreader-plugin-reset-sync-list',
      name: 'Reset Sync List',
      checkCallback: (checking: boolean) => {
        if (this.settings.enbleResetImportedNotes) {
          if (!checking) {
            this.settings.importedNotes = {};
            this.settings.enbleResetImportedNotes = false;
            this.saveSettings();
          }
          return true;
        }
        return false;
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
        )} - ${book.authors}`;
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
    if (updateNote) {
      const { data, content } = matter(
        await this.app.vault.read(updateNote),
        {}
      );
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
      await this.app.vault.modify(updateNote, matter.stringify(body, mergedFrontmatter));
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
        const uniqueIds = bookmarkKeys.map((bk) =>
          md5(`${data[book].title} - ${data[book].authors} - ${data[book].bookmarks[bk as any].pos0} - ${data[book].bookmarks[bk as any].pos1}`)
        );

        // Build a map from uniqueId → bookmark and compute fresh content hashes
        const bookmarkByUniqueId: Record<string, Bookmark> = {};
        const contentHashes: Record<string, string> = {};
        bookmarkKeys.forEach((bk, i) => {
          const bookmark = data[book].bookmarks[bk as any];
          bookmarkByUniqueId[uniqueIds[i]] = bookmark;
          contentHashes[uniqueIds[i]] = bookmarkContentHash(bookmark);
        });

        const existingFile = (data[book].checksum
          ? this.findNoteByChecksum(data[book].checksum, NoteType.BOOK_HIGHLIGHTS)
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
        const dvFile = data[book].checksum
          ? this.findNoteByChecksum(data[book].checksum, NoteType.BOOK_NOTE)
          : this.app.vault.getAbstractFileByPath(`${path}/${managedBookTitle}.md`) instanceof TFile
            ? this.app.vault.getAbstractFileByPath(`${path}/${managedBookTitle}.md`) as TFile
            : null;
        await this.createDataviewQueryPerBook(
          { path, managedBookTitle, book: data[book] },
          dvFile ?? undefined,
        );
      }

      for (const bookmark in data[book].bookmarks) {
        const uniqueId = md5(`${data[book].title} - ${data[book].authors} - ${data[book].bookmarks[bookmark].pos0} - ${data[book].bookmarks[bookmark].pos1}`);

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

            // If a file already exists at this path (stale import or title
            // collision between two bookmarks), disambiguate with a short
            // uniqueId suffix rather than failing.
            let finalNotePath = notePath;
            if (this.app.vault.getAbstractFileByPath(`${finalNotePath}.md`)) {
              finalNotePath = `${notePath}_${uniqueId.substring(0, 6)}`;
            }
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
          // Skip write if rendered content hasn't changed (body_hash optimization)
          const rawExisting = await this.app.vault.read(note);
          const { data: existingFmData, content: existingContent } = matter(rawExisting, {});
          const newBodyHash = md5(newContent.includes(KOREADER_USER_SECTION_SEPARATOR)
            ? newContent.slice(0, newContent.indexOf(KOREADER_USER_SECTION_SEPARATOR))
            : newContent);
          if (newBodyHash === existingFmData[KOREADER_KEY]?.metadata?.body_hash) {
            // No content change, but patch missing metadata fields added in a later version.
            if (!existingFmData[KOREADER_KEY]?.metadata?.book_checksum) {
              await this.app.fileManager.processFrontMatter(note, (fm) => {
                if (!fm[KOREADER_KEY]?.metadata) return;
                const book_ = data[book];
                fm[KOREADER_KEY].metadata.book_checksum = book_.checksum;
                fm[KOREADER_KEY].metadata.last_read_date = book_.last_read_date;
                fm[KOREADER_KEY].metadata.status = book_.status;
              });
            }
            continue;
          }
          // Preserve user content below the separator
          const normalizedExisting = existingContent.startsWith('\n') ? existingContent.slice(1) : existingContent;
          const separatorIdx = normalizedExisting.indexOf(KOREADER_USER_SECTION_SEPARATOR);
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
  }
}
