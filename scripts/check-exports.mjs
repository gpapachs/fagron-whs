// Έλεγχος εξαγωγών στο CI (τρέχει μετά το `next build`):
//   node --experimental-strip-types scripts/check-exports.mjs
// Φτιάχνει PDF/Excel με ΣΥΝΘΕΤΙΚΑ δεδομένα (ποτέ πραγματικά -- το repo είναι
// δημόσιο), ελέγχει ότι διαβάζονται σωστά και τα γράφει στο out/_check/ ώστε
// να μπορούν να ανοιχτούν από το GitHub Pages για οπτικό έλεγχο.

import fs from "node:fs";
import path from "node:path";
import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";
import * as XLSX from "xlsx";
import { buildPlan, filterStockForRecipes, indexStock, picksByRecipe } from "../lib/repack.ts";
import { availablePdf, availableWorkbook, jobsWorkbook, picklistPdf, planWorkbook, stockPdf, stockWorkbook, movesPdf, movesWorkbook, ordersPdf, ordersWorkbook, salesListPdf } from "../lib/exports.ts";
import { buildReservations, evaluateOrders, orderColor } from "../lib/sales.ts";
import * as jobsLib from "../lib/jobs.ts";
import bwipjs from "bwip-js";
import { DEFAULT_LABEL_OPTIONS, bitmapToZpl, dataMatrixText, labelsPdf } from "../lib/labels.ts";
import { autoEnglish } from "../lib/translate.ts";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "out", "_check");
fs.mkdirSync(outDir, { recursive: true });

const font = (f) => fs.readFileSync(path.join(root, "public", "fonts", f)).toString("base64");
const fonts = { regular: font("DejaVuSansCondensed.ttf"), bold: font("DejaVuSansCondensed-Bold.ttf") };

// ---- συνθετικά δεδομένα (ελληνικά, κοινά συστατικά, πολλές θέσεις, έλλειψη)
const recipes = [];
const stock = [];
for (let i = 1; i <= 40; i++) {
  const id = `71-90-${String(i).padStart(3, "0")}`;
  const jar = `40-90-${String(i).padStart(3, "0")}`;
  const lid = `40-91-${String((i % 7) + 1).padStart(3, "0")}`; // κοινά καπάκια
  recipes.push({
    id,
    product_code: id,
    description: `ΒΑΖΑΚΙ ΔΟΚΙΜΗΣ ${i * 10} ML ΜΕ ΚΑΠΑΚΙ — ελληνικά: άέήίόύώ ϊϋΐΰ`,
    components: [
      { code: jar, description: `ΒΑΖΑΚΙ ΓΥΑΛΙΝΟ ΔΟΚΙΜΗΣ ${i * 10} ML`, qty: 1, unit: "ΤΕΜ" },
      { code: lid, description: `ΚΑΠΑΚΙ ΔΟΚΙΜΗΣ Νο ${(i % 7) + 1}`, qty: i % 5 === 0 ? 2 : 1, unit: "ΤΕΜ" },
    ],
  });
  stock.push({ position: `10${i % 9}.0${i % 4}.0${i % 3}.01`, area: "ΑΠΟΘΗΚΗ ΔΟΚΙΜΗΣ", item: jar, description: `ΒΑΖΑΚΙ ΓΥΑΛΙΝΟ ΔΟΚΙΜΗΣ ${i * 10} ML`, qty: 50 * i, unit: "ΤΕΜ", lot: `L${1000 + i}`, expiry: `2031-0${(i % 9) + 1}-15` });
  if (i % 3 === 0) stock.push({ position: `99.${i}`, area: "ΕΙΣΕΡΧΟΜΕΝΑ ΥΛΙΚΑ", item: jar, description: `ΒΑΖΑΚΙ ΓΥΑΛΙΝΟ ΔΟΚΙΜΗΣ ${i * 10} ML`, qty: 17, unit: "ΤΕΜ" });
}
for (let k = 1; k <= 7; k++) {
  stock.push({ position: `20${k}.01.01.02`, area: "ΚΕΝΤΡΙΚΗ ΑΠΟΘΗΚΗ", item: `40-91-00${k}`, description: `ΚΑΠΑΚΙ ΔΟΚΙΜΗΣ Νο ${k}`, qty: 300 * k, unit: "ΤΕΜ" });
}

const planned = { "71-90-001": 40, "71-90-008": 200, "71-90-010": 100, "71-90-035": 1500 };
const plan = buildPlan(recipes, stock, planned);
const stockIdx = indexStock(stock);
const plannedLines = plan.analyses.filter((a) => a.planned > 0);
const meta = {
  generatedAt: new Date(),
  userEmail: "dokimi@example.com",
  stockFile: "apothema-dokimi.xlsx",
  stockUploadedAt: new Date().toISOString(),
  excludedAreas: [],
};

const fail = (msg) => {
  console.error(`::error title=check-exports::${msg}`);
  process.exitCode = 1;
};

// ---- PDF
// μοιρασιά λίστας συλλογής ανά τελικό: κάθε συστατικό καλύπτεται ακριβώς (ή σημειώνεται έλλειψη)
const byRecipe = picksByRecipe(plannedLines, plan.picks);
for (const r of byRecipe) for (const c of r.components) {
  const got = c.from.reduce((s, f) => s + f.take, 0);
  if (Math.abs(got + c.short - c.need) > 1e-6) fail(`μοιρασιά ${r.recipe.id}/${c.code}: ${got}+${c.short} != ${c.need}`);
}
const shortCount = byRecipe.flatMap((r) => r.components).filter((c) => c.short > 0).length;
console.log(`ανά τελικό: ${byRecipe.length} κωδικοί, ${shortCount} συστατικά με έλλειψη`);
const estimateSec = new Map(plannedLines.slice(0, 3).map((a) => [a.recipe.id, a.planned * 12.5]));
const pick = picklistPdf(jsPDF, autoTable, fonts, plannedLines, plan.needs, plan.picks, meta, {
  byRecipe,
  estimateSec,
  fmtDuration: (sec) => `${Math.round(sec / 60)}λ`,
});
const avail = availablePdf(jsPDF, autoTable, fonts, plan.analyses, stockIdx, meta);
for (const [name, res] of [["sample-picklist.pdf", pick], ["sample-available.pdf", avail]]) {
  const buf = Buffer.from(res.doc.output("arraybuffer"));
  fs.writeFileSync(path.join(outDir, name), buf);
  const s = buf.toString("latin1");
  if (!s.startsWith("%PDF")) fail(`${name}: δεν είναι PDF`);
  if (!s.includes("/FontFile2")) fail(`${name}: η γραμματοσειρά δεν ενσωματώθηκε`);
  console.log(`${name}: ${buf.length} bytes, ${res.doc.getNumberOfPages()} σελίδες`);
}

// ---- Excel (γράφεται και ξαναδιαβάζεται)
const a = availableWorkbook(XLSX, plan.analyses, stockIdx, meta);
const p = planWorkbook(XLSX, plannedLines, plan.needs, plan.picks, meta);
for (const [name, wb] of [["sample-available.xlsx", a.wb], ["sample-plan.xlsx", p.wb]]) {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  const back = XLSX.read(fs.readFileSync(file));
  const first = XLSX.utils.sheet_to_json(back.Sheets[back.SheetNames[0]]);
  console.log(`${name}: φύλλα ${back.SheetNames.join(" / ")} · ${first.length} γραμμές`);
  if (!first.length) fail(`${name}: κενό πρώτο φύλλο`);
}
const backA = XLSX.read(fs.readFileSync(path.join(outDir, "sample-available.xlsx")));
const firstRow = XLSX.utils.sheet_to_json(backA.Sheets["Διαθέσιμες"])[0];
if (!String(firstRow?.["Περιγραφή"] ?? "").includes("άέήίόύώ")) fail("τα ελληνικά δεν διατηρήθηκαν στο Excel");
if (a.count !== plan.analyses.filter((x) => x.max > 0).length) fail("λάθος πλήθος διαθέσιμων");

// ---- παρτίδες: ανάγνωση από «Excel» με στήλες Παρτίδα / Ημ.Λήξης (δύο παρτίδες στην ίδια θέση μένουν χωριστά)
{
  const { parseStockRows } = await import("../lib/repack.ts");
  const rows = [
    ["", "Θέση", "Περ.Θέσης", "Είδος", "Περ.Είδους", "Παρτίδα", "Ημ.Λήξης", "Ποσ1", "ΜΜ1", "Ημ.Λήξης"],
    ["", "99.15", "Α", "40-00-122", "ΒΑΖΑΚΙ", "P10018", "4/4/2029", 278, "ΤΕΜ", "1/1/2000"],
    ["", "99.15", "Α", "40-00-122", "ΒΑΖΑΚΙ", "M01-17", "22/4/2035", 40, "ΤΕΜ", "1/1/2000"],
    ["", "99.15", "Α", "40-00-122", "ΒΑΖΑΚΙ", "M01-17", "22/4/2035", 2, "ΤΕΜ", "1/1/2000"],
  ];
  const { stock: lots } = parseStockRows(rows);
  const m = lots.find((x) => x.lot === "M01-17");
  console.log(`παρτίδες: ${lots.length} γραμμές · ${lots.map((x) => `${x.lot}=${x.qty} λ.${x.expiry}`).join(", ")}`);
  if (lots.length !== 2 || m?.qty !== 42 || m?.expiry !== "2035-04-22") fail("λάθος ανάγνωση παρτίδων");
}

// ---- δεσμευμένα από Excel (μορφή ERP εκκρεμοτήτων + πρότυπο)
{
  const { parseReservedRows } = await import("../lib/repack.ts");
  const erp = parseReservedRows([
    ["Αρ. Παραγγελίας", "Πελάτης", "Κωδ.Συναλλ.", "Κωδικός Είδους", "Περιγραφή", "Ποσότητα", "Εκκρεμότητα"],
    ["ΠΑ-101", "Α", "99-1", "71-00-110", "ΒΑΖΟ", 100, 60],
    ["ΠΑ-102", "Β", "99-2", "71-00-110", "ΒΑΖΟ", 50, 50],
    ["ΠΑ-103", "Γ", "99-3", "71-00-081", "Π", 12, "2.400"],
  ]);
  const b110 = erp.items.find((i) => i.code === "71-00-110");
  console.log(`δεσμευμένα: ${erp.items.map((i) => `${i.code}=${i.qty}/${i.orders}π`).join(", ")} · στήλη «${erp.columns?.qty}»`);
  if (b110?.qty !== 110 || b110.orders !== 2 || erp.items.find((i) => i.code === "71-00-081")?.qty !== 2400) fail("λάθος ανάγνωση δεσμευμένων");
}

// ---- φιλτράρισμα ολόκληρου αποθέματος
const noise = Array.from({ length: 5000 }, (_, i) => ({ position: `Z${i}`, area: "Χ", item: `00-99-${i % 900}`, description: "άσχετο", qty: 3, unit: "ΤΕΜ" }));
const flt = filterStockForRecipes([...stock, ...noise, { position: "300.01", area: "Κ", item: "71-90-001", description: "τελικό", qty: 9, unit: "ΤΕΜ" }], recipes);
console.log(`φιλτράρισμα: ${flt.totalRows} γραμμές -> ${flt.kept.length} (${flt.componentItems} συστατικά, ${flt.finalItems} τελικοί)`);
if (flt.kept.length !== stock.length + 1 || flt.finalItems !== 1) fail("λάθος φιλτράρισμα αποθέματος");

// ---- Excel χρόνων + μέσοι όροι
const t0 = Date.parse("2026-10-01T08:00:00Z");
const jobs = [
  { id: "a", recipe_id: "71-90-001", product_code: "71-90-001", description: "ΒΑΖΑΚΙ ΔΟΚΙΜΗΣ", status: "done", started_at: new Date(t0).toISOString(), finished_at: new Date(t0 + 1200e3).toISOString(), units: 120, packages: 40, notes: "", user_id: "u", user_email: "dokimi@example.com" },
  { id: "b", recipe_id: "71-90-001", product_code: "71-90-001", description: "ΒΑΖΑΚΙ ΔΟΚΙΜΗΣ", status: "done", started_at: new Date(t0 + 86400e3).toISOString(), finished_at: new Date(t0 + 86400e3 + 600e3).toISOString(), units: 30, packages: 10, notes: "διάλειμμα", user_id: "u", user_email: "dokimi@example.com" },
  { id: "c", recipe_id: "71-90-002", product_code: "71-90-002", description: "ΑΚΥΡΩΜΕΝΗ", status: "cancelled", started_at: new Date(t0).toISOString(), finished_at: new Date(t0 + 60e3).toISOString(), units: null, packages: null, notes: "", user_id: "u", user_email: null },
];
const st = jobsLib.statsByRecipe(jobs);
// 1800 δευτ. / 50 συσκευασίες = 36 δευτ./συσκ. (σταθμισμένος μέσος, όχι μέσος των 30 και 60)
if (st.length !== 1 || Math.abs(st[0].secPerPackage - 36) > 1e-9) fail(`λάθος μέσος χρόνος: ${st[0]?.secPerPackage}`);
if (jobsLib.fmtDuration(36) !== "36δ" || jobsLib.fmtDuration(3725) !== "1ώ 02λ") fail("λάθος μορφή διάρκειας");
const jw = jobsWorkbook(XLSX, jobs, meta, jobsLib);
fs.writeFileSync(path.join(outDir, "sample-times.xlsx"), XLSX.write(jw.wb, { type: "buffer", bookType: "xlsx" }));
const jback = XLSX.read(fs.readFileSync(path.join(outDir, "sample-times.xlsx")));
const per = XLSX.utils.sheet_to_json(jback.Sheets["Ανά κωδικό"])[0];
console.log(`sample-times.xlsx: ${jback.SheetNames.join(" / ")} · μέσος/συσκ. ${per?.["Μέσος χρόνος / συσκευασία (δευτ.)"]} δευτ.`);
if (per?.["Μέσος χρόνος / συσκευασία (δευτ.)"] !== 36) fail("λάθος μέσος χρόνος στο Excel χρόνων");

// ---- ετικέτα 70×35 σε προεκτυπωμένο χαρτί (τα στοιχεία της φωτογραφίας)
{
  const label = { code: "71-01-359", descEl: "ΣΩΛΗΝΑΡΙΟ ΑΛΟΥΜΙΝΙΟΥ GALENPACK 30 ML", descEn: "ALUMINIUM TUBE GALENPACK 30 ml", quantity: 75, batch: "1236095-01" };
  const txt = dataMatrixText(label);
  const want = "71-01-359#1236095-01##75";
  if (txt !== want) fail(`DataMatrix: «${txt}» αντί για «${want}»`);
  const sn = dataMatrixText({ ...label, code: "12-12-309", batch: "L77", serial: "SN-0001", quantity: 1 });
  if (sn !== "12-12-309#L77#SN-0001#1") fail(`DataMatrix serial: ${sn}`);
  const sn2 = dataMatrixText({ ...label, code: "12-12-309", batch: "", serial: "SN-0002", quantity: "500 G" });
  if (sn2 !== "12-12-309##SN-0002#500 G") fail(`DataMatrix serial χωρίς παρτίδα: ${sn2}`);
  const four = labelsPdf(jsPDF, bwipjs, fonts, [{ data: { ...label, serial: "SN-0001" }, copies: 1 }], DEFAULT_LABEL_OPTIONS);
  fs.writeFileSync(path.join(outDir, "sample-label-batch-serial.pdf"), Buffer.from(four.doc.output("arraybuffer")));
  const { doc, pages } = labelsPdf(jsPDF, bwipjs, fonts, [{ data: label, copies: 2 }], DEFAULT_LABEL_OPTIONS);
  const buf = Buffer.from(doc.output("arraybuffer"));
  fs.writeFileSync(path.join(outDir, "sample-label.pdf"), buf);
  const raw = bwipjs.raw("datamatrix", txt, "")[0];
  console.log(`sample-label.pdf: ${buf.length} bytes, ${pages} σελίδες 70×35 · DataMatrix ${raw.pixx}×${raw.pixy} · «${txt}»`);
  if (pages !== 2) fail("λάθος πλήθος ετικετών");
  const white = labelsPdf(jsPDF, bwipjs, fonts, [{ data: label, copies: 1 }], { ...DEFAULT_LABEL_OPTIONS, preprinted: false, offsetXMm: 1 });
  fs.writeFileSync(path.join(outDir, "sample-label-blank-paper.pdf"), Buffer.from(white.doc.output("arraybuffer")));
  // περιστροφή για οδηγούς με χαρτί δηλωμένο κάθετα: σελίδα 35×70
  for (const rotation of [90, 180, 270]) {
    const r = labelsPdf(jsPDF, bwipjs, fonts, [{ data: label, copies: 1 }], { ...DEFAULT_LABEL_OPTIONS, rotation });
    const sz = r.doc.internal.pageSize;
    const [w, h] = [Math.round(sz.getWidth()), Math.round(sz.getHeight())];
    const want = rotation === 180 ? [70, 35] : [35, 70];
    if (w !== want[0] || h !== want[1]) fail(`στροφή ${rotation}: σελίδα ${w}×${h}`);
    fs.writeFileSync(path.join(outDir, `sample-label-rot${rotation}.pdf`), Buffer.from(r.doc.output("arraybuffer")));
  }
}

// ---- σελίδα «Απόθεμα»: Excel + PDF
{
  const rows = Array.from({ length: 250 }, (_, i) => ({
    item: `40-00-${String(i % 40).padStart(3, "0")}`,
    description: "ΣΩΛΗΝΑΡΙΟ ΑΛΟΥΜΙΝΙΟΥ GALENPACK 30ML",
    position: `16.01.${String(i % 9).padStart(2, "0")}.0${i % 4}`,
    area: i % 2 ? "ΚΕΝΤΡΙΚΗ ΑΠΟΘΗΚΗ" : "ΨΥΓΕΙΟ",
    lot: `L${1000 + (i % 13)}`,
    serial: i % 50 === 0 ? `SN-${i}` : "",
    expiry: i % 7 ? "2027-05-01" : null,
    qty: 10 + i,
  }));
  const sm = { generatedAt: new Date(), userEmail: "test@fagron.gr", filters: ["θέση 16.01…"], syncedAt: new Date().toISOString() };
  const { wb } = stockWorkbook(XLSX, rows, sm);
  const back = XLSX.read(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  const n = XLSX.utils.sheet_to_json(back.Sheets["Απόθεμα"]).length;
  const per = XLSX.utils.sheet_to_json(back.Sheets["Ανά κωδικό"]).length;
  if (n !== 250 || per !== 40) fail(`Excel αποθέματος: ${n} γραμμές / ${per} κωδικοί`);
  const { doc } = stockPdf(jsPDF, autoTable, fonts, rows, sm);
  fs.writeFileSync(path.join(outDir, "sample-stock.pdf"), Buffer.from(doc.output("arraybuffer")));
  console.log(`sample-stock: Excel ${n} γραμμές / ${per} κωδικοί · PDF ${doc.getNumberOfPages()} σελίδες`);
}

// ---- σελίδα «Κινήσεις»
{
  const mv = Array.from({ length: 60 }, (_, i) => ({
    id: `M${i}`, moved_at: new Date(Date.UTC(2026, 10, 3, 8, i)).toISOString(), type: i % 2 ? "ΑΠΟΣΤΟΛΗ" : "ΜΕΤΑΦΟΡΑ", doc: `ΔΑ-${1000 + i}`,
    item: "71-01-359", description: "ΣΩΛΗΝΑΡΙΟ ΑΛΟΥΜΙΝΙΟΥ GALENPACK 30ML", lot: "1236095-01", serial: "", qty: i + 1,
    from_pos: "16.01.03.01", to_pos: i % 2 ? "" : "99.38", customer: i % 2 ? "ΦΑΡΜΑΚΕΙΟ ΠΑΠΑΔΟΠΟΥΛΟΥ" : "", username: "maria",
  }));
  const mm = { generatedAt: new Date(), userEmail: "test@fagron.gr", filters: ["κωδικός 71-01-359"], syncedAt: null };
  const { wb } = movesWorkbook(XLSX, mv, mm);
  const n = XLSX.utils.sheet_to_json(XLSX.read(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })).Sheets["Κινήσεις"]).length;
  if (n !== 60) fail(`Excel κινήσεων: ${n} γραμμές`);
  const { doc } = movesPdf(jsPDF, autoTable, fonts, mv, mm);
  fs.writeFileSync(path.join(outDir, "sample-moves.pdf"), Buffer.from(doc.output("arraybuffer")));
  console.log(`sample-moves: Excel ${n} · PDF ${doc.getNumberOfPages()} σελίδες`);
}

// ---- σελίδα «Orders»: λίστες, μία ανά σελίδα
{
  const ord = Array.from({ length: 30 }, (_, i) => ({
    id: String(1000 + i), order_id: String(900 + (i % 3)), list_no: String(5428 + (i % 3)), doc_type: "salexportcl", doc_no: `ΔΑ-${77 + (i % 3)}`,
    erp_code: `ERP-${i % 3}`, order_date: new Date().toISOString(), customer: "ΦΑΡΜΑΚΕΙΟ ΠΑΠΑΔΟΠΟΥΛΟΥ", item: "71-01-359",
    description: "ΣΩΛΗΝΑΡΙΟ ΑΛΟΥΜΙΝΙΟΥ GALENPACK 30ML", lot: "1236095-01", sn: i % 5 ? "" : `SN-${i}`, qty: 5, init_qty: 5,
    from_pos: "16.01.03.01", to_pos: "", wms_status: "", line_no: i, collected: i % 4 === 0, collected_at: null, collected_by: "", picker: "Nikolaos Stefanou",
  }));
  const om = { generatedAt: new Date(), userEmail: "test@fagron.gr", filters: [], syncedAt: null };
  const { wb } = ordersWorkbook(XLSX, ord, om);
  const n = XLSX.utils.sheet_to_json(XLSX.read(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })).Sheets["Orders"]).length;
  const { doc, lists } = ordersPdf(jsPDF, autoTable, fonts, ord, om);
  if (n !== 30 || lists !== 3 || doc.getNumberOfPages() !== 3) fail(`Orders: Excel ${n}, λίστες ${lists}, σελίδες ${doc.getNumberOfPages()}`);
  fs.writeFileSync(path.join(outDir, "sample-orders.pdf"), Buffer.from(doc.output("arraybuffer")));
  console.log(`sample-orders: ${lists} λίστες σε ${doc.getNumberOfPages()} σελίδες`);
}

// ---- σελίδα «Παραγγελίες»: χρώματα + ανασυσκευασία
{
  if (orderColor([{ state: "ok" }, { state: "ok" }], true) !== "green") fail("χρώμα: όλα διαθέσιμα");
  if (orderColor([{ state: "ok" }, { state: "none" }], true) !== "red") fail("χρώμα: αυστηρή με έλλειψη");
  if (orderColor([{ state: "ok" }, { state: "none" }], false) !== "yellow") fail("χρώμα: μερική με απόθεμα");
  if (orderColor([{ state: "none" }, { state: "none" }], false) !== "red") fail("χρώμα: μερική χωρίς απόθεμα");
  const st = (item, position, qty) => ({ item, position, area: "", description: "", qty, unit: "", lot: "L1", expiry: null });
  const idx = indexStock([st("71-01-359", "16.01.03.01", 3), st("40-01-359", "99.38", 500), st("12-00-001", "1.1", 10)]);
  const recipe = { id: "71-01-359", product_code: "71-01-359", description: "ΣΩΛΗΝΑΡΙΟ", components: [{ code: "40-01-359", description: "ΣΩΛ.", qty: 1, unit: "" }] };
  const base = { order_id: "1", list_no: "544424", doc_type: "SALEXPORTLS", doc_no: "00WOR7768", erp_code: "1113281", order_date: new Date().toISOString(), customer: "ΦΑΡΜΑΚΕΙΟ", lot: "", sn: "", from_pos: "", to_pos: "", wms_status: "", collected: false, collected_at: null, collected_by: "", picker: "", is_completed: false, is_strict: true, description: "Δ" };
  const rows = [
    { ...base, id: "a", item: "71-01-359", qty: 10, init_qty: 10, line_no: 1 },
    { ...base, id: "b", item: "12-00-001", qty: 5, init_qty: 5, line_no: 2 },
  ];
  const [o] = evaluateOrders(rows, idx, new Map([["71-01-359", [recipe]]]));
  if (o.lines[0].state !== "repack" || o.lines[0].repack?.units !== 7 || !o.needsRepack || o.color !== "green") fail(`ανασυσκευασία: ${o.lines[0].state} ${o.lines[0].repack?.units} ${o.color}`);
  // δεσμευμένη παρτίδα από άλλη λίστα: μένουν 2 από τα 10 -> μερικό
  const res = buildReservations([{ list_no: "999", order_id: "9", item: "12-00-001", lot: "L1", qty: 8, is_completed: false }]);
  const [o3] = evaluateOrders(rows, idx, new Map([["71-01-359", [recipe]]]), { reservations: res });
  if (o3.lines[1].state !== "partial" || o3.lines[1].covered !== 2 || o3.color !== "red") fail(`δέσμευση: ${o3.lines[1].state} ${o3.lines[1].covered} ${o3.color}`);
  // εκτελεσμένη γραμμή (ποσότητα 0) δεν εμφανίζεται
  const [o4] = evaluateOrders([...rows, { ...rows[1], id: "c", qty: 0, init_qty: 4, line_no: 3 }], idx, new Map());
  if (o4.lines.length !== 2) fail(`εκτελεσμένες γραμμές: ${o4.lines.length}`);
  const [o2] = evaluateOrders(rows, idx, new Map());
  if (o2.color !== "red" || o2.lines[0].state !== "partial") fail(`χωρίς προδιαγραφή: ${o2.color} ${o2.lines[0].state}`);
  const { doc } = salesListPdf(jsPDF, autoTable, fonts, [o, o2], { generatedAt: new Date(), userEmail: "t@f.gr", filters: [], syncedAt: null });
  fs.writeFileSync(path.join(outDir, "sample-sales.pdf"), Buffer.from(doc.output("arraybuffer")));
  console.log(`sample-sales: ${doc.getNumberOfPages()} σελίδες · χρώματα/ανασυσκευασία OK`);
}

// ---- ZPL (απευθείας εκτύπωση Zebra): 10×2 κουκκίδες, 1η στήλη μαύρη
{
  const bits = new Uint8Array(20);
  bits[0] = 1;
  bits[10] = 1;
  bits[9] = 1;
  const z = bitmapToZpl({ width: 10, height: 2, bits }, 4);
  const want = "^XA^PW10^LL2^LH0,0^FO0,0^GFA,4,4,2,80408000^FS^PQ4,0,1,Y^XZ";
  if (z !== want) fail(`ZPL: ${z} αντί για ${want}`);
  console.log("ZPL ^GFA OK");
}

// ---- αυτόματη αγγλική περιγραφή
{
  const cases = [
    ["ΣΩΛΗΝΑΡΙΟ ΑΛΟΥΜΙΝΙΟΥ GALENPACK 30ML", "ALUMINIUM TUBE GALENPACK 30ML"],
    ["Κάψουλες Galenpack Νο0 Μπλε-Λευκό (1000 τεμ.)", "CAPSULES GALENPACK NO0 BLUE-WHITE (1000 PCS)"],
    ["PET ΚΑΦΕ ΦΙΑΛΗ 500 ML AMBER ΜΕ ΚΑΠΑΚΙ 25ΜΜ", "PET AMBER BOTTLE 500 ML WITH CAP 25MM"],
    ["ΚΑΠΑΚΙ 18GL ΣΤΑΓΟΝΟΜΕΤΡΟ ΠΙΠΕΤΤΑ ΛΕΥΚΟ 5ml", "CAP 18GL DROPPER PIPETTE WHITE 5ML"],
  ];
  for (const [el, en] of cases) {
    const got = autoEnglish(el);
    if (got !== en) fail(`μετάφραση: «${el}» -> «${got}» αντί για «${en}»`);
    if (!/^[\x20-\x7E]*$/.test(got)) fail(`μετάφραση με μη-λατινικούς χαρακτήρες: ${got}`);
  }
  console.log(`αυτόματα αγγλικά: ${cases.length} περιπτώσεις OK`);
}

console.log(process.exitCode ? "ΑΠΕΤΥΧΕ" : "OK: όλες οι εξαγωγές δουλεύουν");
