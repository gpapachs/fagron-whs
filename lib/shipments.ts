// Αποστολές FSSE: ανάγνωση του κοινόχρηστου Excel «FSSE SHIPMENTS» (ένα φύλλο ανά πελάτη) και
// σύγκριση των ανοιχτών γραμμών με το απόθεμα του WMS. Χωρίς React — χρησιμοποιείται από την
// οθόνη, τις εξαγωγές και τους ελέγχους.

export type ShipRow = {
  sheet: string;
  row_no: number;
  customer: string;
  ship_date: string | null; // ISO yyyy-mm-dd
  week: number | null;
  order_date: string | null;
  doc: string;
  po: string;
  item: string;
  bulk: string;
  product: string;
  sku: string;
  qty_ordered: number | null;
  qty_initial: number | null;
  qty_confirmed: number | null;
  requirements: string;
  comments: string;
};

type Cell = string | number | boolean | Date | null | undefined;

const norm = (s: Cell) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
const ITEM_RE = /^[0-9]{2}-[0-9]{2}-[0-9]{3}$/;

// επικεφαλίδες (όπως στο Excel, χωρίς κενά στην αρχή/τέλος) -> πεδίο
const HEADERS: [keyof ShipRow, RegExp][] = [
  ["ship_date", /^DATE$/],
  ["week", /^WEEK/],
  ["order_date", /^ORDER DATE/],
  ["doc", /ΠΑΡ|DOCUMENT/],
  ["customer", /^CUSTOMER NAME/],
  ["po", /^PO /],
  ["item", /^ITEM CODE/],
  ["bulk", /^BULK/],
  ["product", /^PRODUCT/],
  ["sku", /^SKU/],
  ["qty_ordered", /^QUANTITY ORDERED/],
  ["qty_initial", /^INITIAL QUANTITY/],
  ["qty_confirmed", /^CONFIRMED QUANTITY/],
  ["requirements", /^SHIPMENT REQUIREMENTS/],
  ["comments", /^GENERAL COMMENTS/],
];

/** «60 PCS», «1 pc», «1,119», 248 -> αριθμός */
export function parseQty(v: Cell): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const m = String(v).replace(/\s/g, "").match(/^-?[\d.,]+/);
  if (!m) return null;
  let t = m[0];
  // 1.119 ή 1,119 (χιλιάδες) vs 2,5 (δεκαδικό)
  if (/^\d{1,3}([.,]\d{3})+$/.test(t)) t = t.replace(/[.,]/g, "");
  else t = t.replace(",", ".");
  const n = Number(t);
  return isFinite(n) ? n : null;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** «15/10/2026», «6/8/2026», αριθμός Excel (46213), Date -> ISO */
export function parseDate(v: Cell): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  if (typeof v === "number" || /^\d{5}(\.\d+)?$/.test(String(v).trim())) {
    const n = Number(v);
    if (n < 20000 || n > 80000) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const m = String(v).trim().match(/^(\d{1,3})\/(\d{1,3})\/(\d{4})/);
  if (!m) return null;
  const d = Number(m[1]) % 100 || Number(m[1]);
  const mo = Number(m[2]) % 100 || Number(m[2]);
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  return `${m[3]}-${pad(mo)}-${pad(d)}`;
}

/** «W46», «W 46», «W446» (λάθος πληκτρολόγησης -> 46), 46 */
export function parseWeek(v: Cell): number | null {
  const s = String(v ?? "").trim();
  const m = s.match(/(\d+)/);
  if (!m) return null;
  let n = Number(m[1]);
  if (m[1].length > 2) n = Number(m[1].slice(-2));
  return n >= 1 && n <= 53 ? n : null;
}

const str = (v: Cell) => (v == null ? "" : v instanceof Date ? parseDate(v) ?? "" : String(v).replace(/\s+/g, " ").trim());

/** Όλα τα φύλλα -> γραμμές. Φύλλα χωρίς στήλη «ITEM CODE» (σύνοψη, εβδομάδες) αγνοούνται. */
export function parseShipments(sheets: { name: string; rows: Cell[][] }[]): ShipRow[] {
  const out: ShipRow[] = [];
  for (const sh of sheets) {
    let map: Partial<Record<keyof ShipRow, number>> | null = null;
    let hdr: string[] = [];
    let maxCol = 0;
    let addrCol: number | null = null;
    sh.rows.forEach((row, ri) => {
      const cells = row.map(norm);
      if (cells.some((c) => /^ITEM CODE/.test(c))) {
        // (νέα) γραμμή επικεφαλίδων
        const m: Partial<Record<keyof ShipRow, number>> = {};
        cells.forEach((c, ci) => {
          for (const [k, re] of HEADERS) if (m[k] == null && re.test(c)) m[k] = ci;
        });
        const addr = cells.findIndex((c) => /^CUSTOMER ADDRESS/.test(c));
        // στήλες χωρίς επικεφαλίδα στο τέλος (π.χ. «KARANTINA», «URGENT», «invoiced not shipped»)
        hdr = cells;
        maxCol = Math.max(...(Object.values(m) as number[]));
        addrCol = addr >= 0 ? addr : null;
        map = m;
        return;
      }
      if (!map || map.item == null) return;
      const mm = map;
      const get = (k: keyof ShipRow) => (mm[k] == null ? undefined : row[mm[k] as number]);
      const item = norm(get("item"));
      if (!ITEM_RE.test(item)) return;
      const bulk = norm(get("bulk"));
      // σημειώσεις: επιπλέον στήλες χωρίς επικεφαλίδα + «URGENT» γραμμένο στη διεύθυνση
      const notes = row.map((v, ci) => (ci > maxCol && !hdr[ci] ? str(v) : "")).filter(Boolean);
      const addr = addrCol == null ? "" : str(row[addrCol]);
      const reqs = [str(get("requirements")), /URGENT/i.test(addr) ? addr : ""].filter(Boolean).join(" · ");
      out.push({
        sheet: sh.name.trim(),
        row_no: ri + 1,
        customer: str(get("customer")) || sh.name.trim(),
        ship_date: parseDate(get("ship_date")),
        week: parseWeek(get("week")),
        order_date: parseDate(get("order_date")),
        doc: str(get("doc")),
        po: str(get("po")),
        item,
        bulk: ITEM_RE.test(bulk) ? bulk : "",
        product: str(get("product")),
        sku: str(get("sku")),
        qty_ordered: parseQty(get("qty_ordered")),
        qty_initial: parseQty(get("qty_initial")),
        qty_confirmed: parseQty(get("qty_confirmed")),
        requirements: reqs,
        comments: [str(get("comments")), ...notes].filter(Boolean).join(" · "),
      });
    });
  }
  return out;
}

/** ISO εβδομάδα */
export function isoWeek(d: Date): { week: number; year: number } {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return { week: w, year: y };
}

/** Ποσότητα για αποστολή: Confirmed -> Initial -> Ordered */
export const needOf = (r: Pick<ShipRow, "qty_confirmed" | "qty_initial" | "qty_ordered">) => r.qty_confirmed ?? r.qty_initial ?? r.qty_ordered ?? 0;

/** σχετική σειρά εβδομάδας ως προς την τρέχουσα (W1 μετά από W52 = επόμενο έτος) */
export function weekRank(w: number | null, current: number) {
  if (w == null) return null;
  let d = w - current;
  if (d < -26) d += 52;
  if (d > 26) d -= 52;
  return d;
}

export type StockPos = { item: string; position: string; area: string | null; lot: string | null; expiry: string | null; qty: number };
export type LineState = "ok" | "partial" | "none";
export type ShipEval = ShipRow & {
  need: number;
  allocated: number;
  state: LineState;
  itemStock: number;
  bulkStock: number | null;
  positions: StockPos[];
  rank: number | null; // εβδομάδα ως προς την τρέχουσα (0 = τρέχουσα)
};
export type CustomerEval = { sheet: string; customer: string; lines: ShipEval[]; ok: number; partial: number; none: number; weeks: number[]; color: "green" | "yellow" | "red" };

/**
 * Κατανομή αποθέματος: ανά κωδικό, οι γραμμές παίρνουν απόθεμα με σειρά εβδομάδας αποστολής
 * (νωρίτερη πρώτα), μετά φύλλο και γραμμή — έτσι το ίδιο απόθεμα δεν μετράει δύο φορές.
 */
export function evaluateShipments(rows: ShipRow[], stock: StockPos[], opts: { currentWeek: number; scope: "current" | "all" | number; includeNoWeek: boolean }): CustomerEval[] {
  const byItem = new Map<string, StockPos[]>();
  for (const s of stock) byItem.set(s.item, [...(byItem.get(s.item) ?? []), s]);
  const sum = (code: string) => (byItem.get(code) ?? []).reduce((t, s) => t + s.qty, 0);

  const open = rows.filter((r) => {
    const rank = weekRank(r.week, opts.currentWeek);
    if (rank == null) return opts.includeNoWeek;
    if (opts.scope === "all") return true;
    if (opts.scope === "current") return rank >= 0;
    return r.week === opts.scope;
  });
  const order = [...open].sort(
    (a, b) => (weekRank(a.week, opts.currentWeek) ?? 99) - (weekRank(b.week, opts.currentWeek) ?? 99) || a.sheet.localeCompare(b.sheet) || a.row_no - b.row_no
  );
  const left = new Map<string, number>();
  const evals = new Map<ShipRow, ShipEval>();
  for (const r of order) {
    const need = needOf(r);
    const total = sum(r.item);
    const rem = left.has(r.item) ? (left.get(r.item) as number) : total;
    const allocated = Math.max(0, Math.min(need, rem));
    left.set(r.item, rem - allocated);
    evals.set(r, {
      ...r,
      need,
      allocated,
      state: need <= 0 || allocated >= need - 1e-9 ? "ok" : allocated > 0 ? "partial" : "none",
      itemStock: total,
      bulkStock: r.bulk ? sum(r.bulk) : null,
      positions: (byItem.get(r.item) ?? []).slice().sort((x, y) => (x.expiry ?? "9").localeCompare(y.expiry ?? "9")),
      rank: weekRank(r.week, opts.currentWeek),
    });
  }

  const custs = new Map<string, CustomerEval>();
  for (const r of open) {
    const e = evals.get(r) as ShipEval;
    const c = custs.get(r.sheet) ?? { sheet: r.sheet, customer: r.customer, lines: [], ok: 0, partial: 0, none: 0, weeks: [], color: "green" as const };
    c.lines.push(e);
    c[e.state]++;
    if (e.week != null && !c.weeks.includes(e.week)) c.weeks.push(e.week);
    custs.set(r.sheet, c);
  }
  for (const c of custs.values()) {
    c.lines.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.row_no - b.row_no);
    c.weeks.sort((a, b) => (weekRank(a, opts.currentWeek) ?? 0) - (weekRank(b, opts.currentWeek) ?? 0));
    c.color = c.none === 0 && c.partial === 0 ? "green" : c.ok + c.partial > 0 ? "yellow" : "red";
  }
  return [...custs.values()].sort((a, b) => a.sheet.localeCompare(b.sheet));
}
