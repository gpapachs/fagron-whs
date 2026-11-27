// Λίστα πελατών για ετικέτες διεύθυνσης: ανάγνωση Excel (ελληνικές / αγγλικές επικεφαλίδες).
import type { CustomerLabel } from "@/lib/labels";

export type CustomerRow = CustomerLabel & { key: string; copies: number; on: boolean };
type Field = "name" | "address" | "city" | "zip" | "phone" | "country" | "copies" | "note" | "code";

const norm = (s: unknown) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\./g, "")
    .trim();

// σειρά = προτεραιότητα· η πρώτη στήλη που ταιριάζει κερδίζει
const RULES: [Field, RegExp][] = [
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
    out.push({
      kind: "customer",
      key: `x${i}`,
      name,
      address: get(r, "address"),
      city: get(r, "city"),
      zip: get(r, "zip").replace(/\.0$/, ""),
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
  ["Επωνυμία", "Διεύθυνση", "ΤΚ", "Πόλη", "Χώρα", "Τηλέφωνο", "Σημείωση", "Ετικέτες"],
  ["ΦΑΡΜΑΚΕΙΟ ΠΑΡΑΔΕΙΓΜΑ", "Ασκληπιού 10", "42100", "Τρίκαλα", "GR", "24310 12345", "", 1],
];
