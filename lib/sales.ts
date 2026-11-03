// Παραγγελίες (λίστες πωλήσεων SALEXPORTLS): διαθεσιμότητα ανά γραμμή, χρώμα λίστας
// και πιθανή ανασυσκευασία (κωδικοί 00-* / 71-*) από το απόθεμα των συστατικών.
// Καθαρές συναρτήσεις -- τρέχουν ίδια στον browser και στο CI.
import { buildPicks, maxUnits, type ComponentNeed, type PickLine, type Recipe, type StockIndex } from "./repack.ts";
import type { OrderRow } from "./exports";

export type LineState = "ok" | "repack" | "partial" | "none" | "done"; // done = ήδη εκτελεσμένη
export type OrderColor = "green" | "yellow" | "red";

export type RepackSuggestion = {
  recipe: Recipe;
  units: number; // πόσα τεμάχια να ανασυσκευαστούν
  max: number; // πόσα βγαίνουν το πολύ από το απόθεμα
  picks: PickLine[]; // από πού παίρνεις τα συστατικά
};

export type LineEval = {
  line: OrderRow;
  need: number;
  stock: number; // σύνολο αποθέματος του κωδικού
  covered: number; // πόσα καλύπτονται από το απόθεμα (μετά τις προηγούμενες γραμμές της λίστας)
  state: LineState;
  picks: PickLine[]; // θέσεις συλλογής του ίδιου του είδους
  repack: RepackSuggestion | null;
};

export type OrderEval = {
  key: string; // αριθμός λίστας
  head: OrderRow;
  lines: LineEval[];
  color: OrderColor;
  completed: boolean;
  strict: boolean;
  needsRepack: boolean;
  picker: string;
  collecting: boolean; // «σε συλλογή» τώρα στο WMS
};

const EPS = 1e-9;
export const isRepackCode = (code: string) => /^(00|71)-/.test(code);
/** ό,τι ΑΠΟΜΕΝΕΙ να συλλεχθεί: Qty1 του WMS (0 = η γραμμή έχει ήδη εκτελεστεί) */
export const lineNeed = (l: Pick<OrderRow, "qty">) => Math.max(0, Number(l.qty ?? 0));

/** Δεσμευμένες παρτίδες: γραμμές ανοιχτών λιστών με συμπληρωμένη παρτίδα (κωδικός|παρτίδα -> ανά λίστα). */
export type Reservations = Map<string, { list: string; qty: number }[]>;
export function buildReservations(rows: Pick<OrderRow, "list_no" | "order_id" | "item" | "lot" | "qty" | "is_completed">[]): Reservations {
  const m: Reservations = new Map();
  for (const r of rows) {
    const q = lineNeed(r);
    if (!r.lot || q <= EPS || r.is_completed) continue;
    const k = `${r.item}|${r.lot}`;
    const list = r.list_no || r.order_id;
    const arr = m.get(k) ?? [];
    const e = arr.find((x) => x.list === list);
    if (e) e.qty += q;
    else arr.push({ list, qty: q });
    m.set(k, arr);
  }
  return m;
}
export const reservedByOthers = (res: Reservations | undefined, item: string, lot: string, list: string) =>
  (res?.get(`${item}|${lot}`) ?? []).filter((x) => x.list !== list).reduce((a, x) => a + x.qty, 0);

/**
 * Χρώμα λίστας:
 *  πράσινο  = όλα τα είδη διαθέσιμα (με ανασυσκευασία αν `repackCounts`)
 *  κόκκινο  = αυστηρή συλλογή και τουλάχιστον ένα είδος δεν καλύπτεται,
 *             ή μερική συλλογή και κανένα είδος σε απόθεμα
 *  κίτρινο  = μερική συλλογή και απόθεμα σε κάποιο/κάποια είδη
 */
export function orderColor(lines: Pick<LineEval, "state">[], strict: boolean, repackCounts = true): OrderColor {
  const full = (s: LineState) => s === "ok" || (repackCounts && s === "repack");
  const open = lines.filter((l) => l.state !== "done"); // οι εκτελεσμένες δεν μετράνε
  if (open.every((l) => full(l.state))) return "green";
  if (strict) return "red";
  return open.some((l) => l.state !== "none") ? "yellow" : "red";
}

export function evaluateOrders(
  rows: OrderRow[],
  idx: StockIndex,
  recipesByProduct: Map<string, Recipe[]>,
  opts: { repackCounts?: boolean; reservations?: Reservations; showExecuted?: boolean } = {}
): OrderEval[] {
  const repackCounts = opts.repackCounts ?? true;
  const res = opts.reservations;
  const groups = new Map<string, OrderRow[]>();
  for (const r of rows) {
    // γραμμές που έχουν ήδη εκτελεστεί (ποσότητα 0): μόνο αν το ζητήσει ο χρήστης
    if (lineNeed(r) <= EPS && !opts.showExecuted) continue;
    const k = r.list_no || r.order_id;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const total = (code: string) => idx.get(code)?.total ?? 0;
  const out: OrderEval[] = [];
  for (const [key, lines] of groups) {
    const sorted = [...lines].sort((a, b) => (a.line_no ?? 0) - (b.line_no ?? 0) || a.id.localeCompare(b.id));
    const used = new Map<string, number>(); // ίδια θέση/παρτίδα σε πολλές γραμμές της λίστας
    // θέσεις του είδους με ό,τι μένει ελεύθερο: αφαιρούνται οι δεσμεύσεις ΑΛΛΩΝ λιστών και
    // όσα πήραν προηγούμενες γραμμές· με παρτίδα, μόνο αυτή η παρτίδα
    const freeRows = (item: string, lot: string) => {
      const rowsOf = (idx.get(item)?.rows ?? []).filter((r) => !lot || (r.lot ?? "") === lot);
      const left = new Map<string, number>();
      for (const r of rowsOf) {
        const l = r.lot ?? "";
        if (!left.has(l)) left.set(l, reservedByOthers(res, item, l, key));
      }
      return rowsOf
        .map((r) => {
          const l = r.lot ?? "";
          const cut = Math.min(r.qty, left.get(l) ?? 0);
          left.set(l, (left.get(l) ?? 0) - cut);
          const k = `${item}|${r.position}|${l}`;
          return { ...r, qty: Math.max(0, r.qty - cut - (used.get(k) ?? 0)) };
        })
        .filter((r) => r.qty > EPS);
    };
    const evals: LineEval[] = sorted.map((line) => {
      const need = lineNeed(line);
      if (need <= EPS) return { line, need: 0, stock: total(line.item), covered: 0, state: "done" as LineState, picks: [], repack: null };
      const lot = line.lot ?? "";
      const stock = lot ? (idx.get(line.item)?.rows ?? []).filter((r) => (r.lot ?? "") === lot).reduce((a, r) => a + r.qty, 0) : total(line.item);
      const avail = freeRows(line.item, lot);
      const free = avail.reduce((a, r) => a + r.qty, 0);
      const covered = Math.min(need, free);
      let state: LineState = covered + EPS >= need ? "ok" : covered > EPS ? "partial" : "none";
      let repack: RepackSuggestion | null = null;
      const shortage = need - covered;
      // ανασυσκευασία μόνο όταν η γραμμή δεν ζητά συγκεκριμένη παρτίδα
      if (shortage > EPS && !lot && isRepackCode(line.item)) {
        let best: { recipe: Recipe; max: number } | null = null;
        for (const recipe of recipesByProduct.get(line.item) ?? []) {
          const { max } = maxUnits(recipe, total);
          if (!best || max > best.max) best = { recipe, max };
        }
        if (best && best.max > 0) {
          const units = Math.min(Math.ceil(shortage - EPS), best.max);
          const needs: ComponentNeed[] = best.recipe.components.map((c) => ({
            code: c.code,
            description: c.description,
            unit: c.unit,
            required: c.qty * units,
            available: total(c.code),
            shortage: 0,
            usedBy: [],
          }));
          repack = { recipe: best.recipe, units, max: best.max, picks: buildPicks(needs, idx) };
          if (covered + units + EPS >= need) state = "repack";
          else if (state === "none") state = "partial";
        }
      }
      // θέσεις συλλογής από τις ελεύθερες θέσεις
      const sub: StockIndex = new Map([[line.item, { total: free, description: line.description, rows: avail }]]);
      const picks =
        covered > EPS ? buildPicks([{ code: line.item, description: line.description, unit: "", required: covered, available: covered, shortage: 0, usedBy: [] }], sub) : [];
      for (const p of picks) {
        const k = `${line.item}|${p.position}|${p.lot ?? ""}`;
        used.set(k, (used.get(k) ?? 0) + p.take);
      }
      return { line, need, stock, covered, state, picks, repack };
    });
    const head = sorted[0];
    out.push({
      key,
      head,
      lines: evals,
      completed: sorted.every((l) => l.is_completed),
      strict: sorted.some((l) => l.is_strict),
      needsRepack: evals.some((e) => e.repack !== null),
      collecting: sorted.some((l) => l.is_collecting),
      picker: [...new Set(sorted.map((l) => l.picker).filter(Boolean))].join(", "),
      color: orderColor(evals, sorted.some((l) => l.is_strict), repackCounts),
    });
  }
  return out;
}
