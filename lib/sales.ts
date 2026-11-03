// Παραγγελίες (λίστες πωλήσεων SALEXPORTLS): διαθεσιμότητα ανά γραμμή, χρώμα λίστας
// και πιθανή ανασυσκευασία (κωδικοί 00-* / 71-*) από το απόθεμα των συστατικών.
// Καθαρές συναρτήσεις -- τρέχουν ίδια στον browser και στο CI.
import { buildPicks, maxUnits, type ComponentNeed, type PickLine, type Recipe, type StockIndex } from "./repack.ts";
import type { OrderRow } from "./exports";

export type LineState = "ok" | "repack" | "partial" | "none";
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
};

const EPS = 1e-9;
export const isRepackCode = (code: string) => /^(00|71)-/.test(code);
export const lineNeed = (l: Pick<OrderRow, "qty" | "init_qty">) => Math.max(0, Number(l.init_qty ?? 0) > 0 ? Number(l.init_qty) : Number(l.qty ?? 0));

/**
 * Χρώμα λίστας:
 *  πράσινο  = όλα τα είδη διαθέσιμα (με ανασυσκευασία αν `repackCounts`)
 *  κόκκινο  = αυστηρή συλλογή και τουλάχιστον ένα είδος δεν καλύπτεται,
 *             ή μερική συλλογή και κανένα είδος σε απόθεμα
 *  κίτρινο  = μερική συλλογή και απόθεμα σε κάποιο/κάποια είδη
 */
export function orderColor(lines: Pick<LineEval, "state">[], strict: boolean, repackCounts = true): OrderColor {
  const full = (s: LineState) => s === "ok" || (repackCounts && s === "repack");
  if (lines.length && lines.every((l) => full(l.state))) return "green";
  if (strict) return "red";
  return lines.some((l) => l.state !== "none") ? "yellow" : "red";
}

export function evaluateOrders(
  rows: OrderRow[],
  idx: StockIndex,
  recipesByProduct: Map<string, Recipe[]>,
  opts: { repackCounts?: boolean } = {}
): OrderEval[] {
  const repackCounts = opts.repackCounts ?? true;
  const groups = new Map<string, OrderRow[]>();
  for (const r of rows) {
    const k = r.list_no || r.order_id;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const total = (code: string) => idx.get(code)?.total ?? 0;
  const out: OrderEval[] = [];
  for (const [key, lines] of groups) {
    const sorted = [...lines].sort((a, b) => (a.line_no ?? 0) - (b.line_no ?? 0) || a.id.localeCompare(b.id));
    const used = new Map<string, number>(); // ίδιο είδος σε πολλές γραμμές της λίστας
    const evals: LineEval[] = sorted.map((line) => {
      const need = lineNeed(line);
      const stock = total(line.item);
      const free = Math.max(0, stock - (used.get(line.item) ?? 0));
      const covered = Math.min(need, free);
      used.set(line.item, (used.get(line.item) ?? 0) + covered);
      let state: LineState = need <= EPS || covered + EPS >= need ? "ok" : covered > EPS ? "partial" : "none";
      let repack: RepackSuggestion | null = null;
      const shortage = need - covered;
      if (shortage > EPS && isRepackCode(line.item)) {
        // καλύτερη προδιαγραφή: αυτή που βγάζει τα περισσότερα
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
      // θέσεις συλλογής για όσα καλύπτονται από το απόθεμα
      const picks = covered > EPS
        ? buildPicks([{ code: line.item, description: line.description, unit: "", required: covered, available: covered, shortage: 0, usedBy: [] }], idx)
        : [];
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
      picker: [...new Set(sorted.map((l) => l.picker).filter(Boolean))].join(", "),
      color: orderColor(evals, sorted.some((l) => l.is_strict), repackCounts),
    });
  }
  return out;
}
