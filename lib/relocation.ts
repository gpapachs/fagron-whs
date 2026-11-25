// Πλάνο μεταφοράς αποθέματος σε εξωτερική αποθήκη: για κάθε κωδικό υπολογίζει πόσο πρέπει να
// μείνει στην κεντρική (κατανάλωση Χ μηνών + ανοιχτές παραγγελίες, σε ολόκληρες παλέτες), τι
// περισσεύει και ΠΟΙΕΣ θέσεις/παρτίδες να φύγουν: μένουν οι παλαιότερες (FEFO/FIFO), φεύγουν οι
// νεότερες. Βγάζει και τις θέσεις που αδειάζουν και ό,τι πρέπει να επιστρέψει από έξω.
import { palletQty, palletsFor, type PalSource } from "./analysis.ts";
import { siteOf } from "./site.ts";

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
  /** παλιοί κωδικοί με ίδια περιγραφή (π.χ. 40-… που έγιναν 41-…) και η κατανάλωσή τους */
  legacy_codes: string | null;
  legacy_out_qty: number;
  legacy_first_move: string | null;
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
  /** χώρος (1ο τμήμα θέσης, π.χ. "20"): μόνο από εκεί φεύγει απόθεμα· έξω = θέσεις εξωτερικής,
   *  όλα τα άλλα σταθερά. "*" = όλοι οι χώροι της κεντρικής. Κενό = κατά περιοχή του WMS (areaClass). */
  room?: string;
  /** ποσότητα που ο χρήστης θέλει να φύγει ανά κωδικό (αντί για την προτεινόμενη) */
  manual?: Record<string, number>;
  /** ποσότητα ανά παρτίδα/θέση (κλειδί lineKey)· αν υπάρχει για έναν κωδικό, υπερισχύει */
  lotQty?: Record<string, number>;
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
  /** πρώτη παραλαβή (εισαγωγή) της παρτίδας στην αποθήκη */
  received: string | null;
  posQty: number;
  moveQty: number;
  full: boolean; // φεύγει όλη η γραμμή της θέσης
  pallets: number | null;
  freesPosition: boolean;
  /** ποσότητα που έγραψε ο χρήστης σε αυτή την παρτίδα/θέση (αν έγραψε) */
  req?: number;
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
  legacyCodes: string | null;
  legacyOut: number;
  outQty: number; // ανάλωση στην περίοδο (μαζί με τους παλιούς κωδικούς)
  effMonths: number; // μήνες στους οποίους μετρήθηκε η ανάλωση
  need: number; // ανάλωση μηνών + ανοιχτές παραγγελίες, πριν τη στρογγυλοποίηση σε παλέτες
  firstReceipt: string | null;
  /** γιατί προτείνεται αυτή η κίνηση: σύντομα και αναλυτικά */
  why: { short: string; long: string[] };
  /** ποσότητα που όρισε ο χρήστης (null = η προτεινόμενη) */
  manual?: number | null;
  /** η προτεινόμενη ποσότητα (πριν από τη χειροκίνητη) */
  suggested?: number;
  /** όλες οι παρτίδες/θέσεις του χώρου που μπορούν να φύγουν (και όσες δεν προτείνονται, με 0) */
  candidates?: MoveLine[];
  /** οι ποσότητες ορίστηκαν ανά παρτίδα */
  byLot?: boolean;
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
    legacy_codes: (r.legacy_codes as string | null) || null,
    legacy_out_qty: num(r.legacy_out_qty),
    legacy_first_move: (r.legacy_first_move as string | null) ?? null,
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
  const room = (params.room ?? "").trim();
  const clsArea = (area: string) => params.areaClass[area] ?? defaultAreaClass(area);
  // με χώρο: κατά θέση (χώρος -> μεταφέρσιμη, εξωτερική -> εξωτερική, αλλού -> σταθερή)
  const clsRow = (r: RelRow): AreaClass =>
    !room
      ? clsArea(r.area)
      : siteOf(r.pos) === "external"
        ? "offsite"
        : room === "*" || r.pos.split(".")[0] === room
          ? "movable"
          : "fixed";
  const excluded = new Set(params.excluded);

  const areaMap = new Map<string, { area: string; rows: number; qty: number; cls: AreaClass }>();
  for (const r of rows) {
    const a = areaMap.get(r.area) ?? { area: r.area, rows: 0, qty: 0, cls: clsRow(r) };
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
    const onsiteRows = rs.filter((r) => clsRow(r) !== "offsite");
    const movableRows = rs.filter((r) => clsRow(r) === "movable");
    if (room && room !== "*" && !movableRows.length) continue; // ανάλυση μόνο για ό,τι έχει απόθεμα στον χώρο
    const onsite = onsiteRows.reduce((s, r) => s + r.qty, 0);
    const movable = movableRows.reduce((s, r) => s + r.qty, 0);
    const offsite = rs.filter((r) => clsRow(r) === "offsite").reduce((s, r) => s + r.qty, 0);
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

    const need = perMonth * params.keepMonths + demand;
    let keep = need;
    if (pq.qty && keep > 0) keep = Math.ceil(keep / pq.qty - EPS) * pq.qty;
    if (category === "excluded" || (category === "new" && !params.includeNew)) keep = Infinity;

    const suggested = Math.min(movable, Math.max(0, onsite - keep));
    const lotRows = movableRows.filter((r) => params.lotQty?.[lineKey(r)] != null);
    const byLot = lotRows.length > 0;
    const man = byLot ? lotRows.reduce((t, r) => t + Math.max(0, params.lotQty![lineKey(r)]), 0) : params.manual?.[item];
    const manual = man != null && isFinite(man) && man >= 0 ? man : null;
    let excess = manual != null ? Math.min(movable, manual) : suggested;
    const lines: MoveLine[] = [];
    if (byLot) {
      // ποσότητες ανά παρτίδα/θέση: ακριβώς ό,τι έγραψε ο χρήστης (έως όσα υπάρχουν στη θέση)
      for (const r of [...movableRows].sort(keepOrder).reverse()) {
        const want = params.lotQty?.[lineKey(r)];
        if (want == null || want <= EPS) continue;
        const q = Math.min(r.qty, want);
        lines.push({ ...mk(r, q, q >= r.qty - EPS, pq.qty), req: want });
      }
    } else if (excess > EPS && manual != null) {
      // χειροκίνητη ποσότητα: ακριβώς όσα τεμάχια ζητήθηκαν, πρώτα από τις νεότερες παρτίδες
      for (const r of [...movableRows].sort(keepOrder).reverse()) {
        if (excess <= EPS) break;
        const q = Math.min(r.qty, excess);
        lines.push(mk(r, q, q >= r.qty - EPS, pq.qty));
        excess -= q;
      }
    } else if (excess > EPS) {
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
      legacyCodes: h.legacy_codes,
      legacyOut: h.legacy_out_qty,
      outQty: h.item_out_qty,
      effMonths,
      need,
      firstReceipt: h.item_first_receipt,
      why: { short: "", long: [] },
      manual,
      suggested,
      byLot,
      candidates: [...movableRows]
        .sort(keepOrder)
        .reverse()
        .map((r) => {
          const k = lineKey(r);
          const l = lines.find((x) => lineKey(x) === k);
          if (l) return l;
          const z = mk(r, 0, false, pq.qty);
          const want = params.lotQty?.[k];
          return want != null ? { ...z, req: want } : z;
        }),
    });
    const it = items[items.length - 1];
    it.why = explain(it, params, isNew);
    if (manual != null) {
      const txt = `${byLot ? "Ποσότητες ανά παρτίδα" : "Χειροκίνητη ποσότητα"}: φεύγουν ${n0(it.moveQty)} (πρόταση ${n0(suggested)}).`;
      it.why = { short: `${txt} Μένουν ${n0(it.onsite - it.moveQty)} στην κεντρική.`, long: [`${txt} Μένουν ${n0(it.onsite - it.moveQty)} στην κεντρική.`, "Η πρόταση της ανάλυσης ήταν:", ...it.why.long] };
    }
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

const n0 = (n: number) => Math.round(n).toLocaleString("el-GR");
const n1 = (n: number) => n.toLocaleString("el-GR", { maximumFractionDigits: 1 });
const dmy = (s: string | null) => (s ? s.slice(0, 10).split("-").reverse().join("/") : "");

/** Η αιτιολόγηση της πρότασης για έναν κωδικό, με τα νούμερα που την έβγαλαν. */
export function explain(i: ItemPlan, params: RelParams, isNew: boolean): { short: string; long: string[] } {
  const from = dmy(params.from);
  const legacy = i.legacyCodes ? ` (μαζί ${n0(i.legacyOut)} από τον παλιό ${i.legacyCodes})` : "";
  const cons = i.outQty > 0 ? `Ανάλωση ${n0(i.outQty)} σε ${n1(i.effMonths)} μήνες${legacy} = ${n1(i.perMonth)}/μήνα.` : `Καμία ανάλωση από ${from}${i.legacyCodes ? ` (ούτε στον παλιό ${i.legacyCodes})` : ""}.`;
  const dem = i.demand > 0 ? ` + ανοιχτές παραγγελίες ${n0(i.demand)}` : "";
  const pal = i.palQty && i.keep > i.need + 1e-6 ? `, σε ολόκληρες παλέτες των ${n0(i.palQty)} = ${n0(i.keep)}` : "";
  const long: string[] = [cons];
  if (i.category === "excluded") return { short: "Επιλέχθηκε «Κράτα όλο» — μένει.", long: [...long, "Ο κωδικός εξαιρέθηκε χειροκίνητα από τη μεταφορά."] };
  if (i.category === "new" && !params.includeNew)
    return {
      short: `Νέος κωδικός (πρώτη παραλαβή ${dmy(i.firstReceipt)}) χωρίς ανάλωση ακόμη — μένει.`,
      long: [...long, `Ήρθε για πρώτη φορά ${dmy(i.firstReceipt)}, λιγότερο από 90 ημέρες. Μένει μέχρι να φανεί η κατανάλωσή του (ή τσέκαρε «Να φύγουν και οι νέοι κωδικοί»).`],
    };
  if (i.outQty <= 0 && i.demand <= 0) {
    long.push(`Χωρίς ανάλωση και χωρίς ανοιχτές παραγγελίες δεν χρειάζεται απόθεμα στην κεντρική → φεύγει ό,τι είναι σε μεταφέρσιμες θέσεις (${n0(i.movable)}).`);
    if (isNew) long.push("Είναι νέος κωδικός· φεύγει επειδή είναι τσεκαρισμένο «Να φύγουν και οι νέοι κωδικοί».");
    return { short: `Καμία ανάλωση από ${from}${i.legacyCodes ? " (ούτε στον παλιό)" : ""} και καμία παραγγελία → φεύγει όλο.`, long };
  }
  long.push(`Για ${n1(params.keepMonths)} μήνες χρειάζονται ${n0(i.perMonth * params.keepMonths)}${dem ? `${dem} = ${n0(i.need)}` : ""}${pal}.`);
  const cover = i.cover == null ? "" : i.cover >= 24 ? `${n1(i.cover / 12)} έτη` : `${n0(i.cover)} μήνες`;
  long.push(`Στην κεντρική υπάρχουν ${n0(i.onsite)}${cover ? ` (κάλυψη ${cover})` : ""}.`);
  if (i.moveQty <= 0) {
    const why =
      i.onsite <= i.keep + 1e-6
        ? "Δεν περισσεύει — μένει όλο."
        : i.movable <= 0
          ? "Περισσεύει, αλλά δεν είναι σε θέσεις από τις οποίες φεύγει απόθεμα (π.χ. άλλος χώρος)."
          : "Περισσεύει λιγότερο από μία ολόκληρη παλέτα — μένει.";
    long.push(why);
    return { short: `${n1(i.perMonth)}/μήνα, κάλυψη ${cover || "—"} → ${why.toLowerCase()}`, long };
  }
  const excess = i.onsite - i.keep;
  long.push(
    `Περισσεύουν ${n0(excess)} → φεύγουν ${n0(i.moveQty)}${i.movePallets ? ` (${i.movePallets} παλ.)` : ""}: οι νεότερες παρτίδες, ώστε να μείνουν οι παλαιότερες (FEFO)${i.moveQty + 1e-6 < excess ? ` — μόνο σε ολόκληρες παλέτες / μεταφέρσιμες θέσεις` : ""}.`
  );
  if (i.neededBack) long.push(`Με αυτή την ανάλωση, ό,τι μένει φτάνει μέχρι περίπου ${dmy(i.neededBack)} — τότε θα χρειαστεί να επιστρέψει απόθεμα.`);
  return {
    short: `${n1(i.perMonth)}/μήνα${i.legacyCodes ? " (μαζί ο παλιός)" : ""}, κάλυψη ${cover} → για ${n1(params.keepMonths)} μήνες μένουν ${n0(i.keep)}, φεύγουν ${n0(i.moveQty)}.`,
    long,
  };
}

function mk(r: RelRow, q: number, full: boolean, palQ: number | null): MoveLine {
  return { item: r.item, description: r.description, pos: r.pos, area: r.area, lot: r.lot, expiry: r.expiry, received: r.lot_first_receipt, posQty: r.qty, moveQty: q, full, pallets: palletsFor(q, palQ), freesPosition: false };
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

/** Κλειδί γραμμής μεταφοράς (κωδικός · θέση · παρτίδα · λήξη) για τη λίστα συλλογής. */
export const lineKey = (l: Pick<MoveLine, "item" | "pos" | "lot" | "expiry">) => `${l.item}|${l.pos}|${l.lot}|${l.expiry ?? ""}`;

/** Κλειδί «όλος ο κωδικός» (για κωδικούς με χειροκίνητη ποσότητα, όπου οι γραμμές αλλάζουν). */
export const itemKey = (item: string) => `${item}|*`;

/** Το πλάνο περιορισμένο στις γραμμές που επέλεξε ο χρήστης (λίστα συλλογής). */
export function pickPlan(p: RelPlan, keys: Set<string>): RelPlan {
  const lines = p.lines.filter((l) => keys.has(lineKey(l)) || keys.has(itemKey(l.item)));
  const byItem = new Map<string, MoveLine[]>();
  for (const l of lines) byItem.set(l.item, [...(byItem.get(l.item) ?? []), l]);
  const moving = p.moving
    .filter((i) => byItem.has(i.item))
    .map((i) => {
      const ls = byItem.get(i.item)!;
      const pal = ls.every((l) => l.pallets != null) ? ls.reduce((s, l) => s + (l.pallets ?? 0), 0) : null;
      return { ...i, lines: ls, moveQty: ls.reduce((s, l) => s + l.moveQty, 0), movePallets: pal };
    });
  const freed = new Set(lines.filter((l) => l.freesPosition).map((l) => l.pos));
  return {
    ...p,
    items: moving,
    moving,
    returns: [],
    lines,
    freedPositions: p.freedPositions.filter((x) => freed.has(x)),
    totals: {
      moveQty: moving.reduce((s, i) => s + i.moveQty, 0),
      pallets: lines.reduce((s, l) => s + (l.pallets ?? 0), 0),
      palletsMissing: lines.filter((l) => l.pallets == null).length,
      lines: lines.length,
      items: moving.length,
    },
  };
}
