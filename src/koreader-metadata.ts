import * as fs from 'fs';
import * as path from 'path';

import finder from 'node-find-files';
import { parse } from 'lua-json';
import { Books, Bookmarks, ParsedLuaMetadata, ScanResult } from './types';

// Normalize pos0/pos1 values to stable strings.
// PDF bookmarks store coordinates as objects {page, rotation, x, y, zoom};
// EPUB bookmarks store CFI paths as plain strings. Both must produce a
// string so that uniqueId (md5) computation is consistent and stable.
function normalizePos(pos: unknown): string {
  if (!pos) return '';
  if (typeof pos === 'string') return pos;
  if (typeof pos === 'object') return JSON.stringify(pos);
  return String(pos);
}

// Decode Lua \xNN hex escape sequences (e.g. \xc2\xa0 → non-breaking space).
// luaparse does not handle \xNN escapes (a Lua 5.2+ feature), so they appear
// as literal backslash-x sequences in the parsed output.
function decodeLuaHexEscapes(str: string): string {
  return str.replace(/(?:\\x[0-9a-fA-F]{2})+/g, (match) => {
    const bytes: number[] = [];
    const hex = /\\x([0-9a-fA-F]{2})/g;
    let m: RegExpExecArray | null;
    while ((m = hex.exec(match)) !== null) {
      bytes.push(parseInt(m[1], 16));
    }
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
  });
}

// Decode HTML entities that KOReader may embed in doc_props strings
// (e.g. &#39; → ', &amp; → &).
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

export class KOReaderMetadata {
  koreaderBasePath: string;

  constructor(koreaderBasePath: string) {
    this.koreaderBasePath = koreaderBasePath;
  }

  public async scan(): Promise<ScanResult> {
    const books: Books = {};
    const errors: ScanResult['errors'] = [];

    return new Promise((resolve) => {
      const find = new finder({ rootFolder: this.koreaderBasePath });

      find.on('match', (file: string) => {
        const filename = path.parse(file).base;
        if (!filename.match(/metadata\..*\.lua$/)) return;

        try {
          const content = fs.readFileSync(file, 'utf8');
          const jsonMetadata = parse(content) as ParsedLuaMetadata;
          const { bookmarks, annotations, doc_props, percent_finished, summary, partial_md5_checksum } = jsonMetadata;

          const sdrFallback = path.basename(path.dirname(file)).replace(/\.sdr$/, '');
          const title = decodeHtmlEntities(decodeLuaHexEscapes(doc_props?.title || sdrFallback));
          const authors = decodeHtmlEntities(decodeLuaHexEscapes(doc_props?.authors || 'Unknown'));

          if (!title) {
            console.warn(`KOReader: skipping ${file} - could not determine title`);
            return;
          }
          if (!doc_props?.title) {
            console.warn(`KOReader: no title in doc_props for ${file}, using folder name: "${sdrFallback}"`);
          }

          let normalizedBookmarks: Bookmarks | null = null;

          // New format (KOReader >= ~2024): highlights stored under "annotations".
          if (annotations && Object.keys(annotations).length) {
            normalizedBookmarks = {};
            for (const key of Object.keys(annotations)) {
              const ann = annotations[key];
              normalizedBookmarks[key as any] = {
                chapter: decodeLuaHexEscapes(ann.chapter || ''),
                // text is intentionally left empty: createNote() treats an empty
                // text as "new format" and reads the page from bookmark.page instead.
                text: '',
                highlightText: decodeLuaHexEscapes(ann.text || ''),
                annotationText: ann.note ? decodeLuaHexEscapes(ann.note) : undefined,
                datetime: ann.datetime || '',
                datetimeUpdated: ann.datetime_updated || undefined,
                highlighted: true,
                pos0: normalizePos(ann.pos0),
                pos1: normalizePos(ann.pos1),
                page: String(ann.pageno ?? -1),
              };
            }
          }
          // Old format: highlights stored under "bookmarks".
          else if (bookmarks && Object.keys(bookmarks).length) {
            normalizedBookmarks = {};
            for (const key of Object.keys(bookmarks)) {
              const bm = bookmarks[key];
              normalizedBookmarks[key as any] = {
                chapter: decodeLuaHexEscapes(bm.chapter || ''),
                highlightText: decodeLuaHexEscapes(bm.notes || ''),
                text: decodeLuaHexEscapes(bm.text || ''),
                datetime: bm.datetime || '',
                highlighted: bm.highlighted ?? false,
                pos0: normalizePos(bm.pos0),
                pos1: normalizePos(bm.pos1),
                page: bm.page || '-1',
              };
            }
          }

          if (normalizedBookmarks && Object.keys(normalizedBookmarks).length) {
            books[`${title} - ${authors}`] = {
              title,
              authors: authors || 'Unknown',
              bookmarks: normalizedBookmarks,
              percent_finished: (percent_finished || 0) * 100,
              last_read_date: summary?.modified,
              status: summary?.status,
              checksum: partial_md5_checksum,
            };
          }
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          console.error(`KOReader: failed to parse ${file}:`, e);
          errors.push({ file, reason });
        }
      });

      find.on('error', (err: unknown) => {
        // Log but do not reject — a single traversal error should not abort the
        // entire scan. The 'complete' event will still fire after all reachable
        // files have been processed.
        console.error('KOReader: file search error:', err);
      });

      find.on('complete', () => {
        resolve({ books, errors });
      });

      find.startSearch();
    });
  }
}
