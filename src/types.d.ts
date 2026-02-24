export interface Bookmark {
  chapter: string;
  text: string;
  datetime: string;
  datetimeUpdated?: string;
  notes: string;
  userNote?: string;
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
  highlight: any;
  percent_finished: number;
}

export interface Books {
  [fullTitle: string]: Book;
}

export interface FrontMatterData {
  title: string;
  authors: string;
  chapter?: string;
  page?: number;
  highlight?: string;
  datetime?: string;
}

export interface FrontMatterMetadata {
  body_hash: string;
  keep_in_sync?: boolean; // deprecated: moved to top-level koreader_keep_in_sync
  yet_to_be_edited: boolean;
  managed_book_title: string;
  percent_finished?: number;
}

export interface FrontMatter {
  type: string;
  uniqueId?: string;
  uniqueIds?: string[];
  data: FrontMatterData,
  metadata: FrontMatterMetadata,
}
