// SmartPick PDF toolbar integration - injects a SmartPick button into the
// native Obsidian PDF viewer top bar (`.pdf-toolbar-right`).
//
// The floating selection toolbar can be clipped or missed inside the PDF
// viewer, so a persistent button in the PDF bar gives users a reliable entry
// point: click it while text is selected in the PDF and the SmartPick floating
// toolbar appears anchored to that selection.
//
// Implementation follows the pattern used by community PDF plugins (e.g. the
// MutationObserver + `getLeavesOfType('pdf')` sync approach): the native PDF
// viewer re-renders its DOM on zoom/scroll, so the button is re-injected
// whenever the leaf DOM changes.

import { WorkspaceLeaf } from 'obsidian';
import { setIconWithFallback } from '../ui/icons';
import type SmartPickPlugin from '../main';
import type { Toolbar } from './Toolbar';

const PDF_BAR_BUTTON_CLS = 'smartpick-pdf-bar-button';
const SYNC_DEBOUNCE_MS = 80;

class PdfLeafController {
  private plugin: SmartPickPlugin;
  private toolbar: Toolbar;
  private leaf: WorkspaceLeaf;
  private observer: MutationObserver | null = null;
  private syncTimer: number | null = null;
  private barButtonEl: HTMLElement | null = null;

  constructor(plugin: SmartPickPlugin, toolbar: Toolbar, leaf: WorkspaceLeaf) {
    this.plugin = plugin;
    this.toolbar = toolbar;
    this.leaf = leaf;
  }

  getRootEl(): HTMLElement | null {
    try {
      const view = this.leaf.view as unknown as {
        containerEl?: HTMLElement;
      } | null;
      return view?.containerEl ?? null;
    } catch {
      return null;
    }
  }

  sync(): void {
    const root = this.getRootEl();
    if (!root) return;
    this.ensureObserver(root);
    this.syncBarButton(root);
  }

  private scheduleSync(): void {
    if (this.syncTimer) {
      window.clearTimeout(this.syncTimer);
    }
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      try {
        this.sync();
      } catch {
        // ignore sync failures (leaf may be detaching)
      }
    }, SYNC_DEBOUNCE_MS);
  }

  private ensureObserver(root: HTMLElement): void {
    if (this.observer) return;
    this.observer = new MutationObserver((mutations) => {
      if (this.shouldIgnoreMutations(mutations)) return;
      this.scheduleSync();
    });
    this.observer.observe(root, { childList: true, subtree: true });
  }

  private shouldIgnoreMutations(mutations: MutationRecord[]): boolean {
    return mutations.every((mutation) => {
      const nodes: Node[] = [
        mutation.target,
        ...Array.from(mutation.addedNodes || []),
        ...Array.from(mutation.removedNodes || []),
      ].filter(Boolean);
      return nodes.every((node) => {
        const element = node instanceof Element ? node : node.parentElement;
        return Boolean(element?.closest?.(`.${PDF_BAR_BUTTON_CLS}`));
      });
    });
  }

  private syncBarButton(root: HTMLElement): void {
    const toolbarRight = root.querySelector<HTMLElement>('.pdf-toolbar-right');
    if (!toolbarRight) return;

    if (this.barButtonEl && toolbarRight.contains(this.barButtonEl)) return;

    this.barButtonEl?.remove();
    this.barButtonEl = toolbarRight.createEl('div', {
      cls: ['clickable-icon', PDF_BAR_BUTTON_CLS],
      attr: { 'aria-label': 'SmartPick' },
    });
    setIconWithFallback(this.barButtonEl, 'sparkles', 'SmartPick');

    // mousedown/pointerdown 会默认清除 PDF 文选，先 preventDefault 保住选区。
    this.barButtonEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
    });
    this.barButtonEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
    this.barButtonEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toolbar.showToolbarFromPdfBarClick(this.leaf);
    });
  }

  destroy(): void {
    if (this.syncTimer) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.barButtonEl?.remove();
    this.barButtonEl = null;
  }
}

export class PdfToolbarIntegration {
  private plugin: SmartPickPlugin;
  private toolbar: Toolbar;
  private controllers = new Map<WorkspaceLeaf, PdfLeafController>();

  constructor(plugin: SmartPickPlugin, toolbar: Toolbar) {
    this.plugin = plugin;
    this.toolbar = toolbar;
  }

  init(): void {
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('layout-change', () => this.sync())
    );
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('active-leaf-change', () => this.sync())
    );
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('file-open', () => this.sync())
    );
    this.plugin.registerInterval(window.setInterval(() => this.sync(), 1500));
    this.sync();
  }

  sync(): void {
    let pdfLeaves: WorkspaceLeaf[];
    try {
      pdfLeaves = this.plugin.app.workspace.getLeavesOfType('pdf');
    } catch {
      return;
    }

    const alive = new Set(pdfLeaves);
    for (const [leaf, controller] of this.controllers) {
      if (!alive.has(leaf)) {
        try {
          controller.destroy();
        } catch {
          // ignore
        }
        this.controllers.delete(leaf);
      }
    }

    for (const leaf of pdfLeaves) {
      let controller = this.controllers.get(leaf);
      if (!controller) {
        controller = new PdfLeafController(this.plugin, this.toolbar, leaf);
        this.controllers.set(leaf, controller);
      }
      try {
        controller.sync();
      } catch {
        // ignore sync failures (leaf may be detaching)
      }
    }
  }

  destroy(): void {
    for (const controller of this.controllers.values()) {
      try {
        controller.destroy();
      } catch {
        // ignore
      }
    }
    this.controllers.clear();
  }
}
