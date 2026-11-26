"use client";

import { createClient } from "@/lib/supabase/client";
import { fetchAll } from "@/lib/supabase/fetchAll";
import type { Carrier, Invite, Mail, Quote, Rfq, RfqEvent } from "@/lib/logistics";

export type LogData = { rfqs: Rfq[]; carriers: Carrier[]; invites: Invite[]; quotes: Quote[]; events: RfqEvent[]; mails: Mail[] };

const n = (v: unknown) => (v == null ? null : Number(v));

export async function loadLogistics(): Promise<LogData> {
  const sb = createClient();
  const [rfqs, carriers, invites, quotes, events, mails] = await Promise.all([
    fetchAll<Rfq>(sb, "rfqs", "*", ["created_at"]),
    fetchAll<Carrier>(sb, "carriers", "*", ["name"]),
    fetchAll<Invite>(sb, "rfq_invites", "*", ["created_at"]),
    fetchAll<Quote>(sb, "quotes", "*", ["created_at"]),
    fetchAll<RfqEvent>(sb, "rfq_events", "*", ["at"]),
    sb.from("mail_outbox").select("id, to_addrs, cc_addrs, subject, html, rfq_id, status, error, created_at, sent_at").order("id", { ascending: false }).limit(500),
  ]);
  return {
    rfqs: rfqs
      .map((r) => ({ ...r, pallets: n(r.pallets), packages: n(r.packages), weight_kg: n(r.weight_kg), volume_m3: n(r.volume_m3), ldm: n(r.ldm), value_eur: n(r.value_eur), final_cost: n(r.final_cost) }) as Rfq)
      .reverse(),
    carriers,
    invites,
    quotes: quotes.map((q) => ({ ...q, price: Number(q.price), transit_days: n(q.transit_days) }) as Quote),
    events,
    mails: (mails.data as Mail[] | null) ?? [],
  };
}

export async function logEvent(rfq_id: string, text: string, by: string | null) {
  await createClient().from("rfq_events").insert({ rfq_id, text, by });
}

export async function queueMail(m: { to_addrs: string[]; subject: string; html: string; rfq_id: string | null; created_by: string | null }) {
  const { error } = await createClient().from("mail_outbox").insert(m);
  if (error) throw new Error(error.message);
}
