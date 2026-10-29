import { createClient } from "@/lib/supabase/server";
import RepackBoard, { type UploadInfo } from "@/components/repack/RepackBoard";
import type { Recipe, StockRow } from "@/lib/repack";
import type { Profile } from "@/lib/types";

export const metadata = { title: "Ανασυσκευασία · Fagron Hellas" };
export const dynamic = "force-dynamic";

type Supabase = Awaited<ReturnType<typeof createClient>>;

// Το Supabase επιστρέφει έως 1000 γραμμές ανά αίτημα -- φέρνουμε σε σελίδες
// ώστε ένα μεγάλο απόθεμα να μην κόβεται σιωπηλά.
async function fetchAll<T>(supabase: Supabase, table: string, columns: string, order: string[]): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(columns);
    for (const col of order) q = q.order(col);
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error || !data) break;
    out.push(...(data as T[]));
    if (data.length < PAGE) break;
  }
  return out;
}

type ComponentRow = {
  recipe_id: string;
  code: string;
  description: string;
  qty: number | string;
  unit: string;
};

export default async function RepackPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [recipeRows, componentRows, stockRows, uploadsRes, profileRes] = await Promise.all([
    fetchAll<{ id: string; product_code: string; description: string }>(
      supabase,
      "repack_recipes",
      "id, product_code, description",
      ["sort", "id"]
    ),
    fetchAll<ComponentRow>(supabase, "repack_components", "recipe_id, code, description, qty, unit", [
      "recipe_id",
      "sort",
    ]),
    fetchAll<StockRow & { qty: number | string }>(
      supabase,
      "repack_stock",
      "position, area, item, description, qty, unit",
      ["item", "position"]
    ),
    supabase.from("repack_uploads").select("*"),
    user ? supabase.from("profiles").select("*").eq("id", user.id).single() : Promise.resolve({ data: null }),
  ]);

  const byRecipe = new Map<string, Recipe>();
  const recipes: Recipe[] = recipeRows.map((r) => {
    const rec: Recipe = { ...r, components: [] };
    byRecipe.set(r.id, rec);
    return rec;
  });
  for (const c of componentRows) {
    byRecipe.get(c.recipe_id)?.components.push({
      code: c.code,
      description: c.description,
      qty: Number(c.qty),
      unit: c.unit,
    });
  }

  const uploads: Record<string, UploadInfo> = {};
  for (const u of (uploadsRes.data as (UploadInfo & { kind: string })[] | null) ?? []) uploads[u.kind] = u;

  return (
    <RepackBoard
      initialRecipes={recipes}
      initialStock={stockRows.map((s) => ({ ...s, qty: Number(s.qty) }))}
      initialUploads={uploads}
      userEmail={user?.email ?? null}
      role={(profileRes.data as Profile | null)?.role ?? "staff"}
    />
  );
}
