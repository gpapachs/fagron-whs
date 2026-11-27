// Ανάλυση φορτίου σε γραμμές: τύπος παλέτας (προεπιλεγμένες διαστάσεις) ή δέμα, τεμάχια, Μ × Π × Υ, βάρος / τεμ.
export type CargoLine = { type: string; qty: string; l: string; w: string; h: string; kg: string; stack: boolean; note: string };

export const UNIT_TYPES: { key: string; gr: string; en: string; l?: number; w?: number; pallet: boolean }[] = [
  { key: "eur", gr: "Παλέτα EUR", en: "EUR pallet", l: 120, w: 80, pallet: true },
  { key: "ind", gr: "Παλέτα βιομηχανική", en: "Industrial pallet", l: 120, w: 100, pallet: true },
  { key: "half", gr: "Μισή παλέτα", en: "Half pallet", l: 80, w: 60, pallet: true },
  { key: "quarter", gr: "Τέταρτο παλέτας", en: "Quarter pallet", l: 60, w: 40, pallet: true },
  { key: "us", gr: "Παλέτα US", en: "US pallet", l: 122, w: 102, pallet: true },
  { key: "pallet", gr: "Παλέτα (άλλη)", en: "Pallet", pallet: true },
  { key: "box", gr: "Δέμα / κιβώτιο", en: "Package / box", pallet: false },
  { key: "drum", gr: "Βαρέλι / IBC", en: "Drum / IBC", pallet: false },
];
export const unitOf = (k: string) => UNIT_TYPES.find((u) => u.key === k) ?? UNIT_TYPES[0];
export const blankCargo = (type = "eur"): CargoLine => {
  const u = unitOf(type);
  return { type, qty: "1", l: u.l ? String(u.l) : "", w: u.w ? String(u.w) : "", h: "", kg: "", stack: false, note: "" };
};

export const num = (s: string | number | null | undefined) => {
  const t = String(s ?? "").trim().replace(/\s/g, "");
  if (!t) return 0;
  const x = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t) ? t.replace(/\./g, "").replace(",", ".") : t.replace(",", ".");
  const n = Number(x);
  return isFinite(n) ? n : 0;
};
const r2 = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const fm = (n: number, d = 2) => n.toLocaleString("el-GR", { maximumFractionDigits: d });

export function lineTotals(l: CargoLine) {
  const q = num(l.qty);
  const L = num(l.l),
    W = num(l.w),
    H = num(l.h);
  const vol = (L * W * H * q) / 1e6; // m³
  // μέτρα φόρτωσης (LDM): επιφάνεια / πλάτος φορτηγού 2,4 m — τα στοιβαζόμενα ανά 2
  const ldm = (L * W * q) / 10000 / 2.4 / (l.stack ? 2 : 1);
  return { q, kg: num(l.kg) * q, vol, ldm };
}

export function cargoTotals(lines: CargoLine[]) {
  let pallets = 0,
    packages = 0,
    kg = 0,
    vol = 0,
    ldm = 0;
  for (const l of lines) {
    const t = lineTotals(l);
    if (unitOf(l.type).pallet) pallets += t.q;
    else packages += t.q;
    kg += t.kg;
    vol += t.vol;
    ldm += t.ldm;
  }
  return { pallets, packages, kg: r2(kg), vol: r2(vol, 3), ldm: r2(ldm), stackable: lines.length ? lines.every((l) => l.stack) : null };
}

/** σύνοψη για email / φόρμα μεταφορικής: «2× EUR pallet 120×80×150 cm, 300 kg/pc · …» */
export function cargoSummary(lines: CargoLine[]) {
  return lines
    .filter((l) => num(l.qty))
    .map((l) => {
      const u = unitOf(l.type);
      const d = [l.l, l.w, l.h].filter((x) => num(x)).join("×");
      return `${num(l.qty)}× ${u.en}${d ? ` ${d} cm` : ""}${num(l.kg) ? `, ${fm(num(l.kg))} kg/pc` : ""}${l.stack ? ", stackable" : ""}${l.note ? ` (${l.note})` : ""}`;
    })
    .join(" · ");
}
