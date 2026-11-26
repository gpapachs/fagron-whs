// Edge function «relocation-report»: φτιάχνει την εβδομαδιαία αναφορά μεταφοράς (θέμα + HTML).
// Την καλεί το sync του υπολογιστή της αποθήκης (συνδεδεμένος χρήστης) κάθε Πέμπτη 12:00 και τη στέλνει
// από το Outlook. Χρησιμοποιεί το token του καλούντα — τα ίδια δικαιώματα με την εφαρμογή.
import { normRel } from "../lib/relocation.ts";
import { buildRelocationReport } from "../lib/relocationReport.ts";

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Response | Promise<Response>): void };

const URL_ = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json; charset=utf-8" } });

async function rest(auth: string, path: string, body?: unknown) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { apikey: ANON, Authorization: auth, "content-type": "application/json", Range: "0-9999" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

Deno.serve(async (req) => {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Απαιτείται σύνδεση" }, 401);
  try {
    const q = new URL(req.url).searchParams;
    const prefix = q.get("prefix") ?? "41";
    const legacy = q.get("legacy") ?? "40";
    const room = q.get("room") ?? "20";
    const keepMonths = Number(q.get("months") ?? 3) || 3;
    const now = new Date();
    const from = q.get("from") ?? `${now.getFullYear()}-01-01`;
    const [data, skip, pr, pick] = await Promise.all([
      rest(auth, "rpc/wms_relocation_data_v2", { p_prefix: prefix, p_from: from, p_legacy: legacy || null }),
      rest(auth, "relocation_skip_pos?select=code"),
      rest(auth, "relocation_pos_room?select=code,room"),
      rest(auth, "relocation_pick?select=item,keys"),
    ]);
    const rows = (data as Record<string, unknown>[]).map(normRel);
    const rep = buildRelocationReport(rows, {
      prefix,
      from,
      room,
      keepMonths,
      skipPos: (skip as { code: string }[]).map((r) => r.code),
      posRoom: Object.fromEntries((pr as { code: string; room: string }[]).map((r) => [r.code, r.room])),
      picked: new Set((pick as { item: string; keys: string[] }[]).filter((r) => r.keys?.length).map((r) => r.item)),
      appUrl: "https://gpapachs.github.io/fagron-whs/analysis/",
      now,
    });
    return json({ ...rep, rows: rows.length });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
