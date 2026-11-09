"use client";

// Ανάθεση παραγγελιών προς συλλογή σε αποθήκη (πίνακας pick_assignments, κλειδί = παραστατικό).
import { createClient } from "@/lib/supabase/client";
import type { Site } from "@/lib/site";

export type Assignment = { doc_no: string; site: Site; assigned_by: string | null; assigned_at: string };
export type Assignments = Map<string, Assignment>;

export async function loadAssignments(docs: (string | null | undefined)[]): Promise<Assignments> {
  const list = [...new Set(docs.filter((d): d is string => !!d))];
  const m: Assignments = new Map();
  const sb = createClient();
  for (let i = 0; i < list.length; i += 300) {
    const { data } = await sb.from("pick_assignments").select("doc_no, site, assigned_by, assigned_at").in("doc_no", list.slice(i, i + 300));
    for (const a of (data as Assignment[]) ?? []) m.set(a.doc_no, a);
  }
  return m;
}

/** site = null: αφαίρεση ανάθεσης */
export async function assignSite(docs: string[], site: Site | null) {
  const { error } = await createClient().rpc("pick_assign", { p_docs: docs, p_site: site ?? "" });
  return error ? error.message : null;
}
