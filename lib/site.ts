// Κεντρική / εξωτερική αποθήκη από τον κωδικό θέσης. Οι θέσεις της εξωτερικής (Μεγαλοχώρι,
// Herbs Μεγαλοχώρι, Νατσιόπουλος) ξεκινούν από 80, 90, 99 ή 100 και πάνω (101–106, 200).
export type Site = "central" | "external";
export type SiteFilter = "all" | Site;

export function siteOf(pos: string | null | undefined): Site | null {
  const p = (pos ?? "").trim();
  if (!p) return null;
  const n = Number(p.split(".")[0]);
  if (!Number.isFinite(n)) return "central"; // π.χ. G22
  return n === 80 || n === 90 || n === 99 || n >= 100 ? "external" : "central";
}

export const SITE_TXT: Record<Site, string> = { central: "Κεντρική", external: "Εξωτερική" };

/** Οι αποθήκες από τις οποίες γίνεται συλλογή, για μια σειρά θέσεων */
export function sitesOf(positions: (string | null | undefined)[]): Set<Site> {
  const s = new Set<Site>();
  for (const p of positions) {
    const x = siteOf(p);
    if (x) s.add(x);
  }
  return s;
}

export const matchSite = (f: SiteFilter, pos: string | null | undefined) => f === "all" || siteOf(pos) === f;
