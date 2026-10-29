// Shared warehouse-layout logic -- the single source of truth for corridor
// structure, position codes, and stock-import parsing, ported 1:1 from the
// original "Πλάνο Αποθήκης" artifact so every real location code stays
// identical. Used by both the 2D grid, the 3D view, quick-lookup search and
// the Excel import.
//
// Kept in sync manually with scripts/gen-seed.mjs (a one-off Node script,
// so it can't import this .ts file directly) -- if CORRIDOR_SPEC ever
// changes, update both and re-run `npm run gen:seed`.

export const CORRIDORS = 12;
export const SPECIAL_ID = "special" as const;
export const ALL_IDS: (number | string)[] = [
  ...Array.from({ length: CORRIDORS }, (_, i) => i + 1),
  SPECIAL_ID,
];

export const CORRIDOR_SPEC: Record<number, number[][]> = {
  1: [[1, 1], [1, 1], [1, 1]],
  2: [[2, 2, 2, 2, 2], [2, 2, 2, 2, 2], [3, 3, 3, 3, 3], [3, 3, 3, 3, 3, 1]],
  3: [[4, 4, 4, 4, 4, 4, 3], [2, 2, 2, 2, 2, 2], [3, 3, 3, 3, 3, 3], [3, 3, 3, 3, 3, 3]],
  4: [[2, 2, 2, 2, 2, 2], [2, 2, 2, 2, 2, 2], [3, 3, 3, 3, 3, 3], [3, 3, 3, 3, 3, 3], [1, 1, 1, 1, 1, 1]],
  5: [[2, 2, 2, 2, 2, 2], [2, 2, 2, 2, 2, 2], [6, 6, 6, 6, 3, 3], [6, 6, 6, 6, 3, 3, 1], [1, 1, 1, 1, 1, 1]],
  6: [[2, 2, 2, 2, 2, 2], [2, 2, 2, 2, 2, 2], [6, 6, 6, 6, 3, 3], [6, 6, 6, 6, 3, 3, 1], [1, 1, 1, 1, 1, 1]],
  7: [[2, 2, 2, 2, 2, 2], [2, 2, 2, 2, 2, 2], [6, 6, 6, 6, 3, 3], [3, 3, 3, 3, 3, 3, 1]],
  8: [[2, 2, 2, 2, 2, 2], [2, 2, 2, 2, 2, 2], [6, 6, 6, 6, 3, 3], [3, 3, 3, 3, 3, 3, 1]],
  9: [[2, 2, 2, 2, 2, 2], [2, 2, 2, 2, 2, 2], [3, 3, 3, 3, 3, 3], [3, 3, 3, 3, 3, 3, 1], [1, 1, 1, 1, 1, 1, 1]],
  10: [[4, 4, 4, 2, 2, 2], [4, 4, 4, 2, 2, 2], [3, 3, 3, 3, 3, 3], [3, 3, 3, 3, 3, 3, 1], [1, 1, 1, 1, 1, 1]],
  11: [[2, 2, 2, 2, 2, 2], [2, 2, 2, 2, 2, 2], [3, 3, 3, 3, 3, 3], [3, 3, 3, 3, 3, 3, 1]],
  12: [[2, 2, 2, 2, 2, 2, 1], [2, 2, 2, 2, 2, 2, 1], [3, 3, 3, 3, 3, 3, 1], [3, 3, 3, 3, 3, 3, 1]],
};
export const CORRIDOR_ZONE: Record<number, string> = { 1: "ΚΑΘΑΡΙΣΤΙΚΑ" };
export const DEFAULT_ZONE = "ΚΕΝΤΡΙΚΗ ΑΠΟΘΗΚΗ";
export const SPECIAL_LOCATIONS = [{ code: "EXP01-1", zone: "ΚΕΝΤΡΙΚΗ ΑΠΟΘΗΚΗ" }];

export function pad(n: number): string {
  return n < 10 ? "0" + n : "" + n;
}

export function zoneFor(cid: number | string): string {
  if (cid === SPECIAL_ID) return DEFAULT_ZONE;
  return CORRIDOR_ZONE[cid as number] || DEFAULT_ZONE;
}
export function labelFor(cid: number | string): string {
  return cid === SPECIAL_ID ? "Ειδικές θέσεις" : `Διάδρομος ${cid}`;
}

export type LayoutEntry =
  | { special: true; code: string }
  | { special?: false; col: number; row: number; pos: number };

const layoutCache = new Map<number | string, LayoutEntry[]>();
export function layoutFor(cid: number | string): LayoutEntry[] {
  const cached = layoutCache.get(cid);
  if (cached) return cached;
  let layout: LayoutEntry[];
  if (cid === SPECIAL_ID) {
    layout = SPECIAL_LOCATIONS.map((loc) => ({ special: true as const, code: loc.code }));
  } else {
    layout = [];
    const spec = CORRIDOR_SPEC[cid as number] || [];
    spec.forEach((rowCounts, ci) => {
      rowCounts.forEach((count, ri) => {
        for (let p = 1; p <= count; p++) layout.push({ col: ci + 1, row: ri + 1, pos: p });
      });
    });
  }
  layoutCache.set(cid, layout);
  return layout;
}

export function codeFor(cid: number | string, idx: number): string {
  const l = layoutFor(cid)[idx];
  if (!l) return "?";
  if (l.special) return l.code;
  return `E${pad(cid as number)}-${pad(l.col)}-${l.row}-${l.pos}`;
}

export const TOTAL_POSITIONS = ALL_IDS.reduce((n, cid) => n + layoutFor(cid).length, 0);

// normalized code -> {cid, idx}: built once so a scanned/typed/imported code
// can be resolved back to its corridor + index for the grid, the 3D view,
// quick-lookup search, and stock import.
export type CodeHit = { cid: number | string; idx: number };
const CODE_INDEX: Record<string, CodeHit> = {};
ALL_IDS.forEach((cid) => {
  layoutFor(cid).forEach((_entry, idx) => {
    CODE_INDEX[normalizeCode(codeFor(cid, idx))] = { cid, idx };
  });
});
export function findByCode(code: string): CodeHit | undefined {
  return CODE_INDEX[normalizeCode(code)];
}

// ---------- code normalization + Excel/stock-import parsing ----------
export function stripAccents(s: string): string {
  return s.normalize ? s.normalize("NFD").replace(/[̀-ͯ]/g, "") : s;
}
// Accepts any case / zero-padding for the 4-part codes (e1-1-1-1, E01-1-01-1,
// e01-01-01-01 ...) and normalizes to the canonical "E01-01-1-1" form used
// as the primary key; leaves other codes (e.g. EXP01-1) upper-cased as-is.
export function normalizeCode(code: string | null | undefined): string {
  const raw = String(code == null ? "" : code).trim();
  const m = raw.match(/^e?\s*0*(\d+)\s*-\s*0*(\d+)\s*-\s*0*(\d+)\s*-\s*0*(\d+)$/i);
  if (m) return `E${pad(Number(m[1]))}-${pad(Number(m[2]))}-${Number(m[3])}-${Number(m[4])}`;
  return raw.toUpperCase();
}
function findCol(header: string[], re: RegExp): number {
  for (let i = 0; i < header.length; i++) if (re.test(stripAccents(header[i]))) return i;
  return -1;
}
function looksLikeCode(v: unknown): boolean {
  return /^[a-z]*\s*\d+\s*-\s*\d+(\s*-\s*\d+){0,2}$/i.test(String(v == null ? "" : v).trim());
}
export type StockEntry = { raw: string; code: string; product: string; qty?: number };
export function parseStockRows(rows: unknown[][]): StockEntry[] {
  if (!rows || !rows.length) return [];
  const header = (rows[0] as unknown[]).map((h) => String(h == null ? "" : h).trim().toLowerCase());
  let idxCode = findCol(header, /loc|θεσ|τοποθ|κωδικ|code/);
  let idxProduct = findCol(header, /desc|product|sku|προ[ϊι]|περιγρ/);
  const idxQty = findCol(header, /qty|quant|ποσ/);
  let startRow = 1;
  if (idxCode < 0) idxCode = 0;
  // no real header row -- first row is already data
  if (looksLikeCode((rows[0] as unknown[])[idxCode])) {
    startRow = 0;
    if (idxProduct < 0 && rows[0].length > 1) idxProduct = 1;
  }
  const out: StockEntry[] = [];
  for (let i = startRow; i < rows.length; i++) {
    const r = rows[i] as unknown[];
    if (!r) continue;
    const rawCode = r[idxCode];
    const code = String(rawCode == null ? "" : rawCode).trim();
    if (!code) continue;
    const entry: StockEntry = { raw: code, code: normalizeCode(code), product: "" };
    if (idxProduct >= 0) entry.product = String(r[idxProduct] == null ? "" : r[idxProduct]).trim();
    if (idxQty >= 0) {
      const q = Number(r[idxQty]);
      if (!isNaN(q)) entry.qty = q;
    }
    out.push(entry);
  }
  return out;
}

// ---------- 3D geometry constants (shared by Board3D) ----------
export const SLOT_SIZE = 0.9;
export const SLOT_GAP = 0.15;
export const BAY_GAP = 0.55;
export const LEVEL_PITCH = 1.05;
export const PALLET_HEIGHT = 0.6;
export const PALLET_DEPTH = 0.9;
export const AISLE_GAP = 1.7;
export const AISLE_PITCH = PALLET_DEPTH + AISLE_GAP;

export type ColumnInfo = { col: number; width: number; xStart: number; rowCounts: number[] };
const columnLayoutCache = new Map<number, ColumnInfo[] & { totalWidth: number }>();
export function columnLayoutFor(cid: number): ColumnInfo[] & { totalWidth: number } {
  const cached = columnLayoutCache.get(cid);
  if (cached) return cached;
  const spec = CORRIDOR_SPEC[cid] || [];
  const arr = [] as ColumnInfo[] & { totalWidth: number };
  let xCursor = 0;
  spec.forEach((rowCounts, ci) => {
    const maxCount = Math.max(...rowCounts);
    const width = maxCount * SLOT_SIZE + (maxCount - 1) * SLOT_GAP;
    arr.push({ col: ci + 1, width, xStart: xCursor, rowCounts });
    xCursor += width + BAY_GAP;
  });
  arr.totalWidth = Math.max(0, xCursor - BAY_GAP);
  columnLayoutCache.set(cid, arr);
  return arr;
}
export function maxRowsFor(cid: number): number {
  const spec = CORRIDOR_SPEC[cid] || [];
  return spec.reduce((m, rowCounts) => Math.max(m, rowCounts.length), 0);
}
export function rackHeightFor(cid: number): number {
  return maxRowsFor(cid) * LEVEL_PITCH + 0.35;
}
