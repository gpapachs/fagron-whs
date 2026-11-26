// MSDS από το fagron.com/documents?type=msds (δημόσια σελίδα, αναζήτηση με ?s=).
//   POST { action: "search", items: [{ key, cas?, name? }] }  -> { results: [{ key, query, hits: [{ name, number, links: {GR: url,…} }] }] }
//   POST { action: "attach", rfq_id, url, name }               -> κατεβάζει το PDF στο Storage και το καταχωρεί στα έγγραφα (MSDS, ορατό σε όλους)
// Μόνο για συνδεδεμένους χρήστες της εφαρμογής (verify_jwt).
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "content-type": "application/json" } });
const UA = { "User-Agent": "Mozilla/5.0 (FagronHellas-WHS)" };

type Hit = { name: string; number: string; links: Record<string, string> };

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function parse(html: string): Hit[] {
  const out: Hit[] = [];
  for (const tr of html.split(/<tr>/).slice(1)) {
    const name = tr.match(/<td class="leading-normal">([\s\S]*?)<\/td>/)?.[1];
    const num = tr.match(/<td class="whitespace-nowrap">([\s\S]*?)<\/td>/)?.[1];
    if (name == null) continue;
    const links: Record<string, string> = {};
    for (const m of tr.matchAll(/href="([^"]+\.pdf)"[^>]*>\s*([A-Z]{2,4})\s*<\/a>/g)) links[m[2]] ??= decode(m[1]);
    if (Object.keys(links).length) out.push({ name: decode(name), number: decode(num ?? ""), links });
  }
  return out;
}

async function search(q: string): Promise<Hit[]> {
  const res = await fetch(`https://fagron.com/documents?type=msds&s=${encodeURIComponent(q)}`, { headers: UA });
  if (!res.ok) throw new Error(`fagron.com ${res.status}`);
  return parse(await res.text());
}

const toks = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/,/g, ".")
    .split(/[^a-z0-9.%]+/)
    .filter((t) => t.length > 1 || /\d/.test(t));

/** κατάταξη: ίδιος CAS / αριθμός πρώτα, μετά κοινές λέξεις, μετά συντομότερο όνομα */
function rank(hits: Hit[], cas: string, name: string) {
  const q = toks(name);
  const score = (h: Hit) => {
    if (cas && h.number.replace(/\s/g, "") === cas) return 100;
    const t = new Set(toks(h.name));
    const common = q.filter((x) => t.has(x)).length;
    return q.length ? (common / q.length) * 50 - t.size * 0.5 : 0;
  };
  return hits.map((h) => ({ h, s: score(h) })).sort((a, b) => b.s - a.s).map((x) => x.h);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const auth = req.headers.get("Authorization") ?? "";
  const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: u } = await user.auth.getUser();
  if (!u?.user) return json({ error: "Απαιτείται σύνδεση" }, 401);
  const body = await req.json().catch(() => ({}));

  if (body.action === "search") {
    const items: { key: string; cas?: string; name?: string }[] = (body.items ?? []).slice(0, 80);
    const results: { key: string; query: string; hits: Hit[]; error?: string }[] = [];
    // λίγα ταυτόχρονα αιτήματα — δεν φορτώνουμε το site
    for (let i = 0; i < items.length; i += 3) {
      const part = await Promise.all(
        items.slice(i, i + 3).map(async (it) => {
          const cas = (it.cas ?? "").replace(/\s/g, "");
          const name = (it.name ?? "").trim();
          try {
            let hits = cas ? await search(cas) : [];
            let query = cas;
            if (!hits.length && name) {
              query = name;
              hits = await search(name);
              // πολύ συγκεκριμένο όνομα (π.χ. «Ethanol 96% v/v Ph.Eur.»): δοκιμή με την 1η λέξη
              if (!hits.length && name.split(/\s+/).length > 1) {
                query = name.split(/[\s,(]+/)[0];
                hits = await search(query);
              }
            }
            return { key: it.key, query, hits: rank(hits, cas, name).slice(0, 8) };
          } catch (e) {
            return { key: it.key, query: cas || name, hits: [], error: (e as Error).message };
          }
        })
      );
      results.push(...part);
    }
    return json({ results });
  }

  if (body.action === "attach") {
    const url = String(body.url ?? "");
    if (!/^https:\/\/d84823jj91l2\.cloudfront\.net\/documents\/MSDS\/[^?#]+\.pdf$/.test(url)) return json({ error: "Μη αποδεκτός σύνδεσμος MSDS" }, 400);
    const rfqId = String(body.rfq_id ?? "");
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: r } = await admin.from("rfqs").select("id").eq("id", rfqId).maybeSingle();
    if (!r) return json({ error: "Το αίτημα δεν βρέθηκε" }, 404);
    const res = await fetch(url, { headers: UA });
    if (!res.ok) return json({ error: `Λήψη MSDS: ${res.status}` }, 502);
    const buf = new Uint8Array(await res.arrayBuffer());
    const name = String(body.name ?? "MSDS.pdf").replace(/[\\/:*?"<>|]/g, "_").slice(0, 150);
    const path = `${rfqId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`;
    const up = await admin.storage.from("logistics").upload(path, buf, { contentType: "application/pdf" });
    if (up.error) return json({ error: up.error.message }, 500);
    const { data: doc, error } = await admin
      .from("rfq_docs")
      .insert({ rfq_id: rfqId, kind: "msds", name, path, size: buf.length, mime: "application/pdf", visible: "all", notes: url, created_by: u.user.email })
      .select("id, name")
      .single();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, doc });
  }
  return json({ error: "Άγνωστη ενέργεια" }, 400);
});
