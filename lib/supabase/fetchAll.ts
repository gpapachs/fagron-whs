import type { createClient } from "@/lib/supabase/client";

type Client = ReturnType<typeof createClient>;

// Το Supabase επιστρέφει έως 1000 γραμμές ανά αίτημα -- φέρνουμε σε σελίδες
// ώστε ένας μεγάλος πίνακας να μην κόβεται σιωπηλά. Η 1η σελίδα δίνει και το
// σύνολο (count), οι υπόλοιπες έρχονται ΠΑΡΑΛΛΗΛΑ (έως 6 μαζί) -- πολύ πιο γρήγορα
// από τη μία-μία σε πίνακες χιλιάδων γραμμών.
export async function fetchAll<T>(supabase: Client, table: string, columns: string, order: string[]): Promise<T[]> {
  const PAGE = 1000;
  const page = async (from: number, count = false) => {
    let q = count ? supabase.from(table).select(columns, { count: "exact" }) : supabase.from(table).select(columns);
    for (const col of order) q = q.order(col);
    const { data, error, count: total } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as T[], total: total ?? null };
  };
  const first = await page(0, true);
  const out: T[] = [...first.rows];
  if (first.rows.length < PAGE) return out;
  if (first.total === null) {
    // χωρίς count: σειριακά όπως παλιά
    for (let from = PAGE; ; from += PAGE) {
      const { rows } = await page(from);
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  }
  const starts: number[] = [];
  for (let from = PAGE; from < first.total; from += PAGE) starts.push(from);
  const results: T[][] = new Array(starts.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, starts.length) }, async () => {
      while (next < starts.length) {
        const i = next++;
        results[i] = (await page(starts[i])).rows;
      }
    })
  );
  for (const r of results) out.push(...r);
  return out;
}
