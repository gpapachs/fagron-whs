"use client";

// Κοινή φόρτωση για «Παραγγελίες» και την προβολή μίας λίστας: προδιαγραφές
// ανασυσκευασίας (00-*/71-*) και απόθεμα ειδών + συστατικών.
import { createClient } from "@/lib/supabase/client";
import { indexStock, type Recipe, type StockIndex, type StockRow } from "@/lib/repack";
import { buildReservations, isRepackCode, type Reservations } from "@/lib/sales";
import type { OrderRow } from "@/lib/exports";

export const SALES_COLS =
  "id, order_id, list_no, doc_type, doc_no, erp_code, order_date, customer, item, description, lot, sn, qty, init_qty, from_pos, to_pos, wms_status, line_no, collected, collected_at, collected_by, picker, is_completed, is_strict, customer_city, customer_zip, customer_vat, is_abroad, comments, is_collecting";

export async function inChunks<T>(values: string[], size: number, fn: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  const parts: string[][] = [];
  for (let i = 0; i < values.length; i += size) parts.push(values.slice(i, i + size));
  for (let i = 0; i < parts.length; i += 6) (await Promise.all(parts.slice(i, i + 6).map(fn))).forEach((r) => out.push(...r));
  return out;
}

export const normOrder = (r: OrderRow): OrderRow => ({ ...r, qty: r.qty == null ? null : Number(r.qty), init_qty: r.init_qty == null ? null : Number(r.init_qty) });

export async function loadSalesContext(list: OrderRow[]): Promise<{ idx: StockIndex; recipes: Map<string, Recipe[]>; stock: StockRow[] }> {
  const sb = createClient();
  // προδιαγραφές ανασυσκευασίας για 00-* / 71-*
  const items = [...new Set(list.map((r) => r.item).filter(Boolean))];
  const finals = items.filter(isRepackCode);
  const recRows = await inChunks(finals, 150, async (part) => {
    const { data: d, error: e2 } = await sb.from("repack_recipes").select("id, product_code, description").in("product_code", part);
    if (e2) throw new Error(e2.message);
    return (d ?? []) as { id: string; product_code: string; description: string }[];
  });
  const compRows = await inChunks(
    recRows.map((r) => r.id),
    150,
    async (part) => {
      const { data: d, error: e2 } = await sb.from("repack_components").select("recipe_id, code, description, qty, unit").in("recipe_id", part).order("sort");
      if (e2) throw new Error(e2.message);
      return (d ?? []) as { recipe_id: string; code: string; description: string; qty: number | string; unit: string }[];
    }
  );
  const byRecipe = new Map<string, Recipe>();
  for (const r of recRows) byRecipe.set(r.id, { id: r.id, product_code: r.product_code, description: r.description, components: [] });
  for (const c of compRows) byRecipe.get(c.recipe_id)?.components.push({ code: c.code, description: c.description, qty: Number(c.qty), unit: c.unit });
  const recMap = new Map<string, Recipe[]>();
  for (const r of byRecipe.values()) if (r.components.length) recMap.set(r.product_code, [...(recMap.get(r.product_code) ?? []), r]);
  // απόθεμα: είδη + συστατικά
  const codes = [...new Set([...items, ...compRows.map((c) => c.code)])];
  const stock = await inChunks(codes, 150, async (part) => {
    const { data: d, error: e2 } = await sb.from("wms_stock_v").select("item, position, area, lot, expiry, qty, description").in("item", part).limit(10000);
    if (e2) throw new Error(e2.message);
    return ((d ?? []) as (Omit<StockRow, "unit" | "qty"> & { qty: number | string })[]).map((s) => ({ ...s, qty: Number(s.qty), unit: "", lot: s.lot ?? "", expiry: s.lot ? s.expiry ?? null : null }));
  });
  return { idx: indexStock(stock as StockRow[]), recipes: recMap, stock: stock as StockRow[] };
}

/** Δεσμεύσεις παρτίδων από ΟΛΕΣ τις ανοιχτές λίστες πωλήσεων (όχι μόνο όσες φαίνονται). */
export async function loadReservations(): Promise<Reservations> {
  const sb = createClient();
  const rows: Pick<OrderRow, "list_no" | "order_id" | "item" | "lot" | "qty" | "is_completed">[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("wms_orders")
      .select("list_no, order_id, item, lot, qty, is_completed")
      .eq("doc_type", "SALEXPORTLS")
      .eq("is_completed", false)
      .neq("lot", "")
      .gt("qty", 0)
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows).map((r) => ({ ...r, qty: Number(r.qty) })));
    if (!data || data.length < 1000) break;
  }
  return buildReservations(rows);
}
