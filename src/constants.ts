export const KOREADER_KEY = 'koreader-sync';

export const MAX_SUGGESTIONS = 20;

export const BLUR_CLOSE_DELAY = 150; // ms

// Separator between plugin-managed content and user-added notes.
// Rendered as an invisible Obsidian comment in Live Preview.
export const KOREADER_USER_SECTION_SEPARATOR = '\n%% koreader-user-notes %%\n';

export enum NoteType {
  SINGLE_NOTE     = 'koreader-sync-note',
  BOOK_NOTE       = 'koreader-sync-dataview',
  BOOK_HIGHLIGHTS = 'koreader-sync-book-highlights',
}
