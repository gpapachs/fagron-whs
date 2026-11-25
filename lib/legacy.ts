"use client";

// Αντιστοίχιση νέων κωδικών με τους παλιούς που αντικατέστησαν (πίνακας item_legacy).
import { createClient } from "@/lib/supabase/client";

export type LegacyMap = { oldOf: Map<string, string[]>; newOf: Map<string, string> };

/** όλες οι αντιστοιχίσεις για κωδικούς που ξεκινούν από prefix (π.χ. «41-00-006» ή «41») */
export async function loadLegacy(prefix = ""): Promise<LegacyMap> {
  const sb = createClient();
  const oldOf = new Map<string, string[]>();
  const newOf = new Map<string, string>();
  const p = prefix.trim().toUpperCase().replace(/[\\%_]/g, (c) => `\\${c}`);
  for (let from = 0; ; from += 1000) {
    let q = sb.from("item_legacy").select("code, old_code").order("code").range(from, from + 999);
    if (p) q = q.ilike("code", `${p}%`);
    const { data, error } = await q;
    if (error) break;
    for (const r of (data ?? []) as { code: string; old_code: string }[]) {
      oldOf.set(r.code, [...(oldOf.get(r.code) ?? []), r.old_code]);
      newOf.set(r.old_code, r.code);
    }
    if (!data || data.length < 1000) break;
  }
  return { oldOf, newOf };
}

export async function setLegacy(code: string, olds: string[]) {
  const { error } = await createClient().rpc("item_legacy_set", { p_code: code, p_old: olds });
  if (error) throw new Error(error.message);
}

/** «40-00-163, 40-00-164» -> ["40-00-163","40-00-164"] */
export const parseCodes = (s: string) => [...new Set(s.split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))];
