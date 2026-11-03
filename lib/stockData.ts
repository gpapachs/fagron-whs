"use client";

import { createClient } from "@/lib/supabase/client";
import { fetchAll } from "@/lib/supabase/fetchAll";
import type { StockRow } from "@/lib/exports";

const COLS = "item, position, area, lot, serial, expiry, qty, description";
type Raw = Omit<StockRow, "qty"> & { qty: number | string };
// χωρίς παρτίδα = χωρίς λήξη (δεν μετρά ως ληγμένο)
const norm = (s: Raw): StockRow => ({ ...s, qty: Number(s.qty), expiry: s.lot ? s.expiry : null });

export async function loadStock(): Promise<{ rows: StockRow[]; syncedAt: string | null }> {
  const supabase = createClient();
  const [stock, uploads] = await Promise.all([
    fetchAll<Raw>(supabase, "wms_stock_v", COLS, ["position", "item", "lot", "serial"]),
    supabase.from("repack_uploads").select("kind, uploaded_at").eq("kind", "stock").maybeSingle(),
  ]);
  return { rows: stock.map(norm), syncedAt: (uploads.data as { uploaded_at?: string } | null)?.uploaded_at ?? null };
}

/** απόθεμα μόνο συγκεκριμένων κωδικών (live ενημέρωση) */
export async function loadStockItems(items: string[]): Promise<StockRow[]> {
  const supabase = createClient();
  const out: StockRow[] = [];
  for (let i = 0; i < items.length; i += 100) {
    const { data, error } = await supabase.from("wms_stock_v").select(COLS).in("item", items.slice(i, i + 100)).limit(5000);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as Raw[]).map(norm));
  }
  return out;
}
