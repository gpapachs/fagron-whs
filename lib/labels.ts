// Ετικέτες ανασυσκευασίας 70×35 mm (PDF, μία ετικέτα ανά σελίδα) με DataMatrix.
// Χαρτί ΠΡΟΕΚΤΥΠΩΜΕΝΟ: λογότυπο και διεύθυνση υπάρχουν ήδη -- τυπώνονται μόνο
// περιγραφές, Item Code / Quantity / Batch και DataMatrix (preprinted: true).
// Οι βιβλιοθήκες (jsPDF, bwip-js) περνούν ως παράμετροι, όπως στο exports.ts,
// ώστε το ίδιο κώδικας να τρέχει στον browser και στο CI.

export type LabelData = {
  code: string; // κωδικός τελικού, π.χ. 71-01-359
  descEl: string; // ελληνική περιγραφή
  descEn: string; // αγγλική περιγραφή
  quantity: number | null; // τεμάχια στη συσκευασία
  batch: string;
};

export type LabelOptions = {
  widthMm: number;
  heightMm: number;
  footer: string; // διεύθυνση / τηλέφωνο
  companyText: string; // αν δεν δοθεί λογότυπο
  logoDataUrl?: string | null; // PNG/JPEG
  /** προεκτυπωμένο χαρτί: ΔΕΝ τυπώνονται λογότυπο και διεύθυνση */
  preprinted: boolean;
  /** μετατόπιση όλου του περιεχομένου σε mm (ευθυγράμμιση με το χαρτί) */
  offsetXMm: number;
  offsetYMm: number;
  /** περιστροφή περιεχομένου (μοίρες, δεξιόστροφα). 0 = οριζόντια 70×35.
   *  90/270: η σελίδα γίνεται 35×70 και η ετικέτα τυπώνεται «γυρισμένη»
   *  -- για οδηγούς Zebra που έχουν το χαρτί δηλωμένο κατακόρυφα. */
  rotation?: 0 | 90 | 180 | 270;
};

export const DEFAULT_LABEL_OPTIONS: LabelOptions = {
  widthMm: 70,
  heightMm: 35,
  footer: "12 km N.R. Trikala-Larissa - Tel. +30 24310 83633-5 - info@fagron.gr",
  companyText: "Fagron",
  logoDataUrl: null,
  preprinted: true,
  offsetXMm: 0,
  offsetYMm: 0,
  rotation: 0,
};

/** Πίνακας μετασχηματισμού PDF (cm) ώστε σχέδιο σε χώρο ετικέτας W×H να βγει περιστραμμένο. */
function rotationCm(rot: number, W: number, H: number): number[] | null {
  const k = 72 / 25.4; // mm -> pt
  if (rot === 90) return [0, -1, 1, 0, (H - W) * k, W * k];
  if (rot === 180) return [-1, 0, 0, -1, W * k, H * k];
  if (rot === 270) return [0, 1, -1, 0, W * k, 0];
  return null;
}

/** Ίδια μορφή με τις υπάρχουσες ετικέτες: κωδικός#παρτίδα#EN | QUANTITY: x BATCH NO.: παρτίδα */
export function dataMatrixText(l: LabelData): string {
  const en = (l.descEn || l.descEl).trim();
  const qty = l.quantity ?? "";
  return `${l.code}#${l.batch}#${en} | QUANTITY: ${qty} BATCH NO.: ${l.batch}`;
}

/** μόνο ASCII μπαίνει καθαρά στο DataMatrix (οι σαρωτές δεν διαβάζουν σωστά ελληνικά) */
export const isAscii = (s: string) => /^[\x20-\x7E]*$/.test(s);

type Raw = { pixx: number; pixy: number; pixs: number[] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Bwip = { raw: (bcid: string, text: string, opts: string) => any };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsPDFCtor = any;
export type LabelFonts = { regular: string; bold: string };

function matrix(bwip: Bwip, text: string): Raw {
  const r = bwip.raw("datamatrix", text, "")[0];
  return { pixx: r.pixx, pixy: r.pixy, pixs: Array.from(r.pixs as ArrayLike<number>) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function drawMatrix(doc: any, m: Raw, x: number, y: number, size: number) {
  const cell = size / Math.max(m.pixx, m.pixy);
  doc.setFillColor(0, 0, 0);
  for (let row = 0; row < m.pixy; row++) {
    // ενώνει συνεχόμενα μαύρα κελιά της ίδιας σειράς σε ένα ορθογώνιο (μικρότερο, καθαρότερο PDF)
    let start = -1;
    for (let col = 0; col <= m.pixx; col++) {
      const on = col < m.pixx && m.pixs[row * m.pixx + col] === 1;
      if (on && start < 0) start = col;
      if (!on && start >= 0) {
        doc.rect(x + start * cell, y + row * cell, (col - start) * cell + 0.001, cell + 0.001, "F");
        start = -1;
      }
    }
  }
}

/** Το κείμενο σε μία γραμμή: μικραίνει τη γραμματοσειρά μέχρι να χωρέσει (όχι κάτω από min). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fitText(doc: any, text: string, maxW: number, size: number, min: number) {
  let s = size;
  doc.setFontSize(s);
  while (s > min && doc.getTextWidth(text) > maxW) {
    s -= 0.2;
    doc.setFontSize(s);
  }
  return s;
}

export function labelsPdf(
  jsPDF: JsPDFCtor,
  bwip: Bwip,
  fonts: LabelFonts,
  labels: { data: LabelData; copies: number }[],
  opts: LabelOptions = DEFAULT_LABEL_OPTIONS
) {
  const W = opts.widthMm;
  const H = opts.heightMm;
  const rot = opts.rotation ?? 0;
  const cm = rotationCm(rot, W, H);
  // μέγεθος ΣΕΛΙΔΑΣ: στις 90/270 αντιμετατίθενται πλάτος/ύψος
  const PW = rot === 90 || rot === 270 ? H : W;
  const PH = rot === 90 || rot === 270 ? W : H;
  // ΠΡΟΣΟΧΗ: format [PW, PH] με ρητό orientation, αλλιώς το jsPDF τα αντιστρέφει
  const doc = new jsPDF({ orientation: PW >= PH ? "landscape" : "portrait", unit: "mm", format: [PW, PH], compress: true });
  doc.addFileToVFS("DejaVu.ttf", fonts.regular);
  doc.addFont("DejaVu.ttf", "DejaVu", "normal");
  doc.addFileToVFS("DejaVu-Bold.ttf", fonts.bold);
  doc.addFont("DejaVu-Bold.ttf", "DejaVu", "bold");

  const k = H / 35; // κλίμακα αν αλλάξει το μέγεθος
  const m = 2.4 * k; // περιθώριο
  const ox = opts.offsetXMm || 0;
  const oy = opts.offsetYMm || 0;
  const dm = 15.5 * k; // πλευρά DataMatrix
  let first = true;
  let pages = 0;

  for (const { data, copies } of labels) {
    const mat = matrix(bwip, dataMatrixText(data));
    for (let c = 0; c < copies; c++) {
      if (!first) doc.addPage([PW, PH], PW >= PH ? "landscape" : "portrait");
      first = false;
      pages++;
      if (cm) {
        doc.internal.write("q");
        doc.internal.write(`${cm.map((v) => +v.toFixed(4)).join(" ")} cm`);
      }
      doc.setTextColor(0, 0, 0);
      // μετατόπιση: όλες οι συντεταγμένες παρακάτω περνούν από εδώ
      const T = (x: number, y: number) => [x + ox, y + oy] as const;

      // 1. ελληνική περιγραφή (έντονα) -- μία γραμμή αν χωράει, αλλιώς δύο
      doc.setFont("DejaVu", "bold");
      let extra = 0;
      const sEl = fitText(doc, data.descEl, W - 2 * m, 7.4 * k, 6.2 * k);
      if (doc.getTextWidth(data.descEl) > W - 2 * m) {
        doc.setFontSize(Math.min(sEl, 6.2 * k));
        const lines = doc.splitTextToSize(data.descEl, W - 2 * m).slice(0, 2);
        doc.text(lines, ...T(m, m + 2.4 * k), { lineHeightFactor: 1.1 });
        extra = 2.3 * k;
      } else {
        doc.text(data.descEl, ...T(m, m + 2.6 * k));
      }

      // 2. αγγλική περιγραφή
      doc.setFont("DejaVu", "normal");
      if (data.descEn) {
        fitText(doc, data.descEn, W - 2 * m, 6.6 * k, 4.8 * k);
        doc.text(data.descEn, ...T(m, m + 7.2 * k + extra));
      }

      // 3. στοιχεία (αριστερά)
      const rows: [string, string][] = [
        ["Item Code", data.code],
        ["Quantity", data.quantity != null ? String(data.quantity) : ""],
        ["Batch.", data.batch],
      ];
      const y0 = m + 12.6 * k + extra * 0.6;
      const lh = 3.6 * k;
      doc.setFontSize(6.6 * k);
      rows.forEach(([l, v], i) => {
        doc.setFont("DejaVu", "normal");
        doc.text(l, ...T(m + 0.6 * k, y0 + i * lh));
        doc.text(":", ...T(m + 12.8 * k, y0 + i * lh));
        doc.text(v, ...T(m + 14.6 * k, y0 + i * lh));
      });

      // 4. λογότυπο ή όνομα εταιρείας
      const logoY = y0 + 3 * lh - 1.2 * k;
      if (opts.preprinted) {
        /* προεκτυπωμένο λογότυπο */
      } else if (opts.logoDataUrl) {
        try {
          const fmt = opts.logoDataUrl.startsWith("data:image/png") ? "PNG" : "JPEG";
          const props = doc.getImageProperties(opts.logoDataUrl);
          const h = 4.6 * k;
          const w = Math.min((props.width / props.height) * h, 26 * k);
          doc.addImage(opts.logoDataUrl, fmt, m + 3.6 * k, logoY, w, (w / props.width) * props.height);
        } catch {
          /* χαλασμένη εικόνα -> χωρίς λογότυπο */
        }
      } else if (opts.companyText) {
        doc.setFont("DejaVu", "bold");
        doc.setFontSize(9 * k);
        doc.text(opts.companyText, m + 3.6 * k, logoY + 3.6 * k);
      }

      // 5. DataMatrix (δεξιά)
      // με τίτλο δύο γραμμών: λίγο μικρότερο και χαμηλότερα, κάτω από την αγγλική περιγραφή
      const dmSize = extra ? 13 * k : dm;
      drawMatrix(doc, mat, ...T(W - m - dmSize - 1.6 * k, extra ? m + 9.8 * k + extra : m + 8.6 * k), dmSize);

      // 6. υποσέλιδο (μόνο σε λευκό χαρτί)
      if (!opts.preprinted) {
        doc.setFont("DejaVu", "normal");
        doc.setTextColor(60, 60, 60);
        fitText(doc, opts.footer, W - 2 * m, 4.6 * k, 3.6 * k);
        doc.text(opts.footer, W / 2, H - m + 0.4 * k, { align: "center" });
      }
      if (cm) doc.internal.write("Q");
    }
  }
  return { doc, pages };
}
