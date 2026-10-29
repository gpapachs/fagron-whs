// Ανασυσκευασία -- καθαρή λογική (χωρίς React / Supabase), ώστε να
// δοκιμάζεται απευθείας με τα πραγματικά αρχεία Excel.
//
// Δύο αρχεία εισόδου:
//  1. Προδιαγραφές (BOM) -- εξαγωγή ERP χωρίς επικεφαλίδες:
//       γραμμή τελικού:   [κλειδί προδιαγραφής, περιγραφή, κωδικός τελικού, ...]
//       γραμμή συστατικού: [κενό, κωδικός συστατικού, περιγραφή, ποσότητα/τεμ, ΜΜ, ...]
//     Γραμμές συστατικού με "#" στον κωδικό (π.χ. 12-10-719#41-00-204) είναι
//     υπο-συστατικά ενός συστατικού-κιτ: συλλέγεται το κιτ, όχι αυτά, οπότε
//     αγνοούνται.
//  2. Απόθεμα -- εξαγωγή WMS με επικεφαλίδες (Θέση, Περ.Θέσης, Είδος,
//     Περ.Είδους, Ποσ1, ΜΜ1, ...), μία γραμμή ανά θέση/παρτίδα.

export type RecipeComponent = {
  code: string;
  description: string;
  qty: number; // ποσότητα συστατικού ανά 1 τεμάχιο τελικού
  unit: string;
};

export type Recipe = {
  id: string; // κλειδί προδιαγραφής (μοναδικό, π.χ. "71-00-110_2")
  product_code: string; // κωδικός τελικού (μπορεί να επαναλαμβάνεται σε εναλλακτικές)
  description: string;
  components: RecipeComponent[];
};

export type StockRow = {
  position: string;
  area: string; // Περ.Θέσης, π.χ. "ΚΕΝΤΡΙΚΗ ΑΠΟΘΗΚΗ"
  item: string;
  description: string;
  qty: number;
  unit: string;
};

type Cell = unknown;

const str = (v: Cell) => (v === null || v === undefined ? "" : String(v).trim());

function num(v: Cell): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = str(v).replace(/\s/g, "");
  if (!s) return null;
  // ελληνική μορφή "1.234,5" ή απλό "0,3"
  const normalized = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

const EPS = 1e-9;
const round = (n: number) => Math.round(n * 1e6) / 1e6;

// ---------------------------------------------------------------- parsers

export function parseRecipeRows(rows: Cell[][]): { recipes: Recipe[]; warnings: string[] } {
  const recipes: Recipe[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let current: Recipe | null = null;

  for (const row of rows) {
    const head = str(row[0]);
    if (head) {
      // Ίδιο κλειδί δεύτερη φορά = εναλλακτική σύνθεση του ίδιου κωδικού:
      // κρατιέται και αυτή, με διακριτό κλειδί "(2)", "(3)", ...
      let id = head;
      for (let n = 2; seen.has(id); n++) id = `${head} (${n})`;
      if (id !== head) warnings.push(`Η προδιαγραφή ${head} υπάρχει δύο φορές — η δεύτερη κρατήθηκε ως «${id}».`);
      seen.add(id);
      current = {
        id,
        product_code: str(row[2]) || head,
        description: str(row[1]) || str(row[3]),
        components: [],
      };
      recipes.push(current);
      continue;
    }
    const code = str(row[1]);
    if (!code || !current) continue;
    if (code.includes("#")) continue; // υπο-συστατικό κιτ
    const qty = num(row[3]);
    if (qty === null || qty <= 0) {
      warnings.push(`${current.id}: το συστατικό ${code} δεν έχει έγκυρη ποσότητα — παραλείφθηκε.`);
      continue;
    }
    const existing = current.components.find((c) => c.code === code);
    if (existing) existing.qty = round(existing.qty + qty);
    else current.components.push({ code, description: str(row[2]), qty, unit: str(row[4]) });
  }

  const empty = recipes.filter((r) => r.components.length === 0);
  if (empty.length) {
    warnings.push(
      `${empty.length} προδιαγραφ${empty.length === 1 ? "ή δεν έχει" : "ές δεν έχουν"} συστατικά: ${empty
        .slice(0, 8)
        .map((r) => r.id)
        .join(", ")}${empty.length > 8 ? ", …" : ""}`
    );
  }
  return { recipes: recipes.filter((r) => r.components.length > 0), warnings };
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\s.]/g, "");

export function parseStockRows(rows: Cell[][]): { stock: StockRow[]; error?: string } {
  // Βρες τη γραμμή επικεφαλίδων (μέσα στις πρώτες 10)
  let headerIdx = -1;
  let cols: Record<string, number> = {};
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const names = (rows[i] ?? []).map((c) => norm(str(c)));
    const find = (...cands: string[]) => names.findIndex((n) => cands.includes(n));
    const item = find("ειδος", "κωδικος", "κωδικοςειδους");
    const pos = find("θεση");
    if (item >= 0 && pos >= 0) {
      headerIdx = i;
      cols = {
        item,
        pos,
        area: find("περθεσης", "περιγραφηθεσης"),
        desc: find("περειδους", "περιγραφηειδους", "περιγραφη"),
        qty: find("ποσ1", "ποσοτητα"),
        unit: find("μμ1", "μμ"),
      };
      break;
    }
  }
  if (headerIdx < 0) {
    return { stock: [], error: "Δεν βρέθηκαν οι στήλες «Θέση» και «Είδος» στο αρχείο αποθέματος." };
  }
  if (cols.qty < 0) {
    return { stock: [], error: "Δεν βρέθηκε η στήλη ποσότητας «Ποσ1» στο αρχείο αποθέματος." };
  }

  // Ίδιο είδος στην ίδια θέση (π.χ. δύο παρτίδες) -> μία γραμμή
  const merged = new Map<string, StockRow>();
  for (const row of rows.slice(headerIdx + 1)) {
    const item = str(row[cols.item]);
    const position = str(row[cols.pos]);
    const qty = num(row[cols.qty]);
    if (!item || !position || qty === null || qty <= 0) continue;
    const key = `${item}\u0000${position}`;
    const prev = merged.get(key);
    if (prev) prev.qty = round(prev.qty + qty);
    else
      merged.set(key, {
        position,
        area: cols.area >= 0 ? str(row[cols.area]) : "",
        item,
        description: cols.desc >= 0 ? str(row[cols.desc]) : "",
        qty,
        unit: cols.unit >= 0 ? str(row[cols.unit]) : "",
      });
  }
  return { stock: [...merged.values()] };
}

// ------------------------------------------------------------ calculation

export type StockIndex = Map<string, { total: number; description: string; rows: StockRow[] }>;

export function indexStock(stock: StockRow[], excludedAreas: Set<string> = new Set()): StockIndex {
  const idx: StockIndex = new Map();
  for (const r of stock) {
    if (excludedAreas.has(r.area)) continue;
    let e = idx.get(r.item);
    if (!e) {
      e = { total: 0, description: r.description, rows: [] };
      idx.set(r.item, e);
    }
    e.total = round(e.total + r.qty);
    e.rows.push(r);
  }
  return idx;
}

/** Πόσα τεμάχια τελικού βγαίνουν από το δοσμένο απόθεμα ανά κωδικό. */
export function maxUnits(recipe: Recipe, available: (code: string) => number) {
  let max = Infinity;
  let limiting: string | null = null;
  for (const c of recipe.components) {
    const n = Math.floor(available(c.code) / c.qty + EPS);
    if (n < max) {
      max = n;
      limiting = c.code;
    }
  }
  return { max: Number.isFinite(max) ? Math.max(0, max) : 0, limiting };
}

export type RecipeAnalysis = {
  recipe: Recipe;
  max: number; // με όλο το απόθεμα, μόνος του
  limiting: string | null;
  /** άλλες προδιαγραφές (που μπορούν να γίνουν) με κοινό συστατικό */
  sharedWith: { component: string; recipes: string[] }[];
  planned: number;
  /** πόσα ακόμα βγαίνουν αφού αφαιρεθεί το τρέχον πλάνο */
  remaining: number;
};

export type ComponentNeed = {
  code: string;
  description: string;
  unit: string;
  required: number;
  available: number;
  shortage: number;
  usedBy: { recipeId: string; qty: number }[];
};

export type PickLine = {
  position: string;
  area: string;
  item: string;
  description: string;
  take: number;
  inPosition: number;
  unit: string;
};

export type PlanResult = {
  analyses: RecipeAnalysis[];
  needs: ComponentNeed[];
  picks: PickLine[];
  feasible: boolean;
};

export function buildPlan(
  recipes: Recipe[],
  stock: StockRow[],
  planned: Record<string, number>,
  excludedAreas: Set<string> = new Set()
): PlanResult {
  const idx = indexStock(stock, excludedAreas);
  const avail = (code: string) => idx.get(code)?.total ?? 0;

  // συνολικές απαιτήσεις του χειροκίνητου πλάνου
  const needMap = new Map<string, ComponentNeed>();
  for (const r of recipes) {
    const n = Math.max(0, Math.floor(planned[r.id] ?? 0));
    if (!n) continue;
    for (const c of r.components) {
      let need = needMap.get(c.code);
      if (!need) {
        need = {
          code: c.code,
          description: idx.get(c.code)?.description || c.description,
          unit: c.unit,
          required: 0,
          available: avail(c.code),
          shortage: 0,
          usedBy: [],
        };
        needMap.set(c.code, need);
      }
      need.required = round(need.required + n * c.qty);
      need.usedBy.push({ recipeId: r.id, qty: round(n * c.qty) });
    }
  }
  const needs = [...needMap.values()]
    .map((n) => ({ ...n, shortage: round(Math.max(0, n.required - n.available)) }))
    .sort((a, b) => b.shortage - a.shortage || a.code.localeCompare(b.code));

  const leftover = (code: string) => avail(code) - (needMap.get(code)?.required ?? 0);

  // ποιες προδιαγραφές μπορούν να γίνουν -> για εντοπισμό κοινών συστατικών
  const base = recipes.map((r) => ({ r, ...maxUnits(r, avail) }));
  const usersOf = new Map<string, string[]>();
  for (const b of base) {
    if (b.max <= 0) continue;
    for (const c of b.r.components) {
      const list = usersOf.get(c.code) ?? [];
      list.push(b.r.id);
      usersOf.set(c.code, list);
    }
  }

  const analyses: RecipeAnalysis[] = base.map(({ r, max, limiting }) => {
    const sharedWith = r.components
      .map((c) => ({
        component: c.code,
        recipes: (usersOf.get(c.code) ?? []).filter((id) => id !== r.id),
      }))
      .filter((s) => s.recipes.length > 0);
    return {
      recipe: r,
      max,
      limiting,
      sharedWith,
      planned: Math.max(0, Math.floor(planned[r.id] ?? 0)),
      remaining: maxUnits(r, (code) => Math.max(0, leftover(code))).max,
    };
  });

  return {
    analyses,
    needs,
    picks: buildPicks(needs, idx),
    feasible: needs.every((n) => n.shortage <= EPS),
  };
}

/**
 * Από ποιες θέσεις να μαζευτεί κάθε συστατικό:
 * - αν μία θέση καλύπτει όλη την ποσότητα, η μικρότερη τέτοια θέση
 *   (μία στάση, και αδειάζουν πρώτα τα «υπόλοιπα»)
 * - αλλιώς από τη μεγαλύτερη προς τη μικρότερη (όσο λιγότερες στάσεις γίνεται)
 */
export function buildPicks(needs: ComponentNeed[], idx: StockIndex): PickLine[] {
  const picks: PickLine[] = [];
  for (const need of needs) {
    let left = Math.min(need.required, need.available);
    if (left <= EPS) continue;
    const rows = [...(idx.get(need.code)?.rows ?? [])];
    const single = rows
      .filter((r) => r.qty + EPS >= left)
      .sort((a, b) => a.qty - b.qty || a.position.localeCompare(b.position))[0];
    const order = single ? [single] : rows.sort((a, b) => b.qty - a.qty || a.position.localeCompare(b.position));
    for (const r of order) {
      if (left <= EPS) break;
      const take = round(Math.min(r.qty, left));
      picks.push({
        position: r.position,
        area: r.area,
        item: r.item,
        description: r.description || need.description,
        take,
        inPosition: r.qty,
        unit: r.unit || need.unit,
      });
      left = round(left - take);
    }
  }
  // με σειρά θέσης, για να περπατηθεί η αποθήκη με τη σειρά
  return picks.sort(
    (a, b) =>
      a.position.localeCompare(b.position, "el", { numeric: true }) || a.item.localeCompare(b.item)
  );
}

export function areasOf(stock: StockRow[]): { area: string; rows: number }[] {
  const m = new Map<string, number>();
  for (const r of stock) m.set(r.area, (m.get(r.area) ?? 0) + 1);
  return [...m.entries()].map(([area, rows]) => ({ area, rows })).sort((a, b) => b.rows - a.rows);
}

export const fmtQty = (n: number) =>
  n.toLocaleString("el-GR", { maximumFractionDigits: 3 });

/**
 * Από ένα ολόκληρο αρχείο αποθέματος κράτα μόνο ό,τι αφορά την ανασυσκευασία:
 * τα συστατικά των προδιαγραφών και τους ίδιους τους τελικούς κωδικούς
 * (για να φαίνεται το υπάρχον απόθεμα τελικού).
 */
export function filterStockForRecipes(stock: StockRow[], recipes: Recipe[]) {
  const components = new Set(recipes.flatMap((r) => r.components.map((c) => c.code)));
  const finals = new Set(recipes.map((r) => r.product_code));
  const kept = stock.filter((s) => components.has(s.item) || finals.has(s.item));
  const items = new Set(kept.map((s) => s.item));
  return {
    kept,
    totalRows: stock.length,
    totalItems: new Set(stock.map((s) => s.item)).size,
    componentItems: [...items].filter((i) => components.has(i)).length,
    finalItems: [...items].filter((i) => finals.has(i) && !components.has(i)).length,
    missingComponents: [...components].filter((c) => !items.has(c)).length,
    componentCount: components.size,
  };
}
