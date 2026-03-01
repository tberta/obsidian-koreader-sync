import { App, Scope, TAbstractFile, TFile, TFolder } from 'obsidian';
import { MAX_SUGGESTIONS, BLUR_CLOSE_DELAY } from './constants';

abstract class AbstractSuggest<T extends TAbstractFile> {
  protected app: App;
  protected inputEl: HTMLInputElement;
  private suggestEl: HTMLElement;
  private items: T[] = [];
  private selectedIndex = 0;
  private scope: Scope;
  private isOpen = false;

  constructor(app: App, inputEl: HTMLInputElement) {
    this.app = app;
    this.inputEl = inputEl;
    this.scope = new Scope();
    this.suggestEl = document.body.createDiv('suggestion-container');

    this.scope.register([], 'ArrowUp', () => { this.setSelected(this.selectedIndex - 1); return false; });
    this.scope.register([], 'ArrowDown', () => { this.setSelected(this.selectedIndex + 1); return false; });
    this.scope.register([], 'Enter', () => { this.selectItem(this.selectedIndex); return false; });
    this.scope.register([], 'Escape', () => { this.close(); return false; });

    inputEl.addEventListener('input', this.onInput.bind(this));
    inputEl.addEventListener('focus', this.onInput.bind(this));
    inputEl.addEventListener('blur', () => setTimeout(() => this.close(), BLUR_CLOSE_DELAY));
  }

  protected abstract filter(f: TAbstractFile, query: string): f is T;
  protected abstract getDisplayText(item: T): string;

  protected onInput() {
    const query = this.inputEl.value.toLowerCase();
    this.items = this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is T => this.filter(f, query))
      .slice(0, MAX_SUGGESTIONS);

    if (this.items.length === 0) { this.close(); return; }
    this.render();
    if (!this.isOpen) this.open();
  }

  private render() {
    this.suggestEl.empty();
    const inner = this.suggestEl.createDiv('suggestion');
    this.items.forEach((item, i) => {
      const el = inner.createDiv('suggestion-item');
      el.setText(this.getDisplayText(item));
      el.addEventListener('mousedown', (e) => { e.preventDefault(); this.selectItem(i); });
    });
    this.setSelected(0);
  }

  private setSelected(index: number) {
    const items = this.suggestEl.querySelectorAll<HTMLElement>('.suggestion-item');
    if (items.length === 0) return;
    this.selectedIndex = ((index % items.length) + items.length) % items.length;
    items.forEach((el, i) => el.toggleClass('is-selected', i === this.selectedIndex));
    items[this.selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }

  private selectItem(index: number) {
    const item = this.items[index];
    if (item) {
      this.inputEl.value = this.getDisplayText(item);
      this.inputEl.trigger('input');
      this.close();
    }
  }

  private open() {
    (this.app as any).keymap.pushScope(this.scope);
    const rect = this.inputEl.getBoundingClientRect();
    this.suggestEl.style.cssText =
      `position:fixed;top:${rect.bottom}px;left:${rect.left}px;width:${rect.width}px;z-index:var(--layer-modal)`;
    document.body.appendChild(this.suggestEl);
    this.isOpen = true;
  }

  private close() {
    if (!this.isOpen) return;
    (this.app as any).keymap.popScope(this.scope);
    this.suggestEl.detach();
    this.isOpen = false;
  }
}

export class FolderSuggest extends AbstractSuggest<TFolder> {
  protected filter(f: TAbstractFile, query: string): f is TFolder {
    return f instanceof TFolder && f.path.toLowerCase().includes(query);
  }
  protected getDisplayText(item: TFolder): string { return item.path; }
}

export class FileSuggest extends AbstractSuggest<TFile> {
  protected onInput() {
    if (this.inputEl.disabled) return;
    super.onInput();
  }
  protected filter(f: TAbstractFile, query: string): f is TFile {
    return f instanceof TFile && f.extension === 'md' && f.path.toLowerCase().includes(query);
  }
  protected getDisplayText(item: TFile): string { return item.path; }
}
