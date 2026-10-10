// SmartPick Toolbar - Main toolbar controller

import { Editor, FileView, MarkdownView, Notice, Platform, View } from 'obsidian';
import type { EditorPosition, WorkspaceLeaf } from 'obsidian';
import type SmartPickPlugin from '../main';
import { ToolbarUI } from './ToolbarUI';
import { PdfToolbarIntegration } from './PdfToolbarIntegration';
import { DRAWING_PRIMITIVE_SELECTOR } from '../ui/icons';
import { t } from '../i18n';

export type SmartPickSelectionSource = 'markdown' | 'pdf' | null;

const TOOLBAR_DELAY_MS = 200;
const OUTSIDE_DISMISS_GUARD_MS = TOOLBAR_DELAY_MS + 50;

interface SavedSelectionRange {
  anchor: EditorPosition;
  head: EditorPosition;
}

export class Toolbar {
  private plugin: SmartPickPlugin;
  private ui: ToolbarUI;
  private isVisible: boolean = false;
  private debounceTimer: number | null = null;
  private currentEditor: Editor | null = null;
  private currentSelection: string = '';
  private currentSelectionRange: SavedSelectionRange | null = null;
  private currentSource: SmartPickSelectionSource = null;
  private savedPdfRange: Range | null = null;
  private currentPdfView: View | null = null;
  private pdfBar: PdfToolbarIntegration | null = null;
  private watchedEditorEl: HTMLElement | null = null;
  private outsidePointerDocument: Document | null = null;
  private hasSelection: boolean = false;
  private touchStartX: number = 0;
  private touchStartY: number = 0;
  private touchMoved: boolean = false;
  private ignoreSelectionChangeUntil: number = 0;

  constructor(plugin: SmartPickPlugin) {
    this.plugin = plugin;
    this.ui = new ToolbarUI(plugin, this);
  }

  init(): void {
    // Register selection change listener
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('active-leaf-change', () => {
        this.hide();
        this.attachEditorListeners();
      })
    );

    // Initial attach
    this.attachEditorListeners();
    this.attachPdfListeners();

    // PDF 顶栏常驻按钮（原生 PDF 阅读器 `.pdf-toolbar-right`）。
    this.pdfBar = new PdfToolbarIntegration(this.plugin, this);
    this.pdfBar.init();

    // Global ESC listener
    activeDocument.addEventListener('keydown', this.handleKeyDown);

    // 在捕获阶段处理编辑器外点击，避免 CodeMirror 停止冒泡后无法关闭工具栏。
    activeDocument.addEventListener('mousedown', this.handleClickOutside, true);
    // PDF 阅读器内滚动时关闭工具栏，避免悬浮位置过期。
    activeDocument.addEventListener('scroll', this.handlePdfScrollHide, true);

    if (Platform.isMobile) {
      activeDocument.addEventListener('selectionchange', this.handleDocumentSelectionChange);
      activeDocument.addEventListener('touchstart', this.handleTouchOutside, { passive: true });
    }
  }

  private attachEditorListeners(): void {
    // Cleanup previous listeners
    if (this.watchedEditorEl) {
      this.watchedEditorEl.removeEventListener('mouseup', this.handleSelectionChange);
      this.watchedEditorEl.removeEventListener('keyup', this.handleSelectionChange);
      this.watchedEditorEl.removeEventListener('dblclick', this.handleDoubleClick);
      this.watchedEditorEl.removeEventListener('touchstart', this.handleTouchStart);
      this.watchedEditorEl.removeEventListener('touchmove', this.handleTouchMove);
      this.watchedEditorEl.removeEventListener('touchend', this.handleTouchEnd);
      this.watchedEditorEl = null;
    }

    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;

    const editor = view.editor;
    if (!editor) return;

    // Listen to selection changes via DOM
    const editorEl = view.contentEl.querySelector('.cm-content');
    if (editorEl) {
      this.watchedEditorEl = editorEl as HTMLElement;
      this.bindDesktopOutsidePointerListener(this.watchedEditorEl.ownerDocument);
      this.watchedEditorEl.addEventListener('mouseup', this.handleSelectionChange);
      this.watchedEditorEl.addEventListener('keyup', this.handleSelectionChange);
      this.watchedEditorEl.addEventListener('dblclick', this.handleDoubleClick);
      if (Platform.isMobile) {
        this.watchedEditorEl.addEventListener('touchstart', this.handleTouchStart, { passive: true });
        this.watchedEditorEl.addEventListener('touchmove', this.handleTouchMove, { passive: true });
        this.watchedEditorEl.addEventListener('touchend', this.handleTouchEnd);
      }
    }
  }

  private attachPdfListeners(): void {
    // PDF 使用原生 DOM 选区，全局监听一次即可（Markdown 走编辑器局部监听）。
    activeDocument.addEventListener('mouseup', this.handlePdfMouseUp);
    activeDocument.addEventListener('keyup', this.handlePdfKeyUp);
    activeDocument.addEventListener('touchend', this.handlePdfTouchEnd);
    if (!Platform.isMobile) {
      this.bindDesktopOutsidePointerListener(activeDocument);
    }
  }

  private detachPdfListeners(): void {
    activeDocument.removeEventListener('mouseup', this.handlePdfMouseUp);
    activeDocument.removeEventListener('keyup', this.handlePdfKeyUp);
    activeDocument.removeEventListener('touchend', this.handlePdfTouchEnd);
  }

  private getActivePdfView(): FileView | null {
    const view = this.plugin.app.workspace.getActiveViewOfType(FileView);
    if (!view) return null;
    // MarkdownView 同样继承自 FileView，必须排除。
    if (view instanceof MarkdownView) return null;
    const file = view.file;
    if (file?.extension?.toLowerCase() === 'pdf') return view;
    try {
      const viewType = view.getViewType?.();
      if (viewType === 'pdf') return view;
    } catch {
      // ignore
    }
    return null;
  }

  private getPdfHostEl(view: View): HTMLElement | null {
    const withContent = view as View & { contentEl?: HTMLElement; containerEl?: HTMLElement };
    return withContent.contentEl ?? withContent.containerEl ?? null;
  }

  private getPdfSelection(): { text: string; range: Range; rect: DOMRect; view: FileView } | null {
    const pdfView = this.getActivePdfView();
    if (!pdfView) return null;
    const hostEl = this.getPdfHostEl(pdfView);
    if (!hostEl) return null;

    const selection = activeWindow.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const text = selection.toString();
    if (!text || text.trim().length === 0) return null;

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (!anchorNode || !focusNode) return null;
    if (!hostEl.contains(anchorNode) || !hostEl.contains(focusNode)) return null;

    // 忽略工具栏自身内部的选区。
    const range = selection.getRangeAt(0);
    const common = range.commonAncestorContainer;
    const commonEl = common instanceof HTMLElement ? common : common.parentElement;
    if (commonEl?.closest?.('.smartpick-toolbar')) return null;

    let rect: DOMRect | null = null;
    try {
      rect = range.getBoundingClientRect();
    } catch {
      return null;
    }
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;

    return { text, range, rect, view: pdfView };
  }

  private getPdfSelectionCoords(
    view: View,
    rect: DOMRect
  ): {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    isMultiLine: boolean;
    textLeft: number;
    textWidth: number;
  } | null {
    try {
      const hostEl = this.getPdfHostEl(view);
      if (!hostEl) return null;
      const containerRect = hostEl.getBoundingClientRect();
      // 选区完全滚出可视区域时不显示。
      if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) return null;
      if (rect.right <= containerRect.left || rect.left >= containerRect.right) return null;

      return {
        left: rect.left - containerRect.left,
        top: rect.top - containerRect.top,
        right: rect.right - containerRect.left,
        bottom: rect.bottom - containerRect.top,
        width: containerRect.width,
        isMultiLine: rect.height > 20 * 1.5,
        textLeft: 0,
        textWidth: containerRect.width,
      };
    } catch {
      return null;
    }
  }

  private handlePdfMouseUp = (e: MouseEvent): void => {
    if (this.shouldIgnoreSelectionChange()) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('.smartpick-toolbar')) return;
    if (!this.getActivePdfView()) return;
    // Markdown 视图激活时交给编辑器监听处理，避免重复。
    if (this.plugin.app.workspace.getActiveViewOfType(MarkdownView)) return;

    let modifierActive = false;
    if (this.plugin.settings.enableModifierKeyTrigger) {
      modifierActive = this.checkEventModifier(e);
    }
    this.schedulePdfSelectionCheck(modifierActive);
  };

  private handlePdfKeyUp = (e: KeyboardEvent): void => {
    if (this.shouldIgnoreSelectionChange()) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('.smartpick-toolbar')) return;
    if (!this.getActivePdfView()) return;
    if (this.plugin.app.workspace.getActiveViewOfType(MarkdownView)) return;
    this.schedulePdfSelectionCheck(false);
  };

  private handlePdfTouchEnd = (): void => {
    if (this.ui.isMenuLocked()) return;
    if (this.shouldIgnoreSelectionChange()) return;
    if (!this.getActivePdfView()) return;
    if (this.plugin.app.workspace.getActiveViewOfType(MarkdownView)) return;
    this.schedulePdfSelectionCheck(false);
  };

  private handlePdfScrollHide = (e: Event): void => {
    if (!this.isVisible || this.currentSource !== 'pdf') return;
    const target = e.target as HTMLElement | null;
    const pdfView = this.currentPdfView;
    if (!pdfView) return;
    const hostEl = this.getPdfHostEl(pdfView);
    if (hostEl && target instanceof Node && hostEl.contains(target)) {
      this.hide();
    }
  };

  private schedulePdfSelectionCheck(modifierActive: boolean = false): void {
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = window.setTimeout(() => {
      this.checkPdfSelection(modifierActive);
    }, TOOLBAR_DELAY_MS);
  }

  private checkPdfSelection(modifierActive?: boolean): void {
    if (this.ui.isMenuLocked()) return;

    const info = this.getPdfSelection();
    if (!info) {
      if (this.currentSource === 'pdf') this.hide();
      return;
    }

    if (this.plugin.settings.enableModifierKeyTrigger && !Platform.isMobile) {
      if (!modifierActive) {
        if (this.currentSource === 'pdf') this.hide();
        return;
      }
    }

    this.bindDesktopOutsidePointerListener(info.view.contentEl.ownerDocument);
    this.showForPdf(info.view, info.text, info.range, info.rect);
  }

  private showForPdf(view: FileView, text: string, range: Range, rect: DOMRect): void {
    if (this.ui.isMenuLocked()) return;

    this.currentEditor = null;
    this.currentSelection = text;
    this.currentSelectionRange = null;
    this.currentSource = 'pdf';
    this.currentPdfView = view;
    try {
      this.savedPdfRange = range.cloneRange();
    } catch {
      this.savedPdfRange = null;
    }
    this.hasSelection = true;

    const pos = this.getPdfSelectionCoords(view, rect);
    const hostEl = this.getPdfHostEl(view);
    if (pos && hostEl) {
      this.ui.show(pos, true, hostEl);
      this.isVisible = true;
    } else {
      this.hide();
    }
  }

  /**
   * PDF 顶栏 SmartPick 按钮入口：在指定 leaf 内查找当前 PDF 文选并弹出浮动工具栏。
   * 点顶栏按钮时浏览器可能已经清掉选区，因此先读实时选区，再兜底复用最近一次
   * 保存的 PDF 选区；都没有则提示先选中文本。
   */
  showToolbarFromPdfBarClick(leaf?: WorkspaceLeaf | null): boolean {
    if (this.ui.isMenuLocked()) return false;

    const scoped = leaf ? this.getPdfSelectionInLeaf(leaf) : null;
    const active = scoped ?? this.getPdfSelection();
    if (active) {
      this.bindDesktopOutsidePointerListener(active.view.contentEl.ownerDocument);
      this.showForPdf(active.view, active.text, active.range, active.rect);
      return true;
    }

    // 兜底：点击按钮导致选区刚丢失时，复用内存中的选区快照。
    if (this.currentSource === 'pdf' && this.currentSelection && this.savedPdfRange && this.currentPdfView) {
      try {
        const rect = this.savedPdfRange.getBoundingClientRect();
        if (rect && (rect.width !== 0 || rect.height !== 0)) {
          const hostEl = this.getPdfHostEl(this.currentPdfView);
          const pos = this.getPdfSelectionCoords(this.currentPdfView, rect);
          if (pos && hostEl) {
            this.ui.show(pos, true, hostEl);
            this.isVisible = true;
            return true;
          }
        }
      } catch {
        // fall through to notice
      }
    }

    new Notice(t('noSelection'));
    return false;
  }

  private getPdfSelectionInLeaf(
    leaf: WorkspaceLeaf
  ): { text: string; range: Range; rect: DOMRect; view: FileView } | null {
    try {
      const view = leaf.view as unknown as FileView | null;
      if (!view) return null;
      const withEl = view as unknown as { contentEl?: HTMLElement; containerEl?: HTMLElement };
      const scopeEl = withEl.containerEl ?? withEl.contentEl;
      if (!scopeEl) return null;

      const selection = activeWindow.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
      const text = selection.toString();
      if (!text || text.trim().length === 0) return null;

      const anchorNode = selection.anchorNode;
      const focusNode = selection.focusNode;
      if (!anchorNode || !focusNode) return null;
      if (!scopeEl.contains(anchorNode) || !scopeEl.contains(focusNode)) return null;

      const range = selection.getRangeAt(0);
      const common = range.commonAncestorContainer;
      const commonEl = common instanceof HTMLElement ? common : common.parentElement;
      if (commonEl?.closest?.('.smartpick-toolbar')) return null;

      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return null;

      return { text, range, rect, view };
    } catch {
      return null;
    }
  }
  private bindDesktopOutsidePointerListener(ownerDocument: Document): void {
    if (Platform.isMobile || this.outsidePointerDocument === ownerDocument) return;

    this.outsidePointerDocument?.removeEventListener('pointerdown', this.handlePointerDownOutside, true);
    ownerDocument.addEventListener('pointerdown', this.handlePointerDownOutside, true);
    this.outsidePointerDocument = ownerDocument;
  }

  private handleSelectionChange = (e: MouseEvent | KeyboardEvent): void => {
    if (this.shouldIgnoreSelectionChange()) return;

    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
    }

    let modifierActive = false;
    if (this.plugin.settings.enableModifierKeyTrigger) {
      modifierActive = this.checkEventModifier(e);
    }

    this.scheduleSelectionCheck(modifierActive);
  };

  private scheduleSelectionCheck(modifierActive: boolean = false): void {
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = window.setTimeout(() => {
      this.checkSelection(modifierActive);
    }, TOOLBAR_DELAY_MS);
  }

  private handleTouchStart = (e: TouchEvent): void => {
    const touch = e.touches[0];
    if (!touch) return;
    this.touchStartX = touch.clientX;
    this.touchStartY = touch.clientY;
    this.touchMoved = false;
  };

  private handleTouchMove = (e: TouchEvent): void => {
    const touch = e.touches[0];
    if (!touch) return;
    const deltaX = Math.abs(touch.clientX - this.touchStartX);
    const deltaY = Math.abs(touch.clientY - this.touchStartY);
    if (deltaX > 8 || deltaY > 8) {
      this.touchMoved = true;
    }
  };

  private handleTouchEnd = (): void => {
    if (this.ui.isMenuLocked()) return;
    if (this.shouldIgnoreSelectionChange()) return;
    if (this.touchMoved) return;
    this.scheduleSelectionCheck(false);
  };

  private handleDocumentSelectionChange = (): void => {
    if (this.ui.isMenuLocked()) return;
    if (this.shouldIgnoreSelectionChange()) return;

    const activeElement = activeDocument.activeElement;
    if (activeElement?.closest('.smartpick-toolbar')) return;

    const selection = activeWindow.getSelection();
    if (!selection || selection.toString().trim().length === 0) return;
    // Markdown 与 PDF 共用移动端 selectionchange：按当前激活视图分发。
    if (this.plugin.app.workspace.getActiveViewOfType(MarkdownView)) {
      this.scheduleSelectionCheck(false);
    } else if (this.getActivePdfView()) {
      this.schedulePdfSelectionCheck(false);
    } else {
      this.scheduleSelectionCheck(false);
    }
  };

  private handleDoubleClick = (e: MouseEvent): void => {
    if (this.shouldIgnoreSelectionChange()) return;

    // Check if double-click trigger is enabled
    if (!this.plugin.settings.enableDoubleClickTrigger) return;

    // Don't trigger if clicking on the toolbar itself
    const target = e.target as HTMLElement;
    if (target.closest('.smartpick-toolbar')) return;

    // Cancel any pending selection check to avoid conflict
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
    }

    // Use a short delay to let the browser's native double-click selection complete
    window.setTimeout(() => {
      this.showAtCurrentPosition();
    }, 50);
  };

  private showAtCurrentPosition(): void {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      // PDF 双击由 mouseup 兜底，这里无需处理。
      this.checkPdfSelection(false);
      return;
    }

    const editor = view.editor;
    this.currentEditor = editor;
    this.currentSource = 'markdown';
    this.savedPdfRange = null;
    this.currentPdfView = null;

    const selection = editor.getSelection();
    if (selection && selection.trim().length > 0) {
      // Double-click selected a word — show toolbar with selection
      this.currentSelection = selection;
      this.hasSelection = true;
      this.show(editor, view);
    } else {
      // Double-click on empty area — show toolbar at cursor position
      this.currentSelection = '';
      this.hasSelection = false;
      const pos = this.getCursorCoords(editor, view);
      if (pos) {
        this.ui.show(pos, false);
        this.isVisible = true;
      }
    }
  }

  private checkSelection(modifierActive?: boolean): void {
    if (this.ui.isMenuLocked()) return;

    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      // 当前可能是原生 PDF 阅读器，交给 PDF 流程处理。
      this.checkPdfSelection(modifierActive);
      return;
    }

    const editor = view.editor;
    const selection = editor.getSelection();

    if (selection && selection.toString().trim().length > 0) {
      this.currentEditor = editor;
      this.currentSelection = selection.toString();
      this.currentSource = 'markdown';
      this.savedPdfRange = null;
      this.currentPdfView = null;
      this.hasSelection = true;
      
      if (this.plugin.settings.enableModifierKeyTrigger && !Platform.isMobile) {
        if (modifierActive) {
          this.show(editor, view);
        } else {
          this.hide();
        }
      } else {
        this.show(editor, view);
      }
    } else {
      this.hide();
    }
  }

  private show(editor: Editor, view: MarkdownView): void {
    if (this.ui.isMenuLocked()) return;

    this.saveCurrentSelectionRange(editor);
    this.currentSource = 'markdown';
    this.savedPdfRange = null;
    this.currentPdfView = null;

    const pos = this.getSelectionCoords(editor, view);
    if (pos) {
      this.ui.show(pos, true);
      this.isVisible = true;
    } else {
      this.hide();
    }
  }

  hide(): void {
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.isVisible) {
      this.ui.hide();
      this.isVisible = false;
    }
  }

  private getSelectionCoords(
    editor: Editor, 
    view: MarkdownView
  ): {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    isMultiLine: boolean;
    textLeft: number;
    textWidth: number;
  } | null {
    try {
      // Interface for accessing internal CodeMirror 6 editor
      interface EditorWithCM {
        cm?: {
          coordsAtPos(pos: number, bias?: number): { left: number; right: number; top: number; bottom: number } | null;
        };
      }
      const cmEditor = (editor as unknown as EditorWithCM).cm;
      
      if (!cmEditor) return null;

      const selection = editor.listSelections()[0];
      if (!selection) return null;

      const anchorOffset = editor.posToOffset(selection.anchor);
      const headOffset = editor.posToOffset(selection.head);
      const anchorCoords = cmEditor.coordsAtPos(anchorOffset);
      const headCoords = cmEditor.coordsAtPos(headOffset);
      if (!anchorCoords || !headCoords) return null;

      const containerRect = view.contentEl.getBoundingClientRect();
      const textRect = view.contentEl.querySelector<HTMLElement>('.cm-content')?.getBoundingClientRect();

      // 多行选区跟随用户最后拖动且当前可见的活动端点。
      if (headCoords.bottom <= containerRect.top || headCoords.top >= containerRect.bottom) {
        return null;
      }

      return {
        // 水平边界必须覆盖 anchor 和 head，不能只使用活动端点。
        left: Math.min(anchorCoords.left, headCoords.left) - containerRect.left,
        top: headCoords.top - containerRect.top,
        right: Math.max(anchorCoords.right, headCoords.right) - containerRect.left,
        bottom: headCoords.bottom - containerRect.top,
        width: containerRect.width,
        isMultiLine: anchorCoords.top !== headCoords.top,
        textLeft: (textRect?.left ?? containerRect.left) - containerRect.left,
        textWidth: textRect?.width ?? containerRect.width,
      };
    } catch {
      return null;
    }
  }

  private getCursorCoords(
    editor: Editor,
    view: MarkdownView
  ): { left: number; top: number; right: number; bottom: number; width: number } | null {
    try {
      interface EditorWithCM {
        cm?: {
          coordsAtPos(pos: number, bias?: number): { left: number; right: number; top: number; bottom: number } | null;
        };
      }
      const cmEditor = (editor as unknown as EditorWithCM).cm;
      if (!cmEditor) return null;

      const cursor = editor.getCursor();
      const offset = editor.posToOffset(cursor);
      const coords = cmEditor.coordsAtPos(offset);
      if (!coords) return null;

      const containerRect = view.contentEl.getBoundingClientRect();

      return {
        left: coords.left - containerRect.left,
        top: coords.top - containerRect.top,
        right: coords.right - containerRect.left,
        bottom: coords.bottom - containerRect.top,
        width: containerRect.width
      };
    } catch {
      return null;
    }
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.isVisible) {
      this.hide();
    }
  };

  private checkEventModifier(e: MouseEvent | KeyboardEvent): boolean {
    const config = this.plugin.settings.modifierKey || 'CmdOrCtrl';
    
    if (config === 'CmdOrCtrl') {
      return Platform.isMacOS ? e.metaKey : e.ctrlKey;
    }
    
    if (config === 'Control') {
      return e.ctrlKey;
    }
    
    if (config === 'Meta') {
      return e.metaKey;
    }
    
    if (config === 'Alt') {
      return e.altKey;
    }
    
    if (config === 'Shift') {
      return e.shiftKey;
    }
    
    return false;
  }

  private handleClickOutside = (e: MouseEvent): void => {
    if (!this.isVisible) return;
    
    const target = e.target as HTMLElement;
    if (this.markToolbarInteraction(target)) return;

    this.dismissAfterOutsideInteraction();
  };

  private handlePointerDownOutside = (e: PointerEvent): void => {
    if (!this.isVisible || e.pointerType !== 'mouse') return;

    const target = e.target as HTMLElement;
    if (this.markToolbarInteraction(target)) return;

    this.dismissAfterOutsideInteraction();
  };

  private handleTouchOutside = (e: TouchEvent): void => {
    if (!this.isVisible) return;

    const target = e.target as HTMLElement;
    if (this.markToolbarInteraction(target)) return;

    this.dismissAfterOutsideInteraction();
  };

  private dismissAfterOutsideInteraction(): void {
    // 忽略同一次点击随后触发的 mouseup/touchend，避免隐藏后立刻重开。
    this.ignoreSelectionChangeUntil = activeWindow.performance.now() + OUTSIDE_DISMISS_GUARD_MS;
    this.hide();
  }

  private markToolbarInteraction(target: HTMLElement): boolean {
    if (!target.closest('.smartpick-toolbar')) return false;

    // iOS 点浮动按钮会触发 selectionchange；短暂忽略，避免更多菜单刚打开又被重渲染收起。
    this.ignoreSelectionChangeUntil = activeWindow.performance.now() + 500;
    return true;
  }

  private shouldIgnoreSelectionChange(): boolean {
    return activeWindow.performance.now() < this.ignoreSelectionChangeUntil;
  }

  private saveCurrentSelectionRange(editor: Editor): void {
    const selection = editor.listSelections()[0];
    if (!selection) return;

    this.currentSelectionRange = {
      anchor: { ...selection.anchor },
      head: { ...selection.head },
    };
  }

  restoreCurrentSelection(): void {
    if (!this.currentSelection) return;

    this.ignoreSelectionChangeUntil = activeWindow.performance.now() + 500;

    // PDF：恢复原生 DOM 选区（点击工具栏按钮会使选区丢失时使用）。
    if (this.currentSource === 'pdf' && this.savedPdfRange) {
      try {
        const selection = activeWindow.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(this.savedPdfRange.cloneRange());
      } catch {
        // ignore restore failures
      }
      return;
    }

    if (!this.currentEditor || !this.currentSelectionRange) return;

    this.currentEditor.focus();
    this.currentEditor.setSelection(
      this.currentSelectionRange.anchor,
      this.currentSelectionRange.head
    );
  }

  getCurrentSelection(): string {
    return this.currentSelection;
  }

  getCurrentEditor(): Editor | null {
    return this.currentEditor;
  }

  getCurrentSource(): SmartPickSelectionSource {
    return this.currentSource;
  }

  isPdfContext(): boolean {
    return this.currentSource === 'pdf';
  }

  /** Runtime diagnostics for the on-device "Diagnose toolbar icons" command. */
  getDebugLines(): string[] {
    const lines = [
      `sel=${this.currentSelection.length} src=${this.currentSource ?? 'none'} visible=${this.isVisible ? 1 : 0}`,
    ];
    const bars = activeDocument.querySelectorAll('.smartpick-toolbar');
    lines.push(`bars=${bars.length}`);
    bars.forEach((bar, i) => {
      const btns = bar.querySelectorAll('button.smartpick-toolbar-button');
      let svg = 0;
      let prim = 0;
      let txt = 0;
      let empty = 0;
      btns.forEach((b) => {
        const s = b.querySelector('svg');
        if (s) svg++;
        if (s?.querySelector(DRAWING_PRIMITIVE_SELECTOR)) prim++;
        if (b.querySelector('.smartpick-icon-fallback-text')) txt++;
        if (!s && !b.querySelector('.smartpick-icon-fallback-text') && ((b.textContent ?? '').trim() === '')) empty++;
      });
      const shown = (bar as HTMLElement).offsetParent !== null ? 1 : 0;
      lines.push(`bar${i}: btns=${btns.length} svg=${svg} prim=${prim} txt=${txt} empty=${empty} shown=${shown}`);
    });
    return lines;
  }

  getHasSelection(): boolean {
    return this.hasSelection;
  }

  destroy(): void {
    if (this.watchedEditorEl) {
      this.watchedEditorEl.removeEventListener('mouseup', this.handleSelectionChange);
      this.watchedEditorEl.removeEventListener('keyup', this.handleSelectionChange);
      this.watchedEditorEl.removeEventListener('dblclick', this.handleDoubleClick);
      this.watchedEditorEl.removeEventListener('touchstart', this.handleTouchStart);
      this.watchedEditorEl.removeEventListener('touchmove', this.handleTouchMove);
      this.watchedEditorEl.removeEventListener('touchend', this.handleTouchEnd);
      this.watchedEditorEl = null;
    }
    this.detachPdfListeners();
    this.pdfBar?.destroy();
    this.pdfBar = null;
    activeDocument.removeEventListener('keydown', this.handleKeyDown);
    activeDocument.removeEventListener('mousedown', this.handleClickOutside, true);
    activeDocument.removeEventListener('scroll', this.handlePdfScrollHide, true);
    activeDocument.removeEventListener('selectionchange', this.handleDocumentSelectionChange);
    activeDocument.removeEventListener('touchstart', this.handleTouchOutside);
    this.outsidePointerDocument?.removeEventListener('pointerdown', this.handlePointerDownOutside, true);
    this.outsidePointerDocument = null;
    this.ui.destroy();
  }
}
