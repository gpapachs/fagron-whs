// Εξαγωγές Ανασυσκευασίας: Excel (SheetJS) και PDF (jsPDF + autotable).
//
// Οι βιβλιοθήκες περνούν ως παράμετροι (δεν γίνεται import εδώ), ώστε:
//  - στον browser να φορτώνονται μόνο όταν πατηθεί το κουμπί
//  - το scripts/check-exports.mjs να τρέχει τα ίδια ακριβώς functions στο CI
// Μόνο `import type` από άλλα αρχεία -- τίποτα σε runtime.

import type { ComponentNeed, PickLine, RecipeAnalysis, StockIndex } from "./repack";
import type { Job, JobStats } from "./jobs";

const q = (n: number) => n.toLocaleString("el-GR", { maximumFractionDigits: 3 });
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
  positions: { position: string; area: string; qty: number }[];
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
          .map((r) => ({ position: r.position, area: r.area, qty: r.qty }))
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
export function availableWorkbook(XLSX: XLSXLib, analyses: RecipeAnalysis[], stockIdx: StockIndex, meta: ExportMeta) {
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
      })),
      [16, 14, 50, 13, 20, 30, 10]
    ),
    "Διαθέσιμες"
  );

  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      XLSX,
      components.flatMap((c) =>
        (c.positions.length ? c.positions : [{ position: "", area: "", qty: 0 }]).map((p, i) => ({
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
          "Ποσότητα θέσης": p.position ? p.qty : "",
        }))
      ),
      [16, 44, 9, 14, 44, 9, 6, 12, 10, 16, 26, 12]
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
        "Πάρε": p.take,
        "Στη θέση": p.inPosition,
        "ΜΜ": p.unit,
        "Αδειάζει": p.take >= p.inPosition ? "ΝΑΙ" : "",
      })),
      [16, 26, 14, 50, 9, 9, 6, 9]
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
function header(doc: any, title: string, lines: string[]): number {
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
  doc.text("Fagron Hellas · Ανασυσκευασία", 20, 24);
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
    `Δημιουργήθηκε: ${when(meta.generatedAt)}${meta.userEmail ? ` · ${meta.userEmail}` : ""}`,
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
  meta: ExportMeta
) {
  const doc = newDoc(jsPDF, fonts, "portrait");
  let y = header(doc, "Λίστα συλλογής", metaLines(meta));

  y = sectionTitle(doc, "Πλάνο ανασυσκευασίας", y);
  autoTable(doc, {
    ...baseTable,
    startY: y,
    head: [["Κωδικός", "Περιγραφή", "Ποσότητα"]],
    body: planned.map((a) => [a.recipe.id, a.recipe.description, q(a.planned)]),
    columnStyles: { 0: { cellWidth: 30, fontStyle: "bold" }, 2: { cellWidth: 22, halign: "right", fontStyle: "bold" } },
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

  y = sectionTitle(doc, `Συλλογή ανά θέση · ${new Set(picks.map((p) => p.position)).size} στάσεις`, y);

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
      p.description,
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
    row.push(c.positions.map((p) => `${p.position} (${q(p.qty)})`).join("   ") || "—");
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
