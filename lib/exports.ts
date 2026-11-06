// Εξαγωγές Ανασυσκευασίας: Excel (SheetJS) και PDF (jsPDF + autotable).
//
// Οι βιβλιοθήκες περνούν ως παράμετροι (δεν γίνεται import εδώ), ώστε:
//  - στον browser να φορτώνονται μόνο όταν πατηθεί το κουμπί
//  - το scripts/check-exports.mjs να τρέχει τα ίδια ακριβώς functions στο CI
// Μόνο `import type` από άλλα αρχεία -- τίποτα σε runtime.

import type { ComponentNeed, PickLine, ProductSettings, RecipeAnalysis, RecipePick, StockIndex } from "./repack";
import type { Job, JobStats } from "./jobs";
import type { OrderEval } from "./sales";

// όπως lib/users.ts (χωρίς import σε runtime): «alex@whs.local» → «alex»
const displayUser = (e: string) => e.replace(/@whs\.local$/i, "");

const q = (n: number) => n.toLocaleString("el-GR", { maximumFractionDigits: 3 });
const exp = (iso?: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}` : "");
/** «Π. 823600 · λ. 22/05/36» */
const lotTxt = (lot?: string, expiry?: string | null) =>
  [lot ? `Π. ${lot}` : "", expiry ? `λ. ${exp(expiry)}` : ""].filter(Boolean).join(" · ");
const stamp = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const when = (d: Date) =>
  d.toLocaleString("el-GR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export type ExportMeta = {
  generatedAt: Date;
  userEmail: string | null;
  stockFile: string | null;
  stockUploadedAt: string | null;
  excludedAreas: string[];
};

// ===================================================================== data

export type AvailableRow = {
  recipeId: string;
  productCode: string;
  description: string;
  max: number;
  limiting: string;
  sharedWith: string;
  planned: number;
};

export type AvailableComponentRow = {
  recipeId: string;
  description: string;
  max: number;
  component: string;
  componentDescription: string;
  perUnit: number;
  unit: string;
  totalStock: number;
  isLimiting: boolean;
  positions: { position: string; area: string; qty: number; lot: string; expiry: string | null }[];
};

export function availableData(analyses: RecipeAnalysis[], stockIdx: StockIndex) {
  const feasible = analyses
    .filter((a) => a.max > 0)
    .sort((a, b) => a.recipe.id.localeCompare(b.recipe.id, "el", { numeric: true }));

  const rows: AvailableRow[] = feasible.map((a) => ({
    recipeId: a.recipe.id,
    productCode: a.recipe.product_code,
    description: a.recipe.description,
    max: a.max,
    limiting: a.limiting ?? "",
    sharedWith: [...new Set(a.sharedWith.flatMap((s) => s.recipes))].join(", "),
    planned: a.planned,
  }));

  const components: AvailableComponentRow[] = feasible.flatMap((a) =>
    a.recipe.components.map((c) => {
      const e = stockIdx.get(c.code);
      return {
        recipeId: a.recipe.id,
        description: a.recipe.description,
        max: a.max,
        component: c.code,
        componentDescription: e?.description || c.description,
        perUnit: c.qty,
        unit: c.unit,
        totalStock: e?.total ?? 0,
        isLimiting: c.code === a.limiting,
        positions: (e?.rows ?? [])
          .map((r) => ({ position: r.position, area: r.area, qty: r.qty, lot: r.lot ?? "", expiry: r.expiry ?? null }))
          .sort((x, y) => y.qty - x.qty),
      };
    })
  );
  return { rows, components };
}

// ==================================================================== Excel

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type XLSXLib = any;

function sheet(XLSX: XLSXLib, rows: Record<string, unknown>[], widths: number[]) {
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = widths.map((wch) => ({ wch }));
  if (ws["!ref"]) ws["!autofilter"] = { ref: ws["!ref"] };
  return ws;
}

/** Excel με όλες τις ανασυσκευασίες που μπορούν να γίνουν τώρα. */
export function availableWorkbook(
  XLSX: XLSXLib,
  analyses: RecipeAnalysis[],
  stockIdx: StockIndex,
  meta: ExportMeta,
  settings: Record<string, ProductSettings> = {}
) {
  const { rows, components } = availableData(analyses, stockIdx);
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      XLSX,
      rows.map((r) => ({
        "Κωδικός": r.recipeId,
        "Κωδικός τελικού": r.productCode,
        "Περιγραφή": r.description,
        "Μέγιστο (τεμ.)": r.max,
        "Περιοριστικό συστατικό": r.limiting,
        "Κοινό συστατικό με": r.sharedWith,
        "Στο πλάνο": r.planned || "",
        "Τμχ/συσκ.": settings[r.productCode]?.units_per_package ?? "",
        "Μέγιστο (συσκ.)": settings[r.productCode]?.units_per_package ? Math.floor(r.max / (settings[r.productCode].units_per_package as number)) : "",
        "Απόθεμα τελικού": stockIdx.get(r.productCode)?.total ?? 0,
        "Δεσμευμένα": settings[r.productCode]?.reserved || "",
        "Λείπουν για παραγγελίες": Math.max(0, (settings[r.productCode]?.reserved ?? 0) - (stockIdx.get(r.productCode)?.total ?? 0)) || "",
      })),
      [16, 14, 50, 13, 20, 30, 10, 10, 13, 14, 12, 18]
    ),
    "Διαθέσιμες"
  );

  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      XLSX,
      components.flatMap((c) =>
        (c.positions.length ? c.positions : [{ position: "", area: "", qty: 0, lot: "", expiry: null }]).map((p, i) => ({
          "Κωδικός": c.recipeId,
          "Περιγραφή": c.description,
          "Μέγιστο": c.max,
          "Συστατικό": c.component,
          "Περιγραφή συστατικού": c.componentDescription,
          "Ανά τεμ.": c.perUnit,
          "ΜΜ": c.unit,
          "Σύνολο αποθέματος": i === 0 ? c.totalStock : "",
          "Περιορίζει": c.isLimiting && i === 0 ? "ΝΑΙ" : "",
          "Θέση": p.position,
          "Περιοχή": p.area,
          "Παρτίδα": p.lot,
          "Λήξη": p.expiry ? new Date(p.expiry) : "",
          "Ποσότητα θέσης": p.position ? p.qty : "",
        }))
      ),
      [16, 44, 9, 14, 44, 9, 6, 12, 10, 16, 26, 14, 11, 12]
    ),
    "Συστατικά & θέσεις"
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Διαθέσιμες ανασυσκευασίες"],
      ["Δημιουργήθηκε", when(meta.generatedAt)],
      ["Από", meta.userEmail ?? ""],
      ["Αρχείο αποθέματος", meta.stockFile ?? ""],
      ["Ανέβηκε", meta.stockUploadedAt ? when(new Date(meta.stockUploadedAt)) : ""],
      ["Εξαιρούμενες περιοχές", meta.excludedAreas.join(", ") || "—"],
      ["Κωδικοί που βγαίνουν", rows.length],
    ]),
    "Πληροφορίες"
  );
  return { wb, fileName: `diathesimes-anasyskevasies-${stamp(meta.generatedAt)}.xlsx`, count: rows.length };
}

/** Excel του τρέχοντος πλάνου: πλάνο, συστατικά, συλλογή. */
export function planWorkbook(
  XLSX: XLSXLib,
  planned: RecipeAnalysis[],
  needs: ComponentNeed[],
  picks: PickLine[],
  meta: ExportMeta
) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      XLSX,
      planned.map((a) => ({
        "Κωδικός": a.recipe.id,
        "Κωδικός τελικού": a.recipe.product_code,
        "Περιγραφή": a.recipe.description,
        "Ποσότητα": a.planned,
      })),
      [16, 14, 50, 10]
    ),
    "Πλάνο"
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      XLSX,
      needs.map((n) => ({
        "Συστατικό": n.code,
        "Περιγραφή": n.description,
        "Απαιτείται": n.required,
        "Διαθέσιμο": n.available,
        "Λείπει": n.shortage || "",
        "ΜΜ": n.unit,
      })),
      [14, 50, 11, 11, 9, 6]
    ),
    "Συστατικά"
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      XLSX,
      picks.map((p) => ({
        "Θέση": p.position,
        "Περιοχή": p.area,
        "Κωδικός": p.item,
        "Περιγραφή": p.description,
        "Παρτίδα": p.lot,
        "Λήξη": p.expiry ? new Date(p.expiry) : "",
        "Πάρε": p.take,
        "Στη θέση": p.inPosition,
        "ΜΜ": p.unit,
        "Αδειάζει": p.take >= p.inPosition ? "ΝΑΙ" : "",
      })),
      [16, 26, 14, 50, 14, 11, 9, 9, 6, 9]
    ),
    "Συλλογή"
  );
  return { wb, fileName: `plano-anasyskevasias-${stamp(meta.generatedAt)}.xlsx` };
}

// ====================================================================== PDF

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsPDFCtor = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AutoTableFn = (doc: any, options: any) => void;

export type PdfFonts = { regular: string; bold: string }; // base64 TTF

const FONT = "DejaVu";
const INK: [number, number, number] = [17, 24, 39];
const DIM: [number, number, number] = [100, 116, 139];
const ACCENT: [number, number, number] = [20, 33, 61];
const RACK: [number, number, number] = [255, 204, 0];
const LINE: [number, number, number] = [226, 232, 240];
const ZEBRA: [number, number, number] = [248, 250, 252];
const RED: [number, number, number] = [185, 28, 28];
const RED_BG: [number, number, number] = [254, 242, 242];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function newDoc(jsPDF: JsPDFCtor, fonts: PdfFonts, orientation: "portrait" | "landscape"): any {
  const doc = new jsPDF({ orientation, unit: "mm", format: "a4", compress: true });
  doc.addFileToVFS("DejaVu.ttf", fonts.regular);
  doc.addFont("DejaVu.ttf", FONT, "normal");
  doc.addFileToVFS("DejaVu-Bold.ttf", fonts.bold);
  doc.addFont("DejaVu-Bold.ttf", FONT, "bold");
  doc.setFont(FONT, "normal");
  return doc;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function header(doc: any, title: string, lines: string[], subtitle = "Fagron Hellas · Ανασυσκευασία"): number {
  const w = doc.internal.pageSize.getWidth();
  doc.setFillColor(...ACCENT);
  doc.rect(14, 12, 3, 12, "F");
  doc.setFont(FONT, "bold");
  doc.setFontSize(17);
  doc.setTextColor(...INK);
  doc.text(title, 20, 19);
  doc.setFont(FONT, "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...DIM);
  doc.text(subtitle, 20, 24);
  let y = 31;
  doc.setFontSize(9);
  for (const l of lines) {
    doc.text(l, 14, y, { maxWidth: w - 28 });
    y += 4.6;
  }
  doc.setDrawColor(...LINE);
  doc.line(14, y, w - 14, y);
  return y + 5;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function footer(doc: any, label: string) {
  const pages = doc.getNumberOfPages();
  const w = doc.internal.pageSize.getWidth();
  const h = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont(FONT, "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...DIM);
    doc.text(label, 14, h - 8);
    doc.text(`Σελίδα ${i} / ${pages}`, w - 14, h - 8, { align: "right" });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sectionTitle(doc: any, text: string, y: number) {
  doc.setFont(FONT, "bold");
  doc.setFontSize(11);
  doc.setTextColor(...INK);
  doc.text(text, 14, y);
  return y + 3;
}

const baseTable = {
  margin: { left: 14, right: 14, bottom: 16 },
  styles: { font: FONT, fontSize: 8.5, textColor: INK, cellPadding: 1.8, lineColor: LINE, lineWidth: 0.1, valign: "top" },
  headStyles: { font: FONT, fontStyle: "bold", fillColor: [241, 245, 249], textColor: [51, 65, 85], fontSize: 7.5 },
};

function metaLines(meta: ExportMeta) {
  const lines = [
    `Δημιουργήθηκε: ${when(meta.generatedAt)}${meta.userEmail ? ` · ${displayUser(meta.userEmail)}` : ""}`,
    `Απόθεμα: ${meta.stockFile ?? "—"}${meta.stockUploadedAt ? ` (ανέβηκε ${when(new Date(meta.stockUploadedAt))})` : ""}`,
  ];
  if (meta.excludedAreas.length) lines.push(`Χωρίς τις περιοχές: ${meta.excludedAreas.join(", ")}`);
  return lines;
}

/** PDF λίστας συλλογής: πλάνο + από ποια θέση παίρνεις πόσο, με κουτάκι ✓. */
export function picklistPdf(
  jsPDF: JsPDFCtor,
  autoTable: AutoTableFn,
  fonts: PdfFonts,
  planned: RecipeAnalysis[],
  needs: ComponentNeed[],
  picks: PickLine[],
  meta: ExportMeta,
  extra: {
    /** από picksByRecipe(): ανά τελικό -> συστατικά -> θέσεις */
    byRecipe: RecipePick[];
    /** εκτιμώμενα δευτερόλεπτα ανά κωδικό πλάνου (αν υπάρχει ιστορικό χρόνων) */
    estimateSec?: Map<string, number>;
    fmtDuration?: (sec: number) => string;
  }
) {
  const doc = newDoc(jsPDF, fonts, "portrait");
  const est = extra.estimateSec;
  const fd = extra.fmtDuration ?? ((s: number) => `${Math.round(s / 60)} λεπτά`);
  const totalSec = est ? [...est.values()].reduce((a, b) => a + b, 0) : 0;
  let y = header(doc, "Λίστα συλλογής", [
    ...metaLines(meta),
    ...(est && est.size ? [`Εκτιμώμενος χρόνος: ${fd(totalSec)}${est.size < planned.length ? ` (για ${est.size} από ${planned.length} κωδικούς με ιστορικό χρόνων)` : ""}`] : []),
  ]);

  // ---- σύνοψη πλάνου
  y = sectionTitle(doc, "Πλάνο ανασυσκευασίας", y);
  autoTable(doc, {
    ...baseTable,
    startY: y,
    head: [["Κωδικός", "Περιγραφή", "Ποσότητα", ...(est ? ["Εκτ. χρόνος"] : [])]],
    body: planned.map((a) => [a.recipe.id, a.recipe.description, q(a.planned), ...(est ? [est.has(a.recipe.id) ? fd(est.get(a.recipe.id) as number) : "—"] : [])]),
    columnStyles: {
      0: { cellWidth: 30, fontStyle: "bold" },
      2: { cellWidth: 22, halign: "right", fontStyle: "bold" },
      3: { cellWidth: 24, halign: "right" },
    },
  });
  y = doc.lastAutoTable.finalY + 7;

  const short = needs.filter((n) => n.shortage > 0);
  if (short.length) {
    autoTable(doc, {
      ...baseTable,
      startY: y,
      head: [["ΔΕΝ ΕΠΑΡΚΕΙ ΤΟ ΑΠΟΘΕΜΑ — συστατικό", "Θέλει", "Έχει", "Λείπει"]],
      headStyles: { ...baseTable.headStyles, fillColor: RED, textColor: [255, 255, 255] },
      bodyStyles: { fillColor: RED_BG },
      body: short.map((n) => [`${n.code}  ${n.description}`, q(n.required), q(n.available), q(n.shortage)]),
      columnStyles: {
        1: { cellWidth: 20, halign: "right" },
        2: { cellWidth: 20, halign: "right" },
        3: { cellWidth: 20, halign: "right", fontStyle: "bold", textColor: RED },
      },
    });
    y = doc.lastAutoTable.finalY + 7;
  }

  // ---- ανά τελικό: συστατικά και από ποια θέση
  y = sectionTitle(doc, "Ανά τελικό κωδικό", y);
  for (const r of extra.byRecipe) {
    // ο τελικός με τα συστατικά του μένει μαζί στην ίδια σελίδα όταν χωράει
    const pageH = doc.internal.pageSize.getHeight();
    const rowsCount = r.components.reduce((n, c) => n + Math.max(1, c.from.length) + (c.short > 0 && c.from.length ? 1 : 0), 0);
    const blockH = 10.5 + 7 + rowsCount * 9.5 + 6;
    if (y + Math.min(blockH, pageH - 40) > pageH - 16) {
      doc.addPage();
      y = 18;
    }
    // κεφαλίδα τελικού
    const w = doc.internal.pageSize.getWidth();
    doc.setFillColor(...ACCENT);
    doc.roundedRect(14, y, w - 28, 9, 1.2, 1.2, "F");
    doc.setFont(FONT, "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(255, 255, 255);
    doc.text(r.recipe.id, 17, y + 6);
    doc.setFont(FONT, "normal");
    const qtyText = `${q(r.planned)} τεμ.${est?.has(r.recipe.id) ? ` · ~${fd(est.get(r.recipe.id) as number)}` : ""}`;
    doc.text(qtyText, w - 17, y + 6, { align: "right" });
    const descMax = w - 28 - 40 - doc.getTextWidth(qtyText) - 6;
    doc.text(doc.splitTextToSize(r.recipe.description, descMax)[0] ?? "", 48, y + 6);
    y += 10.5;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any[] = [];
    for (const c of r.components) {
      const rows = c.from.length ? c.from : [{ position: "", area: "", lot: "", expiry: null as string | null, take: 0 }];
      rows.forEach((f, i) => {
        body.push([
          i === 0 ? { content: `${c.code}\n${c.description}`, rowSpan: rows.length } : null,
          i === 0 ? { content: `${q(c.need)} ${c.unit}`, rowSpan: rows.length, styles: { halign: "right", fontStyle: "bold" } } : null,
          f.position ? `${f.position}\n${lotTxt(f.lot, f.expiry) || f.area}` : c.short > 0 ? "ΔΕΝ ΥΠΑΡΧΕΙ" : "—",
          f.position ? q(f.take) : "",
          "",
        ].filter((x) => x !== null));
      });
      if (c.short > 0 && c.from.length) {
        body.push([{ content: `Λείπουν ${q(c.short)} ${c.unit} από ${c.code}`, colSpan: 5, styles: { textColor: RED, fillColor: RED_BG, fontStyle: "bold" } }]);
      }
    }
    autoTable(doc, {
      ...baseTable,
      startY: y,
      margin: { ...baseTable.margin, top: 16 },
      head: [["Συστατικό", "Χρειάζεται", "Θέση", "Πάρε", ""]],
      body,
      rowPageBreak: "avoid",
      columnStyles: {
        1: { cellWidth: 24 },
        2: { cellWidth: 46, fontStyle: "bold" },
        3: { cellWidth: 18, halign: "right", fontStyle: "bold" },
        4: { cellWidth: 9 },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      didParseCell: (d: any) => {
        if (d.section === "body" && d.column.index === 2 && typeof d.cell.raw === "string" && d.cell.raw && d.cell.raw !== "—") {
          d.cell.styles.fillColor = d.cell.raw === "ΔΕΝ ΥΠΑΡΧΕΙ" ? RED_BG : RACK;
          if (d.cell.raw === "ΔΕΝ ΥΠΑΡΧΕΙ") d.cell.styles.textColor = RED;
          d.cell.styles.fontSize = 8;
        }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      didDrawCell: (d: any) => {
        if (d.section === "body" && d.column.index === 4) {
          doc.setDrawColor(...INK);
          doc.setLineWidth(0.3);
          doc.rect(d.cell.x + 2, d.cell.y + 1.6, 4.2, 4.2);
        }
      },
    });
    y = doc.lastAutoTable.finalY + 6;
  }

  doc.addPage();
  y = 18;
  y = sectionTitle(doc, `Διαδρομή ανά θέση · ${new Set(picks.map((p) => p.position)).size} στάσεις (όλα μαζί)`, y);

  // εναλλασσόμενο φόντο ανά θέση, για να ξεχωρίζουν οι ομάδες
  let group = -1;
  let last = "";
  const shade: boolean[] = picks.map((p) => {
    if (p.position !== last) {
      group++;
      last = p.position;
    }
    return group % 2 === 1;
  });

  autoTable(doc, {
    ...baseTable,
    startY: y,
    head: [["Θέση", "Κωδικός", "Περιγραφή", "Πάρε", "Στη θέση", ""]],
    body: picks.map((p, i) => [
      i === 0 || picks[i - 1].position !== p.position ? `${p.position}\n${p.area}` : "",
      p.item,
      lotTxt(p.lot, p.expiry) ? `${p.description}\n${lotTxt(p.lot, p.expiry)}` : p.description,
      `${q(p.take)} ${p.unit}`,
      p.take >= p.inPosition ? `${q(p.inPosition)}\nαδειάζει` : q(p.inPosition),
      "",
    ]),
    columnStyles: {
      0: { cellWidth: 30, fontStyle: "bold" },
      1: { cellWidth: 22 },
      3: { cellWidth: 20, halign: "right", fontStyle: "bold" },
      4: { cellWidth: 18, halign: "right", textColor: DIM },
      5: { cellWidth: 9 },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    didParseCell: (d: any) => {
      if (d.section === "body" && shade[d.row.index]) d.cell.styles.fillColor = ZEBRA;
      if (d.section === "body" && d.column.index === 0) {
        d.cell.styles.fontSize = 8;
        if (d.cell.raw) d.cell.styles.fillColor = RACK; // ετικέτα ραφιού, όπως στην αποθήκη
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    didDrawCell: (d: any) => {
      if (d.section === "body" && d.column.index === 5) {
        doc.setDrawColor(...INK);
        doc.setLineWidth(0.3);
        doc.rect(d.cell.x + 2, d.cell.y + 1.6, 4.2, 4.2);
      }
    },
  });

  footer(doc, "Λίστα συλλογής ανασυσκευασίας · Fagron Hellas");
  return { doc, fileName: `lista-syllogis-${stamp(meta.generatedAt)}.pdf` };
}

/** PDF με όλες τις ανασυσκευασίες που βγαίνουν και τις θέσεις των συστατικών. */
export function availablePdf(
  jsPDF: JsPDFCtor,
  autoTable: AutoTableFn,
  fonts: PdfFonts,
  analyses: RecipeAnalysis[],
  stockIdx: StockIndex,
  meta: ExportMeta
) {
  const { rows, components } = availableData(analyses, stockIdx);
  const doc = newDoc(jsPDF, fonts, "landscape");
  const y = header(doc, "Διαθέσιμες ανασυσκευασίες", [
    ...metaLines(meta),
    `${rows.length} κωδικοί μπορούν να γίνουν. «Μέγ.» = πόσα τεμάχια βγαίνουν αν γίνει μόνο ο κωδικός. Με έντονα το συστατικό που περιορίζει.`,
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: any[] = [];
  let recipeIdx = -1;
  const zebra: boolean[] = [];
  for (let i = 0; i < components.length; i++) {
    const c = components[i];
    const first = i === 0 || components[i - 1].recipeId !== c.recipeId;
    if (first) recipeIdx++;
    const span = components.filter((x) => x.recipeId === c.recipeId).length;
    const row = [];
    if (first) {
      const r = rows[recipeIdx];
      row.push({ content: r.recipeId, rowSpan: span, styles: { fontStyle: "bold" } });
      row.push({ content: r.sharedWith ? `${r.description}\nΚοινό με: ${r.sharedWith}` : r.description, rowSpan: span });
      row.push({ content: q(r.max), rowSpan: span, styles: { halign: "right", fontStyle: "bold", fontSize: 10 } });
    }
    row.push({ content: c.component, styles: c.isLimiting ? { fontStyle: "bold" } : {} });
    row.push({ content: c.componentDescription, styles: c.isLimiting ? { fontStyle: "bold" } : {} });
    row.push({ content: `×${q(c.perUnit)}`, styles: { halign: "right" } });
    row.push({ content: q(c.totalStock), styles: { halign: "right" } });
    row.push(c.positions.map((p) => `${p.position} (${q(p.qty)}${p.lot ? ` · Π. ${p.lot}` : ""})`).join("\n") || "—");
    body.push(row);
    zebra.push(recipeIdx % 2 === 1);
  }

  autoTable(doc, {
    ...baseTable,
    startY: y,
    head: [["Κωδικός", "Περιγραφή", "Μέγ.", "Συστατικό", "Περιγραφή συστατικού", "Ανά τεμ.", "Απόθεμα", "Θέσεις (ποσότητα)"]],
    body,
    rowPageBreak: "avoid",
    columnStyles: {
      0: { cellWidth: 24 },
      1: { cellWidth: 58 },
      2: { cellWidth: 14 },
      3: { cellWidth: 20 },
      4: { cellWidth: 62 },
      5: { cellWidth: 14 },
      6: { cellWidth: 16 },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    didParseCell: (d: any) => {
      if (d.section === "body" && zebra[d.row.index]) d.cell.styles.fillColor = ZEBRA;
    },
  });

  footer(doc, "Διαθέσιμες ανασυσκευασίες · Fagron Hellas");
  return { doc, fileName: `diathesimes-anasyskevasies-${stamp(meta.generatedAt)}.pdf`, count: rows.length };
}

// ============================================================ Excel χρόνων


type JobHelpers = {
  durationSec: (j: Pick<Job, "started_at" | "finished_at">) => number;
  statsByRecipe: (jobs: Job[]) => JobStats[];
};

const minutes = (sec: number) => Math.round((sec / 60) * 100) / 100;
const seconds = (sec: number) => Math.round(sec * 10) / 10;

/** Excel χρόνων: ανά κωδικό (μέσοι όροι) + κάθε εργασία. Οι χρόνοι σε αριθμούς, για υπολογισμούς. */
export function jobsWorkbook(XLSX: XLSXLib, jobs: Job[], meta: ExportMeta, h: JobHelpers) {
  const done = jobs.filter((j) => j.status === "done" && j.finished_at && (j.packages ?? 0) > 0);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      XLSX,
      h.statsByRecipe(done).map((s) => ({
        "Κωδικός": s.recipeId,
        "Περιγραφή": s.description,
        "Εργασίες": s.jobs,
        "Συσκευασίες": s.packages,
        "Τεμάχια": s.units,
        "Συνολικός χρόνος (λεπτά)": minutes(s.totalSec),
        "Μέσος χρόνος / συσκευασία (δευτ.)": seconds(s.secPerPackage),
        "Μέσος χρόνος / τεμάχιο (δευτ.)": s.secPerUnit !== null ? seconds(s.secPerUnit) : "",
        "Συσκευασίες / ώρα": Math.round(s.packagesPerHour * 10) / 10,
        "Γρηγορότερη (δευτ./συσκ.)": seconds(s.fastestSecPerPackage),
        "Αργότερη (δευτ./συσκ.)": seconds(s.slowestSecPerPackage),
      })),
      [16, 46, 9, 11, 9, 14, 16, 14, 12, 14, 14]
    ),
    "Ανά κωδικό"
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      XLSX,
      [...done]
        .sort((a, b) => (b.finished_at as string).localeCompare(a.finished_at as string))
        .map((j) => {
          const sec = h.durationSec(j);
          return {
            "Κωδικός": j.recipe_id,
            "Περιγραφή": j.description,
            "Χρήστης": j.user_email ?? "",
            "Έναρξη": new Date(j.started_at),
            "Λήξη": new Date(j.finished_at as string),
            "Διάρκεια (λεπτά)": minutes(sec),
            "Συσκευασίες": j.packages,
            "Τεμάχια": j.units ?? "",
            "Μέσος / συσκευασία (δευτ.)": seconds(sec / (j.packages as number)),
            "Μέσος / τεμάχιο (δευτ.)": j.units ? seconds(sec / j.units) : "",
            "Σημειώσεις": j.notes,
          };
        }),
      [16, 40, 28, 17, 17, 12, 11, 9, 14, 13, 40]
    ),
    "Εργασίες"
  );
  return { wb, fileName: `xronoi-anasyskevasias-${stamp(meta.generatedAt)}.xlsx` };
}

// ============================================================ Απόθεμα (σελίδα «Απόθεμα»)

export type StockRow = {
  item: string;
  description: string;
  position: string;
  area: string;
  lot: string;
  serial: string;
  expiry: string | null;
  qty: number;
};
export type StockExportMeta = { generatedAt: Date; userEmail: string | null; filters: string[]; syncedAt: string | null };

/** Excel με τις γραμμές αποθέματος που φαίνονται (μετά τα φίλτρα) + σύνοψη ανά κωδικό. */
export function stockWorkbook(XLSX: XLSXLib, rows: StockRow[], meta: StockExportMeta) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      XLSX,
      rows.map((r) => ({
        "Θέση": r.position.split(/\s*,\s*/).join("\n"),
        "Περιοχή": r.area,
        "Κωδικός": r.item,
        "Περιγραφή": r.description,
        "Παρτίδα": r.lot,
        "Serial": r.serial,
        "Λήξη": r.expiry ? new Date(r.expiry) : "",
        "Ποσότητα": r.qty,
      })),
      [16, 26, 14, 52, 16, 16, 11, 11]
    ),
    "Απόθεμα"
  );
  const by = new Map<string, { item: string; description: string; qty: number; positions: Set<string>; lots: Set<string> }>();
  for (const r of rows) {
    const g = by.get(r.item) ?? { item: r.item, description: r.description, qty: 0, positions: new Set<string>(), lots: new Set<string>() };
    g.qty += r.qty;
    if (r.position) g.positions.add(r.position);
    if (r.lot) g.lots.add(r.lot);
    by.set(r.item, g);
  }
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      XLSX,
      [...by.values()].map((g) => ({
        "Κωδικός": g.item,
        "Περιγραφή": g.description,
        "Σύνολο": Math.round(g.qty * 1000) / 1000,
        "Θέσεις": g.positions.size,
        "Παρτίδες": g.lots.size,
        "Λίστα θέσεων": [...g.positions].join(", "),
      })),
      [14, 52, 11, 8, 9, 60]
    ),
    "Ανά κωδικό"
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Απόθεμα WMS"],
      ["Δημιουργήθηκε", when(meta.generatedAt)],
      ["Από", meta.userEmail ?? ""],
      ["Συγχρονισμός WMS", meta.syncedAt ? when(new Date(meta.syncedAt)) : "—"],
      ["Φίλτρα", meta.filters.join(" · ") || "χωρίς"],
      ["Γραμμές", rows.length],
      ["Κωδικοί", by.size],
    ]),
    "Πληροφορίες"
  );
  return { wb, fileName: `apothema-${stamp(meta.generatedAt)}.xlsx` };
}

/** PDF (A4 οριζόντιο) με τις γραμμές αποθέματος, ταξινομημένες όπως στην οθόνη. */
export function stockPdf(jsPDF: JsPDFCtor, autoTable: AutoTableFn, fonts: PdfFonts, rows: StockRow[], meta: StockExportMeta) {
  const doc = newDoc(jsPDF, fonts, "landscape");
  const total = rows.reduce((a, r) => a + r.qty, 0);
  const items = new Set(rows.map((r) => r.item)).size;
  const y = header(
    doc,
    "Απόθεμα",
    [
      `Δημιουργήθηκε: ${when(meta.generatedAt)}${meta.userEmail ? ` · ${displayUser(meta.userEmail)}` : ""}${meta.syncedAt ? ` · WMS: ${when(new Date(meta.syncedAt))}` : ""}`,
      `Φίλτρα: ${meta.filters.join(" · ") || "χωρίς"}`,
      `${rows.length.toLocaleString("el-GR")} γραμμές · ${items.toLocaleString("el-GR")} κωδικοί · σύνολο ποσότητας ${q(total)}`,
    ],
    "Fagron Hellas · Αποθήκη"
  );
  autoTable(doc, {
    ...baseTable,
    startY: y,
    head: [["Θέση", "Περιοχή", "Κωδικός", "Περιγραφή", "Παρτίδα", "Serial", "Λήξη", "Ποσότητα"]],
    body: rows.map((r) => [r.position.split(/\s*,\s*/).join("\n"), r.area, r.item, r.description, r.lot, r.serial, exp(r.expiry), q(r.qty)]),
    styles: { ...baseTable.styles, fontSize: 7.8, cellPadding: 1.3 },
    columnStyles: {
      0: { cellWidth: 24, fontStyle: "bold" },
      1: { cellWidth: 30 },
      2: { cellWidth: 20 },
      3: { cellWidth: "auto" }, // ~95mm (πριν ~116)
      4: { cellWidth: 34, overflow: "linebreak" },
      5: { cellWidth: 32, overflow: "linebreak" },
      6: { cellWidth: 15 },
      7: { cellWidth: 18, halign: "right" },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    didParseCell: (d: any) => {
      if (d.section === "body" && d.row.index % 2 === 1) d.cell.styles.fillColor = ZEBRA;
    },
  });
  footer(doc, "Απόθεμα · Fagron Hellas");
  return { doc, fileName: `apothema-${stamp(meta.generatedAt)}.pdf` };
}

// ============================================================ Κινήσεις (σελίδα «Κινήσεις»)

export type MoveRow = {
  id: string;
  moved_at: string | null;
  type: string;
  doc: string;
  item: string;
  description: string;
  lot: string;
  serial: string;
  qty: number | null;
  from_pos: string;
  to_pos: string;
  customer: string;
  username: string;
};

const dt = (iso: string | null) => (iso ? when(new Date(iso)) : "");

export function movesWorkbook(XLSX: XLSXLib, rows: MoveRow[], meta: StockExportMeta) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      XLSX,
      rows.map((r) => ({
        "Ημερομηνία": r.moved_at ? new Date(r.moved_at) : "",
        "Κίνηση": r.type,
        "Παραστατικό": r.doc,
        "Κωδικός": r.item,
        "Περιγραφή": r.description,
        "Παρτίδα": r.lot,
        "Serial": r.serial,
        "Ποσότητα": r.qty ?? "",
        "Από θέση": r.from_pos,
        "Προς θέση": r.to_pos,
        "Πελάτης": r.customer,
        "Χρήστης": r.username,
      })),
      [17, 16, 16, 14, 44, 16, 16, 10, 16, 16, 34, 14]
    ),
    "Κινήσεις"
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Κινήσεις WMS"],
      ["Δημιουργήθηκε", when(meta.generatedAt)],
      ["Από", meta.userEmail ?? ""],
      ["Φίλτρα", meta.filters.join(" · ") || "χωρίς"],
      ["Γραμμές", rows.length],
    ]),
    "Πληροφορίες"
  );
  return { wb, fileName: `kiniseis-${stamp(meta.generatedAt)}.xlsx` };
}

export function movesPdf(jsPDF: JsPDFCtor, autoTable: AutoTableFn, fonts: PdfFonts, rows: MoveRow[], meta: StockExportMeta) {
  const doc = newDoc(jsPDF, fonts, "landscape");
  const y = header(
    doc,
    "Κινήσεις",
    [
      `Δημιουργήθηκε: ${when(meta.generatedAt)}${meta.userEmail ? ` · ${displayUser(meta.userEmail)}` : ""}`,
      `Φίλτρα: ${meta.filters.join(" · ") || "χωρίς"}`,
      `${rows.length.toLocaleString("el-GR")} κινήσεις`,
    ],
    "Fagron Hellas · Αποθήκη"
  );
  autoTable(doc, {
    ...baseTable,
    startY: y,
    head: [["Ημερομηνία", "Κίνηση", "Παραστατικό", "Κωδικός", "Περιγραφή", "Παρτίδα", "Serial", "Ποσ.", "Από", "Προς", "Πελάτης"]],
    body: rows.map((r) => [dt(r.moved_at), r.type, r.doc, r.item, r.description, r.lot, r.serial, r.qty != null ? q(r.qty) : "", r.from_pos, r.to_pos, r.customer]),
    styles: { ...baseTable.styles, fontSize: 7.2, cellPadding: 1.2 },
    columnStyles: {
      0: { cellWidth: 22 },
      1: { cellWidth: 18 },
      2: { cellWidth: 20 },
      3: { cellWidth: 17 },
      4: { cellWidth: "auto" },
      5: { cellWidth: 32 },
      6: { cellWidth: 22 },
      7: { cellWidth: 16, halign: "right" },
      8: { cellWidth: 19 },
      9: { cellWidth: 19 },
      10: { cellWidth: 36 },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    didParseCell: (d: any) => {
      if (d.section === "body" && d.row.index % 2 === 1) d.cell.styles.fillColor = ZEBRA;
    },
  });
  footer(doc, "Κινήσεις · Fagron Hellas");
  return { doc, fileName: `kiniseis-${stamp(meta.generatedAt)}.pdf` };
}

// ============================================================ Orders (σελίδα «Orders»)

export type OrderRow = {
  id: string;
  order_id: string;
  list_no: string;
  doc_type: string;
  doc_no: string;
  erp_code: string;
  order_date: string | null;
  customer: string;
  item: string;
  description: string;
  lot: string;
  sn: string;
  qty: number | null;
  init_qty: number | null;
  from_pos: string;
  to_pos: string;
  wms_status: string;
  line_no: number | null;
  collected: boolean;
  collected_at: string | null;
  collected_by: string;
  picker: string; // χρήστης WMS που έκανε τη συλλογή
  is_completed?: boolean; // λίστες πωλήσεων: ολοκληρωμένη στο WMS
  is_strict?: boolean; // αυστηρή συλλογή
  customer_city?: string;
  customer_zip?: string;
  customer_vat?: string;
  is_abroad?: boolean;
  comments?: string; // σχόλια παραγγελίας (WMS)
  is_collecting?: boolean; // «σε συλλογή» τώρα στο WMS
};

/** ομάδες ανά αριθμό λίστας (σειρά εμφάνισης) */
export function groupOrdersByList(rows: OrderRow[]) {
  const m = new Map<string, OrderRow[]>();
  for (const r of rows) {
    const k = r.list_no || r.order_id || "—";
    const g = m.get(k);
    if (g) g.push(r);
    else m.set(k, [r]);
  }
  return [...m.entries()].map(([list, lines]) => ({ list, lines }));
}

export function ordersWorkbook(XLSX: XLSXLib, rows: OrderRow[], meta: StockExportMeta) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      XLSX,
      rows.map((r) => ({
        "Λίστα": r.list_no,
        "Ημερομηνία": r.order_date ? new Date(r.order_date) : "",
        "Πελάτης": r.customer,
        "Παραστατικό": r.doc_no,
        "Κωδ. ERP": r.erp_code,
        "Κωδικός": r.item,
        "Περιγραφή": r.description,
        "Batch": r.lot,
        "SN": r.sn,
        "Ποσότητα": r.qty ?? r.init_qty ?? "",
        "Από θέση": r.from_pos,
        "Συλλογή (WMS)": r.picker,
        "Κατάσταση": r.collected ? "Collected" : "Non Collected",
        "Collected από": displayUser(r.collected_by || ""),
        "Collected στις": r.collected_at ? new Date(r.collected_at) : "",
      })),
      [10, 16, 34, 16, 14, 14, 44, 16, 16, 10, 16, 22, 14, 24, 16]
    ),
    "Orders"
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Orders (πωλήσεις)"],
      ["Δημιουργήθηκε", when(meta.generatedAt)],
      ["Από", meta.userEmail ?? ""],
      ["Φίλτρα", meta.filters.join(" · ") || "χωρίς"],
      ["Γραμμές", rows.length],
      ["Λίστες", groupOrdersByList(rows).length],
    ]),
    "Πληροφορίες"
  );
  return { wb, fileName: `orders-${stamp(meta.generatedAt)}.xlsx` };
}

/** PDF: κάθε λίστα σε δική της σελίδα (μία ή πολλές λίστες = μαζική εκτύπωση). */
export function ordersPdf(jsPDF: JsPDFCtor, autoTable: AutoTableFn, fonts: PdfFonts, rows: OrderRow[], meta: StockExportMeta) {
  const doc = newDoc(jsPDF, fonts, "portrait");
  const groups = groupOrdersByList(rows);
  const W = doc.internal.pageSize.getWidth();
  groups.forEach((g, gi) => {
    if (gi > 0) doc.addPage();
    const f = g.lines[0];
    const done = g.lines.filter((l) => l.collected).length;
    // κεφαλίδα λίστας
    doc.setFillColor(...ACCENT);
    doc.rect(14, 12, 3, 14, "F");
    doc.setFont(FONT, "bold");
    doc.setFontSize(18);
    doc.setTextColor(...INK);
    doc.text(`Λίστα ${g.list}`, 20, 19);
    titleTag(doc, `Λίστα ${g.list}`, "ΕΚΤΕΛΕΣΜΕΝΟ", 20, 19, false);
    doc.setFont(FONT, "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...DIM);
    doc.text(`Fagron Hellas · Orders · εκτύπωση ${when(meta.generatedAt)}${meta.userEmail ? ` · ${displayUser(meta.userEmail)}` : ""}`, 20, 24.5);
    // κατάσταση πάνω δεξιά
    const allDone = done === g.lines.length;
    doc.setFont(FONT, "bold");
    doc.setFontSize(10);
    doc.setTextColor(...INK); // ασπρόμαυρη εκτύπωση
    doc.text(allDone ? "COLLECTED" : done ? `COLLECTED ${done}/${g.lines.length}` : "NON COLLECTED", W - 14, 19, { align: "right" });
    let y = 32;
    doc.setFont(FONT, "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(...INK);
    const info: [string, string][] = [
      ["Πελάτης", f.customer || "—"],
      ["Παραστατικό", f.doc_no || "—"],
      ["Κωδικός ERP", f.erp_code || "—"],
      ["Ημερομηνία", f.order_date ? when(new Date(f.order_date)) : "—"],
      ["Συλλογή από", [...new Set(g.lines.map((l) => l.picker).filter(Boolean))].join(", ") || "—"],
      ...(f.comments ? ([["Σχόλια", f.comments]] as [string, string][]) : []),
    ];
    for (const [k, v] of info) {
      doc.setFont(FONT, "bold");
      doc.text(`${k}:`, 14, y);
      doc.setFont(FONT, "normal");
      const vl = doc.splitTextToSize(v, W - 56) as string[];
      doc.text(vl.slice(0, 4), 42, y);
      y += 5.2 + (Math.min(vl.length, 4) - 1) * 4.2;
    }
    doc.setDrawColor(...LINE);
    doc.line(14, y, W - 14, y);
    autoTable(doc, {
      ...baseTable,
      startY: y + 3,
      head: [["#", "Κωδικός", "Περιγραφή", "Batch", "SN", "Ποσ.", "Θέση", "Coll."]],
      body: g.lines.map((l, i) => [String(l.line_no ?? i + 1), l.item, l.description, l.lot, l.sn, q(l.qty ?? l.init_qty ?? 0), l.from_pos, l.collected ? "ΝΑΙ" : ""]),
      styles: { ...baseTable.styles, fontSize: 8.2 },
      columnStyles: {
        0: { cellWidth: 8, halign: "right" },
        1: { cellWidth: 20, fontStyle: "bold" },
        2: { cellWidth: "auto" },
        3: { cellWidth: 36 }, // παρτίδα: φαρδύτερη (π.χ. 26F04-H03-01944 σε μία γραμμή)
        4: { cellWidth: 22 },
        5: { cellWidth: 16, halign: "right", fontStyle: "bold" },
        6: { cellWidth: 22 },
        7: { cellWidth: 11, halign: "center" },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      didParseCell: (d: any) => {
        if (d.section === "body" && d.column.index === 6 && d.cell.raw) {
          d.cell.styles.fillColor = RACK;
          d.cell.styles.fontStyle = "bold";
        } else if (d.section === "body" && d.row.index % 2 === 1) d.cell.styles.fillColor = ZEBRA;
      },
    });
    // σύνολο + υπογραφή
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const endY = (doc as any).lastAutoTable?.finalY ?? y + 20;
    const total = g.lines.reduce((a, l) => a + (l.qty ?? l.init_qty ?? 0), 0);
    doc.setFont(FONT, "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(...INK);
    doc.text(`${g.lines.length} γραμμές · σύνολο ${q(total)}`, 14, endY + 7);
    doc.setFont(FONT, "normal");
    doc.setTextColor(...DIM);
    doc.text("Συλλογή: ____________________   Έλεγχος: ____________________", W - 14, endY + 7, { align: "right" });
  });
  footer(doc, `Orders · ${groups.length} λίστ${groups.length === 1 ? "α" : "ες"} · Fagron Hellas`);
  const name = groups.length === 1 ? `lista-${groups[0].list}` : `listes-${groups.length}`;
  return { doc, fileName: `${name}-${stamp(meta.generatedAt)}.pdf`, lists: groups.length };
}

// ============================================================ Παραγγελίες (λίστες πωλήσεων)

/** Ασπρόμαυρη «ετικέτα» με πλαίσιο δίπλα στον τίτλο (π.χ. ΠΡΟΣ ΕΚΤΕΛΕΣΗ / ΕΚΤΕΛΕΣΜΕΝΟ). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function titleTag(doc: any, title: string, tag: string, x: number, y: number, inverse: boolean) {
  doc.setFont(FONT, "bold");
  doc.setFontSize(18);
  const tx = x + doc.getTextWidth(title) + 4;
  doc.setFontSize(10.5);
  const w = doc.getTextWidth(tag) + 5;
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.5);
  if (inverse) {
    doc.setFillColor(0, 0, 0);
    doc.rect(tx, y - 5.6, w, 7.4, "FD");
    doc.setTextColor(255, 255, 255);
  } else {
    doc.rect(tx, y - 5.6, w, 7.4, "S");
    doc.setTextColor(0, 0, 0);
  }
  doc.text(tag, tx + 2.5, y);
  doc.setLineWidth(0.2);
  doc.setTextColor(...INK);
}

const COLOR_TXT: Record<string, string> = { green: "ΟΛΑ ΔΙΑΘΕΣΙΜΑ", yellow: "ΜΕΡΙΚΗ ΣΥΛΛΟΓΗ", red: "ΧΩΡΙΣ ΑΠΟΘΕΜΑ" };
// σύντομα για στενή στήλη: OK / No / Partial / Del (= delivered, ήδη εκτελεσμένο) / Repack
const STATE_TXT: Record<string, string> = { ok: "OK", repack: "Repack", partial: "Partial", none: "No", done: "Del" };

/** PDF λίστας συλλογής: μία λίστα ανά σελίδα, με θέσεις και πιθανή ανασυσκευασία. */
export function salesListPdf(jsPDF: JsPDFCtor, autoTable: AutoTableFn, fonts: PdfFonts, orders: OrderEval[], meta: StockExportMeta) {
  const doc = newDoc(jsPDF, fonts, "portrait");
  const W = doc.internal.pageSize.getWidth();
  const posTxt = (picks: { position: string; take: number; lot: string }[]) =>
    picks.map((p) => `${p.position}: ${q(p.take)}${p.lot ? ` · Π. ${p.lot}` : ""}`).join("\n");
  orders.forEach((o, oi) => {
    if (oi > 0) doc.addPage();
    const h = o.head;
    doc.setFillColor(...(o.completed ? DIM : INK));
    doc.rect(14, 12, 3, 14, "F");
    doc.setFont(FONT, "bold");
    doc.setFontSize(18);
    doc.setTextColor(...INK);
    doc.text(`Λίστα ${o.key}`, 20, 19);
    titleTag(doc, `Λίστα ${o.key}`, "ΠΡΟΣ ΕΚΤΕΛΕΣΗ", 20, 19, true);
    doc.setFont(FONT, "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...DIM);
    doc.text(`Fagron Hellas · Λίστα πωλήσεων · εκτύπωση ${when(meta.generatedAt)}${meta.userEmail ? ` · ${displayUser(meta.userEmail)}` : ""}`, 20, 24.5);
    doc.setFont(FONT, "bold");
    doc.setFontSize(10);
    doc.setTextColor(...INK);
    doc.text(o.completed ? "ΟΛΟΚΛΗΡΩΜΕΝΗ" : COLOR_TXT[o.color], W - 14, 19, { align: "right" });
    if (o.collecting && !o.completed) {
      doc.setFontSize(8.5);
      doc.setTextColor(...INK);
      doc.text(`ΣΕ ΣΥΛΛΟΓΗ${o.picker ? ` · ${o.picker}` : ""}`, W - 14, o.needsRepack ? 29 : 24.5, { align: "right" });
    }
    if (o.needsRepack) {
      doc.setFontSize(8.5);
      doc.setTextColor(...INK);
      doc.text("ΧΡΕΙΑΖΕΤΑΙ ΑΝΑΣΥΣΚΕΥΑΣΙΑ", W - 14, 24.5, { align: "right" });
    }
    let y = 32;
    doc.setFontSize(9.5);
    doc.setTextColor(...INK);
    const info: [string, string][] = [
      ["Πελάτης", h.customer || "—"],
      ["Παραστατικό", h.doc_no || "—"],
      ["Κωδικός ERP", h.erp_code || "—"],
      ["Ημερομηνία", h.order_date ? when(new Date(h.order_date)) : "—"],
      ["Συλλογή", o.strict ? "Αυστηρή" : "Μερική"],
      ...(h.comments ? ([["Σχόλια", h.comments]] as [string, string][]) : []),
    ];
    for (const [k, v] of info) {
      doc.setFont(FONT, "bold");
      doc.text(`${k}:`, 14, y);
      doc.setFont(FONT, "normal");
      const vl = doc.splitTextToSize(v, W - 56) as string[];
      doc.text(vl.slice(0, 4), 42, y);
      y += 5 + (Math.min(vl.length, 4) - 1) * 4.2;
    }
    doc.setDrawColor(...LINE);
    doc.line(14, y, W - 14, y);
    autoTable(doc, {
      ...baseTable,
      startY: y + 3,
      head: [["#", "Κωδικός", "Περιγραφή", "Ζητ.", "Απόθ.", "Θέσεις (ποσότητα · παρτίδα)", "Κατ.", ""]],
      body: o.lines.map((l, i) => [
        String(l.line.line_no ?? i + 1),
        l.line.item,
        l.line.lot ? `${l.line.description}\nΔεσμευμένη παρτίδα: ${l.line.lot}` : l.line.description,
        q(l.need),
        q(l.stock),
        posTxt(l.picks) || "—",
        STATE_TXT[l.state],
        "",
      ]),
      styles: { ...baseTable.styles, fontSize: 8 },
      columnStyles: {
        0: { cellWidth: 7, halign: "right" },
        1: { cellWidth: 19, fontStyle: "bold" },
        2: { cellWidth: "auto" },
        3: { cellWidth: 16, halign: "right", fontStyle: "bold", overflow: "visible" },
        4: { cellWidth: 16, halign: "right", overflow: "visible" },
        5: { cellWidth: 52 },
        6: { cellWidth: 15 },
        7: { cellWidth: 7 },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      didParseCell: (d: any) => {
        if (d.section !== "body") return;
        const st = o.lines[d.row.index]?.state;
        if (d.column.index === 6) {
          // ασπρόμαυρη εκτύπωση: No = μαύρο φόντο, Partial / Repack = γκρι φόντο, Del = αχνό
          d.cell.styles.fontStyle = "bold";
          d.cell.styles.halign = "center";
          if (st === "none") {
            d.cell.styles.fillColor = [0, 0, 0];
            d.cell.styles.textColor = [255, 255, 255];
          } else if (st === "partial" || st === "repack") {
            d.cell.styles.fillColor = [205, 205, 205];
            d.cell.styles.textColor = [0, 0, 0];
          } else d.cell.styles.textColor = st === "done" ? DIM : [0, 0, 0];
        } else if (d.column.index === 5 && d.cell.raw !== "—") d.cell.styles.fillColor = [255, 246, 204];
        else if (d.row.index % 2 === 1) d.cell.styles.fillColor = ZEBRA;
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let endY = (doc as any).lastAutoTable?.finalY ?? y + 20;
    // ανασυσκευασία
    for (const l of o.lines.filter((x) => x.repack)) {
      const r = l.repack!;
      if (endY > doc.internal.pageSize.getHeight() - 50) {
        doc.addPage();
        endY = 16;
      }
      doc.setFont(FONT, "bold");
      doc.setFontSize(10.5);
      doc.setTextColor(...INK);
      doc.text(`Ανασυσκευασία: ${l.line.item} × ${q(r.units)}  (λείπουν ${q(l.need - l.covered)} · βγαίνουν έως ${q(r.max)})`, 14, endY + 8);
      doc.setFont(FONT, "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(...DIM);
      doc.text(`Προδιαγραφή ${r.recipe.id} · ${r.recipe.description}`, 14, endY + 12.5, { maxWidth: W - 28 });
      autoTable(doc, {
        ...baseTable,
        startY: endY + 15,
        head: [["Συστατικό", "Περιγραφή", "Ανά τεμ.", "Σύνολο", "Θέσεις (ποσότητα · παρτίδα)", ""]],
        body: r.recipe.components.map((c) => [
          c.code,
          c.description,
          q(c.qty),
          q(c.qty * r.units),
          posTxt(r.picks.filter((p) => p.item === c.code)) || "—",
          "",
        ]),
        styles: { ...baseTable.styles, fontSize: 8 },
        headStyles: { ...baseTable.headStyles, fillColor: [231, 238, 251] },
        columnStyles: { 0: { cellWidth: 20, fontStyle: "bold" }, 1: { cellWidth: "auto" }, 2: { cellWidth: 16, halign: "right" }, 3: { cellWidth: 16, halign: "right", fontStyle: "bold" }, 4: { cellWidth: 56 }, 5: { cellWidth: 7 } },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      endY = (doc as any).lastAutoTable?.finalY ?? endY + 20;
    }
    doc.setFont(FONT, "normal");
    doc.setFontSize(9);
    doc.setTextColor(...DIM);
    doc.text("Συλλογή: ____________________   Έλεγχος: ____________________", W - 14, Math.min(endY + 9, doc.internal.pageSize.getHeight() - 14), { align: "right" });
  });
  footer(doc, `Λίστες πωλήσεων · ${orders.length} · Fagron Hellas`);
  const name = orders.length === 1 ? `lista-polisis-${orders[0].key}` : `listes-polisis-${orders.length}`;
  return { doc, fileName: `${name}-${stamp(meta.generatedAt)}.pdf` };
}

// ---------------------------------------------------------------------------
// Ανάλυση παραλαβών (καρτέλα «Ανάλυση»)
// ---------------------------------------------------------------------------
type AnalysisLike = import("./analysis").Analysis;
type BatchLike = import("./analysis").Batch;

const dOnly = (s: string | null) => (s ? new Date(s.length <= 10 ? `${s}T00:00:00` : s) : "");
function batchRow(b: BatchLike) {
  return {
    "Κωδικός": b.item,
    "Περιγραφή": b.description ?? "",
    "Παρτίδα": b.lot,
    "Παραλαβή": dOnly(b.first_receipt),
    "Ημέρες": b.ageDays,
    "Προμηθευτής": b.supplier ?? "",
    "Παραλήφθηκε": b.received,
    "Απόθεμα παρτίδας": b.stock,
    "Ποσ./παλέτα": b.palQty ?? "",
    "Πηγή ποσ./παλέτα": b.palSource === "manual" ? "χειροκίνητη" : b.palSource === "wms" ? "WMS" : "",
    "Παλέτες (εκτίμηση)": b.pallets ?? "",
    "Θέσεις παρτίδας": b.lot_positions,
    "Λήξη": dOnly(b.expiry),
    "Μήνες ως λήξη": b.monthsToExpiry ?? "",
    "Έξοδοι κωδικού": b.item_out_n,
    "Τελ. έξοδος κωδικού": dOnly(b.item_out_last),
    "Απόθεμα κωδικού": b.item_stock,
    "Παρτίδες κωδικού": b.item_lots,
    "Θέσεις": b.positions ?? "",
  };
}
const BATCH_W = [12, 40, 18, 11, 8, 28, 11, 12, 11, 12, 11, 9, 11, 9, 9, 12, 12, 9, 40];

export function analysisWorkbook(XLSX: XLSXLib, a: AnalysisLike, meta: StockExportMeta) {
  const wb = XLSX.utils.book_new();
  const qty = (bs: { stock: number }[]) => Math.round(bs.reduce((s, b) => s + b.stock, 0) * 1000) / 1000;
  const pal = (bs: { pallets: number | null }[]) => {
    const n = bs.reduce((s, b) => s + (b.pallets ?? 0), 0);
    const miss = bs.filter((b) => b.pallets == null).length;
    return miss ? `${n} (+${miss} χωρίς ποσ./παλέτα)` : n;
  };
  const summary = [
    { "Ομάδα": "Παρτίδες που παραλήφθηκαν", "Παρτίδες": a.batches.length, "Ποσότητα σήμερα": qty(a.batches), "Παλέτες (εκτίμηση)": pal(a.batches) },
    { "Ομάδα": "Ανέγγιχτες", "Παρτίδες": a.untouched.length, "Ποσότητα σήμερα": qty(a.untouched), "Παλέτες (εκτίμηση)": pal(a.untouched) },
    { "Ομάδα": "  πρόσφατες (≤90 ημ.)", "Παρτίδες": a.recent.length, "Ποσότητα σήμερα": qty(a.recent), "Παλέτες (εκτίμηση)": pal(a.recent) },
    { "Ομάδα": "  παλαιότερες (>90 ημ.)", "Παρτίδες": a.old.length, "Ποσότητα σήμερα": qty(a.old), "Παλέτες (εκτίμηση)": pal(a.old) },
    { "Ομάδα": "Μερικώς αναλωμένες", "Παρτίδες": a.partial.length, "Ποσότητα σήμερα": qty(a.partial), "Παλέτες (εκτίμηση)": pal(a.partial) },
    { "Ομάδα": "Εξαντλήθηκαν", "Παρτίδες": a.gone.length, "Ποσότητα σήμερα": 0 },
    { "Ομάδα": "Κωδικοί χωρίς κατανάλωση (ανέγγιχτες παρτίδες)", "Παρτίδες": a.noConsumption.length, "Ποσότητα σήμερα": qty(a.noConsumption), "Παλέτες (εκτίμηση)": pal(a.noConsumption) },
    { "Ομάδα": "Κάλυψη > 24 μηνών (κωδικοί)", "Παρτίδες": a.overstock.length, "Ποσότητα σήμερα": Math.round(a.overstock.reduce((s, c) => s + c.stock, 0)), "Παλέτες (εκτίμηση)": pal(a.overstock) },
    { "Ομάδα": "FIFO / FEFO", "Παρτίδες": a.fifo.length, "Ποσότητα σήμερα": qty(a.fifo.map((f) => f.batch)), "Παλέτες (εκτίμηση)": pal(a.fifo.map((f) => f.batch)) },
    { "Ομάδα": "Λήξεις < 6 μηνών (ανέγγιχτες)", "Παρτίδες": a.expiring.length, "Ποσότητα σήμερα": qty(a.expiring), "Παλέτες (εκτίμηση)": pal(a.expiring) },
    { "Ομάδα": "Για έλεγχο (μοναδική παρτίδα, έξοδος πριν την παραλαβή)", "Παρτίδες": a.toCheck.length, "Ποσότητα σήμερα": qty(a.toCheck), "Παλέτες (εκτίμηση)": pal(a.toCheck) },
  ];
  XLSX.utils.book_append_sheet(wb, sheet(XLSX, summary, [58, 10, 16, 30]), "Σύνοψη");
  XLSX.utils.book_append_sheet(wb, sheet(XLSX, a.noConsumption.map(batchRow), BATCH_W), "Χωρίς κατανάλωση");
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      XLSX,
      a.coverage.map((c) => ({
        "Κωδικός": c.item,
        "Περιγραφή": c.description ?? "",
        "Απόθεμα κωδικού": c.stock,
        "Ποσ./παλέτα": c.palQty ?? "",
        "Παλέτες (εκτίμηση)": c.pallets ?? "",
        "Θέσεις": c.positions,
        "Έξοδοι περιόδου": c.outQty,
        "Μέση κατανάλωση / μήνα": Math.round(c.perMonth * 100) / 100,
        "Κάλυψη (μήνες)": c.months == null ? "χωρίς κατανάλωση" : Math.round(c.months),
        "Ανέγγιχτες παρτίδες": c.untouchedBatches,
        "Ποσότητα σε ανέγγιχτες": c.untouchedQty,
      })),
      [12, 40, 14, 11, 11, 8, 14, 14, 14, 12, 14]
    ),
    "Κάλυψη μηνών"
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      XLSX,
      a.fifo.map((f) => ({ ...batchRow(f.batch), "Νεότερη σε χρήση": f.newer.lot, "Παραλαβή νεότερης": dOnly(f.newer.first_receipt), "Λήξη νεότερης": dOnly(f.newer.expiry), "FEFO": f.fefo ? "ΝΑΙ" : "όχι" })),
      [...BATCH_W, 18, 11, 11, 7]
    ),
    "FIFO-FEFO"
  );
  XLSX.utils.book_append_sheet(wb, sheet(XLSX, a.expiring.map(batchRow), BATCH_W), "Λήξεις <6μ");
  XLSX.utils.book_append_sheet(wb, sheet(XLSX, a.toCheck.map(batchRow), BATCH_W), "Για έλεγχο");
  XLSX.utils.book_append_sheet(wb, sheet(XLSX, a.untouched.map(batchRow), BATCH_W), "Ανέγγιχτες");
  XLSX.utils.book_append_sheet(
    wb,
    sheet(XLSX, a.partial.map((b) => ({ ...batchRow(b), "% υπόλοιπο": b.received ? Math.round((b.stock / b.received) * 100) : "" })), [...BATCH_W, 9]),
    "Μερικώς αναλωμένες"
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      XLSX,
      [
        { "Στοιχείο": "Πρόθεμα κωδικών", "Τιμή": `${a.prefix}*` },
        { "Στοιχείο": "Παραλαβές από", "Τιμή": a.from.split("-").reverse().join("/") },
        { "Στοιχείο": "Δημιουργήθηκε", "Τιμή": meta.generatedAt.toLocaleString("el-GR") },
        { "Στοιχείο": "Χρήστης", "Τιμή": meta.userEmail ? displayUser(meta.userEmail) : "" },
        { "Στοιχείο": "Ανέγγιχτη", "Τιμή": "σημερινό απόθεμα παρτίδας ≥ παραληφθείσα ποσότητα" },
        { "Στοιχείο": "Παραλαβή", "Τιμή": "κίνηση 12 από προμηθευτή προς θέση" },
        { "Στοιχείο": "Παλέτες", "Τιμή": "απόθεμα ÷ ποσότητα ανά παλέτα, στρογγυλοποίηση προς τα πάνω· ποσότητα χειροκίνητη ή από το WMS" },
        { "Στοιχείο": "Έξοδος / ανάλωση", "Τιμή": "κίνηση 12 από θέση χωρίς «προς», 20, 22" },
      ],
      [22, 60]
    ),
    "Στοιχεία"
  );
  const fileName = `analysi-${a.prefix}-${a.from}.xlsx`;
  return { wb, fileName };
}
