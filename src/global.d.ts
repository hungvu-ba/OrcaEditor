declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it';
  const plugin: (md: MarkdownIt, options?: { enabled?: boolean; label?: boolean; labelAfter?: boolean }) => void;
  export default plugin;
}

declare module 'markdown-it-front-matter' {
  import type MarkdownIt from 'markdown-it';
  const plugin: (md: MarkdownIt, cb: (frontMatter: string) => void) => void;
  export default plugin;
}

declare module '@vscode/markdown-it-katex' {
  import type MarkdownIt from 'markdown-it';
  const plugin: (md: MarkdownIt, options?: Record<string, unknown>) => void;
  export default plugin;
}

declare module '@mixmark-io/domino' {
  export function createDocument(html?: string, force?: boolean): Document;
  export function createWindow(html?: string): Window & { document: Document };
}

declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  export function gfm(service: TurndownService): void;
  export function tables(service: TurndownService): void;
  export function strikethrough(service: TurndownService): void;
  export function taskListItems(service: TurndownService): void;
  export function highlightedCodeBlock(service: TurndownService): void;
}
