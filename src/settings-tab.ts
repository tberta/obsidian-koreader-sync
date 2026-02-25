import {
  App,
  Notice,
  PluginSettingTab,
  SearchComponent,
  Setting,
  ToggleComponent,
  normalizePath,
} from 'obsidian';
import { KOReaderSettings } from './settings';
import { DEFAULT_NOTE_TEMPLATE, DEFAULT_BOOK_HIGHLIGHTS_TEMPLATE, DEFAULT_DATAVIEW_TEMPLATE } from './templates';
import { FolderSuggest, FileSuggest } from './suggest';
import type KOReader from './main';

export class KoreaderSettingTab extends PluginSettingTab {
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

  private async exportTemplate(
    defaultContent: string,
    filePath: string,
    onSuccess: (path: string) => Promise<void>,
  ): Promise<void> {
    try {
      await this.plugin.app.vault.create(filePath, defaultContent);
      await onSuccess(filePath);
      new Notice(`Template exported to ${filePath}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('already exists')) {
        new Notice(`Template already exists at ${filePath}`);
      } else {
        console.error(e);
        new Notice(`Failed to export template: ${msg}`);
      }
    }
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
    const perHighlightSection = containerEl.createDiv();
    perHighlightSection.createEl('h2', { text: 'Per-highlight notes' });

    new Setting(perHighlightSection)
      .setName('Dataview summary note per book')
      .setDesc(
        createFragment((frag) => {
          frag.appendText(
            'Also create a note per book with a Dataview query embedding all its highlights (read the '
          );
          frag.createEl('a', { text: 'documentation', href: 'https://github.com/Edo78/obsidian-koreader-sync#dateview-embedded' },
            (a) => { a.setAttr('target', '_blank'); });
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
        return toggle.setValue(s.customTemplate).onChange(async (value) => {
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
          .onChange(async (value) => { s.templatePath = value; await this.plugin.saveSettings(); });
      })
      .addButton((btn) =>
        btn.setButtonText('Export default').onClick(() => {
          const filePath = normalizePath(`${this.getTemplateFolderPath()}/koreader-note-template.md`);
          this.exportTemplate(DEFAULT_NOTE_TEMPLATE, filePath, async (p) => {
            s.templatePath = p; s.customTemplate = true;
            await this.plugin.saveSettings();
            noteTemplateText.setValue(p).setDisabled(false);
            noteTemplateToggle.setValue(true);
          });
        })
      );

    perHighlightSection.createEl('h3', { text: 'Note title formatting' });

    new Setting(perHighlightSection).setName('Prefix').addText((text) =>
      text.setPlaceholder('Enter the prefix').setValue(s.noteTitleOptions.prefix)
        .onChange(async (value) => { s.noteTitleOptions.prefix = value; await this.plugin.saveSettings(); })
    );
    new Setting(perHighlightSection).setName('Suffix').addText((text) =>
      text.setPlaceholder('Enter the suffix').setValue(s.noteTitleOptions.suffix)
        .onChange(async (value) => { s.noteTitleOptions.suffix = value; await this.plugin.saveSettings(); })
    );
    new Setting(perHighlightSection)
      .setName('Max words')
      .setDesc('If longer than this number of words, the title will be truncated and "..." appended before the optional suffix')
      .addSlider((n) => n.setDynamicTooltip().setLimits(0, 10, 1).setValue(s.noteTitleOptions.maxWords)
        .onChange(async (value) => { s.noteTitleOptions.maxWords = value; await this.plugin.saveSettings(); }));
    new Setting(perHighlightSection)
      .setName('Max length')
      .setDesc('If longer than this number of characters, the title will be truncated and "..." appended before the optional suffix')
      .addSlider((n) => n.setDynamicTooltip().setLimits(0, 50, 1).setValue(s.noteTitleOptions.maxLength)
        .onChange(async (value) => { s.noteTitleOptions.maxLength = value; await this.plugin.saveSettings(); }));

    updatePerHighlightVisibility = () => {
      perHighlightSection.style.display = s.singleFilePerBook ? 'none' : '';
    };
    updatePerHighlightVisibility();

    // ── 5. COMBINED BOOK FILE SETTINGS ──────────────────────────────
    const singleFileSection = containerEl.createDiv();
    singleFileSection.createEl('h2', { text: 'Combined book file' });

    let singleFileTemplateToggle: ToggleComponent;
    let singleFileTemplateText: SearchComponent;

    new Setting(singleFileSection)
      .setName('Custom template')
      .setDesc('Use a custom template for the combined book highlights file')
      .addToggle((toggle) => {
        singleFileTemplateToggle = toggle;
        return toggle.setValue(s.customSingleFileTemplate).onChange(async (value) => {
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
          .onChange(async (value) => { s.singleFileTemplatePath = value; await this.plugin.saveSettings(); });
      })
      .addButton((btn) =>
        btn.setButtonText('Export default').onClick(() => {
          const filePath = normalizePath(`${this.getTemplateFolderPath()}/koreader-book-highlights-template.md`);
          this.exportTemplate(DEFAULT_BOOK_HIGHLIGHTS_TEMPLATE, filePath, async (p) => {
            s.singleFileTemplatePath = p; s.customSingleFileTemplate = true;
            await this.plugin.saveSettings();
            singleFileTemplateText.setValue(p).setDisabled(false);
            singleFileTemplateToggle.setValue(true);
          });
        })
      );

    updateSingleFileVisibility = () => {
      singleFileSection.style.display = s.singleFilePerBook ? '' : 'none';
    };
    updateSingleFileVisibility();

    // ── 6. DATAVIEW SUMMARY SETTINGS ────────────────────────────────
    const dataviewSection = containerEl.createDiv();
    dataviewSection.createEl('h2', { text: 'Dataview summary' });

    let dataviewTemplateToggle: ToggleComponent;
    let dataviewTemplateText: SearchComponent;

    new Setting(dataviewSection)
      .setName('Custom template')
      .setDesc('Use a custom template for the Dataview summary note')
      .addToggle((toggle) => {
        dataviewTemplateToggle = toggle;
        return toggle.setValue(s.customDataviewTemplate).onChange(async (value) => {
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
          .onChange(async (value) => { s.dataviewTemplatePath = value; await this.plugin.saveSettings(); });
      })
      .addButton((btn) =>
        btn.setButtonText('Export default').onClick(() => {
          const filePath = normalizePath(`${this.getTemplateFolderPath()}/koreader-dataview-template.md`);
          this.exportTemplate(DEFAULT_DATAVIEW_TEMPLATE, filePath, async (p) => {
            s.dataviewTemplatePath = p; s.customDataviewTemplate = true;
            await this.plugin.saveSettings();
            dataviewTemplateText.setValue(p).setDisabled(false);
            dataviewTemplateToggle.setValue(true);
          });
        })
      );

    updateDataviewVisibility = () => {
      dataviewSection.style.display = s.createDataviewQuery && !s.singleFilePerBook ? '' : 'none';
    };
    updateDataviewVisibility();

    // ── 7. BOOK TITLE FORMATTING ────────────────────────────────────
    const bookTitlesSection = containerEl.createDiv();
    bookTitlesSection.createEl('h2', { text: 'Book title formatting' });
    bookTitlesSection.createEl('p', { cls: 'setting-item-description' })
      .appendText('Applied to folder names, combined book files, and Dataview summary notes.');

    new Setting(bookTitlesSection).setName('Prefix').addText((text) =>
      text.setPlaceholder('Enter the prefix').setValue(s.bookTitleOptions.prefix)
        .onChange(async (value) => { s.bookTitleOptions.prefix = value; await this.plugin.saveSettings(); })
    );
    new Setting(bookTitlesSection).setName('Suffix').addText((text) =>
      text.setPlaceholder('Enter the suffix').setValue(s.bookTitleOptions.suffix)
        .onChange(async (value) => { s.bookTitleOptions.suffix = value; await this.plugin.saveSettings(); })
    );
    new Setting(bookTitlesSection)
      .setName('Max words')
      .setDesc('If longer than this number of words, the title will be truncated and "..." appended before the optional suffix')
      .addSlider((n) => n.setDynamicTooltip().setLimits(0, 10, 1).setValue(s.bookTitleOptions.maxWords)
        .onChange(async (value) => { s.bookTitleOptions.maxWords = value; await this.plugin.saveSettings(); }));
    new Setting(bookTitlesSection)
      .setName('Max length')
      .setDesc('If longer than this number of characters, the title will be truncated and "..." appended before the optional suffix')
      .addSlider((n) => n.setDynamicTooltip().setLimits(0, 50, 1).setValue(s.bookTitleOptions.maxLength)
        .onChange(async (value) => { s.bookTitleOptions.maxLength = value; await this.plugin.saveSettings(); }));

    updateBookTitlesVisibility = () => {
      bookTitlesSection.style.display = showBookTitles() ? '' : 'none';
    };
    updateBookTitlesVisibility();

    // ── 8. SYNC BEHAVIOR ────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Sync behavior' });

    new Setting(containerEl)
      .setName('Keep in sync')
      .setDesc(
        createFragment((frag) => {
          frag.appendText(
            'When to keep notes in sync with KOReader. ' +
            'The value is written as koreader_keep_in_sync in each note\'s frontmatter ' +
            'and can be overridden per note. (read the '
          );
          frag.createEl('a', { text: 'documentation', href: 'https://github.com/Edo78/obsidian-koreader-sync#sync' },
            (a) => { a.setAttr('target', '_blank'); });
          frag.appendText(')');
        })
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('never', 'Never')
          .addOption('always', 'Always')
          .addOption('unfinished', 'Active books only (less than 100% read)')
          .setValue(s.keepInSyncMode ?? 'never')
          .onChange(async (value) => {
            s.keepInSyncMode = value as KOReaderSettings['keepInSyncMode'];
            await this.plugin.saveSettings();
          })
      );

    // ── 9. ADVANCED ─────────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Advanced' });

    new Setting(containerEl)
      .setName('Enable reset of imported notes')
      .setDesc("Enable the command to empty the list of imported notes in case you can't recover from the trash one or more notes")
      .addToggle((toggle) =>
        toggle.setValue(s.enbleResetImportedNotes).onChange(async (value) => {
          s.enbleResetImportedNotes = value;
          await this.plugin.saveSettings();
        })
      );
  }
}
