"use client";

// Φόρτωση από τη βάση: γραμμές ζήτησης (Excel), προδιαγραφές (ίδιες με το Repack), αντιστοιχίσεις 40->41.
import { createClient } from "@/lib/supabase/client";
import { fetchAll } from "@/lib/supabase/fetchAll";
import { loadLegacy } from "@/lib/legacy";
import { inChunks } from "@/lib/salesData";
import { RESERVED_FROM } from "@/lib/repackLive";
import { computeDemand, planInfoOf, type DemandLine, type Spec, type StockLite } from "@/lib/containerDemand";
import type { PlanInfo } from "@/lib/relocation";

export type DemandUpload = { kind: "plan" | "orders" | "specs"; file_name: string | null; rows: number | null; uploaded_at: string; uploaded_by: string | null };

/** προδιαγραφές: πρώτα οι προδιαγραφές παραγωγής (Ζήτηση περιεκτών), μετά του Repack */
export async function loadSpecs(): Promise<Spec[]> {
  const sb = createClient();
  const [prod, recs, comps] = await Promise.all([
    fetchAll<{ spec_id: string; product_code: string; product_desc: string | null; code: string; description: string | null; qty: number | string; unit: string | null }>(
      sb,
      "prod_spec_lines",
      "spec_id, product_code, product_desc, code, description, qty, unit",
      ["id"]
    ).catch(() => []),
    fetchAll<{ id: string; product_code: string; description: string }>(sb, "repack_recipes", "id, product_code, description", ["sort", "id"]),
    fetchAll<{ recipe_id: string; code: string; description: string; qty: number | string; unit: string }>(sb, "repack_components", "recipe_id, code, description, qty, unit", ["recipe_id", "sort"]),
  ]);
  const by = new Map<string, Spec>();
  const specs = recs.map((r) => {
    const s: Spec = { ...r, components: [] };
    by.set(r.id, s);
    return s;
  });
  for (const c of comps) by.get(c.recipe_id)?.components.push({ code: c.code, description: c.description, qty: Number(c.qty) || 0, unit: c.unit });
  const pm = new Map<string, Spec>();
  for (const l of prod) {
    const sp = pm.get(l.spec_id) ?? { id: l.spec_id, product_code: l.product_code, description: l.product_desc ?? "", components: [] };
    sp.components.push({ code: l.code, description: l.description ?? "", qty: Number(l.qty) || 0, unit: l.unit ?? "" });
    pm.set(l.spec_id, sp);
  }
  return [...pm.values(), ...specs];
}

export async function loadDemandLines(): Promise<{ lines: DemandLine[]; uploads: DemandUpload[] }> {
  const sb = createClient();
  const [rows, up] = await Promise.all([
    fetchAll<{ kind: "plan" | "orders"; product: string; description: string | null; qty: number | string; due: string | null; ref: string | null; stock: number | string | null }>(sb, "demand_lines", "kind, product, description, qty, due, ref, stock", ["id"]).catch(() => []),
    sb.from("demand_uploads").select("*"),
  ]);
  return {
    lines: rows.map((r) => ({ ...r, qty: Number(r.qty) || 0, stock: r.stock == null ? null : Number(r.stock) })),
    uploads: ((up.data as DemandUpload[] | null) ?? []),
  };
}

/** ανοιχτές λίστες πωλήσεων του WMS (SALEXPORTLS) για τα τελικά των προδιαγραφών */
export async function loadWmsOrderLines(products: string[]): Promise<DemandLine[]> {
  const sb = createClient();
  return inChunks(products, 150, async (part) => {
    const out: DemandLine[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb
        .from("wms_orders")
        .select("item, qty, list_no, customer, order_date")
        .eq("doc_type", "SALEXPORTLS")
        .eq("is_completed", false)
        .gt("qty", 0)
        .gte("order_date", RESERVED_FROM)
        .in("item", part)
        .order("id")
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as { item: string; qty: number | string; list_no: string | null; customer: string | null; order_date: string | null }[])
        out.push({ kind: "wms", product: r.item, description: null, qty: Number(r.qty) || 0, due: r.order_date?.slice(0, 10) ?? null, ref: [r.list_no, r.customer].filter(Boolean).join(" · ") || null });
      if (!data || data.length < 1000) break;
    }
    return out;
  });
}

export async function loadStockFor(codes: string[]): Promise<StockLite[]> {
  const sb = createClient();
  return inChunks(codes, 150, async (part) => {
    const { data, error } = await sb.from("wms_stock_v").select("item, position, qty, description").in("item", part).gt("qty", 0).limit(10000);
    if (error) throw new Error(error.message);
    return ((data ?? []) as { item: string; position: string | null; qty: number | string; description: string | null }[]).map((r) => ({ item: r.item, position: r.position ?? "", qty: Number(r.qty) || 0, description: r.description ?? "" }));
  });
}

/** για τη Μεταφορά αποθέματος: πόσα χρειάζονται ανά κωδικό συσκευασίας (πλάνο + παραγγελίες Excel) */
export async function loadContainerNeeds(): Promise<{ byCode: Record<string, number>; info: Record<string, PlanInfo>; lines: number }> {
  const [{ lines }, specs, legacy] = await Promise.all([loadDemandLines(), loadSpecs(), loadLegacy("")]);
  if (!lines.length) return { byCode: {}, info: {}, lines: 0 };
  const r = computeDemand(lines, specs, legacy.newOf, []);
  return { byCode: Object.fromEntries(r.needs.map((n) => [n.code, n.total])), info: planInfoOf(r.needs), lines: r.lines };
}
