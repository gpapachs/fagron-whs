// MSDS από το fagron.com/documents?type=msds (δημόσια σελίδα, αναζήτηση με ?s=).
//   POST { action: "search", items: [{ key, cas?, name? }] }  -> { results: [{ key, query, hits: [{ name, number, links: {GR: url,…} }] }] }
//   POST { action: "transport", items: [{ key, url }] }        -> UN / κλάση / PG από την ενότητα 14 του MSDS (αγγλική έκδοση)
//   POST { action: "attach", rfq_id, url, name }               -> κατεβάζει το PDF στο Storage και το καταχωρεί στα έγγραφα (MSDS, ορατό σε όλους)
// Μόνο για συνδεδεμένους χρήστες της εφαρμογής (verify_jwt).
import { createClient } from "npm:@supabase/supabase-js@2";
import { extractText, getDocumentProxy } from "npm:unpdf@0.12.1";

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
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/,/g, ".")
    .split(/[^a-z0-9.%]+/)
    .filter((t) => t.length > 1 || /\d/.test(t));

/** κατάταξη: ίδιος CAS / αριθμός πρώτα, μετά κοινές λέξεις, μετά συντομότερο όνομα */
function rank(hits: Hit[], cas: string, name: string) {
  const q = toks(name);
  const score = (h: Hit) => {
    // ίδιος CAS: προτίμηση στην εγγραφή με αγγλική (GB) έκδοση
    if (cas && h.number.replace(/\s/g, "") === cas) return 100 + (h.links.GB ? 5 : 0) + Object.keys(h.links).length / 100;
    const t = new Set(toks(h.name));
    const common = q.filter((x) => t.has(x)).length;
    return (q.length ? (common / q.length) * 50 - t.size * 0.5 : 0) + (h.links.GB ? 1 : 0);
  };
  return hits.map((h) => ({ h, s: score(h) })).sort((a, b) => b.s - a.s).map((x) => x.h);
}

const MSDS_URL = /^https:\/\/d84823jj91l2\.cloudfront\.net\/documents\/MSDS\/[^?#]+\.pdf$/;
type Transport = { regulated: boolean; un: string; cls: string; pg: string; psn: string } | null;

/** Ενότητα 14 (Transport information) από το κείμενο του MSDS */
export function parse14(text: string): Transport {
  // (τα US SDS έχουν σπασμένες λέξεις: «T ransport», «Packaging Group»)
  const t = text.replace(/\s+/g, " ").replace(/\bT ransport/g, "Transport").replace(/\bT OXIC/g, "TOXIC");
  const i = t.search(/SECTION 14|14\.1 UN number/i);
  if (i < 0) return null;
  const s14 = t.slice(i, i + 4000);
  const model = s14.match(/UN "Model Regulation":\s*([^·*]+)/i)?.[1]?.trim() ?? "";
  if (/^not regulated/i.test(model) || (/14\.1[^·]*·[^·]*not regulated/i.test(s14) && !/UN\s?\d{4}/.test(s14))) return { regulated: false, un: "", cls: "", pg: "", psn: "" };
  // «UN 1170 ETHANOL (ETHYL ALCOHOL), 3, II»
  const m = model.match(/UN\s?(\d{4})\s+(.+?),\s*(\d(?:\.\d)?[A-Z]?(?:\s*\([^)]*\))?)(?:,\s*(I{1,3})\b)?/);
  if (m) return { regulated: true, un: m[1], psn: m[2].trim(), cls: m[3].trim(), pg: m[4] ?? "" };
  // μορφή US: «UN Number 2811 UN Proper Shipping Name … Transport Hazard Class(es) 6.1 Packaging Group III»
  if (/UN\s*Number\s*:?\s*(Not regulated|Not applicable|N\/A)/i.test(s14) && !/UN\s?\d{4}/.test(s14)) return { regulated: false, un: "", cls: "", pg: "", psn: "" };
  const un =
    s14.match(/14\.1[^·]*·[^·]*?UN\s?(\d{4})/)?.[1] ?? s14.match(/UN\s*Number\s*:?\s*(?:UN\s?)?(\d{4})/i)?.[1] ?? s14.match(/\bUN\s?(\d{4})\b/)?.[1] ?? "";
  const cls = s14.match(/·\s*Class\s+(\d(?:\.\d)?[A-Z]?)/)?.[1] ?? s14.match(/Hazard\s*Class(?:\(es\))?\s*:?\s*(\d(?:\.\d)?)/i)?.[1] ?? "";
  const pg = s14.match(/14\.4 Packing group[^·]*·[^·]*?\b(I{1,3})\b/)?.[1] ?? s14.match(/Pack(?:ag)?ing\s*Group\s*:?\s*(I{1,3})\b/i)?.[1] ?? "";
  const psn = (
    s14.match(/14\.2 UN proper shipping name\s*·\s*[A-Z, ]*?(?:ADR|IMDG|IATA)[A-Z, ]*\s+([^·(]+)/)?.[1] ??
    s14.match(/UN\s*Proper\s*Shipping\s*Name\s*:?\s*(.+?)\s*Transport\s*Hazard/i)?.[1] ??
    ""
  )
    .trim()
    .replace(/^\d{4}\s+/, "");
  if (!un && !cls) return null;
  return { regulated: true, un, cls, pg, psn };
}

async function transport(url: string): Promise<Transport> {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`MSDS ${res.status}`);
  const pdf = await getDocumentProxy(new Uint8Array(await res.arrayBuffer()));
  const { text } = await extractText(pdf, { mergePages: true });
  return parse14(String(text));
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

  if (body.action === "transport") {
    const items: { key: string; url: string }[] = (body.items ?? []).filter((x: { url?: string }) => MSDS_URL.test(String(x.url ?? ""))).slice(0, 20);
    const results: { key: string; t: Transport; error?: string }[] = [];
    for (let i = 0; i < items.length; i += 3) {
      results.push(
        ...(await Promise.all(
          items.slice(i, i + 3).map(async (it) => {
            try {
              return { key: it.key, t: await transport(it.url) };
            } catch (e) {
              return { key: it.key, t: null, error: (e as Error).message };
            }
          })
        ))
      );
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
