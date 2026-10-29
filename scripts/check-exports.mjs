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
import { buildPlan, indexStock } from "../lib/repack.ts";
import { availablePdf, availableWorkbook, picklistPdf, planWorkbook } from "../lib/exports.ts";

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
  stock.push({ position: `10${i % 9}.0${i % 4}.0${i % 3}.01`, area: "ΑΠΟΘΗΚΗ ΔΟΚΙΜΗΣ", item: jar, description: `ΒΑΖΑΚΙ ΓΥΑΛΙΝΟ ΔΟΚΙΜΗΣ ${i * 10} ML`, qty: 50 * i, unit: "ΤΕΜ" });
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
const pick = picklistPdf(jsPDF, autoTable, fonts, plannedLines, plan.needs, plan.picks, meta);
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

console.log(process.exitCode ? "ΑΠΕΤΥΧΕ" : "OK: όλες οι εξαγωγές δουλεύουν");
