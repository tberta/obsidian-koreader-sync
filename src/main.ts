import * as crypto from 'crypto';
import { Eta } from 'eta';

import {
  App,
  Editor,
  MarkdownView,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
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

class KoreaderSettingTab extends PluginSettingTab {
  plugin: KOReader;

  constructor(app: App, plugin: KOReader) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl('h2', { text: 'KOReader general settings' });

    new Setting(containerEl)
      .setName('KOReader mounted path')
      .setDesc('Eg. /media/<user>/KOBOeReader')
      .addText((text) =>
        text
          .setPlaceholder('Enter the path wher KOReader is mounted')
          .setValue(this.plugin.settings.koreaderBasePath)
          .onChange(async (value) => {
            this.plugin.settings.koreaderBasePath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Highlights folder location')
      .setDesc('Vault folder to use for writing book highlight notes')
      .addDropdown((dropdown) => {
        const { files } = this.app.vault.adapter as any;
        const folders = Object.keys(files).filter(
          (key) => files[key].type === 'folder'
        );
        folders.forEach((val) => {
          dropdown.addOption(val, val);
        });
        return dropdown
          .setValue(this.plugin.settings.obsidianNoteFolder)
          .onChange(async (value) => {
            this.plugin.settings.obsidianNoteFolder = value;
            await this.plugin.saveSettings();
          });
      });

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
          .setValue(this.plugin.settings.keepInSync)
          .onChange(async (value) => {
            this.plugin.settings.keepInSync = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Create a folder for each book')
      .setDesc(
        'All the notes from a book will be saved in a folder named after the book'
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.aFolderForEachBook)
          .onChange(async (value) => {
            this.plugin.settings.aFolderForEachBook = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Book path template')
      .setDesc(
        createFragment((frag) => {
          frag.appendText(
            'Template for the book path relative to the highlights folder. ' +
            'Available variables: {{title}}, {{authors}}. ' +
            '{{title}} is processed using the book title settings below. ' +
            'E.g. {{authors}}/{{title}} groups books in per-author folders. ' +
            'Leave empty to use the \'Create a folder for each book\' toggle.'
          );
        })
      )
      .addText((text) =>
        text
          .setPlaceholder('{{authors}}/{{title}}')
          .setValue(this.plugin.settings.bookFolderTemplate ?? '')
          .onChange(async (value) => {
            this.plugin.settings.bookFolderTemplate = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl('h2', { text: 'View settings' });

    new Setting(containerEl)
      .setName('Custom template')
      .setDesc('Use a custom template for the notes')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.customTemplate)
          .onChange(async (value) => {
            this.plugin.settings.customTemplate = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Template file')
      .setDesc('The template file to use. Remember to add the ".md" extension')
      .addText((text) =>
        text
          .setPlaceholder('templates/note.md')
          .setValue(this.plugin.settings.templatePath)
          .onChange(async (value) => {
            this.plugin.settings.templatePath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Custom book template')
      .setDesc('Use a custom template for the dataview')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.customDataviewTemplate)
          .onChange(async (value) => {
            this.plugin.settings.customDataviewTemplate = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Book template file')
      .setDesc('The template file to use. Remember to add the ".md" extension')
      .addText((text) =>
        text
          .setPlaceholder('templates/template-book.md')
          .setValue(this.plugin.settings.dataviewTemplatePath)
          .onChange(async (value) => {
            this.plugin.settings.dataviewTemplatePath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Create a dataview query')
      .setDesc(
        createFragment((frag) => {
          frag.appendText(
            'Create a note (for each book) with a dataview query (read the '
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
          .setValue(this.plugin.settings.createDataviewQuery)
          .onChange(async (value) => {
            this.plugin.settings.createDataviewQuery = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl('h2', { text: 'Single file per book (experimental)' });

    new Setting(containerEl)
      .setName('Combine all highlights into one file per book')
      .setDesc(
        'Creates one note per book with all highlights. Disables per-highlight notes for books in this mode.'
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.singleFilePerBook)
          .onChange(async (value) => {
            this.plugin.settings.singleFilePerBook = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Custom combined-file template')
      .setDesc('Use a custom template for the combined book highlights file')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.customSingleFileTemplate)
          .onChange(async (value) => {
            this.plugin.settings.customSingleFileTemplate = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Combined file template path')
      .setDesc('The template file to use. Remember to add the ".md" extension')
      .addText((text) =>
        text
          .setPlaceholder('templates/book-highlights.md')
          .setValue(this.plugin.settings.singleFileTemplatePath)
          .onChange(async (value) => {
            this.plugin.settings.singleFileTemplatePath = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl('h2', { text: 'Note title settings' });

    new Setting(containerEl).setName('Prefix').addText((text) =>
      text
        .setPlaceholder('Enter the prefix')
        .setValue(this.plugin.settings.noteTitleOptions.prefix)
        .onChange(async (value) => {
          this.plugin.settings.noteTitleOptions.prefix = value;
          await this.plugin.saveSettings();
        })
    );
    new Setting(containerEl).setName('Suffix').addText((text) =>
      text
        .setPlaceholder('Enter the suffix')
        .setValue(this.plugin.settings.noteTitleOptions.suffix)
        .onChange(async (value) => {
          this.plugin.settings.noteTitleOptions.suffix = value;
          await this.plugin.saveSettings();
        })
    );
    new Setting(containerEl)
      .setName('Max words')
      .setDesc(
        'If is longer than this number of words, it will be truncated and "..." will be appended before the optional suffix'
      )
      .addSlider((number) =>
        number
          .setDynamicTooltip()
          .setLimits(0, 10, 1)
          .setValue(this.plugin.settings.noteTitleOptions.maxWords)
          .onChange(async (value) => {
            this.plugin.settings.noteTitleOptions.maxWords = value;
            await this.plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName('Max length')
      .setDesc(
        'If is longer than this number of characters, it will be truncated and "..." will be appended before the optional suffix'
      )
      .addSlider((number) =>
        number
          .setDynamicTooltip()
          .setLimits(0, 50, 1)
          .setValue(this.plugin.settings.noteTitleOptions.maxLength)
          .onChange(async (value) => {
            this.plugin.settings.noteTitleOptions.maxLength = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl('h2', { text: 'Book title settings' });

    new Setting(containerEl).setName('Prefix').addText((text) =>
      text
        .setPlaceholder('Enter the prefix')
        .setValue(this.plugin.settings.bookTitleOptions.prefix)
        .onChange(async (value) => {
          this.plugin.settings.bookTitleOptions.prefix = value;
          await this.plugin.saveSettings();
        })
    );
    new Setting(containerEl).setName('Suffix').addText((text) =>
      text
        .setPlaceholder('Enter the suffix')
        .setValue(this.plugin.settings.bookTitleOptions.suffix)
        .onChange(async (value) => {
          this.plugin.settings.bookTitleOptions.suffix = value;
          await this.plugin.saveSettings();
        })
    );
    new Setting(containerEl)
      .setName('Max words')
      .setDesc(
        'If is longer than this number of words, it will be truncated and "..." will be appended before the optional suffix'
      )
      .addSlider((number) =>
        number
          .setDynamicTooltip()
          .setLimits(0, 10, 1)
          .setValue(this.plugin.settings.bookTitleOptions.maxWords)
          .onChange(async (value) => {
            this.plugin.settings.bookTitleOptions.maxWords = value;
            await this.plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName('Max length')
      .setDesc(
        'If is longer than this number of characters, it will be truncated and "..." will be appended before the optional suffix'
      )
      .addSlider((number) =>
        number
          .setDynamicTooltip()
          .setLimits(0, 50, 1)
          .setValue(this.plugin.settings.bookTitleOptions.maxLength)
          .onChange(async (value) => {
            this.plugin.settings.bookTitleOptions.maxLength = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl('h2', { text: 'DANGER ZONE' });

    new Setting(containerEl)
      .setName('Enable reset of imported notes')
      .setDesc(
        "Enable the command to empty the list of imported notes in case you can't recover from the trash one or more notes"
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enbleResetImportedNotes)
          .onChange(async (value) => {
            this.plugin.settings.enbleResetImportedNotes = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
