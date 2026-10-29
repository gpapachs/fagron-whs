"use client";

import { useEffect, useState } from "react";
import AuthGate, { PageLoading, type SessionInfo } from "@/components/auth/AuthGate";
import RepackBoard, { type UploadInfo } from "@/components/repack/RepackBoard";
import { createClient } from "@/lib/supabase/client";
import { fetchAll } from "@/lib/supabase/fetchAll";
import type { ProductSettings, Recipe, StockRow } from "@/lib/repack";
import type { Job } from "@/lib/jobs";

type ComponentRow = { recipe_id: string; code: string; description: string; qty: number | string; unit: string };

type Data = { recipes: Recipe[]; stock: StockRow[]; uploads: Record<string, UploadInfo>; jobs: Job[]; settings: ProductSettings[] };

async function load(): Promise<Data> {
  const supabase = createClient();
  const [recipeRows, componentRows, stockRows, uploadsRes, jobs, settings] = await Promise.all([
    fetchAll<{ id: string; product_code: string; description: string }>(supabase, "repack_recipes", "id, product_code, description", ["sort", "id"]),
    fetchAll<ComponentRow>(supabase, "repack_components", "recipe_id, code, description, qty, unit", ["recipe_id", "sort"]),
    // παρτίδες (0006) -- αν δεν έχει τρέξει ακόμα, φέρνει το απόθεμα χωρίς παρτίδες
    fetchAll<StockRow & { qty: number | string }>(supabase, "repack_stock", "position, area, item, description, qty, unit, lot, expiry", ["item", "position", "lot"]).catch(() =>
      fetchAll<StockRow & { qty: number | string }>(supabase, "repack_stock", "position, area, item, description, qty, unit", ["item", "position"])
    ),
    supabase.from("repack_uploads").select("*"),
    // εργασίες: αν ο πίνακας δεν έχει στηθεί ακόμα (0004), η σελίδα δουλεύει χωρίς χρόνους
    fetchAll<Job>(supabase, "repack_jobs", "*", ["started_at"]).catch(() => [] as Job[]),
    // ρυθμίσεις ανά τελικό (0005) -- χωρίς αυτές η σελίδα δουλεύει κανονικά
    fetchAll<ProductSettings>(supabase, "repack_product_settings", "*", ["product_code"]).catch(() => [] as ProductSettings[]),
  ]);

  const byRecipe = new Map<string, Recipe>();
  const recipes: Recipe[] = recipeRows.map((r) => {
    const rec: Recipe = { ...r, components: [] };
    byRecipe.set(r.id, rec);
    return rec;
  });
  for (const c of componentRows) {
    byRecipe.get(c.recipe_id)?.components.push({ code: c.code, description: c.description, qty: Number(c.qty), unit: c.unit });
  }

  const uploads: Record<string, UploadInfo> = {};
  for (const u of (uploadsRes.data as (UploadInfo & { kind: string })[] | null) ?? []) uploads[u.kind] = u;

  return { recipes, stock: stockRows.map((s) => ({ ...s, qty: Number(s.qty) })), uploads, jobs: jobs.reverse(), settings };
}

function Loaded({ session }: { session: SessionInfo }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    load()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <PageLoading text={`Σφάλμα φόρτωσης: ${error}`} />;
  if (!data) return <PageLoading text="Φόρτωση προδιαγραφών και αποθέματος…" />;
  return (
    <RepackBoard
      initialRecipes={data.recipes}
      initialStock={data.stock}
      initialUploads={data.uploads}
      initialJobs={data.jobs}
      initialSettings={data.settings}
      userId={session.userId}
      userEmail={session.email}
      role={session.role}
    />
  );
}

export default function RepackLoader() {
  return <AuthGate>{(session) => <Loaded session={session} />}</AuthGate>;
}
