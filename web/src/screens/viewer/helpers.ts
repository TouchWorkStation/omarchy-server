// Small pure helpers for the file viewer, shared by tests and React components.
import type { Marked } from "marked";

export type LinkAction =
  | { kind: "anchor"; id: string }
  | { kind: "external"; url: string }
  | { kind: "mailto" }
  | { kind: "ignore" };

type LinkElementLike = {
  getAttribute: (name: string) => string | null;
};

type AnchorTargetLike = {
  id?: string;
  getAttribute?: (name: string) => string | null;
  scrollIntoView?: (options?: ScrollIntoViewOptions) => void;
};

type ContainerLike = {
  querySelectorAll?: (selector: string) => Iterable<AnchorTargetLike>;
};

type EventTargetLike = {
  closest?: (selector: string) => LinkElementLike | null;
  parentElement?: { closest?: (selector: string) => LinkElementLike | null } | null;
};

export type DocumentClickEventLike = {
  target: EventTarget | EventTargetLike | null;
  currentTarget: EventTarget | ContainerLike | null;
  preventDefault: () => void;
};

const decodeBasicEntities = (s: string) =>
  s
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");

export function headingSlug(htmlOrText: string, seen: Map<string, number>): string {
  const plain = decodeBasicEntities(htmlOrText.replace(/<[^>]+>/g, ""));
  const base = plain
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
  if (!base) return "";
  if (!seen.has(base)) {
    seen.set(base, 0);
    return base;
  }
  let n = (seen.get(base) ?? 0) + 1;
  while (seen.has(`${base}-${n}`)) n++;
  const slug = `${base}-${n}`;
  seen.set(base, n);
  seen.set(slug, 0);
  return slug;
}

export async function renderMarkdownHtml(src: string, MarkedCtor: typeof Marked): Promise<string> {
  const seen = new Map<string, number>();
  const instance = new MarkedCtor({ gfm: true, breaks: false });
  instance.use({
    renderer: {
      heading({ tokens, depth }) {
        const body = this.parser.parseInline(tokens);
        const id = headingSlug(body, seen);
        return id
          ? `<h${depth} id="${id}" data-heading-id="${id}">${body}</h${depth}>\n`
          : `<h${depth}>${body}</h${depth}>\n`;
      },
    },
  });
  return await instance.parse(src);
}

export function classifyLinkHref(rawHref: string | null): LinkAction {
  if (rawHref == null) return { kind: "ignore" };
  const href = rawHref.trim();
  if (href.startsWith("#")) {
    const rawId = href.slice(1);
    let id = rawId;
    try {
      id = decodeURIComponent(rawId);
    } catch {}
    return { kind: "anchor", id };
  }
  if (/^https?:\/\//i.test(href)) return { kind: "external", url: href };
  if (/^mailto:/i.test(href)) return { kind: "mailto" };
  return { kind: "ignore" };
}

export function findAnchorTarget(container: ContainerLike | null | undefined, id: string): AnchorTargetLike | null {
  if (!id || typeof container?.querySelectorAll !== "function") return null;
  const targets = [...container.querySelectorAll("[id], [data-heading-id], a[name]")];
  for (const el of targets) {
    if (el.id === id || el.getAttribute?.("data-heading-id") === id || el.getAttribute?.("name") === id) return el;
  }
  const lower = id.toLowerCase();
  for (const el of targets) {
    const candidates = [el.id, el.getAttribute?.("data-heading-id"), el.getAttribute?.("name")];
    if (candidates.some((v) => v && v.toLowerCase() === lower)) return el;
  }
  return null;
}

export function handleDocumentLinkClick(
  e: DocumentClickEventLike,
  openExternal?: (url: string) => void,
): LinkAction | null {
  const t = e.target as EventTargetLike | null;
  const a = t?.closest?.("a") ?? t?.parentElement?.closest?.("a") ?? null;
  if (!a) return null;
  const raw = a.getAttribute("href");
  if (raw === null) return null;
  const action = classifyLinkHref(raw);
  if (action.kind === "mailto") return action;
  e.preventDefault();
  if (action.kind === "external") {
    const open = openExternal ?? ((url: string) => window.open(url, "_blank", "noopener,noreferrer"));
    open(action.url);
  } else if (action.kind === "anchor" && action.id) {
    const el = findAnchorTarget(e.currentTarget as ContainerLike | null, action.id);
    el?.scrollIntoView?.({ block: "start" });
  }
  return action;
}

export const ZIP_ENTRY_LIMIT = 5000;

export function zipTruncatedNote(totalEntries: number): string | null {
  if (totalEntries <= ZIP_ENTRY_LIMIT) return null;
  return `Showing the first ${ZIP_ENTRY_LIMIT.toLocaleString()} of ${totalEntries.toLocaleString()} entries.`;
}

const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

export function shouldIgnoreViewerKey(
  target: EventTarget | null,
  hasOpenSheet: () => boolean = () => typeof document !== "undefined" && !!document.querySelector(".sheet"),
): boolean {
  if (hasOpenSheet()) return true;
  if (!target || typeof target !== "object") return false;
  const el = target as { closest?: (sel: string) => unknown; isContentEditable?: boolean };
  if (el.isContentEditable) return true;
  return typeof el.closest === "function" && !!el.closest(EDITABLE_SELECTOR);
}
