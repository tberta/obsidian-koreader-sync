export interface TitleOptions {
  prefix?: string;
  suffix?: string;
  maxLength?: number;
  maxWords?: number;
}

export interface KOReaderSettings {
  koreaderBasePath: string;
  obsidianNoteFolder: string;
  noteTitleOptions: TitleOptions;
  bookTitleOptions: TitleOptions;
  keepInSyncMode: 'always' | 'never' | 'unfinished';
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
  bookFolderTemplate?: string;
}

export const DEFAULT_SETTINGS: KOReaderSettings = {
  importedNotes: {},
  bookFolderTemplate: '',
  keepInSyncMode: 'never',
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
