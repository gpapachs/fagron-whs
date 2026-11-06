// Πλάνο μεταφοράς αποθέματος σε εξωτερική αποθήκη: για κάθε κωδικό υπολογίζει πόσο πρέπει να
// μείνει στην κεντρική (κατανάλωση Χ μηνών + ανοιχτές παραγγελίες, σε ολόκληρες παλέτες), τι
// περισσεύει και ΠΟΙΕΣ θέσεις/παρτίδες να φύγουν: μένουν οι παλαιότερες (FEFO/FIFO), φεύγουν οι
// νεότερες. Βγάζει και τις θέσεις που αδειάζουν και ό,τι πρέπει να επιστρέψει από έξω.
import { palletQty, palletsFor, type PalSource } from "./analysis.ts";

export type RelRow = {
  item: string;
  description: string | null;
  pos: string;
  area: string;
  lot: string;
  expiry: string | null;
  qty: number;
  lot_first_receipt: string | null;
  item_out_qty: number;
  item_out_n: number;
  item_out_last: string | null;
  item_first_move: string | null;
  open_demand: number;
  open_lists: number;
  pal_manual: number | null;
  pal_manual_by: string | null;
  pal_wms: number | null;
  pos_other_rows: number;
  item_first_receipt: string | null;
};

export type AreaClass = "movable" | "fixed" | "offsite";
export type RelParams = {
  prefix: string;
  from: string; // κατανάλωση από
  keepMonths: number; // μήνες κάλυψης που μένουν στην κεντρική
  includeNew: boolean; // νέοι κωδικοί (πρώτη κίνηση < 90 ημ.) χωρίς κατανάλωση: να φύγουν κι αυτοί;
  partial: boolean; // επιτρέπεται να φύγει μέρος θέσης (σε ολόκληρες παλέτες)
  areaClass: Record<string, AreaClass>;
  excluded: string[]; // κωδικοί που ο χρήστης κρατά όλους
  today?: Date;
};
export type Category = "dead" | "new" | "slow" | "active" | "excluded";
export type MoveLine = {
  item: string;
  description: string | null;
  pos: string;
  area: string;
  lot: string;
  expiry: string | null;
  posQty: number;
  moveQty: number;
  full: boolean; // φεύγει όλη η γραμμή της θέσης
  pallets: number | null;
  freesPosition: boolean;
};
export type ItemPlan = {
  item: string;
  description: string | null;
  category: Category;
  onsite: number; // κεντρική (μεταφέρσιμη + σταθερή)
  movable: number;
  offsite: number;
  perMonth: number;
  cover: number | null; // μήνες κάλυψης στην κεντρική σήμερα
  demand: number;
  keep: number;
  moveQty: number;
  movePallets: number | null;
  lines: MoveLine[];
  returnQty: number; // να επιστρέψει από εξωτερική (λείπει από την κεντρική)
  neededBack: string | null; // πότε περίπου θα χρειαστεί ό,τι φεύγει (ISO ημερομηνία)
  palQty: number | null;
  palSource: PalSource;
  palBy: string | null;
  positions: number;
};
export type RelPlan = {
  params: RelParams;
  months: number;
  areas: { area: string; rows: number; qty: number; cls: AreaClass }[];
  items: ItemPlan[];
  moving: ItemPlan[];
  returns: ItemPlan[];
  lines: MoveLine[]; // ταξινομημένες ανά θέση (διαδρομή)
  freedPositions: string[];
  totals: { moveQty: number; pallets: number; palletsMissing: number; lines: number; items: number };
};

const DAY = 86400000;
const EPS = 1e-6;
const num = (v: unknown) => (v == null || v === "" ? 0 : Number(v));

export function normRel(r: Record<string, unknown>): RelRow {
  return {
    item: String(r.item ?? ""),
    description: (r.description as string | null) ?? null,
    pos: String(r.pos ?? ""),
    area: String(r.area ?? ""),
    lot: String(r.lot ?? ""),
    expiry: (r.expiry as string | null) ?? null,
    qty: num(r.qty),
    lot_first_receipt: (r.lot_first_receipt as string | null) ?? null,
    item_out_qty: num(r.item_out_qty),
    item_out_n: num(r.item_out_n),
    item_out_last: (r.item_out_last as string | null) ?? null,
    item_first_move: (r.item_first_move as string | null) ?? null,
    open_demand: num(r.open_demand),
    open_lists: num(r.open_lists),
    pal_manual: r.pal_manual == null ? null : num(r.pal_manual),
    pal_manual_by: (r.pal_manual_by as string | null) ?? null,
    pal_wms: r.pal_wms_ppp == null ? null : num(r.pal_wms_ppp),
    pos_other_rows: num(r.pos_other_rows),
    item_first_receipt: (r.item_first_receipt as string | null) ?? null,
  };
}

/** Προεπιλογή κατηγορίας περιοχής από το όνομά της. */
export function defaultAreaClass(area: string): AreaClass {
  const a = area.toUpperCase();
  if (/ΕΞΩΤΕΡΙΚΗ ΑΠΟΘΗΚΗ|ΜΕΓΑΛΟΧΩΡ|ΝΑΤΣΙΟΠΟΥΛ/.test(a)) return "offsite";
  if (a === "" || /^ΚΕΝΤΡΙΚΗ ΑΠΟΘΗΚΗ/.test(a)) return "movable";
  return "fixed"; // αναλώσεων, εισερχόμενα, δειγματοληψία, παραγωγή, ...
}

// μένουν πρώτες οι παλαιότερες: νωρίτερη λήξη, μετά νωρίτερη παραλαβή
const keepOrder = (a: RelRow, b: RelRow) =>
  (a.expiry ?? "9999").localeCompare(b.expiry ?? "9999") || (a.lot_first_receipt ?? "").localeCompare(b.lot_first_receipt ?? "") || a.pos.localeCompare(b.pos);

export function planRelocation(rows: RelRow[], params: RelParams): RelPlan {
  const today = params.today ?? new Date();
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const fromT = new Date(`${params.from}T00:00:00`).getTime();
  const months = Math.max(1, (t0 - fromT) / DAY / 30.4);
  const cls = (area: string) => params.areaClass[area] ?? defaultAreaClass(area);
  const excluded = new Set(params.excluded);

  const areaMap = new Map<string, { area: string; rows: number; qty: number; cls: AreaClass }>();
  for (const r of rows) {
    const a = areaMap.get(r.area) ?? { area: r.area, rows: 0, qty: 0, cls: cls(r.area) };
    a.rows++;
    a.qty += r.qty;
    areaMap.set(r.area, a);
  }

  const byItem = new Map<string, RelRow[]>();
  for (const r of rows) byItem.set(r.item, [...(byItem.get(r.item) ?? []), r]);

  const items: ItemPlan[] = [];
  for (const [item, rs] of byItem) {
    const h = rs[0];
    const pq = palletQty(h);
    const onsiteRows = rs.filter((r) => cls(r.area) !== "offsite");
    const movableRows = rs.filter((r) => cls(r.area) === "movable");
    const onsite = onsiteRows.reduce((s, r) => s + r.qty, 0);
    const movable = movableRows.reduce((s, r) => s + r.qty, 0);
    const offsite = rs.filter((r) => cls(r.area) === "offsite").reduce((s, r) => s + r.qty, 0);
    // μήνες κατανάλωσης: από την αρχή της περιόδου ή από την πρώτη κίνηση του κωδικού, αν είναι νεότερος
    const firstT = h.item_first_move ? new Date(h.item_first_move).getTime() : fromT;
    const effMonths = Math.max(1, (t0 - Math.max(fromT, firstT)) / DAY / 30.4);
    const perMonth = h.item_out_qty / effMonths;
    const demand = h.open_demand;
    // νέος κωδικός: πρώτη παραλαβή τις τελευταίες 90 ημέρες χωρίς καμία κίνηση πριν από αυτήν
    // (όχι απλή εσωτερική μετακίνηση παλιού αποθέματος)
    const rcvT = h.item_first_receipt ? new Date(h.item_first_receipt).getTime() : null;
    const isNew = rcvT != null && t0 - rcvT < 90 * DAY && (!h.item_first_move || new Date(h.item_first_move).getTime() >= rcvT - DAY);
    let category: Category =
      excluded.has(item) ? "excluded" : h.item_out_qty <= EPS && demand <= EPS ? (isNew ? "new" : "dead") : perMonth > 0 && onsite / perMonth > params.keepMonths * 2 ? "slow" : "active";

    let keep = perMonth * params.keepMonths + demand;
    if (pq.qty && keep > 0) keep = Math.ceil(keep / pq.qty - EPS) * pq.qty;
    if (category === "excluded" || (category === "new" && !params.includeNew)) keep = Infinity;

    let excess = Math.min(movable, Math.max(0, onsite - keep));
    const lines: MoveLine[] = [];
    if (excess > EPS) {
      // φεύγουν πρώτα οι νεότερες (αντίστροφη σειρά από αυτές που μένουν)
      const order = [...movableRows].sort(keepOrder).reverse();
      for (const r of order) {
        if (excess <= EPS) break;
        if (r.qty <= excess + EPS) {
          lines.push(mk(r, r.qty, true, pq.qty));
          excess -= r.qty;
        } else if (params.partial && pq.qty) {
          const q = Math.floor(excess / pq.qty + EPS) * pq.qty;
          if (q > EPS) lines.push(mk(r, q, false, pq.qty));
          excess = 0;
        }
      }
    }
    const moveQty = lines.reduce((s, l) => s + l.moveQty, 0);
    const left = onsite - moveQty;
    const returnQty = category !== "excluded" && offsite > 0 && perMonth > 0 && onsite < perMonth * params.keepMonths + demand ? Math.min(offsite, perMonth * params.keepMonths + demand - onsite) : 0;
    const neededBack = moveQty > 0 && perMonth > 0 ? new Date(t0 + (Math.max(0, left - demand) / perMonth) * 30.4 * DAY).toISOString().slice(0, 10) : null;
    if (category === "active" && moveQty > 0) category = "slow";
    items.push({
      item,
      description: h.description,
      category,
      onsite,
      movable,
      offsite,
      perMonth,
      cover: perMonth > 0 ? onsite / perMonth : null,
      demand,
      keep: isFinite(keep) ? keep : onsite,
      moveQty,
      movePallets: pq.qty ? lines.reduce((s, l) => s + (l.pallets ?? 0), 0) : null,
      lines,
      returnQty,
      neededBack,
      palQty: pq.qty,
      palSource: pq.source,
      palBy: h.pal_manual_by,
      positions: new Set(onsiteRows.map((r) => r.pos)).size,
    });
  }

  // θέσεις που αδειάζουν: όλες οι γραμμές του προθέματος φεύγουν ολόκληρες και δεν υπάρχει άλλο είδος
  const posRows = new Map<string, RelRow[]>();
  for (const r of rows) posRows.set(r.pos, [...(posRows.get(r.pos) ?? []), r]);
  const fullMoved = new Set<string>();
  for (const p of items) for (const l of p.lines) if (l.full) fullMoved.add(`${l.item}|${l.pos}|${l.lot}|${l.expiry ?? ""}`);
  const freed = new Set<string>();
  for (const [pos, rs] of posRows) {
    if (rs[0].pos_other_rows > 0) continue;
    if (rs.every((r) => fullMoved.has(`${r.item}|${r.pos}|${r.lot}|${r.expiry ?? ""}`))) freed.add(pos);
  }
  const lines = items.flatMap((p) => p.lines).sort((a, b) => a.pos.localeCompare(b.pos, "el", { numeric: true }) || a.item.localeCompare(b.item));
  for (const l of lines) l.freesPosition = freed.has(l.pos);

  const moving = items.filter((p) => p.moveQty > 0).sort((a, b) => (b.movePallets ?? 0) - (a.movePallets ?? 0) || b.moveQty - a.moveQty);
  const returns = items.filter((p) => p.returnQty > 0);
  const order: Record<Category, number> = { dead: 0, slow: 1, new: 2, active: 3, excluded: 4 };
  items.sort((a, b) => order[a.category] - order[b.category] || b.moveQty - a.moveQty || a.item.localeCompare(b.item));

  return {
    params,
    months,
    areas: [...areaMap.values()].sort((a, b) => b.rows - a.rows),
    items,
    moving,
    returns,
    lines,
    freedPositions: [...freed].sort(),
    totals: {
      moveQty: moving.reduce((s, p) => s + p.moveQty, 0),
      pallets: lines.reduce((s, l) => s + (l.pallets ?? 0), 0),
      palletsMissing: lines.filter((l) => l.pallets == null).length,
      lines: lines.length,
      items: moving.length,
    },
  };
}

function mk(r: RelRow, q: number, full: boolean, palQ: number | null): MoveLine {
  return { item: r.item, description: r.description, pos: r.pos, area: r.area, lot: r.lot, expiry: r.expiry, posQty: r.qty, moveQty: q, full, pallets: palletsFor(q, palQ), freesPosition: false };
}

export const CATEGORY_TXT: Record<Category, string> = {
  dead: "Χωρίς κατανάλωση",
  slow: "Αργή κίνηση",
  new: "Νέος κωδικός",
  active: "Ενεργός",
  excluded: "Μένει (επιλογή)",
};

export const withRelPallet = (rows: RelRow[], item: string, qty: number | null, by: string | null) =>
  rows.map((r) => (r.item === item ? { ...r, pal_manual: qty, pal_manual_by: qty ? by : null } : r));
