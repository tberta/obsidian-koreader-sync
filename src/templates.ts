import { NoteType } from './constants';

export const DEFAULT_NOTE_TEMPLATE = `## Title: [[<%= it.bookPath %>|<%= it.title %>]]

### by: [[<%= it.authors.join(']], [[') %>]]

### Chapter: <%= it.chapter %>

Page: <%= it.page %>

> <%= it.highlightText.split('\\n').join('\\n> ') %>

<%= it.text %>`;

export const DEFAULT_BOOK_HIGHLIGHTS_TEMPLATE = `# <%= it.title %>

### by: [[<%= it.authors.join(']], [[') %>]]

<progress value="<%= it.percent_finished %>" max="100"> </progress>
<% let prevChapter = undefined; it.bookmarks.forEach(function(b) { if (b.chapter !== prevChapter) { prevChapter = b.chapter; -%>

---

### Chapter: <%= b.chapter %>

<% } %>

> <%= b.highlightText.split('\\n').join('\\n> ') %>


Page: <%= b.page %>

<% if (b.text) { %>

> [!note]
> <%= b.text.split('\\n').join('\\n> ') %>

<% } %><% }) %>`;

export const DEFAULT_DATAVIEW_TEMPLATE = `# Title: <%= it.data.title %>

<progress value="<%= it.metadata.percent_finished %>" max="100"> </progress>
\`\`\`dataviewjs
const title = dv.current()['koreader-sync'].metadata.managed_title
const pages = dv.pages().where(n => {
  return n['koreader-sync'] && n['koreader-sync'].type == '${NoteType.SINGLE_NOTE}' && n['koreader-sync'].metadata.managed_book_title == title
}).sort(p => p['koreader-sync'].data.page)
const groups = new Map()
pages.forEach(p => {
  const chapter = p['koreader-sync'].data.chapter || ''
  if (!groups.has(chapter)) groups.set(chapter, [])
  groups.get(chapter).push(p)
})
groups.forEach((highlights, chapter) => {
  if (chapter) dv.header(2, chapter)
  highlights.forEach(p => {
    const d = p['koreader-sync'].data
    const page = 'p. ' + d.page
    const link = dv.fileLink(p.file.path, false, 'open note')
    dv.paragraph('> ' + d.highlightText.split('\\n').join('\\n> '))
    dv.paragraph([page, link].join(' — '))
    dv.paragraph('---')
  })
})
\`\`\`
    `;
