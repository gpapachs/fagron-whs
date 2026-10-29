"use client";

import { useEffect, useState } from "react";
import AuthGate, { PageLoading, type SessionInfo } from "@/components/auth/AuthGate";
import RepackBoard, { type UploadInfo } from "@/components/repack/RepackBoard";
import { createClient } from "@/lib/supabase/client";
import { fetchAll } from "@/lib/supabase/fetchAll";
import type { Recipe, StockRow } from "@/lib/repack";

type ComponentRow = { recipe_id: string; code: string; description: string; qty: number | string; unit: string };

type Data = { recipes: Recipe[]; stock: StockRow[]; uploads: Record<string, UploadInfo> };

async function load(): Promise<Data> {
  const supabase = createClient();
  const [recipeRows, componentRows, stockRows, uploadsRes] = await Promise.all([
    fetchAll<{ id: string; product_code: string; description: string }>(supabase, "repack_recipes", "id, product_code, description", ["sort", "id"]),
    fetchAll<ComponentRow>(supabase, "repack_components", "recipe_id, code, description, qty, unit", ["recipe_id", "sort"]),
    fetchAll<StockRow & { qty: number | string }>(supabase, "repack_stock", "position, area, item, description, qty, unit", ["item", "position"]),
    supabase.from("repack_uploads").select("*"),
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

  return { recipes, stock: stockRows.map((s) => ({ ...s, qty: Number(s.qty) })), uploads };
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
      userEmail={session.email}
      role={session.role}
    />
  );
}

export default function RepackLoader() {
  return <AuthGate>{(session) => <Loaded session={session} />}</AuthGate>;
}
