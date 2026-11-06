// Ανάλυση παραλαβών: ποιες παρτίδες που ήρθαν από μια ημερομηνία και μετά δεν έχουν
// αναλωθεί, ποιοι κωδικοί δεν κινούνται, πόσους μήνες καλύπτει το απόθεμα, FIFO/FEFO, λήξεις.
// Τα δεδομένα έρχονται από το RPC wms_receipt_analysis· εδώ μόνο οι υπολογισμοί (χωρίς React).

export type ReceiptRow = {
  item: string;
  description: string | null;
  lot: string;
  first_receipt: string;
  last_receipt: string;
  supplier: string | null;
  received: number;
  stock: number;
  expiry: string | null;
  positions: string | null;
  lot_out_n: number;
  lot_out_last: string | null;
  item_out_n: number;
  item_out_qty: number;
  item_out_last: string | null;
  item_stock: number;
  item_lots: number;
  lot_positions: number;
  item_positions: number;
  pal_manual: number | null; // ποσότητα/παλέτα που έδωσε χρήστης
  pal_manual_by: string | null;
  pal_wms: number | null; // από το WMS (ms_Item.PiecesPerPalete), όταν είναι συμπληρωμένο
};

export type PalSource = "manual" | "wms" | null;
/** Ποσότητα ανά παλέτα: η χειροκίνητη υπερισχύει της τιμής του WMS. */
export function palletQty(r: { pal_manual: number | null; pal_wms: number | null }): { qty: number | null; source: PalSource } {
  if (r.pal_manual && r.pal_manual > 0) return { qty: r.pal_manual, source: "manual" };
  if (r.pal_wms && r.pal_wms > 1) return { qty: r.pal_wms, source: "wms" };
  return { qty: null, source: null };
}
/** Εκτιμώμενες παλέτες (στρογγυλοποίηση προς τα πάνω, 1 δεκαδικό για το σύνολο) */
export const palletsFor = (stock: number, qty: number | null) => (qty && qty > 0 && stock > 0 ? Math.ceil(stock / qty - 1e-9) : null);

export type BatchState = "untouched" | "partial" | "gone";
export type Batch = ReceiptRow & { state: BatchState; ageDays: number; monthsToExpiry: number | null; palQty: number | null; palSource: PalSource; pallets: number | null };
export type FifoCase = { batch: Batch; newer: Batch; fefo: boolean };
export type Coverage = {
  item: string;
  description: string | null;
  stock: number;
  outQty: number;
  perMonth: number;
  months: number | null; // null = χωρίς κατανάλωση
  untouchedBatches: number;
  untouchedQty: number;
  palQty: number | null;
  palSource: PalSource;
  pallets: number | null; // παλέτες όλου του αποθέματος του κωδικού
  positions: number;
};
export type Analysis = {
  prefix: string;
  from: string;
  periodMonths: number;
  batches: Batch[];
  untouched: Batch[];
  partial: Batch[];
  gone: Batch[];
  recent: Batch[]; // ανέγγιχτες ≤ recentDays
  old: Batch[]; // ανέγγιχτες > recentDays
  noConsumption: Batch[]; // ανέγγιχτες παρτίδες κωδικών χωρίς καμία έξοδο στην περίοδο
  toCheck: Batch[]; // μοναδική παρτίδα, τελευταία έξοδος κωδικού πριν την παραλαβή
  fifo: FifoCase[];
  expiring: Batch[]; // ανέγγιχτες, ληγμένες ή λήγουν σε < expiryMonths
  coverage: Coverage[];
  overstock: Coverage[]; // κάλυψη > coverMonths
};

const DAY = 86400000;
const EPS = 0.001;
const num = (v: unknown) => (v == null || v === "" ? 0 : Number(v));

export function normReceipt(r: Record<string, unknown>): ReceiptRow {
  return {
    item: String(r.item ?? ""),
    description: (r.description as string | null) ?? null,
    lot: String(r.lot ?? ""),
    first_receipt: String(r.first_receipt ?? ""),
    last_receipt: String(r.last_receipt ?? ""),
    supplier: (r.supplier as string | null) ?? null,
    received: num(r.received),
    stock: num(r.stock),
    expiry: (r.expiry as string | null) ?? null,
    positions: (r.positions as string | null) ?? null,
    lot_out_n: num(r.lot_out_n),
    lot_out_last: (r.lot_out_last as string | null) ?? null,
    item_out_n: num(r.item_out_n),
    item_out_qty: num(r.item_out_qty),
    item_out_last: (r.item_out_last as string | null) ?? null,
    item_stock: num(r.item_stock),
    item_lots: num(r.item_lots),
    lot_positions: num(r.lot_positions),
    item_positions: num(r.item_positions),
    pal_manual: r.pal_manual == null ? null : num(r.pal_manual),
    pal_manual_by: (r.pal_manual_by as string | null) ?? null,
    pal_wms: r.pal_wms_ppp == null ? (r.pal_wms == null ? null : num(r.pal_wms)) : num(r.pal_wms_ppp),
  };
}

export function analyse(
  rows: ReceiptRow[],
  opts: { prefix: string; from: string; today?: Date; recentDays?: number; expiryMonths?: number; coverMonths?: number }
): Analysis {
  const today = opts.today ?? new Date();
  const recentDays = opts.recentDays ?? 90;
  const expiryMonths = opts.expiryMonths ?? 6;
  const coverMonths = opts.coverMonths ?? 24;
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const fromT = new Date(`${opts.from}T00:00:00`).getTime();
  const periodMonths = Math.max(0.5, (t0 - fromT) / DAY / 30.4);

  const batches: Batch[] = rows.map((r) => {
    const state: BatchState = r.stock <= 0.0001 ? "gone" : r.stock >= r.received - EPS ? "untouched" : "partial";
    const ageDays = Math.max(0, Math.floor((t0 - new Date(r.first_receipt).getTime()) / DAY));
    const monthsToExpiry = r.expiry ? Math.round(((new Date(`${r.expiry}T00:00:00`).getTime() - t0) / DAY / 30.4) * 10) / 10 : null;
    const pq = palletQty(r);
    return { ...r, state, ageDays, monthsToExpiry, palQty: pq.qty, palSource: pq.source, pallets: palletsFor(r.stock, pq.qty) };
  });
  const untouched = batches.filter((b) => b.state === "untouched");
  const partial = batches.filter((b) => b.state === "partial");
  const gone = batches.filter((b) => b.state === "gone");
  const recent = untouched.filter((b) => b.ageDays <= recentDays);
  const old = untouched.filter((b) => b.ageDays > recentDays);
  const noConsumption = untouched.filter((b) => b.item_out_n === 0).sort((a, b) => b.stock - a.stock);
  const toCheck = old.filter((b) => b.item_out_n > 0 && b.item_lots === 1 && (b.item_out_last ?? "") < b.first_receipt);

  // FIFO: ανέγγιχτη παρτίδα ενώ καταναλώνεται (μερικώς) νεότερη του ίδιου κωδικού
  const partialByItem = new Map<string, Batch[]>();
  for (const p of partial) partialByItem.set(p.item, [...(partialByItem.get(p.item) ?? []), p]);
  const fifo: FifoCase[] = [];
  for (const u of untouched) {
    const newer = (partialByItem.get(u.item) ?? []).filter((p) => p.first_receipt > u.first_receipt);
    if (!newer.length) continue;
    const n = newer.reduce((a, b) => (b.first_receipt > a.first_receipt ? b : a));
    fifo.push({ batch: u, newer: n, fefo: !!(u.expiry && n.expiry && u.expiry < n.expiry) });
  }
  const expiring = untouched
    .filter((b) => b.monthsToExpiry != null && b.monthsToExpiry < expiryMonths)
    .sort((a, b) => (a.expiry ?? "").localeCompare(b.expiry ?? ""));

  // κάλυψη ανά κωδικό με ανέγγιχτη παρτίδα
  const byItem = new Map<string, Coverage>();
  for (const u of untouched) {
    const c = byItem.get(u.item);
    if (c) {
      c.untouchedBatches++;
      c.untouchedQty += u.stock;
      continue;
    }
    const perMonth = u.item_out_qty / periodMonths;
    byItem.set(u.item, {
      item: u.item,
      description: u.description,
      stock: u.item_stock,
      outQty: u.item_out_qty,
      perMonth,
      months: perMonth > 0 ? u.item_stock / perMonth : null,
      untouchedBatches: 1,
      untouchedQty: u.stock,
      palQty: u.palQty,
      palSource: u.palSource,
      pallets: palletsFor(u.item_stock, u.palQty),
      positions: u.item_positions,
    });
  }
  const coverage = [...byItem.values()].sort((a, b) => (b.months ?? Infinity) - (a.months ?? Infinity));
  const overstock = coverage.filter((c) => c.months != null && c.months > coverMonths);

  return {
    prefix: opts.prefix,
    from: opts.from,
    periodMonths,
    batches,
    untouched,
    partial,
    gone,
    recent,
    old,
    noConsumption,
    toCheck,
    fifo,
    expiring,
    coverage,
    overstock,
  };
}

export const sumStock = (bs: { stock: number }[]) => bs.reduce((s, b) => s + b.stock, 0);
/** σύνολο παλετών + πόσες γραμμές δεν έχουν ποσότητα/παλέτα */
export function sumPallets(bs: { pallets: number | null }[]) {
  let n = 0,
    missing = 0;
  for (const b of bs) (b.pallets == null ? missing++ : (n += b.pallets));
  return { pallets: n, missing };
}
/** αλλάζει τη χειροκίνητη ποσότητα/παλέτα ενός κωδικού σε όλες τις γραμμές */
export const withPallet = (rows: ReceiptRow[], item: string, qty: number | null, by: string | null) =>
  rows.map((r) => (r.item === item ? { ...r, pal_manual: qty, pal_manual_by: qty ? by : null } : r));
