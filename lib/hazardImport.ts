// Λίστα επικίνδυνων ειδών από Excel: αναγνώριση στηλών (ελληνικά / αγγλικά), CAS / UN / κλάση.
export type Hazard = {
  key: string;
  code: string;
  name: string;
  cas: string;
  un: string;
  cls: string;
  pg: string;
  qty: string;
  weight: string;
  msds?: { name: string; number: string; lang: string; url: string; docId?: string } | null;
  alts?: { name: string; number: string; links: Record<string, string> }[];
  status?: "found" | "none" | "error" | "attached";
};
type Field = "code" | "name" | "cas" | "un" | "cls" | "pg" | "qty" | "weight";

const norm = (s: unknown) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

const RULES: [Field, RegExp][] = [
  ["cas", /\bcas\b/],
  ["un", /^un\b|un ?(no|number|αρ)|αριθμος un|^un$/],
  ["pg", /packing ?group|ομαδα συσκευασ|^pg$|\bpg\b/],
  ["cls", /κλαση|class|κατηγορια κινδυν|hazard class/],
  ["weight", /βαρος|weight|\bkg\b|κιλα/],
  ["qty", /ποσοτ|qty|quantity|τεμ|pcs|τμχ/],
  ["code", /κωδικ|code|item|article|sku|ειδος$/],
  ["name", /περιγραφ|description|ονομα|name|προιον|product|ουσια|substance|ειδος/],
];

export function detectHazardColumns(header: unknown[]) {
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

const CAS_RE = /\b(\d{2,7}-\d{2}-\d)\b/;
const UN_RE = /\bUN\s?(\d{4})\b/i;

/** rows: 1η γραμμή (ή μία από τις 10 πρώτες) επικεφαλίδες. Χωρίς επικεφαλίδες: 1η στήλη = όνομα, CAS / UN από το κείμενο. */
export function readHazards(rows: unknown[][]): Hazard[] {
  let headerRow = -1;
  let cols: Partial<Record<Field, number>> = {};
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const c = detectHazardColumns(rows[i] ?? []);
    if ((c.name !== undefined || c.code !== undefined || c.cas !== undefined) && Object.keys(c).length > Object.keys(cols).length) {
      headerRow = i;
      cols = c;
    }
  }
  const get = (r: unknown[], f: Field) => (cols[f] === undefined ? "" : String(r[cols[f]!] ?? "").trim());
  const out: Hazard[] = [];
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const all = r.map((x) => String(x ?? "")).join(" ");
    let name = headerRow < 0 ? String(r[0] ?? "").trim() : get(r, "name");
    const code = get(r, "code");
    let cas = get(r, "cas") || all.match(CAS_RE)?.[1] || "";
    cas = cas.match(CAS_RE)?.[1] ?? "";
    let un = get(r, "un") || all.match(UN_RE)?.[0] || "";
    un = un.replace(/[^0-9]/g, "").slice(0, 4);
    // ελεύθερο κείμενο: κομμάτια χωρισμένα με ; | tab — κρατάμε όσα δεν είναι CAS / UN
    if (headerRow < 0)
      name = name
        .split(/[;|\t]/)
        .map((x) => x.replace(CAS_RE, "").replace(UN_RE, "").trim())
        .filter(Boolean)
        .join(" ");
    if (!name && !code && !cas) continue;
    out.push({ key: `${i}`, code, name, cas, un, cls: get(r, "cls"), pg: get(r, "pg").toUpperCase(), qty: get(r, "qty"), weight: get(r, "weight") });
  }
  return out;
}

/** Επικόλληση: μία γραμμή ανά είδος («όνομα; CAS; UN» ή ελεύθερο κείμενο) */
export function parseHazardText(t: string): Hazard[] {
  return readHazards(t.split(/\r?\n/).filter((l) => l.trim()).map((l) => [l]));
}

/** Προτίμηση γλώσσας MSDS: ελληνικά, μετά αγγλικά */
export const LANG_PREF = ["GR", "GB", "UL", "USA", "AUS"];
export function pickLang(links: Record<string, string>, want = "GR") {
  for (const l of [want, ...LANG_PREF]) if (links[l]) return l;
  return Object.keys(links)[0] ?? "";
}

export const adrText = (h: Hazard) => [h.un ? `UN${h.un}` : "", h.cls ? `cl.${h.cls}` : "", h.pg ? `PG ${h.pg}` : ""].filter(Boolean).join(" ");
