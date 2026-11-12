// Files: the Umbrel as a NAS. Browse, preview, upload, download, organise, share on the network.
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  mutate,
  query,
  type FileEntry,
  type Listing,
  type SmbShare,
} from "../api";
import { useBootstrap, useDisk, useUser } from "../data";
import { Icon, type IconName } from "../icons";
import { Sheet, SheetHeader, bytes, haptic, useConfirm, usePortalRoot, useToast } from "../ui";
import { SearchField } from "./Apps";
import { useDesktop } from "../desktop/Desktop";
import { FileViewer } from "./viewer/FileViewer";

// ---- helpers --------------------------------------------------------------------
const isDir = (f: FileEntry) => f.type === "directory";
const enc = encodeURIComponent;
export const viewUrl = (path: string) => `/api/files/view?path=${enc(path)}`;
export const downloadUrl = (paths: string[]) =>
  `/api/files/download?${paths.map((p) => `path=${enc(p)}`).join("&")}`;
const thumbUrl = (f: FileEntry) =>
  f.thumbnail
    ? `/api/files/thumbnail/${enc(f.thumbnail)}?path=${enc(f.path)}`
    : null;
const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const ext = (name: string) =>
  name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";

type Kind =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  | "sheet"
  | "doc"
  | "zip"
  | "disc"
  | "file";
function kindOf(f: FileEntry): Kind {
  if (isDir(f)) return "folder";
  const t = f.type;
  const e = ext(f.name);
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  if (t === "application/pdf") return "pdf";
  if (
    t.startsWith("text/") ||
    [
      "md",
      "json",
      "yml",
      "yaml",
      "log",
      "conf",
      "sh",
      "js",
      "ts",
      "py",
      "csv",
      "env",
      "toml",
      "ini",
      "xml",
    ].includes(e)
  )
    return "text";
  if (
    /spreadsheet|excel|csv/.test(t) ||
    ["xlsx", "xls", "numbers", "ods"].includes(e)
  )
    return "sheet";
  if (
    /word|document|rtf/.test(t) ||
    ["doc", "docx", "pages", "odt"].includes(e)
  )
    return "doc";
  if (
    /zip|tar|gzip|7z|rar|compressed/.test(t) ||
    ["zip", "gz", "tgz", "tar", "7z", "rar", "xz"].includes(e)
  )
    return "zip";
  if (
    /iso9660|disk-image/.test(t) ||
    ["iso", "img", "qcow2", "dmg"].includes(e)
  )
    return "disc";
  return "file";
}
const KIND_LOOK: Record<Kind, { icon: IconName; color: string }> = {
  folder: { icon: "folder-filled", color: "#60a5fa" },
  image: { icon: "image", color: "#f472b6" },
  video: { icon: "video", color: "#c084fc" },
  audio: { icon: "music", color: "#fb923c" },
  pdf: { icon: "pdf", color: "#f87171" },
  text: { icon: "file-text", color: "#a1a1aa" },
  sheet: { icon: "sheet", color: "#4ade80" },
  doc: { icon: "doc", color: "#60a5fa" },
  zip: { icon: "zip", color: "#facc15" },
  disc: { icon: "disc", color: "#2dd4bf" },
  file: { icon: "file", color: "#a1a1aa" },
};
const ago = (t: number) => {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} d ago`;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      new Date(t).getFullYear() === new Date().getFullYear()
        ? undefined
        : "numeric",
  });
};
const nice = (msg: string) =>
  ({
    "[destination-already-exists]": "Something with that name is already there",
    "[does-not-exist]": "That item no longer exists",
    "[subdir-of-self]": "A folder can’t go inside itself",
    "[operation-not-allowed]": "That isn’t allowed here",
  })[msg] ?? msg.replace(/^\[|\]$/g, "").replace(/-/g, " ");

const PLACE_NAMES: Record<string, string> = {
  "/Home": "Home",
  "/Apps": "App data",
  "/External": "External drives",
  "/Network": "Network",
  "/Trash": "Trash",
  "/Backups": "Backups",
  "/Machines": "Machines",
};
// Photos synced from your phone or computer live here (a normal folder in Home).
const PHOTOS = "/Home/Photos";
const titleOf = (path: string) => PLACE_NAMES[path] ?? baseName(path);

function FileIcon({ f, size = 44 }: { f: FileEntry; size?: number }) {
  const [failed, setFailed] = useState(false);
  const k = kindOf(f);
  const look = KIND_LOOK[k];
  const thumb = thumbUrl(f);
  if (thumb && !failed)
    return (
      <span className="file-icon thumb" style={{ width: size, height: size }}>
        <img
          src={thumb}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          draggable={false}
        />
      </span>
    );
  return (
    <span
      className="file-icon"
      style={{ width: size, height: size, "--c": look.color } as CSSProperties}
    >
      <Icon name={look.icon} size={size * 0.52} stroke={1.6} />
    </span>
  );
}

// ---- data ---------------------------------------------------------------------------
function useListing(path: string | null, sort: "name" | "modified" | "size") {
  return useQuery({
    queryKey: ["files.list", path, sort],
    queryFn: () =>
      query<Listing>("files.list", {
        path,
        sortBy: sort,
        sortOrder: sort === "name" ? "ascending" : "descending",
        limit: 2000,
      }),
    enabled: !!path && !path.startsWith("::"),
    refetchInterval: 15_000,
  });
}

function useFileAction() {
  const qc = useQueryClient();
  const toast = useToast();
  return async (path: string, input: unknown, done?: string) => {
    try {
      const result = await mutate(path, input);
      if (done) toast(done);
      return result;
    } catch (e) {
      toast(nice((e as Error).message), true);
      throw e;
    } finally {
      qc.invalidateQueries({ queryKey: ["files.list"] });
      qc.invalidateQueries({ queryKey: ["files.favorites"] });
      qc.invalidateQueries({ queryKey: ["files.recents"] });
      qc.invalidateQueries({ queryKey: ["files.shares"] });
    }
  };
}

// ---- uploads ----------------------------------------------------------------------------
type Upload = {
  id: number;
  name: string;
  loaded: number;
  total: number;
  state: "uploading" | "done" | "error";
  error?: string;
};
// An upload item: a file plus, for folder uploads, its path inside the dropped/picked folder.
export type UploadItem = { file: File; rel?: string };

function uploadOne(
  item: UploadItem,
  dir: string,
  onProgress: (loaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = `${dir}/${item.rel ?? item.file.name}`;
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/files/upload?path=${enc(target)}&collision=keep-both`);
    xhr.setRequestHeader("x-umbrel-touch", "1");
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = `Upload failed (${xhr.status})`;
      try {
        message = JSON.parse(xhr.responseText)?.error?.message ?? message;
      } catch {
        /* not JSON */
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("Connection lost"));
    xhr.send(item.file);
  });
}

function useUploads(onDone: () => void) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const toast = useToast();
  const start = async (input: FileList | File[] | UploadItem[], dir: string) => {
    const items: UploadItem[] = Array.from(input as ArrayLike<File | UploadItem>).map((x) =>
      x instanceof File
        ? { file: x, rel: (x as File & { webkitRelativePath?: string }).webkitRelativePath || undefined }
        : x,
    );
    if (!items.length) return;
    haptic(8);
    const ids = items.map(() => Math.random());
    setUploads((u) => [
      ...u,
      ...items.map((it, i) => ({
        id: ids[i],
        name: it.rel ?? it.file.name,
        loaded: 0,
        total: it.file.size,
        state: "uploading" as const,
      })),
    ]);
    // Folder uploads: make the folders first (parents before children). One that already
    // exists is fine: files land inside it, and name clashes keep both copies.
    const dirs = [
      ...new Set(
        items.flatMap((it) => {
          const parts = (it.rel ?? "").split("/").slice(0, -1);
          return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
        }),
      ),
    ].sort((x, y) => x.split("/").length - y.split("/").length);
    for (const d of dirs) await mutate("files.createDirectory", { path: `${dir}/${d}` }).catch(() => {});
    // Three at a time, so a folder of hundreds of files doesn't swamp the connection.
    let next = 0;
    let failed = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        const it = items[i];
        try {
          await uploadOne(it, dir, (loaded) =>
            setUploads((u) => u.map((x) => (x.id === ids[i] ? { ...x, loaded } : x))),
          );
          setUploads((u) => u.map((x) => (x.id === ids[i] ? { ...x, state: "done", loaded: x.total } : x)));
        } catch (e) {
          failed++;
          setUploads((u) => u.map((x) => (x.id === ids[i] ? { ...x, state: "error", error: (e as Error).message } : x)));
          if (failed <= 3) toast(`${it.rel ?? it.file.name}: ${nice((e as Error).message)}`, true);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, items.length) }, worker));
    onDone();
    if (failed > 3) toast(`${failed} files didn’t upload`, true);
    window.setTimeout(() => setUploads((u) => (u.some((x) => x.state !== "done") ? u : [])), 2500);
  };
  const clear = () => setUploads((u) => u.filter((x) => x.state === "uploading"));
  return { uploads, start, clear };
}

// Files and folders dropped from the computer. Folders are walked so their structure is kept.
async function droppedItems(dt: DataTransfer): Promise<UploadItem[]> {
  const entries = [...dt.items]
    .map((i) => (i.kind === "file" ? (i as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.() : null))
    .filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return [...dt.files].map((file) => ({ file }));
  const out: UploadItem[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, rel: prefix ? `${prefix}/${file.name}` : undefined });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, path);
      }
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}

// ---- screen -----------------------------------------------------------------------------
type Place = {
  path: string;
  label: string;
  icon: IconName;
  color: string;
  sub?: string;
};

export function Files({ initialPath }: { initialPath?: string } = {}) {
  const portalRoot = usePortalRoot();
  const boot = useBootstrap();
  const user = useUser();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const act = useFileAction();
  const disk = useDisk();
  const [path, setPath] = useState<string | null>(() =>
    initialPath ?? sessionStorage.getItem("umbrel-touch:files-path"),
  );
  const [sort, setSort] = useState<"name" | "modified" | "size">("name");
  const [grid, setGrid] = useState(
    () => localStorage.getItem("umbrel-touch:files-grid") === "1",
  );
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<FileEntry | null>(null);
  // The full-window viewer: the files you can step through, and where you started.
  const [viewing, setViewing] = useState<{ files: FileEntry[]; index: number } | null>(null);
  const [picker, setPicker] = useState<{
    mode: "move" | "copy";
    paths: string[];
  } | null>(null);
  const [prompt, setPrompt] = useState<{
    kind: "folder" | "rename";
    entry?: FileEntry;
  } | null>(null);
  const [shareInfo, setShareInfo] = useState<SmbShare | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const refresh = () => qc.invalidateQueries({ queryKey: ["files.list"] });
  const { uploads, start: upload, clear: clearUploads } = useUploads(refresh);

  useEffect(() => {
    if (path) sessionStorage.setItem("umbrel-touch:files-path", path);
    else sessionStorage.removeItem("umbrel-touch:files-path");
    setSelected(new Set());
  }, [path]);

  const listing = useListing(path, sort);
  const recents = useQuery({
    queryKey: ["files.recents"],
    queryFn: () => query<FileEntry[]>("files.recents"),
    enabled: path === null || path === "::recents",
  });
  const favorites = useQuery({
    queryKey: ["files.favorites"],
    queryFn: () => query<string[]>("files.favorites"),
  });
  const shares = useQuery({
    queryKey: ["files.shares"],
    queryFn: () => query<SmbShare[]>("files.shares"),
    retry: false,
  });
  const search = useQuery({
    queryKey: ["files.search", q],
    queryFn: () =>
      query<FileEntry[]>("files.search", { query: q, maxResults: 100 }),
    enabled: q.trim().length >= 2,
    staleTime: 10_000,
  });
  const favSet = useMemo(() => new Set(favorites.data ?? []), [favorites.data]);
  const shareMap = useMemo(
    () => new Map((shares.data ?? []).map((s) => [s.path, s])),
    [shares.data],
  );

  const go = (p: string | null) => {
    haptic(5);
    setQ("");
    setPath(p);
    window.scrollTo({ top: 0 });
  };
  const up = () => {
    if (!path) return;
    if (
      path.startsWith("::") ||
      Object.hasOwn(PLACE_NAMES, path) ||
      path.split("/").length <= 2
    )
      return go(null);
    go(parentOf(path));
  };
  const inTrash = !!path && (path === "/Trash" || path.startsWith("/Trash/"));
  const selecting = selected.size > 0;
  // Where uploads go: the folder you're in (if umbrelOS says it's writable), or Home from the start page.
  const writableHere =
    !!path && !path.startsWith("::") && !inTrash && listing.data?.operations?.includes("writable") !== false && !listing.error;
  const uploadDir = path === null ? "/Home" : writableHere ? path : null;
  const canUpload = !!uploadDir;
  const finePointer = typeof matchMedia !== "undefined" && matchMedia("(pointer: fine)").matches;
  // iPhone/iPad Safari can't pick a whole folder; computers can.
  const canPickFolder = finePointer && "webkitdirectory" in HTMLInputElement.prototype;
  const toggle = (f: FileEntry) => {
    haptic(6);
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(f.path)) n.delete(f.path);
      else n.add(f.path);
      return n;
    });
  };
  const activate = (f: FileEntry) => {
    if (selecting) return toggle(f);
    if (isDir(f)) return go(f.path);
    haptic(6);
    if (inTrash || f.path.startsWith("/Trash/")) return setOpen(f);
    viewFile(f);
  };
  const viewFile = (f: FileEntry) => {
    const files = items.filter((x) => !isDir(x));
    const index = files.findIndex((x) => x.path === f.path);
    setViewing(index < 0 ? { files: [f], index: 0 } : { files, index });
  };

  const places: Place[] = [
    { path: "/Home", label: "Home", icon: "home", color: "#3b82f6" },
    { path: PHOTOS, label: "Photos", icon: "image", color: "#ec4899" },
    { path: "::recents", label: "Recents", icon: "history", color: "#f59e0b" },
    { path: "::favorites", label: "Favorites", icon: "star", color: "#eab308" },
    { path: "/Apps", label: "App data", icon: "apps", color: "#8b5cf6" },
    { path: "/External", label: "Drives", icon: "usb", color: "#14b8a6" },
    { path: "/Network", label: "Network", icon: "server", color: "#0ea5e9" },
    { path: "/Trash", label: "Trash", icon: "trash", color: "#71717a" },
  ];

  // Items shown in the current view.
  const items: FileEntry[] =
    q.trim().length >= 2
      ? (search.data ?? [])
      : path === "::recents"
        ? (recents.data ?? [])
        : path === "::favorites"
          ? (favorites.data ?? []).map(
              (p) =>
                ({
                  name: baseName(p) || p,
                  path: p,
                  type: "directory",
                  modified: 0,
                  operations: ["favorite"],
                }) as FileEntry,
            )
          : (listing.data?.files ?? []);
  const loading =
    q.trim().length >= 2
      ? search.isLoading
      : path === "::recents"
        ? recents.isLoading
        : path && !path.startsWith("::")
          ? listing.isLoading
          : false;

  const trashItems = async (paths: string[]) => {
    const ok = await confirm({
      title:
        paths.length === 1
          ? `Move “${baseName(paths[0])}” to Trash?`
          : `Move ${paths.length} items to Trash?`,
      body: "You can restore them from Trash later.",
      confirm: "Move to Trash",
      danger: true,
      icon: "trash",
    });
    if (!ok) return;
    for (const p of paths)
      await act("files.trash", { path: p }).catch(() => {});
    toast(
      paths.length === 1
        ? "Moved to Trash"
        : `${paths.length} items moved to Trash`,
    );
    setSelected(new Set());
    setOpen(null);
  };
  const deleteForever = async (paths: string[]) => {
    const ok = await confirm({
      title:
        paths.length === 1
          ? `Delete “${baseName(paths[0])}” forever?`
          : `Delete ${paths.length} items forever?`,
      body: "This can’t be undone.",
      confirm: "Delete forever",
      danger: true,
      icon: "trash",
    });
    if (!ok) return;
    for (const p of paths)
      await act("files.delete", { path: p }).catch(() => {});
    toast("Deleted");
    setSelected(new Set());
    setOpen(null);
  };
  const restore = async (paths: string[]) => {
    for (const p of paths)
      await act("files.restore", { path: p, collision: "keep-both" }).catch(
        () => {},
      );
    toast(paths.length === 1 ? "Restored" : `${paths.length} items restored`);
    setSelected(new Set());
    setOpen(null);
  };
  const emptyTrash = async () => {
    if (
      !(await confirm({
        title: "Empty Trash?",
        body: "Everything in Trash is deleted forever.",
        confirm: "Empty Trash",
        danger: true,
        icon: "trash",
      }))
    )
      return;
    await act("files.emptyTrash", undefined, "Trash emptied").catch(() => {});
  };
  const download = (paths: string[]) => {
    haptic(6);
    const a = document.createElement("a");
    a.href = downloadUrl(paths);
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(paths.length > 1 ? "Downloading as a zip" : "Downloading");
  };
  const toggleFavorite = (p: string) =>
    act(
      favSet.has(p) ? "files.removeFavorite" : "files.addFavorite",
      { path: p },
      favSet.has(p) ? "Removed from Favorites" : "Added to Favorites",
    );
  const toggleShare = async (f: FileEntry) => {
    const existing = shareMap.get(f.path);
    if (existing) {
      if (
        await confirm({
          title: `Stop sharing “${f.name}”?`,
          body: "Computers on your network will no longer see this folder.",
          confirm: "Stop sharing",
        })
      )
        await act(
          "files.removeShare",
          { path: f.path },
          "No longer shared",
        ).catch(() => {});
    } else {
      await act(
        "files.addShare",
        { path: f.path },
        "Shared on your network",
      ).catch(() => {});
      const fresh = await query<SmbShare[]>("files.shares").catch(() => []);
      const s = fresh.find((x) => x.path === f.path);
      if (s) {
        setOpen(null);
        setShareInfo(s);
      }
    }
  };
  const used = disk.data ? disk.data.totalUsed / disk.data.size : 0;

  const Header = (
    <div className="files-head">
      {path !== null ? (
        <button className="round-btn" aria-label="Back" onClick={up}>
          <Icon name="back" size={20} />
        </button>
      ) : null}
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 className="title" style={{ margin: 0 }}>
          {path === null
            ? "Files"
            : path === "::recents"
              ? "Recents"
              : path === "::favorites"
                ? "Favorites"
                : titleOf(path)}
        </h1>
        {path && !path.startsWith("::") && path.split("/").length > 2 && (
          <div className="crumbs">
            {path
              .split("/")
              .filter(Boolean)
              .slice(0, -1)
              .map((seg, i, arr) => {
                const p = `/${path
                  .split("/")
                  .filter(Boolean)
                  .slice(0, i + 1)
                  .join("/")}`;
                return (
                  <button key={p} onClick={() => go(p)}>
                    {titleOf(p)}
                    {i < arr.length - 1 && <Icon name="chevron" size={12} />}
                  </button>
                );
              })}
          </div>
        )}
      </div>
      {path && !path.startsWith("::") && (
        <>
          <button
            className="round-btn"
            aria-label={grid ? "List view" : "Grid view"}
            onClick={() => {
              haptic(5);
              setGrid((g) => {
                localStorage.setItem("umbrel-touch:files-grid", g ? "0" : "1");
                return !g;
              });
            }}
          >
            <Icon name={grid ? "list" : "grid"} size={19} />
          </button>
          <button
            className="round-btn"
            aria-label={`Sort by ${sort === "name" ? "date" : sort === "modified" ? "size" : "name"}`}
            onClick={() => {
              haptic(5);
              const next =
                sort === "name"
                  ? "modified"
                  : sort === "modified"
                    ? "size"
                    : "name";
              setSort(next);
              toast(`Sorted by ${next === "modified" ? "date" : next}`);
            }}
          >
            <Icon name="sort" size={19} />
          </button>
        </>
      )}
    </div>
  );

  const longPress = useLongPress((f) => {
    if (!f.operations.length) return;
    haptic(15);
    setSelected((s) => new Set(s).add(f.path));
  });
  const Row = ({ f }: { f: FileEntry }) => {
    const press = longPress(f);
    const sel = selected.has(f.path);
    const shared = shareMap.has(f.path);
    const sub = isDir(f)
      ? f.modified
        ? `Folder · ${ago(f.modified)}`
        : "Folder"
      : `${bytes(f.size)} · ${ago(f.modified)}`;
    if (grid)
      return (
        <button
          className={`file-tile${sel ? " sel" : ""}`}
          onClick={() => activate(f)}
          {...press}
        >
          <span className="tile-art">
            <FileIcon f={f} size={isDir(f) ? 64 : 92} />
            {selecting && (
              <Icon
                name={sel ? "checked" : "unchecked"}
                size={22}
                className="tile-check"
              />
            )}
          </span>
          <span className="name">{f.name}</span>
          <span className="sub">{isDir(f) ? "Folder" : bytes(f.size)}</span>
        </button>
      );
    return (
      <div
        className={`row file-row${sel ? " sel" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => activate(f)}
        onKeyDown={(e) => e.key === "Enter" && activate(f)}
        {...press}
      >
        {selecting && (
          <Icon
            name={sel ? "checked" : "unchecked"}
            size={24}
            className={`check${sel ? " on" : ""}`}
          />
        )}
        <FileIcon f={f} />
        <span className="main">
          <b>
            {f.name}
            {favSet.has(f.path) && (
              <Icon name="star-filled" size={13} className="fav" />
            )}
            {shared && (
              <Icon name="folder-share" size={14} className="shared" />
            )}
          </b>
          <span>{q ? parentOf(f.path) : sub}</span>
        </span>
        {!selecting && !inTrash && !f.path.startsWith("/Trash/") && (
          <button
            className="icon-btn row-dl"
            style={{ alignSelf: "center" }}
            aria-label={isDir(f) ? `Download ${f.name} as a zip` : `Download ${f.name}`}
            title={isDir(f) ? "Download as zip" : "Download"}
            onClick={(e) => {
              e.stopPropagation();
              download([f.path]);
            }}
          >
            <Icon name="download" size={18} />
          </button>
        )}
        {!selecting && (
          <button
            className="icon-btn"
            style={{ alignSelf: "center", background: "transparent" }}
            aria-label={`More for ${f.name}`}
            onClick={(e) => {
              e.stopPropagation();
              haptic(6);
              setOpen(f);
            }}
          >
            <Icon name="dots" size={18} />
          </button>
        )}
      </div>
    );
  };

  const onDragEnter = (e: React.DragEvent) => {
    if (!canUpload || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current++;
    setDropping(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!canUpload || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDropping(false);
  };
  const onDrop = async (e: React.DragEvent) => {
    if (!canUpload || !uploadDir) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDropping(false);
    const items = await droppedItems(e.dataTransfer).catch(() => [] as UploadItem[]);
    if (items.length) upload(items, uploadDir);
  };

  return (
    <div className="stagger files-root" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => (
          uploadDir && e.target.files && upload(e.target.files, uploadDir),
          (e.target.value = "")
        )}
      />
      <input
        ref={photoInput}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        onChange={(e) => {
          const picked = e.target.files ? [...e.target.files] : [];
          e.target.value = "";
          if (!picked.length) return;
          // Sync: upload only what isn't in Photos yet (same name and size).
          const have = new Set((listing.data?.files ?? []).map((f) => `${f.name}:${f.size}`));
          const fresh = picked.filter((f) => !have.has(`${f.name}:${f.size}`));
          const skipped = picked.length - fresh.length;
          if (!fresh.length) return toast(`All ${picked.length} already synced`);
          if (skipped) toast(`${fresh.length} new · ${skipped} already synced`);
          upload(fresh, PHOTOS);
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(e) => (
          uploadDir && e.target.files && upload(e.target.files, uploadDir),
          (e.target.value = "")
        )}
      />
      {Header}
      <SearchField
        value={q}
        onChange={setQ}
        placeholder={path === null ? "Search all files" : `Search files`}
      />
      {canUpload && !q && !selecting && (
        <div className="files-actions">
          {path === PHOTOS && (
            <button className="btn primary" onClick={() => photoInput.current?.click()} disabled={listing.isLoading}>
              <Icon name="restart" size={18} />
              Sync photos
            </button>
          )}
          <button className={`btn${path === PHOTOS ? "" : " primary"}`} onClick={() => fileInput.current?.click()}>
            <Icon name="upload" size={18} />
            {path === null ? "Upload to Home" : "Upload"}
          </button>
          {canPickFolder && (
            <button className="btn" onClick={() => folderInput.current?.click()}>
              <Icon name="folder-share" size={18} />
              Upload folder
            </button>
          )}
          {path !== null && (
            <button className="btn" onClick={() => setPrompt({ kind: "folder" })}>
              <Icon name="folder-plus" size={18} />
              New folder
            </button>
          )}
          {finePointer && <span className="drop-hint">or drop files here</span>}
        </div>
      )}

      {path === null && !q && (
        <>
          <div className="places">
            {places.map((p) => (
              <button
                key={p.path}
                className="glass place press"
                onClick={() =>
                  p.path === PHOTOS
                    ? mutate("files.createDirectory", { path: PHOTOS })
                        .catch(() => {})
                        .finally(() => go(PHOTOS))
                    : go(p.path)
                }
              >
                <span className="place-ico" style={{ background: p.color }}>
                  <Icon name={p.icon} size={21} />
                </span>
                <b>{p.label}</b>
              </button>
            ))}
          </div>
          {disk.data && (
            <div className="glass card storage-card">
              <div className="card-head" style={{ marginBottom: 10 }}>
                <strong>Storage</strong>
                <span>
                  {bytes(disk.data.available, 0)} free of{" "}
                  {bytes(disk.data.size, 0)}
                </span>
              </div>
              <span className="progress" style={{ height: 8 }}>
                <i
                  style={{
                    width: `${used * 100}%`,
                    background:
                      used > 0.9
                        ? "var(--red)"
                        : used > 0.75
                          ? "var(--yellow)"
                          : "var(--accent-text)",
                  }}
                />
              </span>
            </div>
          )}
          {(shares.data?.length ?? 0) > 0 && (
            <section>
              <div className="section-head">
                <h2>Shared on your network</h2>
              </div>
              <div
                className="glass group"
                style={{ "--inset": "74px" } as CSSProperties}
              >
                {shares.data!.map((s) => (
                  <button
                    key={s.path}
                    className="row"
                    onClick={() => setShareInfo(s)}
                  >
                    <span
                      className="file-icon"
                      style={
                        {
                          width: 44,
                          height: 44,
                          "--c": "#0ea5e9",
                        } as CSSProperties
                      }
                    >
                      <Icon name="folder-share" size={23} />
                    </span>
                    <span className="main">
                      <b>{s.name}</b>
                      <span className="mono">
                        smb://{boot.umbrel?.host}/{s.sharename}
                      </span>
                    </span>
                    <Icon name="chevron" size={18} className="chev" />
                  </button>
                ))}
              </div>
            </section>
          )}
          {(recents.data?.length ?? 0) > 0 && (
            <section>
              <div className="section-head">
                <h2>Recent</h2>
                <button className="link-btn" onClick={() => go("::recents")}>
                  See all
                </button>
              </div>
              <div
                className="glass group"
                style={{ "--inset": "74px" } as CSSProperties}
              >
                {recents.data!.slice(0, 5).map((f) => (
                  <Fragment key={f.path}>{Row({ f })}</Fragment>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {(path !== null || q) && (
        <>
          {inTrash && (listing.data?.files.length ?? 0) > 0 && !selecting && (
            <button
              className="btn danger block"
              style={{ marginBottom: 12, minHeight: 46 }}
              onClick={emptyTrash}
            >
              <Icon name="trash" size={18} />
              Empty Trash
            </button>
          )}
          {listing.error && !q && (
            <div className="error">
              <Icon name="alert" size={18} />
              {nice((listing.error as Error).message)}
            </div>
          )}
          {loading ? (
            <div className="glass group">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="row static">
                  <div
                    className="skeleton"
                    style={{ width: 44, height: 44, borderRadius: 12 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div
                      className="skeleton"
                      style={{ width: "55%", height: 12, marginBottom: 8 }}
                    />
                    <div
                      className="skeleton"
                      style={{ width: "30%", height: 10 }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="glass empty">
              <span className="big">
                <Icon
                  name={
                    q
                      ? "search"
                      : inTrash
                        ? "trash"
                        : path === "::favorites"
                          ? "star"
                          : "folder"
                  }
                  size={30}
                />
              </span>
              <b>
                {q
                  ? "No matches"
                  : inTrash
                    ? "Trash is empty"
                    : path === "::favorites"
                      ? "No favorites yet"
                      : "This folder is empty"}
              </b>
              {!q && !inTrash && path && !path.startsWith("::") && (
                <span>Tap + to upload photos or files.</span>
              )}
            </div>
          ) : grid && !q ? (
            <div className="file-grid">
              {items.map((f) => (
                <Fragment key={f.path}>{Row({ f })}</Fragment>
              ))}
            </div>
          ) : (
            <div
              className="glass group"
              style={
                { "--inset": selecting ? "110px" : "74px" } as CSSProperties
              }
            >
              {items.map((f) => (
                <Fragment key={f.path}>{Row({ f })}</Fragment>
              ))}
            </div>
          )}
          {listing.data?.truncatedAt ? (
            <p className="footer-note">
              Showing the first {listing.data.truncatedAt.toLocaleString()}{" "}
              items.
            </p>
          ) : null}
        </>
      )}

      {createPortal(
        <>
          {dropping && uploadDir && (
            <div className="drop-zone" aria-hidden="true">
              <span>
                <Icon name="upload" size={34} />
                <b>Drop to upload</b>
                <small>to {titleOf(uploadDir)}</small>
              </span>
            </div>
          )}

          {/* Selection bar */}
          {selecting && (
            <div className="select-bar">
              <button
                className="sb-cancel"
                onClick={() => setSelected(new Set())}
              >
                <Icon name="close" size={18} stroke={2.2} />
                <span className="num">{selected.size}</span>
              </button>
              {inTrash ? (
                <>
                  <button onClick={() => restore([...selected])}>
                    <Icon name="restore" size={21} />
                    Restore
                  </button>
                  <button
                    className="danger"
                    onClick={() => deleteForever([...selected])}
                  >
                    <Icon name="trash" size={21} />
                    Delete
                  </button>
                </>
              ) : (
                <>
                  <button onClick={() => download([...selected])}>
                    <Icon name="download" size={21} />
                    Download
                  </button>
                  <button
                    onClick={() =>
                      setPicker({ mode: "move", paths: [...selected] })
                    }
                  >
                    <Icon name="move" size={21} />
                    Move
                  </button>
                  <button
                    onClick={() =>
                      setPicker({ mode: "copy", paths: [...selected] })
                    }
                  >
                    <Icon name="copy" size={21} />
                    Copy
                  </button>
                  <button
                    className="danger"
                    onClick={() => trashItems([...selected])}
                  >
                    <Icon name="trash" size={21} />
                    Trash
                  </button>
                </>
              )}
            </div>
          )}

          {uploads.length > 0 && (
            <UploadPanel uploads={uploads} onClear={clearUploads} />
          )}
        </>,
        portalRoot,
      )}


      {viewing && (
        <FileViewer
          files={viewing.files}
          index={viewing.index}
          onClose={() => setViewing(null)}
          onInfo={(f) => setOpen(f)}
          onDownload={(f) => download([f.path])}
          onChanged={() => {
            qc.invalidateQueries({ queryKey: ["files.list"] });
            qc.invalidateQueries({ queryKey: ["files.recents"] });
          }}
        />
      )}

      {open && (
        <ItemSheet
          f={open}
          onView={viewing ? undefined : () => (setOpen(null), viewFile(open))}
          inTrash={inTrash || open.path.startsWith("/Trash/")}
          favorite={favSet.has(open.path)}
          shared={shareMap.get(open.path)}
          onClose={() => setOpen(null)}
          onOpenFolder={() => (setOpen(null), go(open.path))}
          onDownload={() => download([open.path])}
          onRename={() => setPrompt({ kind: "rename", entry: open })}
          onMove={() => setPicker({ mode: "move", paths: [open.path] })}
          onCopy={() => setPicker({ mode: "copy", paths: [open.path] })}
          onFavorite={() => toggleFavorite(open.path)}
          onShare={() => toggleShare(open)}
          onShareInfo={(s) => (setOpen(null), setShareInfo(s))}
          onTrash={() => trashItems([open.path])}
          onRestore={() => restore([open.path])}
          onDelete={() => deleteForever([open.path])}
        />
      )}

      {prompt && (
        <NamePrompt
          title={prompt.kind === "folder" ? "New folder" : "Rename"}
          initial={prompt.kind === "rename" ? prompt.entry!.name : "New folder"}
          submit={prompt.kind === "folder" ? "Create" : "Rename"}
          selectStem={prompt.kind === "rename" && !isDir(prompt.entry!)}
          onClose={() => setPrompt(null)}
          onSubmit={async (name) => {
            if (prompt.kind === "folder")
              await act(
                "files.createDirectory",
                { path: `${path}/${name}` },
                "Folder created",
              );
            else {
              await act(
                "files.rename",
                { path: prompt.entry!.path, newName: name },
                "Renamed",
              );
              setOpen(null);
            }
            setPrompt(null);
          }}
        />
      )}

      {picker && (
        <FolderPicker
          mode={picker.mode}
          count={picker.paths.length}
          start={path && !path.startsWith("::") && !inTrash ? path : "/Home"}
          exclude={picker.paths}
          onClose={() => setPicker(null)}
          onPick={async (dir) => {
            const verb = picker.mode === "move" ? "files.move" : "files.copy";
            let ok = 0;
            for (const p of picker.paths) {
              if (parentOf(p) === dir && picker.mode === "move") continue;
              await act(verb, {
                path: p,
                toDirectory: dir,
                collision: "keep-both",
              }).then(
                () => ok++,
                () => {},
              );
            }
            if (ok)
              toast(
                `${ok === 1 ? "1 item" : `${ok} items`} ${picker.mode === "move" ? "moved" : "copied"} to ${titleOf(dir)}`,
              );
            setPicker(null);
            setSelected(new Set());
            setOpen(null);
          }}
        />
      )}

      {shareInfo && (
        <ShareInfo
          share={shareInfo}
          host={boot.umbrel?.host ?? ""}
          username={user.data?.sambaUsername}
          onClose={() => setShareInfo(null)}
        />
      )}
    </div>
  );
}

// ---- long press -----------------------------------------------------------------------
function useLongPress(onLong: (f: FileEntry) => void) {
  const t = useRef<number>();
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cb = useRef(onLong);
  cb.current = onLong;
  return (f: FileEntry) => ({
    onPointerDown: (e: React.PointerEvent) => {
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      window.clearTimeout(t.current);
      t.current = window.setTimeout(() => {
        fired.current = true;
        cb.current(f);
      }, 480);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (
        start.current &&
        Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) >
          10
      )
        window.clearTimeout(t.current);
    },
    onPointerUp: () => window.clearTimeout(t.current),
    onPointerCancel: () => window.clearTimeout(t.current),
    onClickCapture: (e: React.MouseEvent) => {
      if (fired.current) {
        e.stopPropagation();
        e.preventDefault();
        fired.current = false;
      }
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });
}

// ---- item sheet with preview ---------------------------------------------------------------
function ItemSheet(p: {
  f: FileEntry;
  inTrash: boolean;
  favorite: boolean;
  shared?: SmbShare;
  onClose: () => void;
  onOpenFolder: () => void;
  onView?: () => void;
  onDownload: () => void;
  onRename: () => void;
  onMove: () => void;
  onCopy: () => void;
  onFavorite: () => void;
  onShare: () => void;
  onShareInfo: (s: SmbShare) => void;
  onTrash: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const desk = useDesktop();
  const { f } = p;
  const toast = useToast();
  const k = kindOf(f);
  const can = (op: FileEntry["operations"][number]) =>
    f.operations.includes(op);
  const shareOut = async () => {
    haptic(6);
    try {
      if (!isDir(f) && navigator.canShare && (f.size ?? 0) < 200e6) {
        const blob = await fetch(downloadUrl([f.path]), {
          credentials: "same-origin",
        }).then((r) => {
          if (!r.ok) throw new Error("Couldn’t load the file");
          return r.blob();
        });
        const file = new File([blob], f.name, {
          type: f.type === "directory" ? "application/zip" : f.type,
        });
        if (navigator.canShare({ files: [file] }))
          return void (await navigator.share({ files: [file], title: f.name }));
      }
      p.onDownload();
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast((e as Error).message, true);
    }
  };
  type A = {
    id: string;
    label: string;
    icon: IconName;
    onClick: () => void;
    show: boolean;
    danger?: boolean;
  };
  const actions: A[] = p.inTrash
    ? [
        {
          id: "restore",
          label: "Restore",
          icon: "restore",
          onClick: p.onRestore,
          show: true,
        },
        {
          id: "delete",
          label: "Delete",
          icon: "trash",
          onClick: p.onDelete,
          show: true,
          danger: true,
        },
      ]
    : [
        {
          id: "share-out",
          label: isDir(f) ? "Download zip" : "Share",
          icon: isDir(f) ? "download" : "share",
          onClick: isDir(f) ? p.onDownload : shareOut,
          show: true,
        },
        {
          id: "download",
          label: "Download",
          icon: "download",
          onClick: p.onDownload,
          show: !isDir(f),
        },
        {
          id: "rename",
          label: "Rename",
          icon: "pencil",
          onClick: p.onRename,
          show: can("rename"),
        },
        {
          id: "move",
          label: "Move",
          icon: "move",
          onClick: p.onMove,
          show: can("move"),
        },
        {
          id: "copy",
          label: "Copy",
          icon: "copy",
          onClick: p.onCopy,
          show: can("copy"),
        },
        {
          id: "fav",
          label: p.favorite ? "Unfavorite" : "Favorite",
          icon: p.favorite ? "star-filled" : "star",
          onClick: p.onFavorite,
          show: can("favorite") || p.favorite,
        },
        {
          id: "smb",
          label: p.shared ? "Unshare" : "Network share",
          icon: "folder-share",
          onClick: p.onShare,
          show: isDir(f) && (can("share") || !!p.shared),
        },
        {
          id: "desk",
          label: "Add to desktop",
          icon: "plus",
          onClick: () => {
            desk?.addIcon(`folder:${f.path}`);
            toast(`${f.name} added to the desktop`);
          },
          show: !!desk && isDir(f),
        },
      ];
  const shown = actions.filter((a) => a.show);
  return (
    <Sheet open onClose={p.onClose} label={f.name}>
      <SheetHeader
        icon={<FileIcon f={f} size={52} />}
        title={f.name}
        subtitle={isDir(f) ? "Folder" : `${bytes(f.size)} · ${ago(f.modified)}`}
        onClose={p.onClose}
      />
      {!p.inTrash && !isDir(f) && <Preview f={f} kind={k} />}
      {!isDir(f) && !p.inTrash && p.onView && (
        <div className="primary-row">
          <button className="btn primary" onClick={p.onView}>
            <Icon name="eye" size={20} />
            Open
          </button>
        </div>
      )}
      {isDir(f) && !p.inTrash && (
        <div className="primary-row">
          <button className="btn primary" onClick={p.onOpenFolder}>
            <Icon name="folder" size={20} />
            Open folder
          </button>
        </div>
      )}
      {p.shared && (
        <button
          className="glass card press share-chip"
          onClick={() => p.onShareInfo(p.shared!)}
        >
          <Icon name="folder-share" size={20} />
          <span>
            Shared as <b>{p.shared.sharename}</b> on your network
          </span>
          <Icon name="chevron" size={16} className="muted" />
        </button>
      )}
      <div
        className="actions"
        style={{
          gridTemplateColumns: `repeat(${Math.min(4, shown.length)}, minmax(0, 1fr))`,
        }}
      >
        {shown.map((a) => (
          <button
            key={a.id}
            className={`action${a.danger ? " danger-action" : ""}`}
            onClick={a.onClick}
          >
            <Icon name={a.icon} size={22} />
            {a.label}
          </button>
        ))}
      </div>
      <div className="kv glass group" style={{ borderRadius: 18 }}>
        <div className="row static">
          <span className="k">Where</span>
          <span className="v">{parentOf(f.path)}</span>
        </div>
        {!isDir(f) && (
          <div className="row static">
            <span className="k">Kind</span>
            <span className="v">{f.type.split("/").pop()}</span>
          </div>
        )}
        {f.modified ? (
          <div className="row static">
            <span className="k">Modified</span>
            <span className="v">
              {new Date(f.modified).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </span>
          </div>
        ) : null}
      </div>
      {!p.inTrash && can("trash") && (
        <button className="btn danger block" onClick={p.onTrash}>
          <Icon name="trash" size={19} />
          Move to Trash
        </button>
      )}
    </Sheet>
  );
}

function Preview({ f, kind }: { f: FileEntry; kind: Kind }) {
  const [text, setText] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (kind !== "text" || (f.size ?? 0) > 512_000) return;
    fetch(viewUrl(f.path), { credentials: "same-origin" })
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then(setText, () => setText(null));
  }, [f.path, f.size, kind]);
  let body: ReactNode = null;
  if (kind === "image")
    body = (
      <button
        className="preview-img"
        onClick={() => setFull(true)}
        aria-label="View full screen"
      >
        <img src={viewUrl(f.path)} alt={f.name} />
      </button>
    );
  else if (kind === "video")
    body = (
      <video
        className="preview-media"
        src={viewUrl(f.path)}
        controls
        playsInline
        preload="metadata"
      />
    );
  else if (kind === "audio")
    body = (
      <audio
        className="preview-audio"
        src={viewUrl(f.path)}
        controls
        preload="metadata"
      />
    );
  else if (kind === "pdf")
    body = (
      <iframe
        className="preview-pdf"
        title={f.name}
        src={viewUrl(f.path)}
        sandbox=""
      />
    );
  else if (kind === "text" && text !== null)
    body = <pre className="preview-text">{text.slice(0, 20_000)}</pre>;
  if (!body) return null;
  return (
    <>
      <div className="preview">{body}</div>
      {full && (
        <Sheet open onClose={() => setFull(false)} label={f.name} tall>
          <SheetHeader title={f.name} onClose={() => setFull(false)} />
          <div className="zoom-view">
            <img src={viewUrl(f.path)} alt={f.name} />
          </div>
        </Sheet>
      )}
    </>
  );
}

// ---- name prompt -----------------------------------------------------------------------------
function NamePrompt({
  title,
  initial,
  submit,
  selectStem,
  onClose,
  onSubmit,
}: {
  title: string;
  initial: string;
  submit: string;
  selectStem?: boolean;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, selectStem && dot > 0 ? dot : initial.length);
  }, [initial, selectStem]);
  const valid =
    name.trim() !== "" && !name.includes("/") && name !== "." && name !== "..";
  return (
    <Sheet open onClose={onClose} label={title}>
      <SheetHeader title={title} onClose={onClose} />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid) return;
          setBusy(true);
          await onSubmit(name.trim()).catch(() => {});
          setBusy(false);
        }}
      >
        <div className="field">
          <label htmlFor="fname" className="sr-only">
            Name
          </label>
          <input
            id="fname"
            ref={ref}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        <button
          className="btn primary block"
          disabled={!valid || busy || name === initial}
        >
          {busy && <span className="spinner" />}
          {submit}
        </button>
      </form>
    </Sheet>
  );
}

// ---- folder picker (move / copy) ---------------------------------------------------------------------
function FolderPicker({
  mode,
  count,
  start,
  exclude,
  onClose,
  onPick,
}: {
  mode: "move" | "copy";
  count: number;
  start: string;
  exclude: string[];
  onClose: () => void;
  onPick: (dir: string) => Promise<void>;
}) {
  const [dir, setDir] = useState(start);
  const [busy, setBusy] = useState(false);
  const listing = useListing(dir, "name");
  const folders = (listing.data?.files ?? []).filter(
    (f) => isDir(f) && !exclude.includes(f.path),
  );
  const blocked = exclude.some((p) => dir === p || dir.startsWith(`${p}/`));
  const roots = ["/Home", "/External", "/Network"];
  return (
    <Sheet
      open
      onClose={onClose}
      label={mode === "move" ? "Move to" : "Copy to"}
      tall
    >
      <SheetHeader
        title={`${mode === "move" ? "Move" : "Copy"} ${count === 1 ? "1 item" : `${count} items`}`}
        subtitle={`to ${dir}`}
        onClose={onClose}
      />
      <div className="chips" style={{ marginBottom: 10 }}>
        {roots.map((r) => (
          <button
            key={r}
            className={`chip${dir === r || dir.startsWith(`${r}/`) ? " on" : ""}`}
            onClick={() => setDir(r)}
          >
            {titleOf(r)}
          </button>
        ))}
      </div>
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          margin: "0 -20px",
          padding: "0 20px",
        }}
      >
        <div
          className="glass group"
          style={{ borderRadius: 18, "--inset": "62px" } as CSSProperties}
        >
          {dir.split("/").length > 2 && (
            <button
              className="row"
              style={{ minHeight: 54 }}
              onClick={() => setDir(parentOf(dir))}
            >
              <span
                className="row-ico"
                style={{ "--c": "#71717a" } as CSSProperties}
              >
                <Icon name="back" size={18} />
              </span>
              <span className="main">
                <b style={{ fontWeight: 550 }}>{titleOf(parentOf(dir))}</b>
              </span>
            </button>
          )}
          {listing.isLoading && (
            <div className="row static">
              <span className="spinner" />
            </div>
          )}
          {folders.map((f) => (
            <button
              key={f.path}
              className="row"
              style={{ minHeight: 54 }}
              onClick={() => setDir(f.path)}
            >
              <span
                className="row-ico"
                style={{ "--c": "#3b82f6" } as CSSProperties}
              >
                <Icon name="folder-filled" size={18} />
              </span>
              <span className="main">
                <b style={{ fontWeight: 550 }}>{f.name}</b>
              </span>
              <Icon name="chevron" size={18} className="chev" />
            </button>
          ))}
          {!listing.isLoading && folders.length === 0 && (
            <div className="row static muted">No folders here</div>
          )}
        </div>
      </div>
      <button
        className="btn primary block"
        style={{ marginTop: 14 }}
        disabled={busy || blocked || !!listing.error}
        onClick={async () => {
          setBusy(true);
          await onPick(dir);
          setBusy(false);
        }}
      >
        {busy && <span className="spinner" />}
        {mode === "move" ? "Move here" : "Copy here"}
      </button>
    </Sheet>
  );
}

// ---- uploads panel ------------------------------------------------------------------------------
function UploadPanel({
  uploads,
  onClear,
}: {
  uploads: Upload[];
  onClear: () => void;
}) {
  const active = uploads.filter((u) => u.state === "uploading");
  const total = uploads.reduce((t, u) => t + u.total, 0);
  const loaded = uploads.reduce((t, u) => t + u.loaded, 0);
  const failed = uploads.filter((u) => u.state === "error").length;
  return (
    <div className="upload-panel glass" role="status" aria-live="polite">
      <span
        className="file-icon"
        style={
          {
            width: 40,
            height: 40,
            "--c": active.length
              ? "var(--accent)"
              : failed
                ? "var(--red)"
                : "var(--green)",
          } as CSSProperties
        }
      >
        {active.length ? (
          <span className="spinner" />
        ) : (
          <Icon name={failed ? "alert" : "check"} size={20} />
        )}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <b style={{ display: "block", fontSize: 14, fontWeight: 620 }}>
          {active.length
            ? `Uploading ${active.length} of ${uploads.length}`
            : failed
              ? `${failed} upload${failed > 1 ? "s" : ""} failed`
              : "Upload complete"}
        </b>
        <span className="progress" style={{ display: "block", marginTop: 7 }}>
          <i style={{ width: `${total ? (loaded / total) * 100 : 100}%` }} />
        </span>
        <span
          className="muted num"
          style={{ fontSize: 12, marginTop: 4, display: "block" }}
        >
          {bytes(loaded)} of {bytes(total)}
        </span>
      </span>
      {!active.length && (
        <button className="icon-btn" aria-label="Dismiss" onClick={onClear}>
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}

// ---- SMB share info ----------------------------------------------------------------------------------
function ShareInfo({
  share,
  host,
  username,
  onClose,
}: {
  share: SmbShare;
  host: string;
  username?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [reveal, setReveal] = useState(false);
  const pw = useQuery({
    queryKey: ["files.sharePassword"],
    queryFn: () => query<string>("files.sharePassword"),
    enabled: reveal,
    retry: false,
  });
  const copy = (v: string, what: string) =>
    navigator.clipboard?.writeText(v).then(
      () => toast(`${what} copied`),
      () => toast(v),
    );
  const rows: [string, string, string][] = [
    ["Mac / Linux / iPhone", `smb://${host}/${share.sharename}`, "Address"],
    ["Windows", `\\\\${host}\\${share.sharename}`, "Address"],
  ];
  return (
    <Sheet open onClose={onClose} label="Network share">
      <SheetHeader
        icon={
          <span
            className="file-icon"
            style={{ width: 52, height: 52, "--c": "#0ea5e9" } as CSSProperties}
          >
            <Icon name="folder-share" size={28} />
          </span>
        }
        title={share.name}
        subtitle="Open it from any computer or phone on your network"
        onClose={onClose}
      />
      <div
        className="kv glass group"
        style={{ borderRadius: 18, marginTop: 0 }}
      >
        {rows.map(([k, v, what]) => (
          <button
            key={k}
            className="row"
            style={{ minHeight: 56 }}
            onClick={() => copy(v, what)}
          >
            <span className="k">{k}</span>
            <span className="v mono" style={{ fontSize: 12.5 }}>
              {v}
            </span>
          </button>
        ))}
        {username && (
          <button
            className="row"
            style={{ minHeight: 56 }}
            onClick={() => copy(username, "Username")}
          >
            <span className="k">Username</span>
            <span className="v mono">{username}</span>
          </button>
        )}
        <button
          className="row"
          style={{ minHeight: 56 }}
          onClick={() =>
            pw.data ? copy(pw.data, "Password") : setReveal(true)
          }
        >
          <span className="k">Password</span>
          <span className="v mono" style={{ fontSize: 12.5 }}>
            {pw.data ?? (pw.isFetching ? "…" : "Tap to show")}
          </span>
        </button>
      </div>
      <p className="footer-note" style={{ textAlign: "left", margin: "0 4px" }}>
        Tap any line to copy it. On iPhone, open Files → ⋯ → Connect to Server.
      </p>
    </Sheet>
  );
}
