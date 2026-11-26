// Φόρτωση μεταφορικών από Excel: αναγνώριση στηλών από τις επικεφαλίδες (ελληνικά / αγγλικά),
// μετατροπή τρόπων μεταφοράς και χωρών, και ταίριασμα με τις υπάρχουσες (όνομα ή email).
import type { Carrier } from "@/lib/logistics";

export type CarrierRow = { name: string; emails: string[]; contact: string | null; phone: string | null; modes: string[]; countries: string[]; notes: string | null; rating: number | null; active: boolean };
export type ImportLine = { row: number; data: CarrierRow; match: Carrier | null; error?: string };
type Field = "name" | "emails" | "contact" | "phone" | "modes" | "countries" | "notes" | "rating" | "active";

const norm = (s: unknown) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

// σειρά = προτεραιότητα· η πρώτη στήλη που ταιριάζει κερδίζει
const RULES: [Field, RegExp][] = [
  ["emails", /e-?mail|ηλεκτρ/],
  ["phone", /τηλ|phone|tel|κινητ|mobile/],
  ["contact", /υπευθυν|επαφη|contact|person|ατομο/],
  ["modes", /τροπο|mode|υπηρεσ|service|ειδος μεταφ|transport type/],
  ["countries", /χωρ|countr|προορισ|destin|διαδρομ|route|lane/],
  ["rating", /αξιολογ|rating|βαθμ|αστερ|stars?/],
  ["active", /ενεργ|active/],
  ["notes", /σημειω|παρατηρ|notes?|comment|σχολ/],
  ["name", /επωνυμ|ονομα|μεταφορ|carrier|forwarder|company|εταιρ|name/],
];

export function detectCarrierColumns(header: unknown[]): Partial<Record<Field, number>> {
  const out: Partial<Record<Field, number>> = {};
  const used = new Set<number>();
  for (const [f, re] of RULES)
    header.forEach((h, i) => {
      if (out[f] === undefined && !used.has(i) && re.test(norm(h))) {
        out[f] = i;
        used.add(i);
      }
    });
  return out;
}

const MODE_RE: [string, RegExp][] = [
  ["groupage", /groupage|ltl|ομαδικ|παλετ|pallet|οδικ|road|truck(?!load)/],
  ["ftl", /ftl|full|πληρ|ολοκληρ|φορτηγ/],
  ["courier", /courier|κουριερ|δεμα|parcel|express/],
  ["air", /air|αερο/],
  ["sea", /sea|θαλασσ|ακτοπλο|ocean|ship|πλοι|fcl|lcl/],
];
export function parseModes(s: unknown): string[] {
  const t = norm(s);
  if (!t) return [];
  return MODE_RE.filter(([, re]) => re.test(t)).map(([k]) => k);
}

const COUNTRY: Record<string, string> = {
  ελλαδα: "GR", greece: "GR", hellas: "GR", γερμανια: "DE", germany: "DE", deutschland: "DE", ολλανδια: "NL", netherlands: "NL", holland: "NL",
  βελγιο: "BE", belgium: "BE", ιταλια: "IT", italy: "IT", γαλλια: "FR", france: "FR", ισπανια: "ES", spain: "ES", πορτογαλια: "PT", portugal: "PT",
  αυστρια: "AT", austria: "AT", πολωνια: "PL", poland: "PL", τσεχια: "CZ", czechia: "CZ", "czech republic": "CZ", σλοβακια: "SK", slovakia: "SK",
  ουγγαρια: "HU", hungary: "HU", ρουμανια: "RO", romania: "RO", βουλγαρια: "BG", bulgaria: "BG", κυπρος: "CY", cyprus: "CY", δανια: "DK", denmark: "DK",
  σουηδια: "SE", sweden: "SE", φινλανδια: "FI", finland: "FI", νορβηγια: "NO", norway: "NO", ελβετια: "CH", switzerland: "CH", ιρλανδια: "IE", ireland: "IE",
  "ηνωμενο βασιλειο": "GB", αγγλια: "GB", "united kingdom": "GB", uk: "GB", england: "GB", λουξεμβουργο: "LU", luxembourg: "LU", σλοβενια: "SI", slovenia: "SI",
  κροατια: "HR", croatia: "HR", σερβια: "RS", serbia: "RS", αλβανια: "AL", albania: "AL", "βορεια μακεδονια": "MK", "north macedonia": "MK", τουρκια: "TR", turkey: "TR",
  turkiye: "TR", εσθονια: "EE", estonia: "EE", λετονια: "LV", latvia: "LV", λιθουανια: "LT", lithuania: "LT", μαλτα: "MT", malta: "MT",
  ηπα: "US", usa: "US", "united states": "US", κινα: "CN", china: "CN", ινδια: "IN", india: "IN", ισραηλ: "IL", israel: "IL", αιγυπτος: "EG", egypt: "EG",
  ευρωπη: "EU", europe: "EU", εε: "EU", eu: "EU", ολες: "*", all: "*", παντου: "*", worldwide: "*",
};
export function parseCountries(s: unknown): string[] {
  const parts = String(s ?? "")
    .split(/[,;/|\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const k = norm(p).replace(/\./g, "");
    const code = COUNTRY[k] ?? (/^[a-z]{2}$/i.test(p) ? p.toUpperCase() : p === "*" ? "*" : null);
    if (code === "EU") out.push("*");
    else if (code) out.push(code);
    else
      for (const w of p.split(/\s+/)) {
        const c = COUNTRY[norm(w)] ?? (/^[A-Z]{2}$/.test(w) ? w : null);
        if (c) out.push(c === "EU" ? "*" : c);
      }
  }
  return [...new Set(out)];
}

const emailsOf = (s: unknown) => [...new Set((String(s ?? "").match(/[^\s,;<>()"']+@[^\s,;<>()"']+\.[a-z]{2,}/gi) ?? []).map((x) => x.toLowerCase()))];
const txt = (v: unknown) => {
  const s = String(v ?? "").trim();
  return s ? s : null;
};
const key = (s: string) => norm(s).replace(/[^a-z0-9α-ω]+/g, "");

/** rows = πίνακας γραμμών (1η = επικεφαλίδες). Επιστρέφει γραμμές για προεπισκόπηση. */
export function readCarriers(rows: unknown[][], existing: Carrier[]): { lines: ImportLine[]; cols: Partial<Record<Field, number>>; headerRow: number } {
  // επικεφαλίδα: από τις 10 πρώτες γραμμές, αυτή με στήλη ονόματος και τις περισσότερες αναγνωρισμένες στήλες
  let headerRow = 0;
  let cols: Partial<Record<Field, number>> = {};
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const c = detectCarrierColumns(rows[i] ?? []);
    if (c.name !== undefined && Object.keys(c).length > Object.keys(cols).length) {
      headerRow = i;
      cols = c;
    }
  }
  if (cols.name === undefined) throw new Error("Δεν βρέθηκε στήλη με το όνομα της μεταφορικής (π.χ. «Επωνυμία» ή «Μεταφορική»).");
  const byName = new Map(existing.map((c) => [key(c.name), c]));
  const byMail = new Map(existing.flatMap((c) => c.emails.map((e) => [e.toLowerCase(), c] as const)));
  const get = (r: unknown[], f: Field) => (cols[f] === undefined ? undefined : r[cols[f]!]);
  const lines: ImportLine[] = [];
  const seen = new Set<string>();
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const name = txt(get(r, "name"));
    if (!name || norm(name).startsWith("παραδειγμα")) continue;
    const emails = emailsOf(get(r, "emails"));
    const ratingN = Number(String(get(r, "rating") ?? "").replace(/[^0-9.,]/g, "").replace(",", ".")) || (String(get(r, "rating") ?? "").match(/★/g)?.length ?? 0);
    const act = norm(get(r, "active"));
    const data: CarrierRow = {
      name,
      emails,
      contact: txt(get(r, "contact")),
      phone: txt(get(r, "phone")),
      modes: parseModes(get(r, "modes")),
      countries: parseCountries(get(r, "countries")),
      notes: txt(get(r, "notes")),
      rating: ratingN >= 1 && ratingN <= 5 ? Math.round(ratingN) : null,
      active: !/^(οχι|no|0|false|ανενεργ|inactive|x)$/.test(act),
    };
    const k = key(name);
    const match = byName.get(k) ?? emails.map((e) => byMail.get(e)).find(Boolean) ?? null;
    const line: ImportLine = { row: i + 1, data, match };
    if (seen.has(k)) line.error = "διπλή γραμμή στο αρχείο";
    else if (!emails.length && !match?.emails.length) line.error = "χωρίς email — δεν θα μπορεί να λάβει αιτήματα";
    seen.add(k);
    lines.push(line);
  }
  return { lines, cols, headerRow };
}

/** Ενημέρωση υπάρχουσας: κρατάμε ό,τι δεν δίνει το Excel, ενώνουμε email / τρόπους / χώρες. */
export function mergeCarrier(c: Carrier, d: CarrierRow) {
  return {
    name: d.name,
    emails: [...new Set([...c.emails, ...d.emails])],
    contact: d.contact ?? c.contact,
    phone: d.phone ?? c.phone,
    modes: d.modes.length ? [...new Set([...c.modes, ...d.modes])] : c.modes,
    countries: d.countries.length ? [...new Set([...c.countries, ...d.countries])] : c.countries,
    notes: d.notes ?? c.notes,
    rating: d.rating ?? c.rating,
    active: d.active,
  };
}

export const CARRIER_TEMPLATE = [
  ["Επωνυμία", "Email", "Υπεύθυνος", "Τηλέφωνο", "Τρόποι μεταφοράς", "Χώρες", "Αξιολόγηση (1-5)", "Ενεργή", "Σημειώσεις"],
  ["Παράδειγμα Μεταφορική ΑΕ", "export@example.com; pricing@example.com", "Γιάννης Π.", "2431000000", "Groupage, FTL", "DE, NL, BE", 4, "Ναι", "ADR ναι, ψυγείο όχι"],
];
