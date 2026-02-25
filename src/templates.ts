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
<% it.bookmarks.forEach(function(b) { %>
---

### Chapter: <%= b.chapter %>

Page: <%= b.page %>

> <%= b.highlightText.split('\\n').join('\\n> ') %>

<% if (b.text) { %>

> [!note]
> <%= b.text.split('\\n').join('\\n> ') %>

<% } %>
<% }) %>`;

export const DEFAULT_DATAVIEW_TEMPLATE = `# Title: <%= it.data.title %>

<progress value="<%= it.metadata.percent_finished %>" max="100"> </progress>
\`\`\`dataviewjs
const title = dv.current()['koreader-sync'].metadata.managed_title
dv.pages().where(n => {
return n['koreader-sync'] && n['koreader-sync'].type == '${NoteType.SINGLE_NOTE}' && n['koreader-sync'].metadata.managed_book_title == title
}).sort(p => p['koreader-sync'].data.page).forEach(p => dv.paragraph('![[' + p.file.path + ']]'))
\`\`\`
    `;
