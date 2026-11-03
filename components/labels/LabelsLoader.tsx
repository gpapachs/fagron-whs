"use client";

import { useEffect, useState } from "react";
import AuthGate, { PageLoading, type SessionInfo } from "@/components/auth/AuthGate";
import LabelsBoard, { type LabelProduct, type LotRow } from "@/components/labels/LabelsBoard";
import { createClient } from "@/lib/supabase/client";
import { fetchAll } from "@/lib/supabase/fetchAll";
import type { ProductSettings } from "@/lib/repack";

type Data = { products: LabelProduct[]; settings: ProductSettings[]; lots: LotRow[] };
type Comp = { recipe_id: string; code: string; description: string };

async function load(): Promise<Data> {
  const supabase = createClient();
  const [recipes, comps, settings, stock] = await Promise.all([
    fetchAll<{ id: string; product_code: string; description: string }>(supabase, "repack_recipes", "id, product_code, description", ["sort", "id"]),
    fetchAll<Comp>(supabase, "repack_components", "recipe_id, code, description", ["recipe_id", "sort"]),
    fetchAll<ProductSettings>(supabase, "repack_product_settings", "*", ["product_code"]).catch(() => [] as ProductSettings[]),
    fetchAll<LotRow & { qty: number | string }>(supabase, "repack_stock", "item, lot, expiry, position, qty", ["item", "lot"]).catch(() => [] as LotRow[]),
  ]);
  // ένας τελικός κωδικός μία φορά (η κύρια προδιαγραφή δίνει περιγραφή + συστατικά)
  const compsByRecipe = new Map<string, { code: string; description: string }[]>();
  for (const c of comps) {
    const list = compsByRecipe.get(c.recipe_id) ?? [];
    list.push({ code: c.code, description: c.description });
    compsByRecipe.set(c.recipe_id, list);
  }
  const products = new Map<string, LabelProduct>();
  for (const r of recipes) {
    if (!products.has(r.product_code) || r.id === r.product_code)
      products.set(r.product_code, { code: r.product_code, description: r.description, components: compsByRecipe.get(r.id) ?? [] });
  }
  return {
    products: [...products.values()].sort((a, b) => a.code.localeCompare(b.code, "el", { numeric: true })),
    settings,
    lots: stock.map((s) => ({ ...s, qty: Number(s.qty) })),
  };
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
  if (!data) return <PageLoading text="Φόρτωση κωδικών…" />;
  return <LabelsBoard products={data.products} initialSettings={data.settings} lots={data.lots} userEmail={session.email} role={session.role} />;
}

export default function LabelsLoader() {
  return <AuthGate>{(session) => <Loaded session={session} />}</AuthGate>;
}
