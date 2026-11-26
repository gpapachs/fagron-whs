// Logistics: τύποι, ετικέτες και τα email προς τις μεταφορικές (καθαρή λογική, χωρίς React / Supabase).

export type Direction = "import" | "export";
export type RfqStatus = "draft" | "sent" | "quoted" | "awarded" | "in_transit" | "delivered" | "cancelled";

export type Carrier = {
  id: string;
  name: string;
  emails: string[];
  contact: string | null;
  phone: string | null;
  modes: string[];
  countries: string[];
  notes: string | null;
  rating: number | null;
  active: boolean;
  created_at: string;
};

export type Rfq = {
  id: string;
  ref: string;
  direction: Direction;
  status: RfqStatus;
  mode: string | null;
  from_company: string | null;
  from_address: string | null;
  from_city: string | null;
  from_zip: string | null;
  from_country: string | null;
  to_company: string | null;
  to_address: string | null;
  to_city: string | null;
  to_zip: string | null;
  to_country: string | null;
  pickup_date: string | null;
  delivery_by: string | null;
  quote_deadline: string | null;
  incoterm: string | null;
  goods: string | null;
  pallets: number | null;
  packages: number | null;
  weight_kg: number | null;
  volume_m3: number | null;
  ldm: number | null;
  dims: string | null;
  stackable: boolean | null;
  adr: boolean;
  adr_info: string | null;
  temp: string | null;
  value_eur: number | null;
  customer: string | null;
  order_ref: string | null;
  notes: string | null;
  internal_notes: string | null;
  awarded_quote: string | null;
  carrier_ref: string | null;
  tracking_no: string | null;
  tracking_url: string | null;
  eta: string | null;
  picked_at: string | null;
  delivered_at: string | null;
  final_cost: number | null;
  docs: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
};

export type Invite = { id: string; rfq_id: string; carrier_id: string; token: string; emails: string[]; sent_at: string | null; opened_at: string | null; responded_at: string | null; declined: boolean; created_at: string };
export type Quote = {
  id: string;
  rfq_id: string;
  carrier_id: string;
  price: number;
  currency: string;
  transit_days: number | null;
  pickup_date: string | null;
  delivery_date: string | null;
  valid_until: string | null;
  includes: string | null;
  notes: string | null;
  contact: string | null;
  source: "form" | "manual" | "email";
  created_at: string;
  created_by: string | null;
};
export type RfqEvent = { id: number; rfq_id: string; at: string; by: string | null; text: string };
export type Mail = { id: number; to_addrs: string[]; cc_addrs?: string[]; html?: string; subject: string; rfq_id: string | null; status: "pending" | "sent" | "error" | "cancelled"; error: string | null; created_at: string; sent_at: string | null };

export const STATUS_TXT: Record<RfqStatus, string> = {
  draft: "Πρόχειρο",
  sent: "Στάλθηκε",
  quoted: "Με προσφορές",
  awarded: "Ανατέθηκε",
  in_transit: "Σε μεταφορά",
  delivered: "Παραδόθηκε",
  cancelled: "Ακυρώθηκε",
};
export const STATUS_TONE: Record<RfqStatus, string> = { draft: "neutral", sent: "blue", quoted: "yellow", awarded: "green", in_transit: "orange", delivered: "green", cancelled: "neutral" };
export const DIR_TXT: Record<Direction, string> = { import: "Εισαγωγή", export: "Εξαγωγή" };
export const MODES: { key: string; gr: string; en: string }[] = [
  { key: "groupage", gr: "Groupage (παλέτες)", en: "Groupage / LTL" },
  { key: "ftl", gr: "Φορτηγό (FTL)", en: "Full truck (FTL)" },
  { key: "courier", gr: "Courier", en: "Courier / parcel" },
  { key: "air", gr: "Αεροπορικώς", en: "Air freight" },
  { key: "sea", gr: "Ακτοπλοϊκώς / θαλάσσια", en: "Sea freight" },
];
export const MODE_TXT = Object.fromEntries(MODES.map((m) => [m.key, m.gr])) as Record<string, string>;
export const INCOTERMS = ["EXW", "FCA", "CPT", "CIP", "DAP", "DPU", "DDP", "FOB", "CFR", "CIF"];

/** Η Fagron Hellas — προεπιλογή για αποστολέα εξαγωγών / παραλήπτη εισαγωγών */
export const HOME = { company: "Fagron Hellas", address: "12 km N.R. Trikala - Larissa", city: "Trikala", zip: "42100", country: "GR" };

export const APP_URL = "https://gpapachs.github.io/fagron-whs";
export const quoteLink = (token: string) => `${APP_URL}/quote/?t=${token}`;

const esc = (s: string | number | null | undefined) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export const dmy = (s: string | null | undefined) => (s ? s.slice(0, 10).split("-").reverse().join("/") : "");
const num = (n: number | null | undefined, d = 2) => (n == null ? "" : n.toLocaleString("el-GR", { maximumFractionDigits: d }));

export const place = (r: Rfq, side: "from" | "to") => {
  const g = (k: string) => (r as unknown as Record<string, string | null>)[`${side}_${k}`];
  return [g("company"), g("address"), [g("zip"), g("city")].filter(Boolean).join(" "), g("country")].filter(Boolean).join(", ");
};
export const route = (r: Rfq) => `${[r.from_city, r.from_country].filter(Boolean).join(", ") || "—"} → ${[r.to_city, r.to_country].filter(Boolean).join(", ") || "—"}`;

/** γραμμές στοιχείων φορτίου, δίγλωσσα (οι μεταφορικές είναι και εξωτερικού) */
export function loadRows(r: Rfq): [string, string][] {
  const rows: [string, string][] = [
    ["Αναφορά / Reference", r.ref],
    ["Είδος / Type", r.direction === "export" ? "Εξαγωγή / Export" : "Εισαγωγή / Import"],
    ["Τρόπος / Mode", MODES.find((m) => m.key === r.mode) ? `${MODE_TXT[r.mode!]} / ${MODES.find((m) => m.key === r.mode)!.en}` : r.mode ?? ""],
    ["Φόρτωση / Pick-up", place(r, "from")],
    ["Παράδοση / Delivery", place(r, "to")],
    ["Ημ. φόρτωσης / Pick-up date", dmy(r.pickup_date)],
    ["Παράδοση έως / Deliver by", dmy(r.delivery_by)],
    ["Incoterm", r.incoterm ?? ""],
    ["Εμπόρευμα / Goods", r.goods ?? ""],
    ["Παλέτες / Pallets", r.pallets != null ? String(r.pallets) : ""],
    ["Δέματα / Packages", r.packages != null ? String(r.packages) : ""],
    ["Βάρος / Weight (kg)", num(r.weight_kg)],
    ["Όγκος / Volume (m³)", num(r.volume_m3, 3)],
    ["LDM", num(r.ldm)],
    ["Διαστάσεις / Dimensions", r.dims ?? ""],
    ["Στοιβαζόμενο / Stackable", r.stackable == null ? "" : r.stackable ? "Ναι / Yes" : "Όχι / No"],
    ["ADR", r.adr ? `Ναι / Yes${r.adr_info ? ` — ${r.adr_info}` : ""}` : "Όχι / No"],
    ["Θερμοκρασία / Temperature", r.temp ?? ""],
    ["Σημειώσεις / Notes", r.notes ?? ""],
  ];
  return rows.filter(([, v]) => v);
}

const table = (rows: [string, string][]) =>
  `<table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;font-size:13px">${rows
    .map(([k, v]) => `<tr><td style="background:#f2f5f9;white-space:nowrap"><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`)
    .join("")}</table>`;

/** Αίτημα προσφοράς προς μία μεταφορική (με το προσωπικό της link) */
export function rfqEmail(r: Rfq, carrier: Carrier, token: string, sender: string) {
  const link = quoteLink(token);
  const deadline = r.quote_deadline ? new Date(r.quote_deadline).toLocaleString("el-GR", { timeZone: "Europe/Athens", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "";
  const subject = `Αίτημα προσφοράς / Quote request ${r.ref} — ${route(r)}${r.pickup_date ? ` — ${dmy(r.pickup_date)}` : ""}`;
  const html = `<p>Καλημέρα σας${carrier.contact ? ` κ. ${esc(carrier.contact)}` : ""},</p>
<p>Παρακαλούμε για την προσφορά σας για την παρακάτω μεταφορά${deadline ? ` έως <b>${esc(deadline)}</b>` : ""}.</p>
<p><i>Dear partner, please send us your best offer for the transport below${deadline ? ` by <b>${esc(deadline)}</b>` : ""}.</i></p>
${table(loadRows(r))}
<p><b><a href="${esc(link)}">Συμπλήρωση προσφοράς / Submit your quote</a></b><br>${esc(link)}</p>
<p>Μπορείτε επίσης να απαντήσετε σε αυτό το email. / You may also reply to this email.</p>
<p>Ευχαριστούμε / Thank you,<br>${esc(sender)}<br>Fagron Hellas — Logistics</p>`;
  return { subject, html };
}

/** Ειδοποίηση ανάθεσης (στον νικητή) ή μη ανάθεσης (στους υπόλοιπους) */
export function awardEmail(r: Rfq, carrier: Carrier, q: Quote | null, won: boolean, sender: string) {
  const subject = `${won ? "Ανάθεση / Award" : "Αποτέλεσμα / Result"} ${r.ref} — ${route(r)}`;
  const html = won
    ? `<p>Καλημέρα σας,</p><p>Σας αναθέτουμε τη μεταφορά <b>${esc(r.ref)}</b> σύμφωνα με την προσφορά σας${q ? ` (<b>${esc(num(q.price))} ${esc(q.currency)}</b>${q.transit_days ? `, ${esc(q.transit_days)} ημέρες` : ""})` : ""}.</p>
<p><i>We are pleased to award you transport <b>${esc(r.ref)}</b> as per your offer. Please confirm the pick-up date and send us your reference / tracking number.</i></p>
${table(loadRows(r))}
<p>Ευχαριστούμε / Thank you,<br>${esc(sender)}<br>Fagron Hellas — Logistics</p>`
    : `<p>Καλημέρα σας,</p><p>Σας ευχαριστούμε για την προσφορά σας για τη μεταφορά <b>${esc(r.ref)}</b> (${esc(route(r))}). Αυτή τη φορά η μεταφορά ανατέθηκε αλλού.</p>
<p><i>Thank you for your offer for <b>${esc(r.ref)}</b>. This time the transport has been awarded to another partner.</i></p>
<p>${esc(sender)}<br>Fagron Hellas — Logistics</p>`;
  return { subject, html };
}

/** Μεταφορικές που ταιριάζουν στο αίτημα (τρόπος + χώρα) πρώτα */
export function suggestCarriers(r: Rfq, carriers: Carrier[]) {
  const country = (r.direction === "export" ? r.to_country : r.from_country)?.trim().toUpperCase() ?? "";
  const score = (c: Carrier) =>
    (r.mode && c.modes.includes(r.mode) ? 2 : 0) + (country && c.countries.some((x) => x.toUpperCase() === country || x === "*" || x.toUpperCase() === "ALL") ? 2 : 0) + (c.rating ?? 0) / 10;
  return [...carriers].filter((c) => c.active).sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}

/** σύγκριση προσφορών: φθηνότερη / ταχύτερη / τιμή ανά παλέτα & ανά κιλό */
export function rankQuotes(r: Rfq, quotes: Quote[]) {
  const eur = quotes.filter((q) => q.currency === "EUR");
  const cheapest = eur.length ? Math.min(...eur.map((q) => q.price)) : null;
  const fastest = quotes.filter((q) => q.transit_days != null).length ? Math.min(...quotes.filter((q) => q.transit_days != null).map((q) => q.transit_days!)) : null;
  return [...quotes]
    .sort((a, b) => a.price - b.price)
    .map((q) => ({
      q,
      cheapest: cheapest != null && q.currency === "EUR" && q.price === cheapest,
      fastest: fastest != null && q.transit_days === fastest,
      vsBest: cheapest != null && q.currency === "EUR" && cheapest > 0 ? q.price / cheapest - 1 : null,
      perPallet: r.pallets ? q.price / r.pallets : null,
      perKg: r.weight_kg ? q.price / r.weight_kg : null,
    }));
}

export const parseList = (s: string) => [...new Set(s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];

/** HTML email -> απλό κείμενο (για mailto / χειροκίνητη αποστολή) */
export function htmlToText(html: string) {
  return html
    .replace(/\r?\n/g, " ")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, "$2: $1")
    .replace(/<\/(p|tr|h\d)>|<br\s*\/?>/gi, "\n")
    .replace(/<\/td>\s*<td[^>]*>/gi, ": ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** mailto: για άνοιγμα στο πρόγραμμα email του χρήστη (Outlook) */
export function mailtoHref(to: string[], subject: string, html: string) {
  let body = htmlToText(html);
  if (body.length > 1800) body = body.slice(0, 1800) + "\n…";
  return `mailto:${to.map(encodeURIComponent).join(";")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
