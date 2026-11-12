// Small, read-only readers for Office Open XML (xlsx, pptx) and iWork previews.
// They run in the browser on bytes fetched from /api/files/view; nothing is executed from the file.
import type JSZipType from "jszip";

type Zip = JSZipType;
const xml = (s: string) => new DOMParser().parseFromString(s, "application/xml");
const all = (n: Element | Document, local: string) => [...n.getElementsByTagNameNS("*", local)];
const first = (n: Element | Document | null | undefined, local: string) =>
  (n ? n.getElementsByTagNameNS("*", local)[0] : undefined) ?? null;
const kids = (n: Element, local?: string) => [...n.children].filter((c) => !local || c.localName === local);
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export async function openZip(buf: ArrayBuffer): Promise<Zip> {
  const { default: JSZip } = await import("jszip");
  return JSZip.loadAsync(buf);
}
const read = async (zip: Zip, path: string) => {
  const f = zip.file(path.replace(/^\//, ""));
  return f ? f.async("string") : null;
};
// Relationship targets of a part, resolved to zip paths.
async function rels(zip: Zip, part: string): Promise<Map<string, string>> {
  const dir = part.slice(0, part.lastIndexOf("/") + 1);
  const relsPath = `${dir}_rels/${part.slice(part.lastIndexOf("/") + 1)}.rels`;
  const txt = await read(zip, relsPath);
  const out = new Map<string, string>();
  if (!txt) return out;
  for (const r of all(xml(txt), "Relationship")) {
    const target = r.getAttribute("Target") ?? "";
    if (r.getAttribute("TargetMode") === "External") continue;
    out.set(r.getAttribute("Id") ?? "", resolve(dir, target));
  }
  return out;
}
function resolve(dir: string, target: string) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = (dir + target).split("/");
  const outp: string[] = [];
  for (const p of parts) {
    if (p === "..") outp.pop();
    else if (p !== ".") outp.push(p);
  }
  return outp.join("/");
}

// ---- spreadsheets (.xlsx / .xlsm) ------------------------------------------------------------
export type Sheet = { name: string; rows: string[][]; truncated: boolean };
const MAX_ROWS = 5000;
const MAX_COLS = 200;
const colIndex = (ref: string) => {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};
const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
function excelDate(serial: number, withTime: boolean) {
  const d = new Date(Math.round((serial - 25569) * 86400 * 1000));
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  const day = iso.slice(0, 10);
  if (!withTime) return day;
  const time = iso.slice(11, 16);
  return serial < 1 ? time : `${day} ${time}`;
}
const cleanNum = (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1e10) / 1e10);
};

export async function readXlsx(buf: ArrayBuffer): Promise<Sheet[]> {
  const zip = await openZip(buf);
  const wbPath = "xl/workbook.xml";
  const wb = await read(zip, wbPath);
  if (!wb) throw new Error("This isn’t an Excel workbook");
  const wbRels = await rels(zip, wbPath);
  const shared: string[] = [];
  const sst = await read(zip, "xl/sharedStrings.xml");
  if (sst) for (const si of all(xml(sst), "si")) shared.push(all(si, "t").map((t) => t.textContent ?? "").join(""));
  // Which number formats are dates.
  const dateStyles: (null | "date" | "datetime")[] = [];
  const st = await read(zip, "xl/styles.xml");
  if (st) {
    const doc = xml(st);
    const custom = new Map<number, string>();
    for (const nf of all(doc, "numFmt")) custom.set(Number(nf.getAttribute("numFmtId")), nf.getAttribute("formatCode") ?? "");
    const xfs = first(doc, "cellXfs");
    if (xfs)
      for (const xf of kids(xfs, "xf")) {
        const id = Number(xf.getAttribute("numFmtId") ?? 0);
        const code = (custom.get(id) ?? "").replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
        const isDate = DATE_IDS.has(id) || (custom.has(id) && /[dmy]/i.test(code) && !/^[#0.,%\s]*$/.test(code));
        dateStyles.push(isDate ? (/[hs]/i.test(code) || [18, 19, 20, 21, 22, 45, 46, 47].includes(id) ? "datetime" : "date") : null);
      }
  }
  const sheets: Sheet[] = [];
  for (const s of all(xml(wb), "sheet")) {
    const name = s.getAttribute("name") ?? `Sheet ${sheets.length + 1}`;
    const rid = s.getAttributeNS(R_NS, "id") ?? s.getAttribute("r:id") ?? "";
    const path = wbRels.get(rid);
    const txt = path ? await read(zip, path) : null;
    if (!txt) continue;
    const rows: string[][] = [];
    let truncated = false;
    for (const row of all(xml(txt), "row")) {
      const r = Number(row.getAttribute("r") ?? rows.length + 1) - 1;
      if (r >= MAX_ROWS) {
        truncated = true;
        break;
      }
      const out: string[] = [];
      kids(row, "c").forEach((c, i) => {
        const ref = c.getAttribute("r");
        const ci = ref ? colIndex(ref) : i;
        if (ci >= MAX_COLS) return (truncated = true);
        const t = c.getAttribute("t");
        const v = first(c, "v")?.textContent ?? "";
        let val = "";
        if (t === "s") val = shared[Number(v)] ?? "";
        else if (t === "inlineStr") val = all(c, "t").map((x) => x.textContent ?? "").join("");
        else if (t === "b") val = v === "1" ? "TRUE" : "FALSE";
        else if (t === "str" || t === "e") val = v;
        else if (v !== "") {
          const ds = dateStyles[Number(c.getAttribute("s") ?? -1)];
          val = ds ? excelDate(Number(v), ds === "datetime") : cleanNum(v);
        }
        out[ci] = val;
      });
      rows[r] = Array.from(out, (x) => x ?? "");
    }
    sheets.push({ name, rows: Array.from(rows, (x) => x ?? []), truncated });
  }
  return sheets;
}

// ---- CSV / TSV ---------------------------------------------------------------------------------
export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') (cell += '"'), i++;
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) row.push(cell), (cell = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += ch;
  }
  if (cell !== "" || row.length) row.push(cell), rows.push(row);
  return rows;
}
export function toDelimited(rows: string[][], sep: string): string {
  const q = (c: string) => (c.includes(sep) || /["\r\n]/.test(c) || /^\s|\s$/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return rows.map((r) => r.map(q).join(sep)).join("\n") + "\n";
}

// ---- presentations (.pptx) ---------------------------------------------------------------------
export type Run = { text: string; size?: number; bold?: boolean; italic?: boolean; color?: string };
export type Para = { runs: Run[]; align?: string; bullet?: boolean; level: number };
export type Shape =
  | { kind: "text"; x: number; y: number; w: number; h: number; fill?: string; paras: Para[]; anchor?: string; title?: boolean }
  | { kind: "image"; x: number; y: number; w: number; h: number; src: string }
  | { kind: "box"; x: number; y: number; w: number; h: number; fill: string };
export type Slide = { background?: string; backgroundImage?: string; shapes: Shape[] };
export type Deck = { width: number; height: number; slides: Slide[]; urls: string[] };

type Xfrm = { x: number; y: number; w: number; h: number };
const EMU = 9525; // per CSS pixel at 96 dpi
function xfrmOf(el: Element): Xfrm | null {
  const spPr = kids(el).find((c) => c.localName === "spPr" || c.localName === "grpSpPr") ?? kids(el).find((c) => c.localName === "xfrm");
  const x = spPr?.localName === "xfrm" ? spPr : spPr ? first(spPr, "xfrm") : first(el, "xfrm");
  const off = x && first(x, "off");
  const ext = x && first(x, "ext");
  if (!off || !ext) return null;
  return {
    x: Number(off.getAttribute("x")) / EMU,
    y: Number(off.getAttribute("y")) / EMU,
    w: Number(ext.getAttribute("cx")) / EMU,
    h: Number(ext.getAttribute("cy")) / EMU,
  };
}
const phKey = (el: Element) => {
  const ph = first(el, "ph");
  if (!ph) return null;
  return { type: ph.getAttribute("type") ?? "body", idx: ph.getAttribute("idx") };
};

export async function readPptx(buf: ArrayBuffer): Promise<Deck> {
  const zip = await openZip(buf);
  const presPath = "ppt/presentation.xml";
  const pres = await read(zip, presPath);
  if (!pres) throw new Error("This isn’t a PowerPoint deck");
  const pdoc = xml(pres);
  const sz = first(pdoc, "sldSz");
  const width = Number(sz?.getAttribute("cx") ?? 12192000) / EMU;
  const height = Number(sz?.getAttribute("cy") ?? 6858000) / EMU;
  const presRels = await rels(zip, presPath);
  const urls: string[] = [];
  const blobUrl = async (path: string) => {
    const f = zip.file(path);
    if (!f) return null;
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    const type = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", bmp: "image/bmp" }[ext];
    if (!type) return null; // emf/wmf/tiff etc. can't be drawn by a browser
    const u = URL.createObjectURL(new Blob([await f.async("arraybuffer")], { type }));
    urls.push(u);
    return u;
  };
  // Theme colours.
  const scheme = new Map<string, string>();
  for (const [, target] of presRels) {
    if (!/slideMasters\//.test(target)) continue;
    const mRels = await rels(zip, target);
    for (const [, t] of mRels)
      if (/theme\//.test(t)) {
        const th = await read(zip, t);
        const cs = th ? first(xml(th), "clrScheme") : null;
        if (cs)
          for (const c of kids(cs)) {
            const v = first(c, "srgbClr")?.getAttribute("val") ?? first(c, "sysClr")?.getAttribute("lastClr");
            if (v) scheme.set(c.localName, `#${v}`);
          }
      }
    break;
  }
  const alias: Record<string, string> = { tx1: "dk1", tx2: "dk2", bg1: "lt1", bg2: "lt2" };
  const color = (el: Element | null | undefined): string | undefined => {
    if (!el) return;
    const s = first(el, "srgbClr")?.getAttribute("val");
    if (s) return `#${s}`;
    const sc = first(el, "schemeClr")?.getAttribute("val");
    if (sc) return scheme.get(alias[sc] ?? sc);
    const sys = first(el, "sysClr")?.getAttribute("lastClr");
    return sys ? `#${sys}` : undefined;
  };
  const fillOf = (el: Element) => {
    const spPr = kids(el, "spPr")[0];
    const sf = spPr && kids(spPr, "solidFill")[0];
    return sf ? color(sf) : undefined;
  };
  // Placeholder positions from a layout or master.
  type Ph = { x?: Xfrm; size?: number; algn?: string; anchor?: string };
  const placeholders = async (part: string) => {
    const txt = await read(zip, part);
    const map = new Map<string, Ph>();
    if (!txt) return map;
    for (const sp of all(xml(txt), "sp")) {
      const k = phKey(sp);
      if (!k) continue;
      const lvl1 = first(first(sp, "lstStyle"), "lvl1pPr");
      const sz = first(lvl1, "defRPr")?.getAttribute("sz");
      const ph: Ph = {
        x: xfrmOf(sp) ?? undefined,
        size: sz ? Number(sz) / 100 : undefined,
        algn: lvl1?.getAttribute("algn") ?? undefined,
        anchor: first(sp, "bodyPr")?.getAttribute("anchor") ?? undefined,
      };
      if (k.idx) map.set(`idx:${k.idx}`, ph);
      map.set(`type:${k.type}`, ph);
    }
    return map;
  };
  // The master's default text styles: title, and body by outline level.
  const masterStyles = async (part: string) => {
    const txt = await read(zip, part);
    const out = { title: 44, titleAlgn: undefined as string | undefined, body: [32, 28, 24, 20, 20, 20, 20, 20, 20], other: 18 };
    if (!txt) return out;
    const doc = xml(txt);
    const sizeIn = (el: Element | null, lvl: number) => {
      const v = first(first(el, `lvl${lvl}pPr`), "defRPr")?.getAttribute("sz");
      return v ? Number(v) / 100 : undefined;
    };
    const ts = first(doc, "titleStyle");
    out.title = sizeIn(ts, 1) ?? out.title;
    out.titleAlgn = first(ts, "lvl1pPr")?.getAttribute("algn") ?? undefined;
    const bs = first(doc, "bodyStyle");
    out.body = out.body.map((d, i) => sizeIn(bs, i + 1) ?? d);
    out.other = sizeIn(first(doc, "otherStyle"), 1) ?? out.other;
    return out;
  };
  const sldIds = all(pdoc, "sldId");
  const slides: Slide[] = [];
  for (const id of sldIds) {
    const rid = id.getAttributeNS(R_NS, "id") ?? id.getAttribute("r:id") ?? "";
    const path = presRels.get(rid);
    const txt = path ? await read(zip, path) : null;
    if (!path || !txt) continue;
    const sRels = await rels(zip, path);
    const layout = [...sRels.values()].find((t) => /slideLayouts\//.test(t));
    const lph = layout ? await placeholders(layout) : new Map<string, Ph>();
    const master = layout ? [...(await rels(zip, layout)).values()].find((t) => /slideMasters\//.test(t)) : undefined;
    const mph = master ? await placeholders(master) : new Map<string, Ph>();
    const ms = await masterStyles(master ?? "");
    const doc = xml(txt);
    const slide: Slide = { shapes: [] };
    const bg = first(doc, "bg");
    if (bg) {
      slide.background = color(first(bg, "solidFill"));
      const blip = first(bg, "blip");
      const rel = blip?.getAttributeNS(R_NS, "embed");
      if (rel && sRels.get(rel)) slide.backgroundImage = (await blobUrl(sRels.get(rel)!)) ?? undefined;
    }
    const walk = async (parent: Element, map: (x: Xfrm) => Xfrm) => {
      for (const el of kids(parent)) {
        if (el.localName === "grpSp") {
          const gx = xfrmOf(el);
          const gpr = kids(el, "grpSpPr")[0];
          const xf = gpr && first(gpr, "xfrm");
          const ch = xf && first(xf, "chOff");
          const ce = xf && first(xf, "chExt");
          if (gx && ch && ce) {
            const cx = Number(ch.getAttribute("x")) / EMU,
              cy = Number(ch.getAttribute("y")) / EMU;
            const sx = gx.w / (Number(ce.getAttribute("cx")) / EMU || 1),
              sy = gx.h / (Number(ce.getAttribute("cy")) / EMU || 1);
            await walk(el, (x) => map({ x: gx.x + (x.x - cx) * sx, y: gx.y + (x.y - cy) * sy, w: x.w * sx, h: x.h * sy }));
          } else await walk(el, map);
          continue;
        }
        if (el.localName === "pic") {
          const x = xfrmOf(el);
          const rel = first(el, "blip")?.getAttributeNS(R_NS, "embed");
          const src = rel && sRels.get(rel) ? await blobUrl(sRels.get(rel)!) : null;
          if (x && src) slide.shapes.push({ kind: "image", ...map(x), src });
          continue;
        }
        if (el.localName !== "sp") continue;
        const k = phKey(el);
        if (k && /sldNum|dt|ftr/.test(k.type)) continue;
        // Inherited placeholder settings: the layout first, then the master.
        const chain = k
          ? [lph.get(`idx:${k.idx}`), lph.get(`type:${k.type}`), mph.get(`type:${k.type}`), mph.get(`idx:${k.idx}`), k.type === "ctrTitle" ? mph.get("type:title") : undefined, k.type === "subTitle" ? mph.get("type:body") : undefined].filter((v): v is Ph => !!v)
          : [];
        const inherit = <K extends keyof Ph>(key: K) => chain.find((c) => c[key] !== undefined)?.[key];
        const isTitle = !!k && /title|ctrTitle/i.test(k.type) && k.type !== "subTitle";
        const x = xfrmOf(el) ?? inherit("x") ?? null;
        if (!x) continue;
        const phSize = inherit("size");
        const baseSize = (lvl: number) => phSize ?? (isTitle ? ms.title : k ? ms.body[Math.min(lvl, 8)] : ms.other);
        const baseAlgn = inherit("algn") ?? (isTitle ? ms.titleAlgn : undefined);
        const fill = fillOf(el);
        const body = first(el, "txBody");
        const paras: Para[] = [];
        if (body)
          for (const p of kids(body, "p")) {
            const pPr = kids(p, "pPr")[0];
            const runs: Run[] = [];
            for (const r of kids(p)) {
              if (r.localName === "br") runs.push({ text: "\n" });
              if (r.localName !== "r" && r.localName !== "fld") continue;
              const rPr = kids(r, "rPr")[0];
              const sz = rPr?.getAttribute("sz") ?? first(pPr ?? null, "defRPr")?.getAttribute("sz");
              runs.push({
                text: first(r, "t")?.textContent ?? "",
                size: sz ? Number(sz) / 100 : undefined,
                bold: rPr?.getAttribute("b") === "1",
                italic: rPr?.getAttribute("i") === "1",
                color: rPr ? color(kids(rPr, "solidFill")[0]) : undefined,
              });
            }
            const level = Number(pPr?.getAttribute("lvl") ?? 0);
            for (const r of runs) r.size ??= baseSize(level);
            paras.push({
              runs,
              align: pPr?.getAttribute("algn") ?? baseAlgn,
              level,
              bullet: !!k && k.type === "body" && runs.some((r) => r.text.trim()) && !first(pPr ?? null, "buNone"),
            });
          }
        const hasText = paras.some((p) => p.runs.some((r) => r.text.trim()));
        if (!hasText && fill) slide.shapes.push({ kind: "box", ...map(x), fill });
        else if (hasText)
          slide.shapes.push({
            kind: "text",
            ...map(x),
            fill,
            paras,
            anchor: first(body, "bodyPr")?.getAttribute("anchor") ?? inherit("anchor") ?? (isTitle ? "ctr" : undefined),
            title: isTitle,
          });
      }
    };
    const tree = first(doc, "spTree");
    if (tree) await walk(tree, (x) => x);
    slides.push(slide);
  }
  return { width, height, slides, urls };
}

// ---- iWork (Keynote, Pages, Numbers): only the preview image the app saves inside -----------
export async function iworkPreview(buf: ArrayBuffer): Promise<string | null> {
  const zip = await openZip(buf);
  for (const name of ["preview.jpg", "preview-web.jpg", "QuickLook/Thumbnail.jpg", "preview-micro.jpg"]) {
    const f = zip.file(name);
    if (f) return URL.createObjectURL(new Blob([await f.async("arraybuffer")], { type: "image/jpeg" }));
  }
  return null;
}

// ---- zip listing -------------------------------------------------------------------------------
export type ZipEntry = { name: string; dir: boolean; size: number; date?: Date };
export async function listZip(buf: ArrayBuffer): Promise<ZipEntry[]> {
  const zip = await openZip(buf);
  const out: ZipEntry[] = [];
  zip.forEach((path, f) => {
    if (path.startsWith("__MACOSX/") || /(^|\/)\._/.test(path)) return;
    out.push({
      name: path,
      dir: f.dir,
      size: (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0,
      date: f.date,
    });
  });
  // Folders that only exist implicitly in file paths.
  const dirs = new Set(out.filter((e) => e.dir).map((e) => e.name));
  for (const e of [...out])
    for (let i = e.name.indexOf("/"); i > 0 && i < e.name.length - 1; i = e.name.indexOf("/", i + 1)) {
      const d = e.name.slice(0, i + 1);
      if (!dirs.has(d)) dirs.add(d), out.push({ name: d, dir: true, size: 0 });
    }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
