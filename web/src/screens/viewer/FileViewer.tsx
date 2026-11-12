// Full-window viewer for Files: photos, video, music, PDFs, text and code, Markdown, CSV,
// Excel, Word, PowerPoint, iWork previews, archives and fonts. Swipe or ←/→ steps through the folder.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { mutate, type FileEntry } from "../../api";
import { Icon, type IconName } from "../../icons";
import { bytes, haptic, usePortalRoot, useToast } from "../../ui";
import type { Sheet, Shape, ZipEntry } from "./office";

const enc = encodeURIComponent;
const viewUrl = (path: string) => `/api/files/view?path=${enc(path)}`;
const ext = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");

// ---- what opens how ----------------------------------------------------------------------------
export type ViewKind =
  | "image" | "video" | "audio" | "pdf" | "text" | "markdown" | "csv" | "xlsx"
  | "docx" | "pptx" | "iwork" | "zip" | "archive" | "font" | "none";
const TEXT_EXT = new Set(
  ("txt md markdown json jsonc json5 yml yaml log conf cfg ini toml env sh bash zsh fish ps1 bat js mjs cjs jsx ts tsx " +
    "py rb go rs java kt c h cpp hpp cc cs php pl lua swift sql html htm css scss less xml svg vtt srt nfo " +
    "gitignore dockerfile makefile properties service gradle r dart vue svelte tf hcl nix lock").split(" "),
);
// Formats umbrelOS turns into a viewable picture for us (browsers can't decode these from the file).
const RENDERED_EXT = new Set("heic heif tif tiff psd dng cr2 cr3 nef arw raf orf rw2 raw".split(" "));
export function viewKind(f: FileEntry): ViewKind {
  const t = f.type;
  const e = ext(f.name);
  const n = f.name.toLowerCase();
  if (t === "directory") return "none";
  if (e === "svg") return "image";
  if (t.startsWith("image/") || RENDERED_EXT.has(e)) return "image";
  if (t.startsWith("video/") && !(t === "video/mp2t" && /\.m?ts$/.test(n))) return "video";
  if (["mp4", "m4v", "mov", "webm", "mkv", "ogv"].includes(e)) return "video";
  if (t.startsWith("audio/") || ["mp3", "m4a", "aac", "flac", "wav", "ogg", "opus", "oga"].includes(e)) return "audio";
  if (t === "application/pdf" || e === "pdf") return "pdf";
  if (["md", "markdown"].includes(e) || t === "text/markdown") return "markdown";
  if (["csv", "tsv"].includes(e) || t === "text/csv" || t === "text/tab-separated-values") return "csv";
  if (["xlsx", "xlsm", "xltx"].includes(e)) return "xlsx";
  if (["docx", "docm", "dotx"].includes(e)) return "docx";
  if (["pptx", "pptm", "ppsx", "potx"].includes(e)) return "pptx";
  if (["key", "pages", "numbers"].includes(e)) return "iwork";
  if (e === "zip") return "zip";
  if (/\.(tar|tgz|tar\.gz|tar\.bz2|tar\.xz|7z|rar)$/.test(n)) return "archive";
  if (["ttf", "otf", "woff", "woff2"].includes(e)) return "font";
  if (t.startsWith("text/") || t.endsWith("+json") || t.endsWith("+xml") || t === "application/json" || t === "application/xml" ||
    TEXT_EXT.has(e) || ["dockerfile", "makefile", "readme", "license", ".env"].includes(n)) return "text";
  return "none";
}
const KIND_INFO: Record<ViewKind, { icon: IconName; color: string; label: string }> = {
  image: { icon: "image", color: "#f472b6", label: "Image" },
  video: { icon: "video", color: "#c084fc", label: "Video" },
  audio: { icon: "music", color: "#fb923c", label: "Audio" },
  pdf: { icon: "pdf", color: "#f87171", label: "PDF" },
  text: { icon: "file-text", color: "#a1a1aa", label: "Text" },
  markdown: { icon: "file-text", color: "#a1a1aa", label: "Markdown" },
  csv: { icon: "sheet", color: "#4ade80", label: "Spreadsheet" },
  xlsx: { icon: "sheet", color: "#4ade80", label: "Excel workbook" },
  docx: { icon: "doc", color: "#60a5fa", label: "Word document" },
  pptx: { icon: "slides", color: "#fb923c", label: "Presentation" },
  iwork: { icon: "doc", color: "#60a5fa", label: "iWork document" },
  zip: { icon: "zip", color: "#facc15", label: "Zip archive" },
  archive: { icon: "zip", color: "#facc15", label: "Archive" },
  font: { icon: "font", color: "#2dd4bf", label: "Font" },
  none: { icon: "file", color: "#a1a1aa", label: "File" },
};

// Bytes of the file, for viewers that parse it in the browser.
const MAX_PARSE = 150e6;
async function fetchBytes(f: FileEntry, signal: AbortSignal) {
  if ((f.size ?? 0) > MAX_PARSE) throw new Error(`Too large to open here (${bytes(f.size)}). Download it instead.`);
  const r = await fetch(viewUrl(f.path), { credentials: "same-origin", signal });
  if (!r.ok) throw new Error(r.status === 404 ? "The file isn’t there any more" : `Couldn’t open the file (${r.status})`);
  return r.arrayBuffer();
}
function useBytes(f: FileEntry) {
  const [state, set] = useState<{ buf?: ArrayBuffer; error?: string }>({});
  useEffect(() => {
    const ac = new AbortController();
    set({});
    fetchBytes(f, ac.signal).then(
      (buf) => set({ buf }),
      (e) => !ac.signal.aborted && set({ error: (e as Error).message }),
    );
    return () => ac.abort();
  }, [f.path, f.modified]);
  return state;
}
// Run an async parse over the file's bytes.
function useParsed<T>(f: FileEntry, parse: (buf: ArrayBuffer) => Promise<T>, cleanup?: (v: T) => void) {
  const { buf, error } = useBytes(f);
  const [state, set] = useState<{ value?: T; error?: string }>({});
  useEffect(() => {
    if (!buf) return set({});
    let live = true;
    let made: T | undefined;
    parse(buf).then(
      (value) => (live ? set({ value: (made = value) }) : cleanup?.(value)),
      (e) => live && set({ error: (e as Error).message || "This file couldn’t be read" }),
    );
    return () => {
      live = false;
      if (made !== undefined)
        try {
          cleanup?.(made);
        } catch {}
    };
  }, [buf]);
  return { value: state.value, error: error ?? state.error, loading: !error && !state.error && state.value === undefined };
}

// Overwrite the file in place with new contents (the same upload umbrelOS's own editor uses).
async function saveFile(f: FileEntry, body: Blob) {
  const r = await fetch(`/api/files/upload?path=${enc(f.path)}&collision=replace`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "x-umbrel-touch": "1", "content-type": "application/octet-stream" },
    body,
  });
  if (!r.ok) {
    let msg = `Couldn’t save (${r.status})`;
    try {
      const j = await r.json();
      msg = j?.error?.message ?? j?.error ?? msg;
    } catch {}
    throw new Error(String(msg));
  }
}

// ---- shell ---------------------------------------------------------------------------------------
export type ViewerProps = {
  files: FileEntry[];
  index: number;
  onClose: () => void;
  onInfo: (f: FileEntry) => void;
  onDownload: (f: FileEntry) => void;
  onChanged: () => void;
};
type Tools = { node: ReactNode; ownsArrows?: boolean; dirty?: boolean };

export function FileViewer(p: ViewerProps) {
  const root = usePortalRoot();
  const [i, setI] = useState(p.index);
  const f = p.files[Math.min(i, p.files.length - 1)];
  const [tools, setTools] = useState<Tools>({ node: null });
  const [zoomed, setZoomed] = useState(false);
  const has = { prev: i > 0, next: i < p.files.length - 1 };
  const guard = () => !tools.dirty || confirm("Discard your unsaved changes?");
  const step = (d: number) => {
    const n = i + d;
    if (n < 0 || n >= p.files.length || !guard()) return;
    haptic(4);
    setTools({ node: null });
    setZoomed(false);
    setI(n);
  };
  const close = () => guard() && p.onClose();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, [contenteditable=true]") || document.querySelector(".sheet")) return;
      if (e.key === "Escape") close();
      else if (!tools.ownsArrows && e.key === "ArrowLeft") step(-1);
      else if (!tools.ownsArrows && e.key === "ArrowRight") step(1);
    };
    // Capture phase: runs before a details sheet on top closes itself, so Esc closes one layer.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });
  // Swipe sideways between files (not while zoomed into a photo, and not on scrolling documents).
  const swipe = useRef<{ x: number; y: number; t: number } | null>(null);
  const kind = f ? viewKind(f) : "none";
  const swipeable = ["image", "video", "audio", "none", "font", "iwork", "archive"].includes(kind) && !zoomed;
  if (!f) return null;
  const look = KIND_INFO[kind];
  return createPortal(
    <div
      className="fv"
      role="dialog"
      aria-modal="true"
      aria-label={f.name}
      onTouchStart={(e) => {
        if (!swipeable || e.touches.length !== 1) return (swipe.current = null);
        swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
      }}
      onTouchEnd={(e) => {
        const s = swipe.current;
        swipe.current = null;
        if (!s) return;
        const dx = e.changedTouches[0].clientX - s.x;
        const dy = e.changedTouches[0].clientY - s.y;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - s.t < 600) step(dx < 0 ? 1 : -1);
        else if (dy > 110 && Math.abs(dy) > Math.abs(dx) * 1.5 && kind === "image") close();
      }}
    >
      <header className="fv-bar">
        <button className="icon-btn" onClick={close} aria-label="Close viewer" title="Close (Esc)">
          <Icon name="back" size={22} />
        </button>
        <span className="fv-title">
          <b>{f.name}</b>
          <span>
            {look.label}
            {f.size != null && ` · ${bytes(f.size)}`}
            {p.files.length > 1 && ` · ${i + 1} of ${p.files.length}`}
          </span>
        </span>
        <span className="fv-tools">{tools.node}</span>
        <button className="icon-btn" onClick={() => p.onDownload(f)} aria-label="Download" title="Download">
          <Icon name="download" size={20} />
        </button>
        <button className="icon-btn" onClick={() => p.onInfo(f)} aria-label="Details and actions" title="Details">
          <Icon name="dots" size={20} />
        </button>
      </header>
      <div className={`fv-body fv-${kind}`} key={f.path}>
        <Body f={f} kind={kind} setTools={setTools} setZoomed={setZoomed} onDownload={() => p.onDownload(f)} onChanged={p.onChanged} />
      </div>
      {has.prev && (
        <button className="fv-nav prev" onClick={() => step(-1)} aria-label="Previous file" title="Previous (←)">
          <Icon name="back" size={26} />
        </button>
      )}
      {has.next && (
        <button className="fv-nav next" onClick={() => step(1)} aria-label="Next file" title="Next (→)">
          <Icon name="chevron" size={26} />
        </button>
      )}
    </div>,
    root,
  );
}

type BodyProps = {
  f: FileEntry;
  kind: ViewKind;
  setTools: (t: Tools) => void;
  setZoomed: (z: boolean) => void;
  onDownload: () => void;
  onChanged: () => void;
};
function Body(b: BodyProps) {
  switch (b.kind) {
    case "image": return <ImageView {...b} />;
    case "video": return <VideoView {...b} />;
    case "audio": return <AudioView {...b} />;
    case "pdf": return <PdfView {...b} />;
    case "text":
    case "markdown": return <TextView {...b} />;
    case "csv": return <CsvView {...b} />;
    case "xlsx": return <XlsxView {...b} />;
    case "docx": return <DocxView {...b} />;
    case "pptx": return <PptxView {...b} />;
    case "iwork": return <IworkView {...b} />;
    case "zip": return <ZipView {...b} />;
    case "archive": return <InfoCard {...b} />;
    case "font": return <FontView {...b} />;
    default: return <InfoCard {...b} />;
  }
}

const Loading = ({ label = "Opening…" }: { label?: string }) => (
  <div className="fv-state">
    <span className="spinner" />
    {label}
  </div>
);
function InfoCard({ f, kind, onDownload, onChanged, reason }: BodyProps & { reason?: string }) {
  const look = KIND_INFO[kind];
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const canExtract = (kind === "archive" || kind === "zip") && f.operations.includes("unarchive");
  const hint =
    reason ??
    (kind === "archive"
      ? "Archives like this can’t be listed in the browser, but you can extract them right here."
      : /\.(iso|img|qcow2)$/i.test(f.name)
        ? "Disk images can be used when you create a Machine."
        : /\.(doc|xls|ppt)$/i.test(f.name)
          ? "Older Office formats can’t be opened here. Newer .docx, .xlsx and .pptx files can."
          : "There’s no viewer for this kind of file yet.");
  return (
    <div className="fv-card glass">
      <span className="fv-card-icon" style={{ background: look.color }}>
        <Icon name={look.icon} size={40} />
      </span>
      <b>{f.name}</b>
      <span className="muted">
        {look.label}
        {f.size != null && ` · ${bytes(f.size)}`}
      </span>
      <p className="muted">{hint}</p>
      <div className="fv-card-actions">
        {canExtract && (
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await mutate("files.unarchive", { path: f.path });
                toast("Extracted next to the archive");
                onChanged();
              } catch (e) {
                toast((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Icon name="extract" size={19} />
            {busy ? "Extracting…" : "Extract here"}
          </button>
        )}
        <button className={`btn${canExtract ? "" : " primary"}`} onClick={onDownload}>
          <Icon name="download" size={19} />
          Download
        </button>
      </div>
    </div>
  );
}
const Failed = (b: BodyProps & { error: string }) => <InfoCard {...b} reason={b.error} />;

// ---- photos -------------------------------------------------------------------------------------
function ImageView(b: BodyProps) {
  const { f, setZoomed, setTools } = b;
  const needsRendition = RENDERED_EXT.has(ext(f.name)) && ext(f.name) !== "svg";
  const [src, setSrc] = useState<string | null>(needsRendition ? null : viewUrl(f.path));
  const [failed, setFailed] = useState(false);
  const [z, setZ] = useState({ s: 1, x: 0, y: 0 });
  const box = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ d: number; s: number; x: number; y: number; cx: number; cy: number } | null>(null);
  const lastTap = useRef(0);
  // Ask umbrelOS for a large rendition when the browser can't draw the original.
  const rendition = async () => {
    for (const input of [{ path: f.path, variant: "preview-1280-webp-v2" }, { path: f.path }]) {
      try {
        const name = await mutate<string | { thumbnail?: string } | null>("files.getThumbnail", input);
        const n = typeof name === "string" ? name : name?.thumbnail;
        if (n) return setSrc(`/api/files/thumbnail/${enc(n)}?path=${enc(f.path)}`);
      } catch {}
    }
    setFailed(true);
  };
  useEffect(() => {
    if (needsRendition) void rendition();
  }, []);
  const set = (s: number, x: number, y: number) => {
    const ns = Math.min(8, Math.max(1, s));
    const el = box.current;
    const lim = el ? { x: (el.clientWidth * (ns - 1)) / 2, y: (el.clientHeight * (ns - 1)) / 2 } : { x: 0, y: 0 };
    const nz = ns === 1 ? { s: 1, x: 0, y: 0 } : { s: ns, x: Math.max(-lim.x, Math.min(lim.x, x)), y: Math.max(-lim.y, Math.min(lim.y, y)) };
    setZ(nz);
    setZoomed(nz.s > 1);
  };
  const zoomAt = (factor: number, cx: number, cy: number) => {
    const el = box.current!;
    const r = el.getBoundingClientRect();
    const px = cx - r.left - r.width / 2,
      py = cy - r.top - r.height / 2;
    const ns = Math.min(8, Math.max(1, z.s * factor));
    const k = ns / z.s;
    set(ns, px - (px - z.x) * k, py - (py - z.y) * k);
  };
  useEffect(() => {
    setTools({
      node: (
        <>
          <button className="icon-btn" aria-label="Zoom out" title="Zoom out" onClick={() => set(z.s / 1.5, z.x / 1.5, z.y / 1.5)} disabled={z.s <= 1}>
            <Icon name="zoom-out" size={20} />
          </button>
          <button className="icon-btn" aria-label="Zoom in" title="Zoom in" onClick={() => set(z.s * 1.5, z.x * 1.5, z.y * 1.5)}>
            <Icon name="zoom-in" size={20} />
          </button>
        </>
      ),
    });
  }, [z.s]);
  if (failed) return <Failed {...b} error="This picture can’t be shown in the browser. Download it to open it on your device." />;
  if (!src) return <Loading />;
  return (
    <div
      ref={box}
      className="fv-stage"
      style={{ touchAction: z.s > 1 ? "none" : "pan-y" }}
      onWheel={(e) => {
        if (!e.ctrlKey && !e.metaKey && z.s === 1) return;
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY / 200), e.clientX, e.clientY);
        else set(z.s, z.x - e.deltaX, z.y - e.deltaY);
      }}
      onDoubleClick={(e) => (z.s > 1 ? set(1, 0, 0) : zoomAt(2.5, e.clientX, e.clientY))}
      onPointerDown={(e) => {
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (e.pointerType === "touch" && pointers.current.size === 1) {
          const now = Date.now();
          if (now - lastTap.current < 280) {
            z.s > 1 ? set(1, 0, 0) : zoomAt(2.5, e.clientX, e.clientY);
            lastTap.current = 0;
          } else lastTap.current = now;
        }
        const pts = [...pointers.current.values()];
        if (pts.length === 2) {
          const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          gesture.current = { d, s: z.s, x: z.x, y: z.y, cx: (pts[0].x + pts[1].x) / 2, cy: (pts[0].y + pts[1].y) / 2 };
        } else if (pts.length === 1 && z.s > 1) {
          gesture.current = { d: 0, s: z.s, x: z.x, y: z.y, cx: e.clientX, cy: e.clientY };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }
      }}
      onPointerMove={(e) => {
        if (!pointers.current.has(e.pointerId)) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const g = gesture.current;
        if (!g) return;
        const pts = [...pointers.current.values()];
        if (pts.length >= 2 && g.d) {
          const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          const cx = (pts[0].x + pts[1].x) / 2,
            cy = (pts[0].y + pts[1].y) / 2;
          const r = box.current!.getBoundingClientRect();
          const px = g.cx - r.left - r.width / 2,
            py = g.cy - r.top - r.height / 2;
          const ns = Math.min(8, Math.max(1, (g.s * d) / g.d));
          const k = ns / g.s;
          set(ns, px - (px - g.x) * k + (cx - g.cx), py - (py - g.y) * k + (cy - g.cy));
        } else if (pts.length === 1 && !g.d) set(g.s, g.x + e.clientX - g.cx, g.y + e.clientY - g.cy);
      }}
      onPointerUp={(e) => {
        pointers.current.delete(e.pointerId);
        if (pointers.current.size < 2 && gesture.current?.d) gesture.current = null;
        if (!pointers.current.size) gesture.current = null;
      }}
      onPointerCancel={(e) => {
        pointers.current.delete(e.pointerId);
        gesture.current = null;
      }}
    >
      <img
        src={src}
        alt={f.name}
        draggable={false}
        style={{ transform: `translate(${z.x}px, ${z.y}px) scale(${z.s})` }}
        onError={() => (src.startsWith("/api/files/view") ? void rendition() : setFailed(true))}
      />
    </div>
  );
}

// ---- video and music ------------------------------------------------------------------------------
function VideoView(b: BodyProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => b.setTools({ node: null, ownsArrows: false }), []);
  if (failed)
    return <Failed {...b} error="This video’s format or codec can’t play in this browser. Download it, or play it in an app like Jellyfin or Plex." />;
  return <video className="fv-video" src={viewUrl(b.f.path)} controls autoPlay playsInline preload="metadata" onError={() => setFailed(true)} />;
}
function AudioView(b: BodyProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => b.setTools({ node: null }), []);
  if (failed) return <Failed {...b} error="This audio format can’t play in this browser. Download it to play it on your device." />;
  return (
    <div className="fv-card glass fv-audio">
      <span className="fv-card-icon" style={{ background: "linear-gradient(135deg, #fb923c, #f472b6)" }}>
        <Icon name="music" size={46} />
      </span>
      <b>{b.f.name.replace(/\.[^.]+$/, "")}</b>
      <span className="muted">{ext(b.f.name).toUpperCase()} · {bytes(b.f.size)}</span>
      <audio src={viewUrl(b.f.path)} controls autoPlay preload="metadata" onError={() => setFailed(true)} />
    </div>
  );
}

// ---- PDF (pdf.js, so every page renders the same on iPhone, Android and desktop) -------------------
type PdfDoc = { numPages: number; getPage: (n: number) => Promise<any>; destroy: () => Promise<void> };
async function loadPdf(buf: ArrayBuffer): Promise<PdfDoc> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const worker = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
    enableXfa: false,
  });
  const doc = await task.promise;
  return { numPages: doc.numPages, getPage: (n: number) => doc.getPage(n), destroy: () => task.destroy() };
}
function PdfView(b: BodyProps) {
  const { value: doc, error, loading } = useParsed(b.f, loadPdf, (d) => void d.destroy());
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc]);
  const goPage = (n: number) => {
    const el = scroller.current?.querySelector(`[data-page="${n}"]`);
    el?.scrollIntoView({ block: "start" });
  };
  useEffect(() => {
    b.setTools({
      ownsArrows: true,
      node: doc ? (
        <>
          <span className="fv-pill">{page} / {doc.numPages}</span>
          <button className="icon-btn" aria-label="Zoom out" title="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, z / 1.25))}>
            <Icon name="zoom-out" size={20} />
          </button>
          <button className="icon-btn" aria-label="Zoom in" title="Zoom in" onClick={() => setZoom((z) => Math.min(4, z * 1.25))}>
            <Icon name="zoom-in" size={20} />
          </button>
        </>
      ) : null,
    });
  }, [doc, page]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!doc) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") goPage(Math.min(doc.numPages, page + 1));
      if (e.key === "ArrowLeft" || e.key === "PageUp") goPage(Math.max(1, page - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc, page]);
  if (error) return <Failed {...b} error={error} />;
  if (loading || !doc) return <Loading />;
  const pageWidth = Math.max(200, Math.min(width - 24, 980) * zoom);
  return (
    <div
      className="fv-scroll fv-pdf-pages"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        const pages = el.querySelectorAll<HTMLElement>("[data-page]");
        const mid = el.scrollTop + el.clientHeight / 3;
        for (const p of pages) if (p.offsetTop + p.offsetHeight > mid) return setPage(Number(p.dataset.page));
      }}
    >
      {width > 0 && Array.from({ length: doc.numPages }, (_, n) => <PdfPage key={n} doc={doc} n={n + 1} width={pageWidth} root={scroller} />)}
    </div>
  );
}
function PdfPage({ doc, n, width, root }: { doc: PdfDoc; n: number; width: number; root: React.RefObject<HTMLDivElement> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(1.294);
  const [visible, setVisible] = useState(n <= 2);
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { root: root.current, rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    let live = true;
    doc.getPage(n).then((page) => {
      if (!live || !canvas.current) return;
      const base = page.getViewport({ scale: 1 });
      setRatio(base.height / base.width);
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const vp = page.getViewport({ scale: (width / base.width) * dpr });
      const c = canvas.current;
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      task = page.render({ canvas: c, canvasContext: c.getContext("2d")!, viewport: vp });
      task!.promise.catch(() => {});
    });
    return () => {
      live = false;
      task?.cancel();
    };
  }, [visible, width]);
  return (
    <div ref={holder} className="fv-page" data-page={n} style={{ width, height: width * ratio }}>
      <canvas ref={canvas} style={{ width: "100%", height: "100%" }} aria-label={`Page ${n}`} />
    </div>
  );
}

// ---- text, code and Markdown, with editing ----------------------------------------------------------
const MAX_TEXT_VIEW = 8e6;
const MAX_TEXT_EDIT = 3e6;
function useText(f: FileEntry, reload: number) {
  const [state, set] = useState<{ text?: string; error?: string }>({});
  useEffect(() => {
    if ((f.size ?? 0) > MAX_TEXT_VIEW) return set({ error: `Too large to show here (${bytes(f.size)}). Download it instead.` });
    const ac = new AbortController();
    set({});
    fetch(viewUrl(f.path), { credentials: "same-origin", signal: ac.signal })
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`Couldn’t open the file (${r.status})`))))
      .then((buf) => {
        const head = new Uint8Array(buf.slice(0, 4096));
        if (head.includes(0)) throw new Error("This file isn’t text, so it can’t be shown here.");
        set({ text: new TextDecoder().decode(buf) });
      })
      .catch((e) => !ac.signal.aborted && set({ error: (e as Error).message }));
    return () => ac.abort();
  }, [f.path, f.modified, reload]);
  return state;
}
async function renderMarkdown(src: string) {
  const [{ marked }, { default: DOMPurify }] = await Promise.all([import("marked"), import("dompurify")]);
  const html = await marked.parse(src, { gfm: true, breaks: false });
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form", "input"], USE_PROFILES: { html: true } });
}
function TextView(b: BodyProps) {
  const { f } = b;
  const toast = useToast();
  const [reload, setReload] = useState(0);
  const { text, error } = useText(f, reload);
  const isMd = b.kind === "markdown";
  const [mode, setMode] = useState<"view" | "source" | "edit">(isMd ? "view" : "source");
  const [draft, setDraft] = useState("");
  const [wrap, setWrap] = useState(true);
  const [html, setHtml] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editable = f.operations.includes("rename") && (f.size ?? 0) <= MAX_TEXT_EDIT;
  const dirty = mode === "edit" && draft !== text;
  useEffect(() => {
    if (isMd && text != null && mode === "view") renderMarkdown(text).then(setHtml, () => setHtml(null));
  }, [text, mode]);
  const save = async () => {
    setSaving(true);
    try {
      await saveFile(f, new Blob([draft], { type: "text/plain" }));
      toast("Saved");
      setMode(isMd ? "view" : "source");
      setReload((r) => r + 1);
      b.onChanged();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    b.setTools({
      dirty,
      node:
        text == null ? null : mode === "edit" ? (
          <>
            <button className="btn small" onClick={() => (!dirty || confirm("Discard your changes?")) && setMode(isMd ? "view" : "source")}>
              Cancel
            </button>
            <button className="btn small primary" onClick={save} disabled={saving || !dirty}>
              <Icon name="save" size={17} />
              {saving ? "Saving…" : "Save"}
            </button>
          </>
        ) : (
          <>
            {isMd && (
              <button className="icon-btn" aria-label={mode === "view" ? "Show source" : "Show preview"} title={mode === "view" ? "Source" : "Preview"} onClick={() => setMode(mode === "view" ? "source" : "view")}>
                <Icon name={mode === "view" ? "developer" : "eye"} size={20} />
              </button>
            )}
            {mode === "source" && (
              <button className={`icon-btn${wrap ? " on" : ""}`} aria-label="Wrap lines" title="Wrap lines" onClick={() => setWrap((w) => !w)}>
                <Icon name="wrap" size={20} />
              </button>
            )}
            {editable && (
              <button className="btn small" onClick={() => (setDraft(text), setMode("edit"))}>
                <Icon name="pencil" size={17} />
                Edit
              </button>
            )}
          </>
        ),
    });
  }, [text, mode, dirty, saving, wrap, draft]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode === "edit" && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (error) return <Failed {...b} error={error} />;
  if (text == null) return <Loading />;
  if (mode === "edit")
    return (
      <textarea
        className="fv-editor"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={isMd}
        autoCapitalize="off"
        autoCorrect="off"
        autoFocus
        aria-label={`Editing ${f.name}`}
      />
    );
  if (isMd && mode === "view")
    return html == null ? <Loading /> : (
      <div className="fv-scroll">
        <article
          className="fv-md"
          dangerouslySetInnerHTML={{ __html: html }}
          onClick={(e) => {
            const a = (e.target as HTMLElement).closest("a");
            if (a?.href) {
              e.preventDefault();
              if (/^https?:/.test(a.href)) window.open(a.href, "_blank", "noopener,noreferrer");
            }
          }}
        />
      </div>
    );
  return <CodeView text={text} wrap={wrap} />;
}
function CodeView({ text, wrap }: { text: string; wrap: boolean }) {
  const lines = useMemo(() => {
    const l = text.split(/\r?\n/);
    if (l.length > 1 && l[l.length - 1] === "") l.pop();
    return l;
  }, [text]);
  const LIMIT = 20000;
  const shown = lines.length > LIMIT ? lines.slice(0, LIMIT) : lines;
  return (
    <div className="fv-scroll">
      <div className={`fv-code${wrap ? " wrap" : ""}`}>
        <pre className="fv-gutter" aria-hidden="true">{shown.map((_, n) => n + 1).join("\n")}</pre>
        <pre className="fv-lines">{shown.join("\n")}</pre>
      </div>
      {lines.length > LIMIT && <p className="fv-note">Showing the first {LIMIT.toLocaleString()} of {lines.length.toLocaleString()} lines. Download for the rest.</p>}
    </div>
  );
}

// ---- spreadsheets ------------------------------------------------------------------------------------
const colName = (n: number) => {
  let s = "";
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
function Grid({ rows, editable, onEdit, header }: { rows: string[][]; editable?: boolean; onEdit?: (r: number, c: number, v: string) => void; header?: boolean }) {
  const LIMIT = 3000;
  const cols = Math.max(1, ...rows.slice(0, LIMIT).map((r) => r.length));
  const [cell, setCell] = useState<[number, number] | null>(null);
  return (
    <div className="fv-scroll">
      <table className="fv-grid">
        <thead>
          <tr>
            <th className="corner" />
            {Array.from({ length: cols }, (_, c) => <th key={c}>{colName(c)}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, LIMIT).map((r, ri) => (
            <tr key={ri} className={header && ri === 0 ? "head" : undefined}>
              <th>{ri + 1}</th>
              {Array.from({ length: cols }, (_, ci) => {
                const editing = cell?.[0] === ri && cell?.[1] === ci;
                const v = r[ci] ?? "";
                return (
                  <td key={ci} className={editing ? "editing" : /^-?[\d.,]+%?$/.test(v) ? "num" : undefined} onClick={() => editable && setCell([ri, ci])}>
                    {editing ? (
                      <input
                        autoFocus
                        defaultValue={v}
                        onBlur={(e) => (onEdit?.(ri, ci, e.target.value), setCell(null))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === "Tab") {
                            e.preventDefault();
                            onEdit?.(ri, ci, (e.target as HTMLInputElement).value);
                            setCell(e.key === "Tab" ? [ri, ci + 1] : [ri + 1, ci]);
                          }
                          if (e.key === "Escape") setCell(null);
                        }}
                      />
                    ) : (
                      v
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > LIMIT && <p className="fv-note">Showing the first {LIMIT.toLocaleString()} of {rows.length.toLocaleString()} rows.</p>}
    </div>
  );
}
function CsvView(b: BodyProps) {
  const toast = useToast();
  const [reload, setReload] = useState(0);
  const { text, error } = useText(b.f, reload);
  const sep = ext(b.f.name) === "tsv" || b.f.type === "text/tab-separated-values" ? "\t" : ",";
  const [rows, setRows] = useState<string[][] | null>(null);
  const [orig, setOrig] = useState<string[][] | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (text == null) return;
    import("./office").then(({ parseDelimited }) => {
      const r = parseDelimited(text, sep);
      setRows(r);
      setOrig(r);
    });
  }, [text]);
  const dirty = editing && rows !== orig;
  const editable = b.f.operations.includes("rename") && (b.f.size ?? 0) <= MAX_TEXT_EDIT;
  const save = async () => {
    if (!rows) return;
    setSaving(true);
    try {
      const { toDelimited } = await import("./office");
      await saveFile(b.f, new Blob([toDelimited(rows, sep)], { type: "text/csv" }));
      toast("Saved");
      setEditing(false);
      setReload((r) => r + 1);
      b.onChanged();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    b.setTools({
      dirty,
      node: !rows ? null : editing ? (
        <>
          <button className="btn small" onClick={() => (!dirty || confirm("Discard your changes?")) && (setRows(orig), setEditing(false))}>Cancel</button>
          <button className="btn small primary" disabled={!dirty || saving} onClick={save}>
            <Icon name="save" size={17} />
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      ) : editable ? (
        <button className="btn small" onClick={() => setEditing(true)}>
          <Icon name="pencil" size={17} />
          Edit
        </button>
      ) : null,
    });
  }, [rows, editing, dirty, saving]);
  if (error) return <Failed {...b} error={error} />;
  if (!rows) return <Loading />;
  return (
    <Grid
      rows={rows}
      header
      editable={editing}
      onEdit={(r, c, v) =>
        setRows((cur) => {
          if (!cur || (cur[r]?.[c] ?? "") === v) return cur;
          const next = cur.map((x) => x.slice());
          while (next.length <= r) next.push([]);
          while (next[r].length < c) next[r].push("");
          next[r][c] = v;
          return next;
        })
      }
    />
  );
}
function XlsxView(b: BodyProps) {
  const { value: sheets, error, loading } = useParsed(b.f, async (buf) => (await import("./office")).readXlsx(buf));
  const [tab, setTab] = useState(0);
  useEffect(() => b.setTools({ node: null }), []);
  if (error) return <Failed {...b} error={error} />;
  if (loading || !sheets) return <Loading />;
  if (!sheets.length) return <Failed {...b} error="This workbook has no sheets." />;
  const s: Sheet = sheets[Math.min(tab, sheets.length - 1)];
  return (
    <div className="fv-col">
      <Grid rows={s.rows} />
      {s.truncated && <p className="fv-note">Large sheet: showing the first 5,000 rows and 200 columns.</p>}
      {sheets.length > 1 && (
        <nav className="fv-tabs" aria-label="Sheets">
          {sheets.map((x, n) => (
            <button key={n} className={n === tab ? "on" : undefined} onClick={() => setTab(n)}>{x.name}</button>
          ))}
        </nav>
      )}
    </div>
  );
}

// ---- Word ---------------------------------------------------------------------------------------------
async function readDocx(buf: ArrayBuffer) {
  const [mammoth, { default: DOMPurify }] = await Promise.all([import("mammoth"), import("dompurify")]);
  const m = (mammoth as unknown as { default?: typeof mammoth }).default ?? mammoth;
  const res = await m.convertToHtml(
    { arrayBuffer: buf },
    { styleMap: ["p[style-name='Title'] => h1.doc-title:fresh", "p[style-name='Subtitle'] => p.doc-subtitle:fresh"] },
  );
  return DOMPurify.sanitize(res.value, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "input"] });
}
function DocxView(b: BodyProps) {
  const { value: html, error, loading } = useParsed(b.f, readDocx);
  useEffect(() => b.setTools({ node: null }), []);
  if (error) return <Failed {...b} error={error} />;
  if (loading || html == null) return <Loading />;
  return (
    <div className="fv-scroll fv-paper-bg">
      <article className="fv-paper" dangerouslySetInnerHTML={{ __html: html || "<p><i>This document is empty.</i></p>" }} />
    </div>
  );
}

// ---- PowerPoint ---------------------------------------------------------------------------------------
function PptxView(b: BodyProps) {
  const { value: deck, error, loading } = useParsed(
    b.f,
    async (buf) => (await import("./office")).readPptx(buf),
    (d) => d.urls.forEach((u) => URL.revokeObjectURL(u)),
  );
  const [cur, setCur] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [deck]);
  const go = (n: number) => scroller.current?.querySelector(`[data-slide="${n}"]`)?.scrollIntoView({ block: "center" });
  useEffect(() => {
    b.setTools({ ownsArrows: true, node: deck ? <span className="fv-pill">{cur + 1} / {deck.slides.length}</span> : null });
  }, [deck, cur]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!deck) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown") (e.preventDefault(), go(Math.min(deck.slides.length - 1, cur + 1)));
      if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") (e.preventDefault(), go(Math.max(0, cur - 1)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deck, cur]);
  if (error) return <Failed {...b} error={error} />;
  if (loading || !deck) return <Loading />;
  const w = Math.max(200, Math.min(width - 32, 1100));
  const scale = w / deck.width;
  return (
    <div
      className="fv-scroll fv-slides"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        const mid = el.scrollTop + el.clientHeight / 2;
        for (const s of el.querySelectorAll<HTMLElement>("[data-slide]")) if (s.offsetTop + s.offsetHeight > mid) return setCur(Number(s.dataset.slide));
      }}
    >
      {width > 0 &&
        deck.slides.map((s, n) => (
          <div key={n} data-slide={n} className="fv-slide" style={{ width: w, height: deck.height * scale }}>
            <div
              className="fv-slide-inner"
              style={{
                width: deck.width,
                height: deck.height,
                transform: `scale(${scale})`,
                background: s.background ?? "#fff",
                backgroundImage: s.backgroundImage ? `url(${s.backgroundImage})` : undefined,
              }}
            >
              {s.shapes.map((sh, k) => <SlideShape key={k} s={sh} />)}
            </div>
          </div>
        ))}
    </div>
  );
}
function SlideShape({ s }: { s: Shape }) {
  const pos = { left: s.x, top: s.y, width: s.w, height: s.h };
  if (s.kind === "image") return <img className="fv-sh" src={s.src} alt="" style={pos} draggable={false} />;
  if (s.kind === "box") return <div className="fv-sh" style={{ ...pos, background: s.fill }} />;
  const justify = s.anchor === "ctr" ? "center" : s.anchor === "b" ? "flex-end" : "flex-start";
  return (
    <div className="fv-sh fv-sh-text" style={{ ...pos, background: s.fill, justifyContent: s.title && !s.anchor ? "center" : justify }}>
      {s.paras.map((p, i) => (
        <p
          key={i}
          style={{
            textAlign: p.align === "ctr" ? "center" : p.align === "r" ? "right" : p.align === "just" ? "justify" : "left",
            paddingLeft: p.level * 28 + (p.bullet ? 22 : 0),
            fontSize: (p.runs.find((r) => r.size)?.size ?? 18) * 1.333,
          }}
          className={p.bullet ? "bullet" : undefined}
        >
          {p.runs.length ? p.runs.map((r, k) =>
            r.text === "\n" ? <br key={k} /> : (
              <span key={k} style={{ fontSize: r.size ? r.size * 1.333 : undefined, fontWeight: r.bold ? 700 : undefined, fontStyle: r.italic ? "italic" : undefined, color: r.color }}>
                {r.text}
              </span>
            ),
          ) : " "}
        </p>
      ))}
    </div>
  );
}

// ---- iWork --------------------------------------------------------------------------------------------
function IworkView(b: BodyProps) {
  const { value: url, error, loading } = useParsed(
    b.f,
    async (buf) => (await import("./office")).iworkPreview(buf),
    (u) => u && URL.revokeObjectURL(u),
  );
  useEffect(() => b.setTools({ node: null }), []);
  if (error || (!loading && !url))
    return <Failed {...b} error="This iWork file has no saved preview. Open it in Keynote, Pages or Numbers, or export it to PDF or Office format." />;
  if (loading) return <Loading />;
  return (
    <div className="fv-stage">
      <img src={url!} alt={`Preview of ${b.f.name}`} />
      <p className="fv-note fv-float">Preview saved by {/\.key$/i.test(b.f.name) ? "Keynote" : /\.numbers$/i.test(b.f.name) ? "Numbers" : "Pages"}</p>
    </div>
  );
}

// ---- zip archives -------------------------------------------------------------------------------------
function ZipView(b: BodyProps) {
  const { value: entries, error, loading } = useParsed(b.f, async (buf) => (await import("./office")).listZip(buf));
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const canExtract = b.f.operations.includes("unarchive");
  useEffect(() => {
    b.setTools({
      node: canExtract ? (
        <button
          className="btn small primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await mutate("files.unarchive", { path: b.f.path });
              toast("Extracted next to the archive");
              b.onChanged();
            } catch (e) {
              toast((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Icon name="extract" size={17} />
          {busy ? "Extracting…" : "Extract"}
        </button>
      ) : null,
    });
  }, [busy]);
  if (error) return <Failed {...b} error={error} />;
  if (loading || !entries) return <Loading />;
  const files = entries.filter((e: ZipEntry) => !e.dir);
  const total = files.reduce((n, e) => n + e.size, 0);
  return (
    <div className="fv-scroll">
      <div className="fv-zip">
        <p className="muted">{files.length.toLocaleString()} {files.length === 1 ? "file" : "files"} · {bytes(total)} uncompressed</p>
        <ul className="glass">
          {entries.slice(0, 5000).map((e) => {
            const depth = e.name.replace(/\/$/, "").split("/").length - 1;
            const name = e.name.replace(/\/$/, "").split("/").pop();
            return (
              <li key={e.name} style={{ paddingLeft: 14 + depth * 18 }}>
                <Icon name={e.dir ? "folder-filled" : "file"} size={17} className={e.dir ? "dir" : "muted"} />
                <span>{name}</span>
                {!e.dir && <span className="muted">{bytes(e.size)}</span>}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// ---- fonts --------------------------------------------------------------------------------------------
function FontView(b: BodyProps) {
  const [family, setFamily] = useState<string | null>(null);
  const { buf, error } = useBytes(b.f);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => b.setTools({ node: null }), []);
  useEffect(() => {
    if (!buf) return;
    const name = `fv-font-${Math.random().toString(36).slice(2)}`;
    const face = new FontFace(name, buf);
    face.load().then(
      () => (document.fonts.add(face), setFamily(name)),
      () => setFailed("This font couldn’t be loaded."),
    );
    return () => void document.fonts.delete(face);
  }, [buf]);
  if (error || failed) return <Failed {...b} error={error ?? failed!} />;
  if (!family) return <Loading />;
  return (
    <div className="fv-scroll">
      <div className="fv-font" style={{ fontFamily: family }}>
        <p style={{ fontSize: 64 }}>Aa Bb Cc</p>
        <p style={{ fontSize: 34 }}>The quick brown fox jumps over the lazy dog.</p>
        <p style={{ fontSize: 22 }}>ABCDEFGHIJKLMNOPQRSTUVWXYZ<br />abcdefghijklmnopqrstuvwxyz<br />0123456789 !?&amp;@#%()[]</p>
        {[14, 18, 24, 32, 48].map((s) => (
          <p key={s} style={{ fontSize: s }}>
            <small>{s}</small> Your files, your cloud, your rules.
          </p>
        ))}
      </div>
    </div>
  );
}
