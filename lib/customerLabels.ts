// Λίστα πελατών για ετικέτες διεύθυνσης: ανάγνωση Excel (ελληνικές / αγγλικές επικεφαλίδες).
import type { CustomerLabel } from "@/lib/labels";

export type CustomerRow = CustomerLabel & { key: string; copies: number; on: boolean };
type Field = "name" | "org" | "address" | "city" | "zip" | "phone" | "country" | "copies" | "note" | "code" | "skip";

const norm = (s: unknown) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\./g, "")
    .trim();

// σειρά = προτεραιότητα· η πρώτη στήλη που ταιριάζει κερδίζει
const RULES: [Field, RegExp][] = [
  ["skip", /ειδικοτ|specialt|ιδιοτητ/],
  ["org", /institution|ιδρυμα|νοσοκομ|φορεας|hospital|clinic|κλινικ|οργανισμ/],
  ["phone", /τηλ|κινητ|phone|tel|mobile/],
  ["zip", /^τκ$|ταχ\w* κωδ|^tk$|zip|postal|postcode|^plz$/],
  ["city", /πολη|περιοχη|δημος|city|town/],
  ["country", /χωρα|country/],
  ["copies", /αντιτυπ|ετικετες|copies|labels|τεμ/],
  ["note", /σημειωσ|υποψη|attn|note|σχολ/],
  ["code", /κωδικ|code|^id$/],
  ["address", /διευθυνσ|οδος|address|street|addr/],
  ["name", /επωνυμ|ονομα|πελατ|name|customer|φαρμακειο|company|εταιρ/],
];

export function detectCustomerColumns(header: unknown[]) {
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

export function readCustomers(rows: unknown[][]): CustomerRow[] {
  let headerRow = -1;
  let cols: Partial<Record<Field, number>> = {};
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const c = detectCustomerColumns(rows[i] ?? []);
    if (c.name !== undefined && Object.keys(c).length > Object.keys(cols).length) {
      headerRow = i;
      cols = c;
    }
  }
  if (headerRow < 0) throw new Error("Δεν βρέθηκε στήλη με το όνομα του πελάτη (π.χ. «Επωνυμία» ή «Πελάτης»).");
  const get = (r: unknown[], f: Field) => (cols[f] === undefined ? "" : String(r[cols[f]!] ?? "").replace(/\s+/g, " ").trim());
  const out: CustomerRow[] = [];
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const name = get(r, "name");
    if (!name) continue;
    const n = Number(get(r, "copies").replace(",", "."));
    let address = get(r, "address");
    let zip = get(r, "zip").replace(/\.0$/, "");
    // ΤΚ μέσα στη διεύθυνση (π.χ. «ΧΡΥΣΟΧΟΟΥ 1, 41221», «… 185,35», «… 2,55133,ΚΑΛΑΜΑΡΙΑ»)
    if (!zip) {
      const ms = [...address.matchAll(/(^|[\s,])(?:(?:Τ\.?\s?Κ|T\.?\s?K)\.?\s*:?\s*)?(\d{3})[\s,]?(\d{2})(?=\s*(?:,|$))/gi)];
      const m = ms[ms.length - 1];
      if (m) {
        zip = m[2] + m[3];
        address = (address.slice(0, m.index! + m[1].length) + address.slice(m.index! + m[0].length)).replace(/\s*,\s*,\s*/g, ", ").replace(/[\s,]+$/, "").replace(/^[\s,]+/, "").replace(/\s*,\s*/g, ", ").replace(/\s{2,}/g, " ");
      }
    }
    const org = get(r, "org");
    out.push({
      kind: "customer",
      key: `x${i}`,
      name,
      org: /^(ιδιωτης|ιδιώτης|-|—)$/i.test(org) ? "" : org,
      address,
      // ομαδοποιήσεις τύπου «ΑΘΗΝΑ - ΠΡΟΑΣΤΙΑ» -> «ΑΘΗΝΑ»
      city: get(r, "city").replace(/\s*-\s*(ΠΡΟΑΣΤΙΑ|προάστια|προαστια)\s*$/i, ""),
      zip,
      country: get(r, "country"),
      phone: get(r, "phone").replace(/\.0$/, ""),
      note: get(r, "note"),
      copies: Number.isFinite(n) && n >= 1 ? Math.min(500, Math.round(n)) : 1,
      on: true,
    });
  }
  return out;
}

export const CUSTOMER_TEMPLATE = [
  ["Επωνυμία", "Φορέας / Νοσοκομείο", "Διεύθυνση", "ΤΚ", "Πόλη", "Χώρα", "Τηλέφωνο", "Σημείωση", "Ετικέτες"],
  ["ΦΑΡΜΑΚΕΙΟ ΠΑΡΑΔΕΙΓΜΑ", "", "Ασκληπιού 10", "42100", "Τρίκαλα", "GR", "24310 12345", "", 1],
];
