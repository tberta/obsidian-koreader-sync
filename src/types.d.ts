import { NoteType } from './constants';

export interface Bookmark {
  chapter: string;
  /** Old KOReader format: formatted string containing page + note text. Empty in new format. */
  text: string;
  datetime: string;
  datetimeUpdated?: string;
  /** Highlight text (the selected passage from the book). */
  highlightText: string;
  /** User-written annotation attached to the highlight (new format only). */
  annotationText?: string;
  highlighted: boolean;
  pos0: string;
  pos1: string;
  page: string;
}

export interface Bookmarks {
  [key: number]: Bookmark;
}

export interface Book {
  title: string;
  authors: string;
  bookmarks: Bookmarks;
  percent_finished: number;
}

export interface Books {
  [fullTitle: string]: Book;
}

// ── Parsed Lua metadata shapes ────────────────────────────────────────────────

export interface ParsedLuaAnnotation {
  text?: string;
  note?: string;
  chapter?: string;
  datetime?: string;
  datetime_updated?: string;
  pageno?: number;
  pos0?: string;
  pos1?: string;
}

export interface ParsedLuaBookmark {
  text?: string;
  notes?: string;
  chapter?: string;
  datetime?: string;
  highlighted?: boolean;
  pos0?: string;
  pos1?: string;
  page?: string;
}

export interface ParsedLuaMetadata {
  doc_props?: { title?: string; authors?: string };
  percent_finished?: number;
  annotations?: Record<string, ParsedLuaAnnotation>;
  bookmarks?: Record<string, ParsedLuaBookmark>;
}

/** Returned by KOReaderMetadata.scan() — carries books plus any per-file errors. */
export interface ScanResult {
  books: Books;
  errors: Array<{ file: string; reason: string }>;
}

// ── Obsidian frontmatter shapes ───────────────────────────────────────────────

export interface FrontMatterData {
  title: string;
  authors: string;
  chapter?: string;
  page?: number;
  highlightText?: string;
  datetime?: string;
}

export interface FrontMatterMetadata {
  body_hash: string;
  managed_book_title: string;
  percent_finished?: number;
}

export interface FrontMatter {
  type: NoteType;
  uniqueId?: string;
  uniqueIds?: string[];
  data: FrontMatterData;
  metadata: FrontMatterMetadata;
}
