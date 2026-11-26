// Loading manifest (Δελτίο φόρτωσης) σε PDF — δίγλωσσο, για τον οδηγό / τη μεταφορική.
import { MODES, type Carrier, type Manifest, type ManifestLine, type Quote, type Rfq } from "@/lib/logistics";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type Fonts = { regular: string; bold: string };
const F = "DejaVu";
const INK: [number, number, number] = [17, 24, 39];
const DIM: [number, number, number] = [100, 116, 139];
const ACCENT: [number, number, number] = [20, 33, 61];
const LINE: [number, number, number] = [203, 213, 225];
const caps = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
const dmy = (s: string | null | undefined) => (s ? s.slice(0, 10).split("-").reverse().join("/") : "");
const numOf = (s: string) => {
  const t = (s ?? "").trim().replace(/\s/g, "");
  if (!t) return null;
  const x = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t) ? t.replace(/\./g, "").replace(",", ".") : t.replace(",", ".");
  const n = Number(x);
  return isFinite(n) ? n : null;
};
const fmt = (n: number | null, d = 2) => (n == null ? "" : n.toLocaleString("el-GR", { maximumFractionDigits: d }));

/** Αρχικές γραμμές από το αίτημα */
export function manifestFromRfq(r: Rfq): Manifest {
  if (r.manifest?.lines?.length) return { ...r.manifest, docs: r.manifest.docs ?? [] };
  const line: ManifestLine = {
    desc: r.goods ?? "",
    pallets: r.pallets != null ? String(r.pallets) : "",
    packages: r.packages != null ? String(r.packages) : "",
    weight: r.weight_kg != null ? String(r.weight_kg).replace(".", ",") : "",
    dims: r.dims ?? "",
    adr: r.adr ? r.adr_info || "ADR" : "",
    notes: "",
  };
  return { lines: [line], plate: "", driver: "", loading_time: "", instructions: r.notes ?? "", docs: [] };
}

export function manifestTotals(m: Manifest) {
  const sum = (k: keyof ManifestLine) => m.lines.reduce((t, l) => t + (numOf(l[k]) ?? 0), 0);
  return { pallets: sum("pallets"), packages: sum("packages"), weight: sum("weight") };
}

export function manifestPdf(jsPDF: Any, autoTable: (d: Any, o: Any) => void, fonts: Fonts, r: Rfq, carrier: Carrier | null, q: Quote | null, m: Manifest, by: string) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
  doc.addFileToVFS("DejaVu.ttf", fonts.regular);
  doc.addFont("DejaVu.ttf", F, "normal");
  doc.addFileToVFS("DejaVu-Bold.ttf", fonts.bold);
  doc.addFont("DejaVu-Bold.ttf", F, "bold");
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const L = 14;
  const R = W - 14;

  // κεφαλίδα
  doc.setFillColor(...ACCENT);
  doc.rect(L, 12, 3, 14, "F");
  doc.setFont(F, "bold");
  doc.setFontSize(18);
  doc.setTextColor(...INK);
  doc.text("LOADING MANIFEST", L + 6, 19);
  doc.setFont(F, "normal");
  doc.setFontSize(10);
  doc.setTextColor(...DIM);
  doc.text("Δελτίο φόρτωσης · Fagron Hellas — Logistics", L + 6, 25);
  doc.setFont(F, "bold");
  doc.setFontSize(13);
  doc.setTextColor(...INK);
  doc.text(r.ref, R, 19, { align: "right" });
  doc.setFont(F, "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...DIM);
  const issued = new Date().toLocaleString("el-GR", { timeZone: "Europe/Athens", dateStyle: "short", timeStyle: "short" });
  doc.text(`Έκδοση / Issued: ${issued}`, R, 25, { align: "right" });

  // πλαίσια: αποστολέας / παραλήπτης
  const box = (x: number, y: number, w: number, h: number, title: string, lines: string[]) => {
    doc.setDrawColor(...LINE);
    doc.setLineWidth(0.3);
    doc.roundedRect(x, y, w, h, 1.5, 1.5, "S");
    doc.setFont(F, "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(...DIM);
    doc.text(caps(title), x + 3, y + 5);
    doc.setFont(F, "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(...INK);
    let yy = y + 10;
    lines.filter(Boolean).forEach((t, i) => {
      if (i === 0) doc.setFont(F, "bold");
      const wrapped = doc.splitTextToSize(t, w - 6);
      doc.text(wrapped, x + 3, yy);
      yy += 4.4 * wrapped.length;
      if (i === 0) doc.setFont(F, "normal");
    });
  };
  const side = (s: "from" | "to") => {
    const g = (k: string) => ((r as unknown as Record<string, string | null>)[`${s}_${k}`] ?? "") as string;
    return [g("company"), g("address"), [g("zip"), g("city")].filter(Boolean).join(" "), g("country")];
  };
  const half = (R - L - 4) / 2;
  let y = 32;
  box(L, y, half, 30, "Φόρτωση / Shipper — pick-up", side("from"));
  box(L + half + 4, y, half, 30, "Παράδοση / Consignee — delivery", side("to"));
  y += 34;
  const mode = MODES.find((x) => x.key === r.mode);
  box(L, y, half, 30, "Μεταφορική / Carrier", [
    carrier?.name ?? "",
    [carrier?.contact, carrier?.phone].filter(Boolean).join(" · "),
    r.carrier_ref ? `Αρ. / Ref: ${r.carrier_ref}` : "",
    [m.plate ? `Όχημα / Truck: ${m.plate}` : "", m.driver ? `Οδηγός / Driver: ${m.driver}` : ""].filter(Boolean).join(" · "),
  ]);
  box(L + half + 4, y, half, 30, "Μεταφορά / Transport", [
    `${dmy(r.pickup_date) || "—"}${m.loading_time ? ` · ${m.loading_time}` : ""}  (φόρτωση / loading)`,
    r.delivery_by ? `Παράδοση έως / Deliver by: ${dmy(r.delivery_by)}` : "",
    [mode ? mode.en : r.mode, r.incoterm ? `Incoterm ${r.incoterm}` : ""].filter(Boolean).join(" · "),
    [r.order_ref ? `PO / Order: ${r.order_ref}` : "", q?.transit_days ? `Transit ${fmt(q.transit_days, 1)} d` : ""].filter(Boolean).join(" · "),
  ]);
  y += 36;

  // γραμμές φορτίου
  const t = manifestTotals(m);
  autoTable(doc, {
    startY: y,
    margin: { left: L, right: 14, bottom: 20 },
    styles: { font: F, fontSize: 9, textColor: INK, cellPadding: 2, lineColor: LINE, lineWidth: 0.15, valign: "top" },
    headStyles: { font: F, fontStyle: "bold", fillColor: [241, 245, 249], textColor: [51, 65, 85], fontSize: 7.5 },
    footStyles: { font: F, fontStyle: "bold", fillColor: [241, 245, 249], textColor: INK },
    head: [["#", "Περιγραφή / Description", "Παλέτες\nPallets", "Δέματα\nPackages", "Μικτό kg\nGross kg", "Διαστάσεις\nDimensions", "ADR (UN / class)", "Σημ. / Notes"]],
    body: m.lines.map((l, i) => [String(i + 1), l.desc, l.pallets, l.packages, fmt(numOf(l.weight)), l.dims, l.adr, l.notes]),
    foot: [["", "Σύνολο / Total", fmt(t.pallets, 0), fmt(t.packages, 0), fmt(t.weight), "", "", ""]],
    columnStyles: { 0: { cellWidth: 7 }, 2: { halign: "right", cellWidth: 16 }, 3: { halign: "right", cellWidth: 19 }, 4: { halign: "right", cellWidth: 20 }, 5: { cellWidth: 26 }, 6: { cellWidth: 24 } },
  });
  y = doc.lastAutoTable.finalY + 6;

  // ειδικές οδηγίες
  const specs = [
    r.temp ? `Θερμοκρασία / Temperature: ${r.temp}` : "",
    r.stackable == null ? "" : `Στοιβαζόμενο / Stackable: ${r.stackable ? "Ναι / Yes" : "ΟΧΙ / NO"}`,
    r.adr ? `ADR: ${r.adr_info || "Ναι / Yes"}` : "",
    r.volume_m3 ? `Όγκος / Volume: ${fmt(r.volume_m3, 3)} m³` : "",
    r.ldm ? `LDM: ${fmt(r.ldm)}` : "",
  ].filter(Boolean);
  const block = (title: string, text: string[]) => {
    if (!text.length) return;
    if (y > H - 60) {
      doc.addPage();
      y = 20;
    }
    doc.setFont(F, "bold");
    doc.setFontSize(9);
    doc.setTextColor(...INK);
    doc.text(title, L, y);
    y += 4.5;
    doc.setFont(F, "normal");
    doc.setFontSize(9);
    for (const s of text) {
      const w = doc.splitTextToSize(s, R - L);
      doc.text(w, L, y);
      y += 4.4 * w.length;
    }
    y += 3;
  };
  block("Ειδικές απαιτήσεις / Special requirements", specs);
  block("Οδηγίες φόρτωσης / Loading instructions", m.instructions ? m.instructions.split(/\n+/) : []);
  if (m.docs.length) {
    // κουτάκια ελέγχου (η γραμματοσειρά δεν έχει ☐)
    if (y > H - 60) {
      doc.addPage();
      y = 20;
    }
    doc.setFont(F, "bold");
    doc.setFontSize(9);
    doc.setTextColor(...INK);
    doc.text("Συνοδευτικά έγγραφα / Accompanying documents", L, y);
    y += 5;
    doc.setFont(F, "normal");
    doc.setDrawColor(...DIM);
    for (const d of m.docs) {
      doc.rect(L, y - 3, 3.2, 3.2, "S");
      doc.text(d, L + 5.5, y);
      y += 5;
    }
    y += 2;
  }

  // υπογραφές
  if (y > H - 48) {
    doc.addPage();
    y = 20;
  }
  y = Math.max(y + 4, H - 52);
  const third = (R - L - 8) / 3;
  ["Αποστολέας / Shipper", "Οδηγός / Driver", "Παραλήπτης / Consignee"].forEach((s, i) => {
    const x = L + i * (third + 4);
    doc.setDrawColor(...LINE);
    doc.roundedRect(x, y, third, 34, 1.5, 1.5, "S");
    doc.setFont(F, "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(...DIM);
    doc.text(caps(s), x + 3, y + 5);
    doc.setFont(F, "normal");
    doc.text("Ονοματεπώνυμο / Name", x + 3, y + 14);
    doc.text("Ημ/νία & ώρα / Date & time", x + 3, y + 22);
    doc.text("Υπογραφή - σφραγίδα / Signature - stamp", x + 3, y + 30);
  });

  // υποσέλιδο
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(7.5);
    doc.setTextColor(...DIM);
    doc.text(`Fagron Hellas · ${r.ref} · ${by}`, L, H - 8);
    doc.text(`${i} / ${pages}`, R, H - 8, { align: "right" });
  }
  return { doc, fileName: `loading-manifest-${r.ref}.pdf` };
}
