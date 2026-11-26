// Ζήτηση υλικών συσκευασίας (περιέκτες, καπάκια κ.λπ.) από το πλάνο παραγωγής και τις ανοιχτές παραγγελίες.
// Τελικά προϊόντα (00*, 71* …) -> προδιαγραφές (ίδιες με το Repack) -> υλικά με κωδικό ΟΧΙ 00* / 71*.
// Οι παλιοί κωδικοί 40* των προδιαγραφών μεταφράζονται στους νέους 41* (item_legacy). Καθαρή λογική.
import { siteOf } from "./site.ts";

export type DemandKind = "plan" | "orders" | "wms";
export type DemandLine = { kind: DemandKind; product: string; description: string | null; qty: number; due: string | null; ref: string | null };
export type SpecComp = { code: string; description: string; qty: number; unit: string };
export type Spec = { id: string; product_code: string; description: string; components: SpecComp[] };
export type StockLite = { item: string; position: string; qty: number; description: string };

export const KIND_TXT: Record<DemandKind, string> = { plan: "Πλάνο παραγωγής", orders: "Ανοιχτές παραγγελίες", wms: "Λίστες WMS" };

/** υλικό συσκευασίας = όχι πρώτη ύλη (00*) ούτε τελικό (71*) */
export const isPackaging = (code: string) => !!code && !/^(00|71)-/.test(code) && !code.includes("#");

export type NeedSource = { kind: DemandKind; product: string; productDesc: string | null; productQty: number; perUnit: number; need: number; due: string | null; ref: string | null; specCode: string };
export type ContainerNeed = {
  code: string; // κωδικός σήμερα (41* όπου υπάρχει αντιστοίχιση)
  specCodes: string[]; // όπως γράφεται στις προδιαγραφές (π.χ. 40-…)
  description: string;
  unit: string;
  need: Record<DemandKind, number>;
  total: number;
  central: number;
  external: number;
  stock: number;
  short: number; // λείπει συνολικά
  fromExternal: number; // πρέπει να έρθει από την εξωτερική για να καλυφθεί
  firstDue: string | null;
  sources: NeedSource[];
};
export type DemandResult = { needs: ContainerNeed[]; noSpec: { product: string; description: string | null; qty: number; kinds: DemandKind[] }[]; lines: number };

export function computeDemand(lines: DemandLine[], specs: Spec[], newOf: Map<string, string>, stock: StockLite[], until: string | null = null): DemandResult {
  // η πρώτη προδιαγραφή ανά τελικό (οι υπόλοιπες είναι εναλλακτικές)
  const specOf = new Map<string, Spec>();
  for (const s of specs) if (!specOf.has(s.product_code.toUpperCase())) specOf.set(s.product_code.toUpperCase(), s);
  const st = new Map<string, { central: number; external: number; description: string }>();
  for (const s of stock) {
    const e = st.get(s.item) ?? { central: 0, external: 0, description: s.description };
    if (siteOf(s.position) === "external") e.external += s.qty;
    else e.central += s.qty;
    st.set(s.item, e);
  }
  const m = new Map<string, ContainerNeed>();
  const noSpec = new Map<string, { product: string; description: string | null; qty: number; kinds: Set<DemandKind> }>();
  let n = 0;
  for (const l of lines) {
    if (until && l.due && l.due > until) continue;
    n++;
    const spec = specOf.get(l.product.toUpperCase());
    if (!spec) {
      const e = noSpec.get(l.product) ?? { product: l.product, description: l.description, qty: 0, kinds: new Set<DemandKind>() };
      e.qty += l.qty;
      e.kinds.add(l.kind);
      noSpec.set(l.product, e);
      continue;
    }
    for (const c of spec.components) {
      if (!isPackaging(c.code)) continue;
      const code = newOf.get(c.code) ?? c.code;
      const need = l.qty * (c.qty || 0);
      if (need <= 0) continue;
      const e =
        m.get(code) ??
        ({ code, specCodes: [], description: c.description, unit: c.unit, need: { plan: 0, orders: 0, wms: 0 }, total: 0, central: 0, external: 0, stock: 0, short: 0, fromExternal: 0, firstDue: null, sources: [] } as ContainerNeed);
      if (!e.specCodes.includes(c.code)) e.specCodes.push(c.code);
      e.need[l.kind] += need;
      e.total += need;
      if (l.due && (!e.firstDue || l.due < e.firstDue)) e.firstDue = l.due;
      e.sources.push({ kind: l.kind, product: l.product, productDesc: l.description ?? spec.description, productQty: l.qty, perUnit: c.qty, need, due: l.due, ref: l.ref, specCode: c.code });
      m.set(code, e);
    }
  }
  const needs = [...m.values()].map((e) => {
    const s = st.get(e.code);
    e.central = s?.central ?? 0;
    e.external = s?.external ?? 0;
    e.stock = e.central + e.external;
    if (s?.description) e.description = s.description;
    e.short = Math.max(0, e.total - e.stock);
    e.fromExternal = Math.max(0, Math.min(e.external, e.total - e.central));
    e.sources.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || b.need - a.need);
    return e;
  });
  needs.sort((a, b) => b.short - a.short || b.fromExternal - a.fromExternal || b.total - a.total);
  return {
    needs,
    noSpec: [...noSpec.values()].map((x) => ({ ...x, kinds: [...x.kinds] })).sort((a, b) => b.qty - a.qty),
    lines: n,
  };
}

// ------------------------------------------------------------ Excel

export type Cell = string | number | Date | null | undefined;
export type ColMap = { product: number; qty: number; due: number; desc: number; ref: number };
const CODE_RE = /^\d{2}-\d{2}-\d{3}/;
const s = (v: Cell) => (v instanceof Date ? v.toISOString() : String(v ?? "")).trim();
const norm = (v: Cell) => s(v).toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function toNum(v: Cell): number | null {
  if (typeof v === "number") return isFinite(v) ? v : null;
  const t = s(v).replace(/\s/g, "");
  if (!t) return null;
  // 1.234 / 1.234,5 (ελληνικά) · 1,234.5 (αγγλικά) · 12,5 · 12.5
  const x = /^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)
    ? t.replace(/\./g, "").replace(",", ".")
    : /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)
      ? t.replace(/,/g, "")
      : t.replace(",", ".");
  const n = Number(x);
  return isFinite(n) ? n : null;
}
export function toDate(v: Cell): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) return new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  const m = s(v).match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  const iso = s(v).match(/^\d{4}-\d{2}-\d{2}/);
  return iso ? iso[0] : null;
}

/** Βρίσκει γραμμή επικεφαλίδων και στήλες (κωδικός, ποσότητα, ημερομηνία, περιγραφή, αναφορά) */
export function detectColumns(rows: Cell[][]): { header: number; cols: ColMap; names: string[] } {
  const width = Math.max(0, ...rows.slice(0, 200).map((r) => r.length));
  // στήλη κωδικού: εκεί που ταιριάζουν οι περισσότεροι κωδικοί τύπου 71-00-052
  const hits = Array.from({ length: width }, (_, c) => rows.slice(0, 500).filter((r) => CODE_RE.test(s(r[c]))).length);
  const product = hits.indexOf(Math.max(...hits, 0));
  const firstData = rows.findIndex((r) => CODE_RE.test(s(r[product])));
  let header = -1;
  for (let i = Math.max(0, firstData - 1); i >= Math.max(0, firstData - 6); i--) if (rows[i]?.filter((x) => s(x)).length >= 2) {
    header = i;
    break;
  }
  const names = Array.from({ length: width }, (_, c) => (header >= 0 ? s(rows[header][c]) : "") || `Στήλη ${c + 1}`);
  const H = names.map((n) => norm(n));
  const find = (re: RegExp, not: number[] = []) => H.findIndex((h, i) => re.test(h) && !not.includes(i));
  const data = rows.slice(Math.max(0, firstData), firstData + 300);
  const numeric = (c: number) => data.filter((r) => toNum(r[c]) != null).length;
  const dates = (c: number) => data.filter((r) => r[c] instanceof Date || /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/.test(s(r[c]))).length;
  let qty = find(/ΠΟΣΟΤ|ΠΟΣ\b|QTY|QUANT|ΤΕΜΑΧ|ΤΕΜ\b|PCS|UNITS|ΠΑΡΤΙΔΑ ΠΑΡ|BATCH SIZE|ΣΥΝΟΛΟ/, [product]);
  if (qty < 0) qty = [...Array(width).keys()].filter((c) => c !== product).sort((a, b) => numeric(b) - numeric(a))[0] ?? -1;
  let due = find(/ΗΜΕΡΟΜ|ΗΜ\/ΝΙΑ|DATE|ΠΑΡΑΔΟΣ|DELIVERY|DUE|ΕΒΔΟΜ|WEEK/, [product, qty]);
  if (due < 0) {
    const best = [...Array(width).keys()].filter((c) => c !== product && c !== qty).sort((a, b) => dates(b) - dates(a))[0];
    due = best != null && dates(best) > 0 ? best : -1;
  }
  const desc = find(/ΠΕΡΙΓΡ|DESCR|ΟΝΟΜΑΣ|ΠΡΟΙΟΝ|PRODUCT NAME|ITEM NAME/, [product, qty, due]);
  const ref = find(/ΠΑΡΑΓΓ|ORDER|ΠΕΛΑΤ|CUSTOMER|ΕΝΤΟΛ|ΠΑΡΤ|LOT|BATCH|ΑΡ\./, [product, qty, due, desc]);
  return { header, cols: { product, qty, due, desc, ref }, names };
}

export function readDemand(rows: Cell[][], cols: ColMap, header: number): { product: string; description: string | null; qty: number; due: string | null; ref: string | null; row: number }[] {
  const out: { product: string; description: string | null; qty: number; due: string | null; ref: string | null; row: number }[] = [];
  for (let i = header + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const code = s(r[cols.product]).toUpperCase().match(CODE_RE)?.[0];
    const q = cols.qty >= 0 ? toNum(r[cols.qty]) : null;
    if (!code || q == null || q <= 0) continue;
    out.push({
      product: code,
      description: cols.desc >= 0 ? s(r[cols.desc]) || null : null,
      qty: q,
      due: cols.due >= 0 ? toDate(r[cols.due]) : null,
      ref: cols.ref >= 0 ? s(r[cols.ref]) || null : null,
      row: i + 1,
    });
  }
  return out;
}
