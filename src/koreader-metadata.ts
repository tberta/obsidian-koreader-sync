import * as fs from 'fs';
import * as path from 'path';

import finder from 'node-find-files';
import { parse } from 'lua-json';
import { Books } from './types';

export class KOReaderMetadata {
  koreaderBasePath: string;

  constructor(koreaderBasePath: string) {
    this.koreaderBasePath = koreaderBasePath;
  }

  public async scan(): Promise<Books> {
    const metadatas: any = {};
    return new Promise((resolve, reject) => {
      const find = new finder({
        rootFolder: this.koreaderBasePath,
      });
      find.on('match', (file: string) => {
        const filename = path.parse(file).base;
        if (filename.match(/metadata\..*\.lua$/)) {
          try {
            const content = fs.readFileSync(file, 'utf8');
            const jsonMetadata: any = parse(content);
            const { bookmarks, annotations, doc_props, percent_finished } =
              jsonMetadata;

            const sdrFallback = path.basename(path.dirname(file)).replace(/\.sdr$/, '');
            const title = doc_props?.title || sdrFallback;
            const authors = doc_props?.authors || 'Unknown';

            if (!title) {
              // sdrFallback is always non-empty (it is the directory name), so this
              // branch is only reached if path.dirname returns something unexpected.
              console.warn(`KOReader: skipping ${file} - could not determine title`);
              return;
            }
            if (!doc_props?.title) {
              console.warn(`KOReader: no title in doc_props for ${file}, using folder name: "${sdrFallback}"`);
            }

            let normalizedBookmarks: any = null;

            // New format (KOReader >= ~2024): highlights stored under "annotations".
            // Each entry has: text (highlight), pageno (int page), chapter, datetime,
            // pos0, pos1. There is no pre-formatted text string.
            if (annotations && Object.keys(annotations).length) {
              normalizedBookmarks = {};
              for (const key of Object.keys(annotations)) {
                const ann = annotations[key];
                normalizedBookmarks[key] = {
                  chapter: ann.chapter || '',
                  // text is intentionally left empty: createNote() treats an empty
                  // text as "new format" and reads the page from bookmark.page instead.
                  text: '',
                  notes: ann.text || '',       // highlight text lives in "text"
                  datetime: ann.datetime || '',
                  highlighted: true,
                  pos0: ann.pos0 || '',
                  pos1: ann.pos1 || '',
                  page: String(ann.pageno ?? -1), // pageno is the integer page number
                };
              }
            }
            // Old format: highlights stored under "bookmarks".
            else if (bookmarks && Object.keys(bookmarks).length) {
              normalizedBookmarks = bookmarks;
            }

            if (normalizedBookmarks && Object.keys(normalizedBookmarks).length) {
              metadatas[`${title} - ${authors}`] = {
                title,
                authors: authors || 'Unknown',
                bookmarks: normalizedBookmarks,
                percent_finished: (percent_finished || 0) * 100,
              };
            }
          } catch (e) {
            console.error(`KOReader: failed to parse ${file}:`, e);
          }
        }
      });
      find.on('error', (err: any) => {
        // Log but do not reject — a single traversal error should not abort the
        // entire scan. The 'complete' event will still fire after all reachable
        // files have been processed.
        console.error('KOReader: file search error:', err);
      });
      find.on('complete', () => {
        resolve(metadatas);
      });
      find.startSearch();
    });
  }
}
