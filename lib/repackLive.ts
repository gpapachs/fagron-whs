"use client";

// Ανασυσκευασία με δεδομένα WMS live: απόθεμα συστατικών/τελικών από wms_stock_v και
// δεσμευμένα τελικών από τις ανοιχτές λίστες «προς εκτέλεση» (SALEXPORTLS).
import { createClient } from "@/lib/supabase/client";
import { inChunks } from "@/lib/salesData";
import type { Recipe, StockRow } from "@/lib/repack";

export const recipeCodes = (recipes: Recipe[]) => [...new Set(recipes.flatMap((r) => [r.product_code, ...r.components.map((c) => c.code)]).filter(Boolean))];

export async function loadLiveStock(codes: string[]): Promise<StockRow[]> {
  const sb = createClient();
  return inChunks(codes, 150, async (part) => {
    const { data, error } = await sb.from("wms_stock_v").select("item, position, area, lot, expiry, qty, description").in("item", part).gt("qty", 0).limit(10000);
    if (error) throw new Error(error.message);
    return ((data ?? []) as { item: string; position: string; area: string | null; lot: string | null; expiry: string | null; qty: number | string; description: string | null }[]).map((s) => ({
      item: s.item,
      position: s.position ?? "",
      area: s.area ?? "",
      description: s.description ?? "",
      qty: Number(s.qty) || 0,
      unit: "",
      lot: s.lot ?? "",
      expiry: s.lot ? s.expiry ?? null : null,
    }));
  });
}

/** μετράνε μόνο λίστες από αυτή την ημερομηνία και μετά (παλιές ανοιχτές λίστες του WMS αγνοούνται) */
export const RESERVED_FROM = "2026-01-01";

export type LiveReserved = { qty: number; lists: string[]; customers: string[] };

/** ανοιχτές γραμμές πωλήσεων (μη ολοκληρωμένες λίστες) ανά τελικό κωδικό */
export async function loadLiveReserved(finals: string[]): Promise<Map<string, LiveReserved>> {
  const sb = createClient();
  const rows = await inChunks(finals, 150, async (part) => {
    const out: { item: string; qty: number | string; list_no: string | null; customer: string | null }[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb
        .from("wms_orders")
        .select("item, qty, list_no, customer")
        .eq("doc_type", "SALEXPORTLS")
        .eq("is_completed", false)
        .gt("qty", 0)
        .gte("order_date", RESERVED_FROM)
        .in("item", part)
        .order("id")
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      out.push(...((data ?? []) as typeof out));
      if (!data || data.length < 1000) break;
    }
    return out;
  });
  const m = new Map<string, LiveReserved>();
  for (const r of rows) {
    const e = m.get(r.item) ?? { qty: 0, lists: [], customers: [] };
    e.qty = Math.round((e.qty + (Number(r.qty) || 0)) * 1000) / 1000;
    if (r.list_no && !e.lists.includes(r.list_no)) e.lists.push(r.list_no);
    if (r.customer && !e.customers.includes(r.customer)) e.customers.push(r.customer);
    m.set(r.item, e);
  }
  return m;
}
