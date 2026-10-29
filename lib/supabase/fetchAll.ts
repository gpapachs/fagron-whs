import type { createClient } from "@/lib/supabase/client";

type Client = ReturnType<typeof createClient>;

// Το Supabase επιστρέφει έως 1000 γραμμές ανά αίτημα -- φέρνουμε σε σελίδες
// ώστε ένας μεγάλος πίνακας να μην κόβεται σιωπηλά.
export async function fetchAll<T>(supabase: Client, table: string, columns: string, order: string[]): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(columns);
    for (const col of order) q = q.order(col);
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data) break;
    out.push(...(data as T[]));
    if (data.length < PAGE) break;
  }
  return out;
}
