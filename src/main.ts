import * as crypto from 'crypto';
import { Eta } from 'eta';

import {
  App,
  Editor,
  MarkdownView,
  Plugin,
  PluginSettingTab,
  Scope,
  SearchComponent,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  ToggleComponent,
  normalizePath,
  Notice,
} from 'obsidian';
import matter from 'gray-matter';
import { Book, Bookmark, Books, FrontMatter } from './types';

import { KOReaderMetadata } from './koreader-metadata';

enum NoteType {
  SINGLE_NOTE = 'koreader-sync-note',
  BOOK_NOTE = 'koreader-sync-dataview',
  BOOK_HIGHLIGHTS = 'koreader-sync-book-highlights',
}

const DEFAULT_NOTE_TEMPLATE = `## Title: [[<%= it.bookPath %>|<%= it.title %>]]

### by: [[<%= it.authors.join(']], [[') %>]]

### Chapter: <%= it.chapter %>

Page: <%= it.page %>

> <%= it.highlight %>

<%= it.text %>`;

const DEFAULT_BOOK_HIGHLIGHTS_TEMPLATE = `# <%= it.title %>

### by: [[<%= it.authors.join(']], [[') %>]]

<progress value="<%= it.percent_finished %>" max="100"> </progress>
<% it.bookmarks.forEach(function(b) { %>
---

### Chapter: <%= b.chapter %>

Page: <%= b.page %>

> <%= b.highlight %>

<%= b.text %>
<% }) %>`;

const DEFAULT_DATAVIEW_TEMPLATE = `# Title: <%= it.data.title %>

<progress value="<%= it.metadata.percent_finished %>" max="100"> </progress>
\`\`\`dataviewjs
const title = dv.current()['koreader-sync'].metadata.managed_title
dv.pages().where(n => {
return n['koreader-sync'] && n['koreader-sync'].type == '${NoteType.SINGLE_NOTE}' && n['koreader-sync'].metadata.managed_book_title == title
}).sort(p => p['koreader-sync'].data.page).forEach(p => dv.paragraph('![[' + p.file.path + ']]'))
\`\`\`
    `;

interface KOReaderSettings {
  koreaderBasePath: string;
  obsidianNoteFolder: string;
  noteTitleOptions: TitleOptions;
  bookTitleOptions: TitleOptions;
  keepInSync: boolean;
  aFolderForEachBook: boolean;
  customTemplate: boolean;
  customDataviewTemplate: boolean;
  templatePath?: string;
  dataviewTemplatePath?: string;
  createDataviewQuery: boolean;
  singleFilePerBook: boolean;
  customSingleFileTemplate: boolean;
  singleFileTemplatePath?: string;
  importedNotes: { [key: string]: boolean };
  enbleResetImportedNotes: boolean;
  bookFolderTemplate?: string;
}

const DEFAULT_SETTINGS: KOReaderSettings = {
  importedNotes: {},
  enbleResetImportedNotes: false,
  bookFolderTemplate: '',
  keepInSync: false,
  aFolderForEachBook: false,
  customTemplate: false,
  customDataviewTemplate: false,
  createDataviewQuery: false,
  singleFilePerBook: false,
  customSingleFileTemplate: false,
  koreaderBasePath: '/media/user/KOBOeReader',
  obsidianNoteFolder: '/',
  noteTitleOptions: {
    maxWords: 5,
    maxLength: 25,
  },
  bookTitleOptions: {
    maxWords: 5,
    maxLength: 25,
    prefix: '(book) ',
  },
};

interface TitleOptions {
  prefix?: string;
  suffix?: string;
  maxLength?: number;
  maxWords?: number;
}

const KOREADERKEY = 'koreader-sync';

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
    const resolved = tpl
      .replace(/\{\{title\}\}/g,   sanitizedTitle)
      .replace(/\{\{authors\}\}/g, sanitizedAuthors);
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
      cache: true, // Make Eta cache templates
      autoEscape: false,
    });
    await this.loadSettings();

    // listen for note changes to update the frontmatter
    this.app.metadataCache.on('changed', async (file: TAbstractFile) => {
      try {
        await this.updateMetadataText(file as TFile);
      } catch (e) {
        console.error(e);
        new Notice(`Error updating metadata text: ${e.message}`);
      }
    });

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
      id: 'obsidian-koreader-plugin-set-edit',
      name: 'Mark this note as Edited',
      editorCheckCallback: (
        checking: boolean,
        editor: Editor,
        view: MarkdownView
      ) => {
        const propertyPath = `${[KOREADERKEY]}.metadata.yet_to_be_edited`;
        if (checking) {
          if (this.getFrontmatterProperty(propertyPath, view) === true) {
            return true;
          }
          return false;
        }
        this.setFrontmatterProperty(propertyPath, false, view);
      },
    });

    this.addCommand({
      id: 'obsidian-koreader-plugin-clear-edit',
      name: 'Mark this note as NOT Edited',
      editorCheckCallback: (
        checking: boolean,
        editor: Editor,
        view: MarkdownView
      ) => {
        const propertyPath = `${[KOREADERKEY]}.metadata.yet_to_be_edited`;
        if (checking) {
          if (this.getFrontmatterProperty(propertyPath, view) === false) {
            return true;
          }
          return false;
        }
        this.setFrontmatterProperty(propertyPath, true, view);
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
        const propertyPath = `${[KOREADERKEY]}.metadata.keep_in_sync`;
        if (checking) {
          if (this.getFrontmatterProperty(propertyPath, view) === false) {
            return true;
          }
          return false;
        }
        this.setFrontmatterProperty(propertyPath, true, view);
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
        const propertyPath = `${[KOREADERKEY]}.metadata.keep_in_sync`;
        if (checking) {
          if (this.getFrontmatterProperty(propertyPath, view) === true) {
            return true;
          }
          return false;
        }
        this.setFrontmatterProperty(propertyPath, false, view);
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
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async updateMetadataText(file: TFile) {
    const raw = await this.app.vault.cachedRead(file);
    const { data, content } = matter(raw, {});
    const frontMatter = data[KOREADERKEY];
    if (
      !frontMatter ||
      (frontMatter.type !== NoteType.SINGLE_NOTE &&
       frontMatter.type !== NoteType.BOOK_HIGHLIGHTS)
    ) {
      return;
    }
    const currentHash = crypto.createHash('md5').update(content).digest('hex');
    if (currentHash === frontMatter.metadata?.body_hash) {
      return;
    }
    // Body changed — user edited the note
    this.setObjectProperty(data, `${KOREADERKEY}.metadata.yet_to_be_edited`, false);
    this.setObjectProperty(data, `${KOREADERKEY}.metadata.body_hash`, currentHash);
    await this.app.vault.modify(file, matter.stringify(content, data, {}));
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
    const page = bookmark.text
      ? (parseInt(bookmark.text.match(/\d+/g)?.[0]) || -1)
      : (parseInt(bookmark.page) || -1);
    const noteItself = bookmark.text
      ? (bookmark.text.split(bookmark.datetime)[1] || '').replace(/^\s+|\s+$/g, '')
      : '';
    const noteTitle = noteItself
      ? this.manageTitle(noteItself, this.settings.noteTitleOptions)
      : `${this.manageTitle(
          bookmark.notes || '',
          this.settings.noteTitleOptions
        )} - ${book.authors}`;
    const notePath = normalizePath(`${path}/${noteTitle}`);

    const templateFile = this.settings.customTemplate
      ? this.app.vault.getAbstractFileByPath(this.settings.templatePath)
      : null;
    const template = templateFile
      ? await this.app.vault.read(templateFile as TFile)
      : DEFAULT_NOTE_TEMPLATE;
    const bookPath = normalizePath(`${path}/${managedBookTitle}`);
    const { body, extraFrontmatter } = await this.renderTemplate(template, {
      bookPath,
      title: book.title,
      authors: book.authors?.split('\n').map(a => a.trim()).filter(a => a) ?? [],
      chapter: bookmark.chapter,
      highlight: bookmark.notes,
      text: noteItself,
      datetime: bookmark.datetime,
      page,
    });

    const pluginFrontmatter: { [key: string]: FrontMatter } = {
      [KOREADERKEY]: {
        type: NoteType.SINGLE_NOTE,
        uniqueId,
        data: {
          title: book.title ?? '',
          authors: book.authors ?? '',
          chapter: bookmark.chapter ?? '',
          page,
          highlight: bookmark.notes ?? '',
          datetime: bookmark.datetime ?? '',
        },
        metadata: {
          body_hash: crypto.createHash('md5').update(body).digest('hex'),
          keep_in_sync: keepInSync || this.settings.keepInSync,
          yet_to_be_edited: true,
          managed_book_title: managedBookTitle,
        },
      },
    };
    const frontmatterData = { ...extraFrontmatter, ...pluginFrontmatter };

    return { content: body, frontmatterData, notePath };
  }

  private async createBookHighlightsNote(params: {
    path: string;
    managedBookTitle: string;
    book: Book;
    uniqueIds: string[];
    keepInSync?: boolean;
  }): Promise<{ content: string; frontmatterData: object; notePath: string }> {
    const { path, managedBookTitle, book, uniqueIds, keepInSync } = params;

    // Build sorted bookmarks array
    const bookmarks = Object.values(book.bookmarks)
      .map((bookmark: Bookmark) => {
        const page = bookmark.text
          ? (parseInt(bookmark.text.match(/\d+/g)?.[0]) || -1)
          : (parseInt(bookmark.page) || -1);
        const text = bookmark.text
          ? (bookmark.text.split(bookmark.datetime)[1] || '').replace(/^\s+|\s+$/g, '')
          : '';
        return {
          chapter: bookmark.chapter ?? '',
          highlight: bookmark.notes ?? '',
          text,
          datetime: bookmark.datetime ?? '',
          page,
        };
      })
      .sort((a, b) => a.page - b.page);

    const templateFile = this.settings.customSingleFileTemplate
      ? this.app.vault.getAbstractFileByPath(this.settings.singleFileTemplatePath)
      : null;
    const template = templateFile
      ? await this.app.vault.read(templateFile as TFile)
      : DEFAULT_BOOK_HIGHLIGHTS_TEMPLATE;

    const { body, extraFrontmatter } = await this.renderTemplate(template, {
      title: book.title,
      authors: book.authors?.split('\n').map(a => a.trim()).filter(a => a) ?? [],
      percent_finished: book.percent_finished,
      bookmarks,
    });

    const notePath = normalizePath(`${path}/${managedBookTitle}`);

    const frontmatterData = {
      ...extraFrontmatter,
      [KOREADERKEY]: {
        type: NoteType.BOOK_HIGHLIGHTS,
        uniqueIds,
        data: {
          title: book.title ?? '',
          authors: book.authors ?? '',
        },
        metadata: {
          body_hash: crypto.createHash('md5').update(body).digest('hex'),
          percent_finished: book.percent_finished,
          managed_book_title: managedBookTitle,
          keep_in_sync: keepInSync ?? this.settings.keepInSync,
          yet_to_be_edited: true,
        },
      },
    };

    return { content: body, frontmatterData, notePath };
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
    let { keepInSync } = this.settings;
    if (updateNote) {
      const { data, content } = matter(
        await this.app.vault.read(updateNote),
        {}
      );
      keepInSync = data[KOREADERKEY].metadata.keep_in_sync;
      const yetToBeEdited = data[KOREADERKEY].metadata.yet_to_be_edited;
      if (!keepInSync || !yetToBeEdited) {
        return;
      }
    }
    const frontMatter = {
      cssclass: NoteType.BOOK_NOTE,
      [KOREADERKEY]: {
        uniqueId: crypto
          .createHash('md5')
          .update(`${book.title} - ${book.authors}`)
          .digest('hex'),
        type: NoteType.BOOK_NOTE,
        data: {
          title: book.title,
          authors: book.authors,
        },
        metadata: {
          percent_finished: book.percent_finished,
          managed_title: managedBookTitle,
          keep_in_sync: keepInSync,
          yet_to_be_edited: true,
        },
      },
    };

    const templateFile = this.settings.customDataviewTemplate
      ? this.app.vault.getAbstractFileByPath(this.settings.dataviewTemplatePath)
      : null;
    const template = templateFile
      ? await this.app.vault.read(templateFile as TFile)
      : DEFAULT_DATAVIEW_TEMPLATE;
    const { body, extraFrontmatter } = await this.renderTemplate(
      template,
      frontMatter[KOREADERKEY]
    );
    const mergedFrontmatter = {
      ...extraFrontmatter,
      cssclass: NoteType.BOOK_NOTE,
      [KOREADERKEY]: frontMatter[KOREADERKEY],
    };
    if (updateNote) {
      this.app.vault.modify(updateNote, matter.stringify(body, mergedFrontmatter));
    } else {
      this.app.vault.create(
        `${path}/${managedBookTitle}.md`,
        matter.stringify(body, mergedFrontmatter)
      );
    }
  }

  async importNotes() {
    const metadata = new KOReaderMetadata(this.settings.koreaderBasePath);
    const data: Books = await metadata.scan();

    // create a list of notes already imported in obsidian
    const existingNotes: {
      [key: string]: {
        keep_in_sync: boolean;
        yet_to_be_edited: boolean;
        note: TAbstractFile;
      };
    } = {};
    this.app.vault.getMarkdownFiles().forEach((f) => {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (fm?.[KOREADERKEY]?.uniqueId) {
        existingNotes[fm[KOREADERKEY].uniqueId] = {
          keep_in_sync: fm[KOREADERKEY].metadata.keep_in_sync,
          yet_to_be_edited: fm[KOREADERKEY].metadata.yet_to_be_edited,
          note: f,
        };
      }
    });

    for (const book in data) {
      const { folder, basename } = this.resolveBookPath(data[book]);
      const managedBookTitle = basename;
      const path = folder
        ? `${this.settings.obsidianNoteFolder}/${folder}`
        : this.settings.obsidianNoteFolder;
      await this.ensureFolder(path);

      // Single-file-per-book mode: one combined note per book
      if (this.settings.singleFilePerBook) {
        const filePath = `${path}/${managedBookTitle}.md`;
        const uniqueIds = Object.keys(data[book].bookmarks).map((bk) =>
          crypto
            .createHash('md5')
            .update(
              `${data[book].title} - ${data[book].authors} - ${data[book].bookmarks[bk as any].pos0} - ${data[book].bookmarks[bk as any].pos1}`
            )
            .digest('hex')
        );

        const existingFile = this.app.vault.getAbstractFileByPath(filePath) as TFile | null;
        if (!existingFile) {
          const { content, frontmatterData } = await this.createBookHighlightsNote({
            path,
            managedBookTitle,
            book: data[book],
            uniqueIds,
            keepInSync: this.settings.keepInSync,
          });
          try {
            await this.app.vault.create(filePath, matter.stringify(content, frontmatterData));
          } catch (e) {
            console.error(`KOReader: failed to create book highlights note ${filePath}:`, e);
            new Notice(`KOReader: failed to create book highlights note "${filePath}": ${e.message}`);
          }
        } else {
          // File exists — check if any uniqueId is new
          const raw = await this.app.vault.read(existingFile);
          const { data: fmData } = matter(raw, {});
          const existingFm = fmData[KOREADERKEY];
          if (existingFm?.type === NoteType.BOOK_HIGHLIGHTS) {
            const existingIds: string[] = existingFm?.uniqueIds ?? [];
            const hasNew = uniqueIds.some((id) => !existingIds.includes(id));
            if (hasNew) {
              const keepInSync = existingFm?.metadata?.keep_in_sync ?? false;
              const yetToBeEdited = existingFm?.metadata?.yet_to_be_edited ?? true;
              // Re-sync only when keep_in_sync is enabled and user hasn't edited the note yet
              if (keepInSync && yetToBeEdited) {
                const { content, frontmatterData } = await this.createBookHighlightsNote({
                  path,
                  managedBookTitle,
                  book: data[book],
                  uniqueIds,
                  keepInSync,
                });
                await this.app.vault.modify(existingFile, matter.stringify(content, frontmatterData));
              }
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
        await this.createDataviewQueryPerBook(
          {
            path,
            managedBookTitle,
            book: data[book],
          },
          this.app.vault.getAbstractFileByPath(
            `${path}/${managedBookTitle}.md`
          ) as TFile
        );
      }

      for (const bookmark in data[book].bookmarks) {
        const updateNote: boolean = false;
        const uniqueId = crypto
          .createHash('md5')
          .update(
            `${data[book].title} - ${data[book].authors} - ${data[book].bookmarks[bookmark].pos0} - ${data[book].bookmarks[bookmark].pos1}`
          )
          .digest('hex');

        // if the note is not yet imported, we create it
        if (!Object.keys(this.settings.importedNotes).includes(uniqueId)) {
          if (!Object.keys(existingNotes).includes(uniqueId)) {
            const { content, frontmatterData, notePath } =
              await this.createNote({
                path,
                uniqueId,
                bookmark: data[book].bookmarks[bookmark],
                managedBookTitle,
                book: data[book],
                keepInSync: this.settings.keepInSync,
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
              console.error(`KOReader: failed to create note ${finalNotePath}:`, e);
              new Notice(`KOReader: failed to create note "${finalNotePath}": ${e.message}`);
              continue;
            }
          }
          this.settings.importedNotes[uniqueId] = true;
          // else if the note exists and keep_in_sync is true and yet_to_be_edited is false, we update it
        } else if (
          Object.keys(existingNotes).includes(uniqueId) &&
          existingNotes[uniqueId].keep_in_sync &&
          !existingNotes[uniqueId].yet_to_be_edited
        ) {
          const note = existingNotes[uniqueId].note as TFile;
          const { content, frontmatterData, notePath } = await this.createNote({
            path,
            uniqueId,
            bookmark: data[book].bookmarks[bookmark],
            managedBookTitle,
            book: data[book],
            keepInSync: existingNotes[uniqueId]?.keep_in_sync,
          });

          await this.app.vault.modify(
            note,
            matter.stringify(content, frontmatterData)
          );
        }
      }
    }
    await this.saveSettings();
  }
}

class FolderSuggest {
  private app: App;
  private inputEl: HTMLInputElement;
  private suggestEl: HTMLElement;
  private items: TFolder[] = [];
  private selectedIndex = 0;
  private scope: Scope;
  private isOpen = false;

  constructor(app: App, inputEl: HTMLInputElement) {
    this.app = app;
    this.inputEl = inputEl;
    this.scope = new Scope();
    this.suggestEl = document.body.createDiv('suggestion-container');

    this.scope.register([], 'ArrowUp', () => {
      this.setSelected(this.selectedIndex - 1);
      return false;
    });
    this.scope.register([], 'ArrowDown', () => {
      this.setSelected(this.selectedIndex + 1);
      return false;
    });
    this.scope.register([], 'Enter', () => {
      this.selectItem(this.selectedIndex);
      return false;
    });
    this.scope.register([], 'Escape', () => {
      this.close();
      return false;
    });

    inputEl.addEventListener('input', this.onInput.bind(this));
    inputEl.addEventListener('focus', this.onInput.bind(this));
    inputEl.addEventListener('blur', () => setTimeout(() => this.close(), 150));
  }

  private onInput() {
    const query = this.inputEl.value.toLowerCase();
    this.items = this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder && f.path.toLowerCase().includes(query))
      .slice(0, 20);

    if (this.items.length === 0) {
      this.close();
      return;
    }

    this.render();
    if (!this.isOpen) this.open();
  }

  private render() {
    this.suggestEl.empty();
    const inner = this.suggestEl.createDiv('suggestion');
    this.items.forEach((folder, i) => {
      const item = inner.createDiv('suggestion-item');
      item.setText(folder.path);
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.selectItem(i);
      });
    });
    this.setSelected(0);
  }

  private setSelected(index: number) {
    const items = this.suggestEl.querySelectorAll<HTMLElement>('.suggestion-item');
    if (items.length === 0) return;
    this.selectedIndex = ((index % items.length) + items.length) % items.length;
    items.forEach((el, i) => el.toggleClass('is-selected', i === this.selectedIndex));
    items[this.selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }

  private selectItem(index: number) {
    const folder = this.items[index];
    if (folder) {
      this.inputEl.value = folder.path;
      this.inputEl.trigger('input');
      this.close();
    }
  }

  private open() {
    (this.app as any).keymap.pushScope(this.scope);
    const rect = this.inputEl.getBoundingClientRect();
    this.suggestEl.style.cssText =
      `position:fixed;top:${rect.bottom}px;left:${rect.left}px;width:${rect.width}px;z-index:var(--layer-modal)`;
    document.body.appendChild(this.suggestEl);
    this.isOpen = true;
  }

  private close() {
    if (!this.isOpen) return;
    (this.app as any).keymap.popScope(this.scope);
    this.suggestEl.detach();
    this.isOpen = false;
  }
}

class FileSuggest {
  private app: App;
  private inputEl: HTMLInputElement;
  private suggestEl: HTMLElement;
  private items: TFile[] = [];
  private selectedIndex = 0;
  private scope: Scope;
  private isOpen = false;

  constructor(app: App, inputEl: HTMLInputElement) {
    this.app = app;
    this.inputEl = inputEl;
    this.scope = new Scope();
    this.suggestEl = document.body.createDiv('suggestion-container');

    this.scope.register([], 'ArrowUp', () => {
      this.setSelected(this.selectedIndex - 1);
      return false;
    });
    this.scope.register([], 'ArrowDown', () => {
      this.setSelected(this.selectedIndex + 1);
      return false;
    });
    this.scope.register([], 'Enter', () => {
      this.selectItem(this.selectedIndex);
      return false;
    });
    this.scope.register([], 'Escape', () => {
      this.close();
      return false;
    });

    inputEl.addEventListener('input', this.onInput.bind(this));
    inputEl.addEventListener('focus', this.onInput.bind(this));
    inputEl.addEventListener('blur', () => setTimeout(() => this.close(), 150));
  }

  private onInput() {
    if (this.inputEl.disabled) return;
    const query = this.inputEl.value.toLowerCase();
    this.items = this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFile => f instanceof TFile && f.extension === 'md' && f.path.toLowerCase().includes(query))
      .slice(0, 20);

    if (this.items.length === 0) {
      this.close();
      return;
    }

    this.render();
    if (!this.isOpen) this.open();
  }

  private render() {
    this.suggestEl.empty();
    const inner = this.suggestEl.createDiv('suggestion');
    this.items.forEach((file, i) => {
      const item = inner.createDiv('suggestion-item');
      item.setText(file.path);
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.selectItem(i);
      });
    });
    this.setSelected(0);
  }

  private setSelected(index: number) {
    const items = this.suggestEl.querySelectorAll<HTMLElement>('.suggestion-item');
    if (items.length === 0) return;
    this.selectedIndex = ((index % items.length) + items.length) % items.length;
    items.forEach((el, i) => el.toggleClass('is-selected', i === this.selectedIndex));
    items[this.selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }

  private selectItem(index: number) {
    const file = this.items[index];
    if (file) {
      this.inputEl.value = file.path;
      this.inputEl.trigger('input');
      this.close();
    }
  }

  private open() {
    (this.app as any).keymap.pushScope(this.scope);
    const rect = this.inputEl.getBoundingClientRect();
    this.suggestEl.style.cssText =
      `position:fixed;top:${rect.bottom}px;left:${rect.left}px;width:${rect.width}px;z-index:var(--layer-modal)`;
    document.body.appendChild(this.suggestEl);
    this.isOpen = true;
  }

  private close() {
    if (!this.isOpen) return;
    (this.app as any).keymap.popScope(this.scope);
    this.suggestEl.detach();
    this.isOpen = false;
  }
}

class KoreaderSettingTab extends PluginSettingTab {
  plugin: KOReader;

  constructor(app: App, plugin: KOReader) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private getTemplateFolderPath(): string {
    const app = this.app as any;
    const coreFolder = app.internalPlugins?.getPluginById('templates')?.instance?.options?.folder;
    if (coreFolder) return coreFolder;
    const templaterFolder = app.plugins?.getPlugin('templater-obsidian')?.settings?.templates_folder;
    if (templaterFolder) return templaterFolder;
    return this.plugin.settings.obsidianNoteFolder;
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;

    containerEl.empty();

    // Visibility helpers — assigned after their sections are built, called from
    // onChange handlers further down. Closures capture variables by reference so
    // assigning the real functions before any user interaction is sufficient.
    let updatePerHighlightVisibility: () => void = () => {};
    let updateSingleFileVisibility: () => void = () => {};
    let updateDataviewVisibility: () => void = () => {};
    let updateBookTitlesVisibility: () => void = () => {};

    const showBookTitles = () =>
      s.aFolderForEachBook || !!s.bookFolderTemplate || s.singleFilePerBook || s.createDataviewQuery;

    // ── 1. DEVICE CONNECTION ────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Device connection' });

    new Setting(containerEl)
      .setName('KOReader mounted path')
      .setDesc('Eg. /media/<user>/KOBOeReader')
      .addText((text) =>
        text
          .setPlaceholder('Enter the path where KOReader is mounted')
          .setValue(s.koreaderBasePath)
          .onChange(async (value) => {
            s.koreaderBasePath = value;
            await this.plugin.saveSettings();
          })
      );

    // ── 2. VAULT STORAGE ────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Vault storage' });

    new Setting(containerEl)
      .setName('Highlights folder location')
      .setDesc('Vault folder to use for writing book highlight notes')
      .addSearch((search) => {
        new FolderSuggest(this.app, search.inputEl);
        search
          .setPlaceholder('Example: folder/subfolder')
          .setValue(s.obsidianNoteFolder)
          .onChange(async (value) => {
            s.obsidianNoteFolder = value;
            await this.plugin.saveSettings();
          });
      });

    const deriveBookOrgMode = (): string => {
      if (s.bookFolderTemplate?.trim()) return 'custom';
      if (s.aFolderForEachBook) return 'per-book';
      return 'none';
    };

    // Track the dropdown's selected value directly so visibility is not
    // re-derived from settings (template is empty while 'custom' is selected).
    let selectedBookOrgMode = deriveBookOrgMode();

    let updateBookTemplateVisibility: () => void = () => {};

    new Setting(containerEl)
      .setName('Book organisation')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('none', 'No subfolder')
          .addOption('per-book', 'Folder per book')
          .addOption('custom', 'Custom path template')
          .setValue(selectedBookOrgMode)
          .onChange(async (value) => {
            selectedBookOrgMode = value;
            if (value === 'none') {
              s.aFolderForEachBook = false;
              s.bookFolderTemplate = '';
            } else if (value === 'per-book') {
              s.aFolderForEachBook = true;
              s.bookFolderTemplate = '';
            }
            // 'custom': leave existing values, just reveal the input
            await this.plugin.saveSettings();
            updateBookTemplateVisibility();
            updateBookTitlesVisibility();
          })
      );

    const bookTemplateSetting = new Setting(containerEl)
      .setName('Book path template')
      .setDesc('Available variables: {{title}}, {{authors}}. {{title}} uses book title formatting below. E.g. {{authors}}/{{title}} groups books in per-author subfolders.')
      .addText((text) =>
        text
          .setPlaceholder('{{authors}}/{{title}}')
          .setValue(s.bookFolderTemplate ?? '')
          .onChange(async (value) => {
            s.bookFolderTemplate = value;
            await this.plugin.saveSettings();
            updateBookTitlesVisibility();
          })
      );

    updateBookTemplateVisibility = () => {
      bookTemplateSetting.settingEl.style.display = selectedBookOrgMode === 'custom' ? '' : 'none';
    };
    updateBookTemplateVisibility();

    // ── 3. NOTE CREATION MODE ───────────────────────────────────────
    containerEl.createEl('h2', { text: 'Note creation mode' });

    new Setting(containerEl)
      .setName('Note format')
      .setDesc('Choose how highlights are saved to your vault')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('per-highlight', 'Per-highlight notes')
          .addOption('combined', 'Combined book file')
          .setValue(s.singleFilePerBook ? 'combined' : 'per-highlight')
          .onChange(async (value) => {
            s.singleFilePerBook = value === 'combined';
            await this.plugin.saveSettings();
            updatePerHighlightVisibility();
            updateSingleFileVisibility();
            updateDataviewVisibility();
            updateBookTitlesVisibility();
          })
      );

    // ── 4. PER-HIGHLIGHT NOTES SETTINGS ─────────────────────────────
    // Entire section (including heading) hides when combined mode is active.
    const perHighlightSection = containerEl.createDiv();

    perHighlightSection.createEl('h2', { text: 'Per-highlight notes' });

    // Dataview: sub-option of per-highlight mode only
    new Setting(perHighlightSection)
      .setName('Dataview summary note per book')
      .setDesc(
        createFragment((frag) => {
          frag.appendText(
            'Also create a note per book with a Dataview query embedding all its highlights (read the '
          );
          frag.createEl(
            'a',
            {
              text: 'documentation',
              href: 'https://github.com/Edo78/obsidian-koreader-sync#dateview-embedded',
            },
            (a) => {
              a.setAttr('target', '_blank');
            }
          );
          frag.appendText(')');
        })
      )
      .addToggle((toggle) =>
        toggle
          .setValue(s.createDataviewQuery)
          .onChange(async (value) => {
            s.createDataviewQuery = value;
            await this.plugin.saveSettings();
            updateDataviewVisibility();
            updateBookTitlesVisibility();
          })
      );

    let noteTemplateToggle: ToggleComponent;
    let noteTemplateText: SearchComponent;

    new Setting(perHighlightSection)
      .setName('Custom template')
      .setDesc('Use a custom template for individual highlight notes')
      .addToggle((toggle) => {
        noteTemplateToggle = toggle;
        return toggle
          .setValue(s.customTemplate)
          .onChange(async (value) => {
            s.customTemplate = value;
            await this.plugin.saveSettings();
            noteTemplateText.setDisabled(!value);
          });
      });

    new Setting(perHighlightSection)
      .setName('Template file')
      .setDesc('The template file to use')
      .addSearch((search) => {
        noteTemplateText = search;
        new FileSuggest(this.app, search.inputEl);
        search
          .setPlaceholder('templates/note.md')
          .setValue(s.templatePath)
          .setDisabled(!s.customTemplate)
          .onChange(async (value) => {
            s.templatePath = value;
            await this.plugin.saveSettings();
          });
      })
      .addButton((btn) =>
        btn
          .setButtonText('Export default')
          .onClick(async () => {
            const filePath = normalizePath(
              `${this.getTemplateFolderPath()}/koreader-note-template.md`
            );
            try {
              await this.plugin.app.vault.create(filePath, DEFAULT_NOTE_TEMPLATE);
              s.templatePath = filePath;
              s.customTemplate = true;
              await this.plugin.saveSettings();
              noteTemplateText.setValue(filePath).setDisabled(false);
              noteTemplateToggle.setValue(true);
              new Notice(`Template exported to ${filePath}`);
            } catch (e) {
              if (e.message?.includes('already exists')) {
                new Notice(`Template already exists at ${filePath}`);
              } else {
                console.error(e);
                new Notice(`Failed to export template: ${e.message}`);
              }
            }
          })
      );

    perHighlightSection.createEl('h3', { text: 'Note title formatting' });

    new Setting(perHighlightSection).setName('Prefix').addText((text) =>
      text
        .setPlaceholder('Enter the prefix')
        .setValue(s.noteTitleOptions.prefix)
        .onChange(async (value) => {
          s.noteTitleOptions.prefix = value;
          await this.plugin.saveSettings();
        })
    );
    new Setting(perHighlightSection).setName('Suffix').addText((text) =>
      text
        .setPlaceholder('Enter the suffix')
        .setValue(s.noteTitleOptions.suffix)
        .onChange(async (value) => {
          s.noteTitleOptions.suffix = value;
          await this.plugin.saveSettings();
        })
    );
    new Setting(perHighlightSection)
      .setName('Max words')
      .setDesc(
        'If longer than this number of words, the title will be truncated and "..." appended before the optional suffix'
      )
      .addSlider((number) =>
        number
          .setDynamicTooltip()
          .setLimits(0, 10, 1)
          .setValue(s.noteTitleOptions.maxWords)
          .onChange(async (value) => {
            s.noteTitleOptions.maxWords = value;
            await this.plugin.saveSettings();
          })
      );
    new Setting(perHighlightSection)
      .setName('Max length')
      .setDesc(
        'If longer than this number of characters, the title will be truncated and "..." appended before the optional suffix'
      )
      .addSlider((number) =>
        number
          .setDynamicTooltip()
          .setLimits(0, 50, 1)
          .setValue(s.noteTitleOptions.maxLength)
          .onChange(async (value) => {
            s.noteTitleOptions.maxLength = value;
            await this.plugin.saveSettings();
          })
      );

    updatePerHighlightVisibility = () => {
      perHighlightSection.style.display = s.singleFilePerBook ? 'none' : '';
    };
    updatePerHighlightVisibility();

    // ── 5. COMBINED BOOK FILE SETTINGS ──────────────────────────────
    // Entire section (including heading) hides when per-highlight mode is active.
    const singleFileSection = containerEl.createDiv();

    singleFileSection.createEl('h2', { text: 'Combined book file' });

    let singleFileTemplateToggle: ToggleComponent;
    let singleFileTemplateText: SearchComponent;

    new Setting(singleFileSection)
      .setName('Custom template')
      .setDesc('Use a custom template for the combined book highlights file')
      .addToggle((toggle) => {
        singleFileTemplateToggle = toggle;
        return toggle
          .setValue(s.customSingleFileTemplate)
          .onChange(async (value) => {
            s.customSingleFileTemplate = value;
            await this.plugin.saveSettings();
            singleFileTemplateText.setDisabled(!value);
          });
      });

    new Setting(singleFileSection)
      .setName('Template file')
      .setDesc('The template file to use')
      .addSearch((search) => {
        singleFileTemplateText = search;
        new FileSuggest(this.app, search.inputEl);
        search
          .setPlaceholder('templates/book-highlights.md')
          .setValue(s.singleFileTemplatePath)
          .setDisabled(!s.customSingleFileTemplate)
          .onChange(async (value) => {
            s.singleFileTemplatePath = value;
            await this.plugin.saveSettings();
          });
      })
      .addButton((btn) =>
        btn
          .setButtonText('Export default')
          .onClick(async () => {
            const filePath = normalizePath(
              `${this.getTemplateFolderPath()}/koreader-book-highlights-template.md`
            );
            try {
              await this.plugin.app.vault.create(filePath, DEFAULT_BOOK_HIGHLIGHTS_TEMPLATE);
              s.singleFileTemplatePath = filePath;
              s.customSingleFileTemplate = true;
              await this.plugin.saveSettings();
              singleFileTemplateText.setValue(filePath).setDisabled(false);
              singleFileTemplateToggle.setValue(true);
              new Notice(`Template exported to ${filePath}`);
            } catch (e) {
              if (e.message?.includes('already exists')) {
                new Notice(`Template already exists at ${filePath}`);
              } else {
                console.error(e);
                new Notice(`Failed to export template: ${e.message}`);
              }
            }
          })
      );

    updateSingleFileVisibility = () => {
      singleFileSection.style.display = s.singleFilePerBook ? '' : 'none';
    };
    updateSingleFileVisibility();

    // ── 6. DATAVIEW SUMMARY SETTINGS ────────────────────────────────
    // Entire section (including heading) hides when dataview is disabled.
    const dataviewSection = containerEl.createDiv();

    dataviewSection.createEl('h2', { text: 'Dataview summary' });

    let dataviewTemplateToggle: ToggleComponent;
    let dataviewTemplateText: SearchComponent;

    new Setting(dataviewSection)
      .setName('Custom template')
      .setDesc('Use a custom template for the Dataview summary note')
      .addToggle((toggle) => {
        dataviewTemplateToggle = toggle;
        return toggle
          .setValue(s.customDataviewTemplate)
          .onChange(async (value) => {
            s.customDataviewTemplate = value;
            await this.plugin.saveSettings();
            dataviewTemplateText.setDisabled(!value);
          });
      });

    new Setting(dataviewSection)
      .setName('Template file')
      .setDesc('The template file to use')
      .addSearch((search) => {
        dataviewTemplateText = search;
        new FileSuggest(this.app, search.inputEl);
        search
          .setPlaceholder('templates/template-book.md')
          .setValue(s.dataviewTemplatePath)
          .setDisabled(!s.customDataviewTemplate)
          .onChange(async (value) => {
            s.dataviewTemplatePath = value;
            await this.plugin.saveSettings();
          });
      })
      .addButton((btn) =>
        btn
          .setButtonText('Export default')
          .onClick(async () => {
            const filePath = normalizePath(
              `${this.getTemplateFolderPath()}/koreader-dataview-template.md`
            );
            try {
              await this.plugin.app.vault.create(filePath, DEFAULT_DATAVIEW_TEMPLATE);
              s.dataviewTemplatePath = filePath;
              s.customDataviewTemplate = true;
              await this.plugin.saveSettings();
              dataviewTemplateText.setValue(filePath).setDisabled(false);
              dataviewTemplateToggle.setValue(true);
              new Notice(`Template exported to ${filePath}`);
            } catch (e) {
              if (e.message?.includes('already exists')) {
                new Notice(`Template already exists at ${filePath}`);
              } else {
                console.error(e);
                new Notice(`Failed to export template: ${e.message}`);
              }
            }
          })
      );

    updateDataviewVisibility = () => {
      dataviewSection.style.display = s.createDataviewQuery && !s.singleFilePerBook ? '' : 'none';
    };
    updateDataviewVisibility();

    // ── 6. BOOK TITLE FORMATTING ────────────────────────────────────
    // Shown when any book-level naming is in use
    const bookTitlesSection = containerEl.createDiv();

    bookTitlesSection.createEl('h2', { text: 'Book title formatting' });
    bookTitlesSection
      .createEl('p', { cls: 'setting-item-description' })
      .appendText(
        'Applied to folder names, combined book files, and Dataview summary notes.'
      );

    new Setting(bookTitlesSection).setName('Prefix').addText((text) =>
      text
        .setPlaceholder('Enter the prefix')
        .setValue(s.bookTitleOptions.prefix)
        .onChange(async (value) => {
          s.bookTitleOptions.prefix = value;
          await this.plugin.saveSettings();
        })
    );
    new Setting(bookTitlesSection).setName('Suffix').addText((text) =>
      text
        .setPlaceholder('Enter the suffix')
        .setValue(s.bookTitleOptions.suffix)
        .onChange(async (value) => {
          s.bookTitleOptions.suffix = value;
          await this.plugin.saveSettings();
        })
    );
    new Setting(bookTitlesSection)
      .setName('Max words')
      .setDesc(
        'If longer than this number of words, the title will be truncated and "..." appended before the optional suffix'
      )
      .addSlider((number) =>
        number
          .setDynamicTooltip()
          .setLimits(0, 10, 1)
          .setValue(s.bookTitleOptions.maxWords)
          .onChange(async (value) => {
            s.bookTitleOptions.maxWords = value;
            await this.plugin.saveSettings();
          })
      );
    new Setting(bookTitlesSection)
      .setName('Max length')
      .setDesc(
        'If longer than this number of characters, the title will be truncated and "..." appended before the optional suffix'
      )
      .addSlider((number) =>
        number
          .setDynamicTooltip()
          .setLimits(0, 50, 1)
          .setValue(s.bookTitleOptions.maxLength)
          .onChange(async (value) => {
            s.bookTitleOptions.maxLength = value;
            await this.plugin.saveSettings();
          })
      );

    updateBookTitlesVisibility = () => {
      bookTitlesSection.style.display = showBookTitles() ? '' : 'none';
    };
    updateBookTitlesVisibility();

    // ── 7. SYNC BEHAVIOR ────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Sync behavior' });

    new Setting(containerEl)
      .setName('Keep in sync')
      .setDesc(
        createFragment((frag) => {
          frag.appendText('Keep notes in sync with KOReader (read the ');
          frag.createEl(
            'a',
            {
              text: 'documentation',
              href: 'https://github.com/Edo78/obsidian-koreader-sync#sync',
            },
            (a) => {
              a.setAttr('target', '_blank');
            }
          );
          frag.appendText(')');
        })
      )
      .addToggle((toggle) =>
        toggle
          .setValue(s.keepInSync)
          .onChange(async (value) => {
            s.keepInSync = value;
            await this.plugin.saveSettings();
          })
      );

    // ── 8. ADVANCED ─────────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Advanced' });

    new Setting(containerEl)
      .setName('Enable reset of imported notes')
      .setDesc(
        "Enable the command to empty the list of imported notes in case you can't recover from the trash one or more notes"
      )
      .addToggle((toggle) =>
        toggle
          .setValue(s.enbleResetImportedNotes)
          .onChange(async (value) => {
            s.enbleResetImportedNotes = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
