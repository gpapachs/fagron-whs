// Λήψη εγγράφου αιτήματος από τη μεταφορική (δημόσια φόρμα, χωρίς login):
//   GET /functions/v1/rfq-doc?t=<token πρόσκλησης>&d=<id εγγράφου>
// Ελέγχει ότι το token ανήκει στο ίδιο αίτημα και ότι το έγγραφο είναι ορατό στη μεταφορική
// (visible = 'all', ή 'winner' και η μεταφορική είναι ο νικητής). Μετά ανακατευθύνει σε signed URL 5 λεπτών.
import { createClient } from "npm:@supabase/supabase-js@2";

const html = (status: number, msg: string) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>Fagron Hellas</title><body style="font-family:sans-serif;padding:24px"><p>${msg}</p></body>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const t = u.searchParams.get("t") ?? "";
  const d = u.searchParams.get("d") ?? "";
  if (t.length < 20 || !/^[0-9a-f-]{36}$/i.test(d)) return html(400, "Μη έγκυρος σύνδεσμος. / Invalid link.");
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const { data: inv } = await sb.from("rfq_invites").select("rfq_id, carrier_id").eq("token", t).maybeSingle();
  if (!inv) return html(404, "Ο σύνδεσμος δεν βρέθηκε. / Link not found.");
  const { data: doc } = await sb.from("rfq_docs").select("id, rfq_id, name, path, visible").eq("id", d).maybeSingle();
  if (!doc || doc.rfq_id !== inv.rfq_id || doc.visible === "no") return html(404, "Το έγγραφο δεν είναι διαθέσιμο. / Document not available.");
  if (doc.visible === "winner") {
    const [{ data: r }, { data: q }] = await Promise.all([
      sb.from("rfqs").select("awarded_quote").eq("id", inv.rfq_id).maybeSingle(),
      sb.from("quotes").select("id").eq("rfq_id", inv.rfq_id).eq("carrier_id", inv.carrier_id).maybeSingle(),
    ]);
    if (!r?.awarded_quote || r.awarded_quote !== q?.id) return html(404, "Το έγγραφο δεν είναι διαθέσιμο. / Document not available.");
  }
  const { data: s, error } = await sb.storage.from("logistics").createSignedUrl(doc.path, 300, { download: doc.name });
  if (error || !s) return html(500, "Σφάλμα λήψης. / Download error.");
  const { data: c } = await sb.from("carriers").select("name").eq("id", inv.carrier_id).maybeSingle();
  await sb.from("rfq_events").insert({ rfq_id: inv.rfq_id, by: c?.name ?? "μεταφορική", text: `Λήψη εγγράφου: ${doc.name}` });
  return Response.redirect(s.signedUrl, 302);
});
