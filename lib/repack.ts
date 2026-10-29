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
  lot?: string; // παρτίδα ("" αν δεν υπάρχει)
  expiry?: string | null; // ημ. λήξης παρτίδας, ISO "2030-12-30"
};

type Cell = unknown;

const str = (v: Cell) => (v === null || v === undefined ? "" : String(v).trim());

function num(v: Cell): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = str(v).replace(/\s/g, "");
  if (!s) return null;
  // ελληνική μορφή "1.234,5", "0,3" ή "2.400" (τελεία = χιλιάδες)
  const normalized = s.includes(",")
    ? s.replace(/\./g, "").replace(",", ".")
    : /^-?\d{1,3}(\.\d{3})+$/.test(s)
      ? s.replace(/\./g, "")
      : s;
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
        lot: find("παρτιδα", "lot"),
        // η ΠΡΩΤΗ «Ημ.Λήξης» είναι της παρτίδας (υπάρχει και δεύτερη, της φάσης)
        expiry: find("ημληξης", "ημερομηνιαληξης", "ληξη"),
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

  // Ίδιο είδος + θέση + παρτίδα -> μία γραμμή (διαφορετικές παρτίδες μένουν χωριστά)
  const merged = new Map<string, StockRow>();
  for (const row of rows.slice(headerIdx + 1)) {
    const item = str(row[cols.item]);
    const position = str(row[cols.pos]);
    const qty = num(row[cols.qty]);
    if (!item || !position || qty === null || qty <= 0) continue;
    const lot = cols.lot >= 0 ? str(row[cols.lot]) : "";
    const key = `${item}\u0000${position}\u0000${lot}`;
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
        lot,
        expiry: cols.expiry >= 0 ? parseDate(row[cols.expiry]) : null,
      });
  }
  return { stock: [...merged.values()] };
}

/** «30/12/2030», Excel serial ή Date -> "2030-12-30" (αλλιώς null) */
export function parseDate(v: Cell): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const d = new Date(Math.round((v - 25569) * 86400000)); // Excel -> Unix
    return d.toISOString().slice(0, 10);
  }
  const m = str(v).match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    return y > 1900 && y < 2200 && !isNaN(Date.parse(d)) && y !== 2000 ? d : null; // 1/1/2000 = κενό στο WMS
  }
  const iso = str(v).match(/^\d{4}-\d{2}-\d{2}/);
  return iso ? iso[0] : null;
}

/** "2030-12-30" -> "30/12/30" */
export const fmtExpiry = (iso?: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}` : "");

/** Κείμενο παρτίδας για εμφάνιση: «823600 · λ. 22/05/36» */
export const lotLabel = (r: { lot?: string; expiry?: string | null }) =>
  [r.lot ? r.lot : "", r.expiry ? `λ. ${fmtExpiry(r.expiry)}` : ""].filter(Boolean).join(" · ");

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
  lot: string;
  expiry: string | null;
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
        lot: r.lot ?? "",
        expiry: r.expiry ?? null,
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

export type RecipePick = {
  recipe: Recipe;
  planned: number;
  components: {
    code: string;
    description: string;
    unit: string;
    need: number;
    short: number;
    from: { position: string; area: string; lot: string; expiry: string | null; take: number }[];
  }[];
};

/**
 * Μοιράζει τη λίστα συλλογής (που είναι ανά συστατικό/θέση) στους τελικούς
 * κωδικούς του πλάνου, με τη σειρά του πλάνου: για κάθε τελικό -> κάθε
 * συστατικό -> από ποιες θέσεις παίρνεις πόσο. Ό,τι δεν καλύπτεται = short.
 */
export function picksByRecipe(planned: RecipeAnalysis[], picks: PickLine[]): RecipePick[] {
  // ουρά διαθέσιμων λήψεων ανά συστατικό (ίδια σειρά με τη λίστα συλλογής)
  const queue = new Map<string, { position: string; area: string; lot: string; expiry: string | null; left: number }[]>();
  for (const p of picks) {
    const q = queue.get(p.item) ?? [];
    q.push({ position: p.position, area: p.area, lot: p.lot, expiry: p.expiry, left: p.take });
    queue.set(p.item, q);
  }
  return planned
    .filter((a) => a.planned > 0)
    .map((a) => ({
      recipe: a.recipe,
      planned: a.planned,
      components: a.recipe.components.map((c) => {
        const need = round(a.planned * c.qty);
        let left = need;
        const from: { position: string; area: string; lot: string; expiry: string | null; take: number }[] = [];
        for (const slot of queue.get(c.code) ?? []) {
          if (left <= EPS) break;
          if (slot.left <= EPS) continue;
          const take = round(Math.min(slot.left, left));
          slot.left = round(slot.left - take);
          left = round(left - take);
          from.push({ position: slot.position, area: slot.area, lot: slot.lot, expiry: slot.expiry, take });
        }
        const pick = picks.find((p) => p.item === c.code);
        return {
          code: c.code,
          description: pick?.description || c.description,
          unit: c.unit || pick?.unit || "",
          need,
          short: left > EPS ? left : 0,
          from,
        };
      }),
    }));
}

// ---------------------------------------------------- ρυθμίσεις ανά τελικό

export type ProductSettings = {
  product_code: string;
  units_per_package: number | null; // τεμάχια ανά συσκευασία
  reserved: number; // τεμάχια για παραγγελίες σε εκκρεμότητα
  reserved_note: string;
  updated_at?: string;
  updated_by_email?: string | null;
};

/** Πόσα λείπουν για τις παραγγελίες: δεσμευμένα − απόθεμα τελικού (≥ 0). */
export function reservedShortfall(reserved: number, finalStock: number) {
  return Math.max(0, Math.round(reserved - finalStock));
}

/**
 * Πλάνο που καλύπτει τα δεσμευμένα: για κάθε τελικό κωδικό με έλλειψη,
 * όσα λείπουν -- αλλά όχι παραπάνω από όσα επιτρέπει το απόθεμα συστατικών
 * που μένει (με τη σειρά: μεγαλύτερη έλλειψη πρώτα). Αν ένας τελικός έχει
 * εναλλακτικές προδιαγραφές, προτιμάται η κύρια (id = κωδικός τελικού).
 * Επιστρέφει νέο πλάνο (κρατά ό,τι υπάρχει για τους υπόλοιπους κωδικούς)
 * και τι δεν καλύφθηκε.
 */
export function planForReserved(
  recipes: Recipe[],
  stock: StockRow[],
  current: Record<string, number>,
  shortfallByProduct: Map<string, number>,
  excludedAreas: Set<string> = new Set()
) {
  const next: Record<string, number> = { ...current };
  const uncovered: { productCode: string; missing: number }[] = [];
  const order = [...shortfallByProduct.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  for (const [productCode, need] of order) {
    const options = recipes
      .filter((r) => r.product_code === productCode)
      .sort((a, b) => Number(b.id === productCode) - Number(a.id === productCode));
    // καθάρισε ό,τι υπήρχε για αυτόν τον τελικό, ώστε να μη μετρηθεί δύο φορές
    for (const r of options) delete next[r.id];
    let left = need;
    for (const r of options) {
      if (left <= 0) break;
      const plan = buildPlan(recipes, stock, next, excludedAreas);
      const room = plan.analyses.find((a) => a.recipe.id === r.id)?.remaining ?? 0;
      const take = Math.min(room, left);
      if (take > 0) {
        next[r.id] = take;
        left -= take;
      }
    }
    if (left > 0) uncovered.push({ productCode, missing: left });
  }
  return { plan: next, uncovered };
}

// ---------------------------------------------------- δεσμευμένα από Excel

export type ReservedItem = { code: string; qty: number; orders: number };

/**
 * Excel εκκρεμών παραγγελιών -> δεσμευμένα ανά κωδικό.
 * Βρίσκει μόνο του τις στήλες (κωδικός / ποσότητα / παραγγελία) από τις
 * επικεφαλίδες· χωρίς επικεφαλίδες: στήλη Α = κωδικός, Β = ποσότητα.
 * Ίδιος κωδικός σε πολλές γραμμές (πολλές παραγγελίες) αθροίζεται.
 */
export function parseReservedRows(rows: Cell[][]): {
  items: ReservedItem[];
  columns?: { code: string; qty: string; order?: string };
  skipped: number;
  error?: string;
} {
  let headerIdx = -1;
  let cCode = -1;
  let cQty = -1;
  let cOrder = -1;
  let names: string[] = [];
  const pick = (cands: ((n: string) => boolean)[]) => {
    for (const test of cands) {
      const i = names.findIndex((n) => n && test(n));
      if (i >= 0) return i;
    }
    return -1;
  };
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    names = (rows[i] ?? []).map((c) => norm(str(c)));
    const code = pick([
      (n) => ["κωδικος", "κωδικοςειδους", "κωδειδους", "κωδικοςτελικου", "ειδος", "item", "code", "sku"].includes(n),
      (n) => n.startsWith("κωδ") && !n.includes("συναλ") && !n.includes("πελατ"),
    ]);
    const qty = pick([
      (n) => n.includes("δεσμ"),
      (n) => n.includes("εκκρεμ"),
      (n) => n.includes("υπολοιπ"),
      (n) => n.includes("ποσοτ") || n === "ποσ" || n.startsWith("ποσ1") || n === "qty" || n === "quantity",
      (n) => n.startsWith("τεμ"),
    ]);
    if (code >= 0 && qty >= 0 && code !== qty) {
      headerIdx = i;
      cCode = code;
      cQty = qty;
      cOrder = pick([(n) => n.includes("παραγγ") || n.includes("order"), (n) => n.includes("παραστατ") || n.startsWith("αριθμ")]);
      break;
    }
  }
  const header = headerIdx >= 0 ? rows[headerIdx] : null;
  if (headerIdx < 0) {
    // χωρίς επικεφαλίδες: Α = κωδικός, Β = ποσότητα, αν μοιάζει έτσι
    const sample = rows.slice(0, 20).filter((r) => str(r?.[0]));
    const looks = sample.length > 0 && sample.filter((r) => /^\d{2}-\d{2}-\d{3}/.test(str(r[0])) && num(r[1]) !== null).length >= Math.ceil(sample.length / 2);
    if (!looks) {
      return {
        items: [],
        skipped: 0,
        error: "Δεν βρέθηκαν στήλες κωδικού και ποσότητας. Βάλτε επικεφαλίδες π.χ. «Κωδικός» και «Δεσμευμένα» (ή κατεβάστε το Πρότυπο).",
      };
    }
    cCode = 0;
    cQty = 1;
  }

  const map = new Map<string, { qty: number; orders: Set<string>; lines: number }>();
  let skipped = 0;
  for (const row of rows.slice(headerIdx + 1)) {
    const code = str(row[cCode]).toUpperCase();
    const qty = num(row[cQty]);
    if (!code) continue;
    if (qty === null || qty <= 0) {
      skipped++;
      continue;
    }
    const e = map.get(code) ?? { qty: 0, orders: new Set<string>(), lines: 0 };
    e.qty = round(e.qty + qty);
    e.lines++;
    if (cOrder >= 0 && str(row[cOrder])) e.orders.add(str(row[cOrder]));
    map.set(code, e);
  }
  const items = [...map.entries()]
    .map(([code, e]) => ({ code, qty: Math.round(e.qty), orders: cOrder >= 0 ? e.orders.size : e.lines }))
    .filter((x) => x.qty > 0)
    .sort((a, b) => a.code.localeCompare(b.code, "el", { numeric: true }));
  return {
    items,
    skipped,
    columns: header
      ? { code: str(header[cCode]), qty: str(header[cQty]), order: cOrder >= 0 ? str(header[cOrder]) : undefined }
      : { code: "στήλη Α", qty: "στήλη Β" },
  };
}
