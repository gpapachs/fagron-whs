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
  /** ποσότητα ανά τεμάχιο, π.χ. «5 g», «1 L», «25 kg» */
  pack?: string;
  weight: string;
  msds?: { name: string; number: string; lang: string; url: string; docId?: string } | null;
  alts?: { name: string; number: string; links: Record<string, string> }[];
  /** από την ενότητα 14 του MSDS: false = «not regulated» (όχι ADR) */
  regulated?: boolean | null;
  psn?: string;
  auto?: boolean; // UN / κλάση / PG συμπληρώθηκαν από το MSDS
  status?: "found" | "none" | "error" | "attached";
};
type Field = "code" | "name" | "cas" | "un" | "cls" | "pg" | "qty" | "pack" | "weight";

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
  ["pack", /συσκευασ|ανα τεμ|ανα τμχ|περιεκτ|μεγεθος|pack|size|per (unit|piece|pc)/],
  ["weight", /βαρος|weight|\bkg\b|κιλα|συνολ/],
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
    out.push({ key: `${i}`, code, name, cas, un, cls: get(r, "cls"), pg: get(r, "pg").toUpperCase(), qty: get(r, "qty"), pack: get(r, "pack"), weight: get(r, "weight") });
  }
  return out;
}

/** Επικόλληση: μία γραμμή ανά είδος («όνομα; CAS; UN» ή ελεύθερο κείμενο) */
export function parseHazardText(t: string): Hazard[] {
  return readHazards(t.split(/\r?\n/).filter((l) => l.trim()).map((l) => [l]));
}

/** αγγλικό MSDS για ανάγνωση της ενότητας 14 */
export function englishUrl(links: Record<string, string> | undefined) {
  if (!links) return "";
  for (const l of ["GB", "UL", "USA", "US", "AUS"]) if (links[l]) return links[l];
  return "";
}

/** Προτίμηση γλώσσας MSDS: αγγλικά (GB, μετά UL / USA / AUS), μετά ελληνικά */
export const LANG_PREF = ["GB", "UL", "USA", "US", "AUS", "GR"];
export function pickLang(links: Record<string, string>, want = "GB") {
  for (const l of [want, ...LANG_PREF]) if (links[l]) return l;
  return Object.keys(links)[0] ?? "";
}

export const adrText = (h: Hazard) => [h.un ? `UN${h.un}` : "", h.cls ? `cl.${h.cls}` : "", h.pg ? `PG ${h.pg}` : ""].filter(Boolean).join(" ");

const n = (t: string) => {
  const x = t.trim().replace(/\s/g, "");
  const v = Number(/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(x) ? x.replace(/\./g, "").replace(",", ".") : x.replace(",", "."));
  return isFinite(v) ? v : NaN;
};
/** «5g», «5 gr», «1,5 kg», «250ml», «1 L», «500 mg» -> σε kg ή L */
export function parsePack(s: string | undefined): { v: number; unit: "kg" | "L" } | null {
  const m = String(s ?? "").match(/([\d.,]+)\s*(kgr?|κιλ\S*|γρ\S*|λιτ\S*|mg|ml|cl|gr?|lt?)(?![a-z])/i);
  if (!m) return null;
  const v = n(m[1]);
  if (!isFinite(v)) return null;
  const u = m[2].toLowerCase();
  if (u === "mg") return { v: v / 1e6, unit: "kg" };
  if (u === "g" || u === "gr" || u.startsWith("γρ")) return { v: v / 1000, unit: "kg" };
  if (u.startsWith("kg") || u.startsWith("κιλ")) return { v, unit: "kg" };
  if (u === "ml") return { v: v / 1000, unit: "L" };
  if (u === "cl") return { v: v / 100, unit: "L" };
  return { v, unit: "L" };
}
const fmt = (v: number) => v.toLocaleString("el-GR", { maximumFractionDigits: v < 1 ? 4 : 3 });
/** συνολική ποσότητα: τμχ × ποσότητα ανά τμχ (π.χ. 5 × 5 g = 0,025 kg) */
export function hazardTotal(h: Pick<Hazard, "qty" | "pack" | "weight">): { v: number; unit: "kg" | "L"; text: string } | null {
  const p = parsePack(h.pack);
  const q = n(h.qty || "1");
  if (p && isFinite(q)) {
    const v = Math.round(p.v * q * 1e6) / 1e6;
    return { v, unit: p.unit, text: `${fmt(v)} ${p.unit}` };
  }
  const w = n(h.weight || "");
  return h.weight && isFinite(w) ? { v: w, unit: "kg", text: `${fmt(w)} kg` } : null;
}
