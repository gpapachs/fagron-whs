"use client";

// Ανασυσκευασίες που ζητήθηκαν από παραγγελίες -> κοινό πλάνο ανασυσκευασίας.
import { createClient } from "@/lib/supabase/client";

export type PlanOrder = {
  id: string;
  recipe_id: string;
  product_code: string;
  qty: number;
  list_no: string;
  order_line_id: string;
  customer: string;
  created_by: string;
  created_at: string;
  done: boolean;
};

export async function loadPlanOrders(): Promise<PlanOrder[]> {
  const { data, error } = await createClient().from("repack_plan_orders").select("*").eq("done", false).order("created_at").limit(2000);
  if (error) throw new Error(error.message);
  return (data ?? []) as PlanOrder[];
}

export async function addPlanOrder(p: Omit<PlanOrder, "id" | "created_at" | "done">): Promise<PlanOrder> {
  const { data, error } = await createClient().from("repack_plan_orders").insert(p).select("*").single();
  if (error) throw new Error(error.message);
  return data as PlanOrder;
}

export async function closePlanOrder(id: string) {
  const { error } = await createClient().from("repack_plan_orders").update({ done: true, done_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

/** σύνολο ανά προδιαγραφή */
export function planOrderTotals(list: PlanOrder[]) {
  const m: Record<string, number> = {};
  for (const p of list) if (!p.done) m[p.recipe_id] = (m[p.recipe_id] ?? 0) + p.qty;
  return m;
}
