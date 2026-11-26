// Ζήτηση υλικών συσκευασίας (περιέκτες, καπάκια κ.λπ.) από το πλάνο παραγωγής και τις ανοιχτές παραγγελίες.
// Τελικά προϊόντα (00*, 71* …) -> προδιαγραφές (ίδιες με το Repack) -> υλικά με κωδικό ΟΧΙ 00* / 71*.
// Οι παλιοί κωδικοί 40* των προδιαγραφών μεταφράζονται στους νέους 41* (item_legacy). Καθαρή λογική.
import { siteOf } from "./site.ts";

export type DemandKind = "plan" | "orders" | "wms";
export type DemandLine = { kind: DemandKind; product: string; description: string | null; qty: number; due: string | null; ref: string | null; stock?: number | null };
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
export type DemandResult = { orderInfo: Map<string, { pending: number; stock: number; plan: number; toMake: number }>; needs: ContainerNeed[]; noSpec: { product: string; description: string | null; qty: number; kinds: DemandKind[] }[]; lines: number };

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
  // Ανοιχτές παραγγελίες: μετράει μόνο ό,τι δεν καλύπτεται από το απόθεμα του τελικού και από το πλάνο παραγωγής
  // (αλλιώς οι ίδιοι περιέκτες θα μετρούσαν δύο φορές). Μοιράζεται στις γραμμές με σειρά ημερομηνίας.
  const inScope = lines.filter((l) => !(until && l.due && l.due > until));
  const planOf = new Map<string, number>();
  for (const l of inScope) if (l.kind === "plan") planOf.set(l.product, (planOf.get(l.product) ?? 0) + l.qty);
  const ordersBy = new Map<string, DemandLine[]>();
  for (const l of inScope) if (l.kind === "orders") ordersBy.set(l.product, [...(ordersBy.get(l.product) ?? []), l]);
  const effective: DemandLine[] = inScope.filter((l) => l.kind !== "orders");
  const orderInfo = new Map<string, { pending: number; stock: number; plan: number; toMake: number }>();
  for (const [prod, ls] of ordersBy) {
    const pending = ls.reduce((t, l) => t + l.qty, 0);
    const stockF = Math.max(0, ...ls.map((l) => l.stock ?? 0));
    const plan = planOf.get(prod) ?? 0;
    let toMake = Math.max(0, pending - stockF - plan);
    orderInfo.set(prod, { pending, stock: stockF, plan, toMake });
    for (const l of [...ls].sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999")).reverse()) {
      // οι νεότερες παραγγελίες μένουν ακάλυπτες πρώτες (οι παλιές εξυπηρετούνται από το απόθεμα)
      if (toMake <= 0) break;
      const q = Math.min(l.qty, toMake);
      effective.push({ ...l, qty: q });
      toMake -= q;
    }
  }
  const m = new Map<string, ContainerNeed>();
  const noSpec = new Map<string, { product: string; description: string | null; qty: number; kinds: Set<DemandKind> }>();
  let n = 0;
  for (const l of effective) {
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
    orderInfo,
    needs,
    noSpec: [...noSpec.values()].map((x) => ({ ...x, kinds: [...x.kinds] })).sort((a, b) => b.qty - a.qty),
    lines: n,
  };
}

// ------------------------------------------------------------ Excel

export type Cell = string | number | boolean | Date | null | undefined;
export type ColMap = { product: number; qty: number; due: number; desc: number; ref: number; cust: number; produced: number; done: number; stock: number };
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

/** Βρίσκει γραμμή επικεφαλίδων και στήλες (κωδικός, ποσότητα, ημερομηνία, περιγραφή, αναφορά, πελάτης, παραχθέντα, ολοκληρωμένο) */
export function detectColumns(rows: Cell[][]): { header: number; cols: ColMap; names: string[] } {
  const width = Math.max(0, ...rows.slice(0, 200).map((r) => r.length));
  const hits = Array.from({ length: width }, (_, c) => rows.slice(0, 800).filter((r) => CODE_RE.test(s(r[c]))).length);
  // γραμμή επικεφαλίδων: η πρώτη με ≥3 κείμενα πάνω από τα δεδομένα
  const anyCode = rows.findIndex((r) => r.some((x) => CODE_RE.test(s(x))));
  let header = -1;
  for (let i = Math.max(0, anyCode - 1); i >= Math.max(0, anyCode - 8); i--)
    if ((rows[i] ?? []).filter((x) => s(x) && !CODE_RE.test(s(x)) && typeof x !== "number").length >= 2) {
      header = i;
      break;
    }
  const names = Array.from({ length: width }, (_, c) => (header >= 0 ? s(rows[header][c]) : "") || `Στήλη ${c + 1}`);
  const H = names.map((n) => norm(n));
  const used: number[] = [];
  const pick = (...res: RegExp[]) => {
    for (const re of res) {
      const i = H.findIndex((h, k) => re.test(h) && !used.includes(k));
      if (i >= 0) {
        used.push(i);
        return i;
      }
    }
    return -1;
  };
  // κωδικός τελικού: στήλη «Code / Κωδικός είδους», όχι πελάτη ή bulk
  let product = pick(/^(CODE|ITEM CODE|ITEM|ΚΩΔΙΚΟΣ|ΚΩΔΙΚΟΣ ΕΙΔΟΥΣ|ΚΩΔ\.? ΕΙΔΟΥΣ|ΕΙΔΟΣ|PRODUCT CODE|ΚΩΔΙΚΟΣ ΤΕΛΙΚΟΥ)$/);
  if (product < 0) {
    const cands = [...Array(width).keys()].filter((c) => !/CUS|ΠΕΛΑΤ|BULK|ΧΥΜ/.test(H[c]) && !used.includes(c));
    product = cands.sort((a, b) => hits[b] - hits[a])[0] ?? -1;
    if (product >= 0) used.push(product);
  }
  const firstData = Math.max(header + 1, rows.findIndex((r) => CODE_RE.test(s(r[product]))));
  const data = rows.slice(firstData, firstData + 300);
  const numeric = (c: number) => data.filter((r) => toNum(r[c]) != null).length;
  const dates = (c: number) => data.filter((r) => r[c] instanceof Date || /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/.test(s(r[c]))).length;
  let qty = pick(/QTY FOR PRODUCTION|ΠΡΟΣ ΠΑΡΑΓΩΓΗ|ΠΟΣΟΤΗΤΑ ΠΑΡΑΓΩΓΗΣ/, /QTY PENDING|^PENDING|ΥΠΟΛΟΙΠ|ΕΚΚΡΕΜ/, /^(ΠΟΣΟΤΗΤΑ|ΠΟΣ\.?|QTY|QUANTITY|ΤΕΜΑΧΙΑ|ΤΕΜ\.?|PCS)$/);
  if (qty < 0) {
    const i = H.findIndex((h, k) => /ΠΟΣΟΤ|QTY|QUANT|ΤΕΜΑΧ/.test(h) && !/KG|NEEDED|RESERV|PRODUCED|ΠΑΡΗΧΘ|BULK/.test(h) && !used.includes(k));
    qty = i >= 0 ? i : [...Array(width).keys()].filter((c) => !used.includes(c)).sort((a, b) => numeric(b) - numeric(a))[0] ?? -1;
    if (qty >= 0) used.push(qty);
  }
  const produced = pick(/^PRODUCED|ΠΑΡΗΧΘ|ΠΑΡΑΧΘ|ΕΚΤΕΛΕΣΜ/);
  const done = pick(/^COMPLETED$|ΟΛΟΚΛΗΡ/);
  let due = pick(/PRODUCTION DATE|ΗΜΕΡΟΜΗΝΙΑ ΠΑΡΑΓΩΓ|ΗΜ\.? ΠΑΡΑΓΩΓ/, /^(REQUEST DATE|REQUESTED DATE|DUE DATE|ΗΜΕΡΟΜΗΝΙΑ ΠΑΡΑΔΟΣΗΣ|ΠΑΡΑΔΟΣΗ)$/, /^(ESTIMATED DELIVERY DATE|DELIVERY DATE)$/, /^(ΗΜΕΡΟΜΗΝΙΑ|DATE|ΗΜ\/ΝΙΑ)$/);
  if (due < 0) {
    const best = [...Array(width).keys()].filter((c) => !used.includes(c)).sort((a, b) => dates(b) - dates(a))[0];
    due = best != null && dates(best) > 0 ? best : -1;
    if (due >= 0) used.push(due);
  }
  const desc = pick(/^(DESCRIPTION|ΠΕΡΙΓΡΑΦΗ|ΠΕΡΙΓΡΑΦΗ ΕΙΔΟΥΣ|ITEM NAME|PRODUCT NAME)$/, /ΠΕΡΙΓΡ|DESCR/);
  const cust = pick(/^(CUSTOMER|ΠΕΛΑΤΗΣ|ΕΠΩΝΥΜΙΑ)$/, /^CUSTOMER(?! EXTRA)|ΠΕΛΑΤ/);
  const ref = pick(/ORDER INVOICE|TRADECODE|ΑΡ\.? ΠΑΡΑΓΓ|ΠΑΡΑΓΓΕΛΙΑ|ORDER NO|ORDER$/);
  const stock = pick(/^(STOCK|ΑΠΟΘΕΜΑ|ΥΠΟΛΟΙΠΟ ΑΠΟΘΗΚΗΣ)$/);
  return { header, cols: { product, qty, due, desc, ref, cust, produced, done, stock }, names };
}

const yes = (v: Cell) => /^(YES|ΝΑΙ|Y|TRUE|1|X|✓)$/i.test(s(v)) || v === true;

/** Γραμμές ζήτησης: μένει να παραχθεί = ποσότητα − παραχθέντα· οι ολοκληρωμένες γραμμές δεν μετράνε */
export type ReadLine = { product: string; description: string | null; qty: number; due: string | null; ref: string | null; row: number; stock: number | null };
export function readDemand(rows: Cell[][], cols: ColMap, header: number): ReadLine[] {
  const out: ReadLine[] = [];
  for (let i = header + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const code = s(r[cols.product]).toUpperCase().match(CODE_RE)?.[0];
    let q = cols.qty >= 0 ? toNum(r[cols.qty]) : null;
    if (!code || q == null || q <= 0) continue;
    if (cols.done >= 0 && yes(r[cols.done])) continue;
    if (cols.produced >= 0) q -= Math.max(0, toNum(r[cols.produced]) ?? 0);
    if (q <= 0) continue;
    const ref = [cols.cust >= 0 ? s(r[cols.cust]) : "", cols.ref >= 0 ? s(r[cols.ref]) : ""].filter(Boolean).join(" · ");
    out.push({
      product: code,
      description: cols.desc >= 0 ? s(r[cols.desc]) || null : null,
      qty: q,
      due: cols.due >= 0 ? toDate(r[cols.due]) : null,
      ref: ref || null,
      row: i + 1,
      stock: cols.stock >= 0 ? toNum(r[cols.stock]) : null,
    });
  }
  return out;
}
