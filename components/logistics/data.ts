"use client";

import { createClient } from "@/lib/supabase/client";
import { fetchAll } from "@/lib/supabase/fetchAll";
import type { Carrier, Invite, Mail, Quote, Rfq, RfqDoc, RfqEvent } from "@/lib/logistics";

export type LogData = { rfqs: Rfq[]; carriers: Carrier[]; invites: Invite[]; quotes: Quote[]; events: RfqEvent[]; mails: Mail[]; docs: RfqDoc[] };

const n = (v: unknown) => (v == null ? null : Number(v));

export async function loadLogistics(): Promise<LogData> {
  const sb = createClient();
  const [rfqs, carriers, invites, quotes, events, mails, docs] = await Promise.all([
    fetchAll<Rfq>(sb, "rfqs", "*", ["created_at"]),
    fetchAll<Carrier>(sb, "carriers", "*", ["name"]),
    fetchAll<Invite>(sb, "rfq_invites", "*", ["created_at"]),
    fetchAll<Quote>(sb, "quotes", "*", ["created_at"]),
    fetchAll<RfqEvent>(sb, "rfq_events", "*", ["at"]),
    sb.from("mail_outbox").select("id, to_addrs, cc_addrs, subject, html, attachments, rfq_id, status, error, created_at, sent_at").order("id", { ascending: false }).limit(500),
    fetchAll<RfqDoc>(sb, "rfq_docs", "*", ["created_at"]),
  ]);
  return {
    rfqs: rfqs
      .map((r) => ({ ...r, round_target: n(r.round_target), round_pct: n(r.round_pct), pallets: n(r.pallets), packages: n(r.packages), weight_kg: n(r.weight_kg), volume_m3: n(r.volume_m3), ldm: n(r.ldm), value_eur: n(r.value_eur), final_cost: n(r.final_cost) }) as Rfq)
      .reverse(),
    carriers,
    invites,
    quotes: quotes.map((q) => ({ ...q, price: Number(q.price), first_price: n(q.first_price), transit_days: n(q.transit_days) }) as Quote),
    events,
    mails: (mails.data as Mail[] | null) ?? [],
    docs: docs.map((d) => ({ ...d, size: n(d.size) }) as RfqDoc),
  };
}

export async function logEvent(rfq_id: string, text: string, by: string | null) {
  await createClient().from("rfq_events").insert({ rfq_id, text, by });
}

export async function queueMail(m: { to_addrs: string[]; subject: string; html: string; rfq_id: string | null; created_by: string | null; attachments?: { path: string; name: string }[] }) {
  const { error } = await createClient().from("mail_outbox").insert(m);
  if (error) throw new Error(error.message);
}

/** Ανέβασμα αρχείου στο bucket «logistics» + εγγραφή στο rfq_docs */
export async function uploadDoc(rfqId: string, file: Blob, name: string, kind: string, visible: string, by: string | null) {
  const sb = createClient();
  const ext = (name.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? "").toLowerCase();
  const path = `${rfqId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const up = await sb.storage.from("logistics").upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
  if (up.error) throw new Error(`${name}: ${up.error.message}`);
  const { data, error } = await sb.from("rfq_docs").insert({ rfq_id: rfqId, kind, name, path, size: file.size, mime: file.type || null, visible, created_by: by }).select("*").single();
  if (error) {
    await sb.storage.from("logistics").remove([path]);
    throw new Error(`${name}: ${error.message}`);
  }
  return data as { id: string; path: string; name: string };
}

export async function downloadDoc(path: string, name: string) {
  const { data, error } = await createClient().storage.from("logistics").createSignedUrl(path, 120, { download: name });
  if (error || !data) throw new Error(error?.message ?? "Σφάλμα λήψης");
  const a = document.createElement("a");
  a.href = data.signedUrl;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
