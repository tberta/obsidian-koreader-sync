import * as crypto from 'crypto';
import { normalizePath } from 'obsidian';
import { Bookmark } from './types';

/** MD5 hex digest of a string. */
export function md5(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Resolve a book-folder path template, substituting variables and
 * normalizing the result to guard against path traversal.
 */
export function safeResolvePath(template: string, vars: Record<string, string>): string {
  const resolved = Object.entries(vars).reduce(
    (tpl, [k, v]) => tpl.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v),
    template
  );
  return normalizePath(resolved);
}

/**
 * Extract the integer page number from a Bookmark.
 * Old format stores it as the first number in the formatted `text` string.
 * New format stores it directly in `bookmark.page`.
 */
export function getPageNumber(bookmark: Bookmark): number {
  if (!bookmark.text) return parseInt(bookmark.page, 10) || -1;
  return parseInt(bookmark.text.match(/\d+/g)?.[0] ?? '', 10) || -1;
}

/**
 * Extract the user-visible note/annotation text from a Bookmark.
 * Old format encodes it after the datetime in the `text` field.
 * New format stores it directly in `userNote`.
 */
export function getNoteText(bookmark: Bookmark): string {
  if (!bookmark.text) return bookmark.annotationText ?? '';
  return (bookmark.text.split(bookmark.datetime)[1] ?? '').trim();
}

/** Compute content hash for a Bookmark (used to detect KOReader-side changes). */
export function bookmarkContentHash(bookmark: Bookmark): string {
  return md5(`${bookmark.highlightText}|${bookmark.annotationText ?? ''}|${bookmark.chapter}`);
}
