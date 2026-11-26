// Edge function «relocation-report»: φτιάχνει την εβδομαδιαία αναφορά μεταφοράς (θέμα + HTML).
// Δύο τρόποι κλήσης:
//  - συνδεδεμένος χρήστης (Authorization: Bearer <token>) — ίδια δικαιώματα με την εφαρμογή
//  - η βάση (pg_net από relocation_report_generate()) με την κεφαλίδα x-report-key (ελέγχεται με το
//    relocation_report_check)· τότε
//    διαβάζει με το service key και αποθηκεύει την αναφορά στον πίνακα relocation_report.
import { normRel } from "../lib/relocation.ts";
import { buildRelocationReport } from "../lib/relocationReport.ts";

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Response | Promise<Response>): void };

const URL_ = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json; charset=utf-8" } });

async function rest(apikey: string, auth: string, path: string, body?: unknown, prefer?: string) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { apikey, Authorization: auth, "content-type": "application/json", Range: "0-9999", ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

Deno.serve(async (req) => {
  const k = req.headers.get("x-report-key");
  const byDb = !!k && !!SERVICE && (await rest(SERVICE, `Bearer ${SERVICE}`, "rpc/relocation_report_check", { p_key: k }).catch(() => false)) === true;
  const auth = byDb ? `Bearer ${SERVICE}` : req.headers.get("Authorization") ?? "";
  const apikey = byDb ? SERVICE : ANON;
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
      rest(apikey, auth, "rpc/wms_relocation_data_v2", { p_prefix: prefix, p_from: from, p_legacy: legacy || null }),
      rest(apikey, auth, "relocation_skip_pos?select=code"),
      rest(apikey, auth, "relocation_pos_room?select=code,room"),
      rest(apikey, auth, "relocation_pick?select=item,keys"),
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
    if (byDb) {
      await rest(apikey, auth, "relocation_report", { subject: rep.subject, html: rep.html, html365: rep.html365, items: rep.count, rows: rows.length }, "return=minimal");
      return json({ ok: true, subject: rep.subject, items: rep.count, rows: rows.length, html365_len: rep.html365.length });
    }
    return json({ ...rep, rows: rows.length });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
