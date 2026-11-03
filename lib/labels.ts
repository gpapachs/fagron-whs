// Ετικέτες ανασυσκευασίας 70×35 mm (PDF, μία ετικέτα ανά σελίδα) με DataMatrix.
// Χαρτί ΠΡΟΕΚΤΥΠΩΜΕΝΟ: λογότυπο και διεύθυνση υπάρχουν ήδη -- τυπώνονται μόνο
// περιγραφές, Item Code / Quantity / Batch και DataMatrix (preprinted: true).
// Οι βιβλιοθήκες (jsPDF, bwip-js) περνούν ως παράμετροι, όπως στο exports.ts,
// ώστε το ίδιο κώδικας να τρέχει στον browser και στο CI.

export type LabelData = {
  code: string; // κωδικός τελικού, π.χ. 71-01-359
  descEl: string; // ελληνική περιγραφή
  descEn: string; // αγγλική περιγραφή
  quantity: number | string | null; // τεμάχια στη συσκευασία (ή κείμενο, π.χ. «1 KG»)
  batch: string; // παρτίδα (κενό αν δεν υπάρχει)
  serial?: string; // serial number (κενό στις ανασυσκευασίες)
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

/** Μορφή DataMatrix (ίδια για όλες τις ετικέτες): κωδικός#παρτίδα#serial#ποσότητα
 *  -- κενό πεδίο μένει κενό, π.χ. 71-01-359#1236095-01##75 */
export function dataMatrixText(l: LabelData): string {
  const clean = (v: unknown) => String(v ?? "").replace(/#/g, "").trim();
  return [l.code, l.batch, l.serial ?? "", l.quantity ?? ""].map(clean).join("#");
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

// ------------------------------------------------------------------ διάταξη
// Η διάταξη υπολογίζεται ΜΙΑ φορά ως λίστα «εντολών» (κείμενο / DataMatrix / λογότυπο)
// και ζωγραφίζεται είτε σε PDF (jsPDF) είτε σε bitmap για απευθείας εκτύπωση στη Zebra.
// Συντεταγμένες σε mm, πάνω-αριστερά, μέγεθος γραμματοσειράς σε pt, y = baseline.

export const PT_MM = 25.4 / 72;
/** πλάτος κειμένου σε mm για δοσμένο μέγεθος (pt) */
export type Measure = (text: string, sizePt: number, bold: boolean) => number;

export type LabelOp =
  | { t: "text"; x: number; y: number; text: string; size: number; bold: boolean; align?: "center"; gray?: boolean }
  | { t: "matrix"; x: number; y: number; size: number; m: Raw }
  | { t: "logo"; x: number; y: number; h: number; maxW: number };

function fit(measure: Measure, text: string, maxW: number, size: number, min: number, bold: boolean) {
  let s = size;
  while (s > min && measure(text, s, bold) > maxW) s -= 0.2;
  return s;
}

function wrap(measure: Measure, text: string, maxW: number, size: number, bold: boolean): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && measure(next, size, bold) > maxW) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

export function layoutLabel(data: LabelData, mat: Raw, opts: LabelOptions, measure: Measure): LabelOp[] {
  const W = opts.widthMm;
  const H = opts.heightMm;
  const k = H / 35; // κλίμακα αν αλλάξει το μέγεθος
  const m = 2.4 * k; // περιθώριο
  const ox = opts.offsetXMm || 0;
  const oy = opts.offsetYMm || 0;
  const ops: LabelOp[] = [];
  const text = (x: number, y: number, t: string, size: number, bold: boolean) =>
    ops.push({ t: "text", x: x + ox, y: y + oy, text: t, size, bold });
  const maxW = W - 2 * m;

  // 1. ελληνική περιγραφή (έντονα) -- μία γραμμή αν χωράει, αλλιώς δύο
  let extra = 0;
  const sEl = fit(measure, data.descEl, maxW, 7.4 * k, 6.2 * k, true);
  if (measure(data.descEl, sEl, true) > maxW) {
    const size = Math.min(sEl, 6.2 * k);
    wrap(measure, data.descEl, maxW, size, true)
      .slice(0, 2)
      .forEach((l, i) => text(m, m + 2.4 * k + i * size * 1.1 * PT_MM, l, size, true));
    extra = 2.3 * k;
  } else {
    text(m, m + 2.6 * k, data.descEl, sEl, true);
  }

  // 2. αγγλική περιγραφή
  if (data.descEn) {
    const s = fit(measure, data.descEn, maxW, 6.6 * k, 4.8 * k, false);
    text(m, m + 7.2 * k + extra, data.descEn, s, false);
  }

  // 3. στοιχεία (αριστερά)
  // Batch πάντα όταν δεν υπάρχει serial· με serial: Serial No. (+ Batch αν υπάρχει)
  const rows: [string, string][] = [
    ["Item Code", data.code],
    ["Quantity", data.quantity != null ? String(data.quantity) : ""],
  ];
  if (data.batch || !data.serial) rows.push(["Batch.", data.batch]);
  if (data.serial) rows.push(["Serial No.", data.serial]);
  const four = rows.length > 3; // 4 γραμμές: πιο πυκνά, για να μη φτάσουν στο προεκτυπωμένο λογότυπο
  const y0 = m + (four ? 11.9 : 12.6) * k + extra * (four ? 0.4 : 0.6);
  const lh = (four ? 3.0 : 3.6) * k;
  const fs = (four ? 6.0 : 6.6) * k;
  rows.forEach(([l, v], i) => {
    text(m + 0.6 * k, y0 + i * lh, l, fs, false);
    text(m + 12.8 * k, y0 + i * lh, ":", fs, false);
    text(m + 14.6 * k, y0 + i * lh, v, fs, false);
  });

  // 4. λογότυπο ή όνομα εταιρείας (μόνο σε λευκό χαρτί)
  const logoY = m + 12.6 * k + extra * 0.6 + 3 * 3.6 * k - 1.2 * k;
  if (!opts.preprinted) {
    if (opts.logoDataUrl) ops.push({ t: "logo", x: m + 3.6 * k, y: logoY, h: 4.6 * k, maxW: 26 * k });
    else if (opts.companyText) ops.push({ t: "text", x: m + 3.6 * k, y: logoY + 3.6 * k, text: opts.companyText, size: 9 * k, bold: true });
  }

  // 5. DataMatrix (δεξιά) -- με τίτλο δύο γραμμών λίγο μικρότερο και χαμηλότερα
  const dmSize = extra ? 13 * k : 15.5 * k;
  ops.push({ t: "matrix", x: W - m - dmSize - 1.6 * k + ox, y: (extra ? m + 9.8 * k + extra : m + 8.6 * k) + oy, size: dmSize, m: mat });

  // 6. υποσέλιδο (μόνο σε λευκό χαρτί)
  if (!opts.preprinted) {
    const s = fit(measure, opts.footer, maxW, 4.6 * k, 3.6 * k, false);
    ops.push({ t: "text", x: W / 2, y: H - m + 0.4 * k, text: opts.footer, size: s, bold: false, align: "center", gray: true });
  }
  return ops;
}

/** μέγεθος σελίδας/bitmap μετά την περιστροφή */
export function pageSize(opts: LabelOptions) {
  const rot = opts.rotation ?? 0;
  const side = rot === 90 || rot === 270;
  return { rot, PW: side ? opts.heightMm : opts.widthMm, PH: side ? opts.widthMm : opts.heightMm };
}

// ------------------------------------------------------------------ PDF
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function drawMatrixPdf(doc: any, m: Raw, x: number, y: number, size: number) {
  const cell = size / Math.max(m.pixx, m.pixy);
  doc.setFillColor(0, 0, 0);
  for (let row = 0; row < m.pixy; row++) {
    // ενώνει συνεχόμενα μαύρα κελιά της ίδιας σειράς σε ένα ορθογώνιο
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

export function labelsPdf(
  jsPDF: JsPDFCtor,
  bwip: Bwip,
  fonts: LabelFonts,
  labels: { data: LabelData; copies: number }[],
  opts: LabelOptions = DEFAULT_LABEL_OPTIONS
) {
  const W = opts.widthMm;
  const H = opts.heightMm;
  const { rot, PW, PH } = pageSize(opts);
  const cm = rotationCm(rot, W, H);
  // ΠΡΟΣΟΧΗ: format [PW, PH] με ρητό orientation, αλλιώς το jsPDF τα αντιστρέφει
  const doc = new jsPDF({ orientation: PW >= PH ? "landscape" : "portrait", unit: "mm", format: [PW, PH], compress: true });
  doc.addFileToVFS("DejaVu.ttf", fonts.regular);
  doc.addFont("DejaVu.ttf", "DejaVu", "normal");
  doc.addFileToVFS("DejaVu-Bold.ttf", fonts.bold);
  doc.addFont("DejaVu-Bold.ttf", "DejaVu", "bold");
  const measure: Measure = (t, size, bold) => {
    doc.setFont("DejaVu", bold ? "bold" : "normal");
    doc.setFontSize(size);
    return doc.getTextWidth(t);
  };

  let first = true;
  let pages = 0;
  for (const { data, copies } of labels) {
    const ops = layoutLabel(data, matrix(bwip, dataMatrixText(data)), opts, measure);
    for (let c = 0; c < copies; c++) {
      if (!first) doc.addPage([PW, PH], PW >= PH ? "landscape" : "portrait");
      first = false;
      pages++;
      if (cm) {
        doc.internal.write("q");
        doc.internal.write(`${cm.map((v) => +v.toFixed(4)).join(" ")} cm`);
      }
      for (const op of ops) {
        if (op.t === "text") {
          doc.setFont("DejaVu", op.bold ? "bold" : "normal");
          doc.setFontSize(op.size);
          if (op.gray) doc.setTextColor(60, 60, 60);
          else doc.setTextColor(0, 0, 0);
          doc.text(op.text, op.x, op.y, op.align ? { align: op.align } : undefined);
        } else if (op.t === "matrix") {
          drawMatrixPdf(doc, op.m, op.x, op.y, op.size);
        } else if (op.t === "logo" && opts.logoDataUrl) {
          try {
            const fmt = opts.logoDataUrl.startsWith("data:image/png") ? "PNG" : "JPEG";
            const props = doc.getImageProperties(opts.logoDataUrl);
            const w = Math.min((props.width / props.height) * op.h, op.maxW);
            doc.addImage(opts.logoDataUrl, fmt, op.x, op.y, w, (w / props.width) * props.height);
          } catch {
            /* χαλασμένη εικόνα -> χωρίς λογότυπο */
          }
        }
      }
      if (cm) doc.internal.write("Q");
    }
  }
  return { doc, pages };
}

// ------------------------------------------------------------------ bitmap (Zebra)
/** Μονόχρωμο bitmap: 1 = μαύρο. Γραμμή-γραμμή, width × height κουκκίδες. */
export type MonoBitmap = { width: number; height: number; bits: Uint8Array };

/**
 * Ζωγραφίζει την ετικέτα σε canvas στην ανάλυση του εκτυπωτή (dpi) και επιστρέφει
 * μονόχρωμο bitmap. Το DataMatrix μπαίνει με ΑΚΕΡΑΙΟ αριθμό κουκκίδων ανά κελί
 * (καθαρό σκανάρισμα). `fontFamily`: FontFace με τα DejaVu ήδη φορτωμένα.
 */
export function labelBitmap(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  canvas: any,
  bwip: Bwip,
  data: LabelData,
  opts: LabelOptions,
  dpi: number,
  fontFamily: string
): MonoBitmap {
  const d = dpi / 25.4; // κουκκίδες ανά mm
  const { rot, PW, PH } = pageSize(opts);
  const cw = Math.round(PW * d);
  const ch = Math.round(PH * d);
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, cw, ch);
  // περιστροφή χώρου ετικέτας (κουκκίδες) -> σελίδα
  if (rot === 90) ctx.setTransform(0, 1, -1, 0, cw, 0);
  else if (rot === 180) ctx.setTransform(-1, 0, 0, -1, cw, ch);
  else if (rot === 270) ctx.setTransform(0, -1, 1, 0, 0, ch);
  const font = (size: number, bold: boolean) => `${bold ? "bold " : ""}${size * PT_MM * d}px ${fontFamily}`;
  const measure: Measure = (t, size, bold) => {
    ctx.font = font(size, bold);
    return ctx.measureText(t).width / d;
  };
  const ops = layoutLabel(data, matrix(bwip, dataMatrixText(data)), opts, measure);
  ctx.textBaseline = "alphabetic";
  for (const op of ops) {
    if (op.t === "text") {
      ctx.font = font(op.size, op.bold);
      ctx.fillStyle = "#000";
      ctx.textAlign = op.align ?? "left";
      ctx.fillText(op.text, op.x * d, op.y * d);
    } else if (op.t === "matrix") {
      const n = Math.max(op.m.pixx, op.m.pixy);
      const cell = Math.max(1, Math.floor((op.size * d) / n));
      // κεντραρισμένο στη θέση του, σε ακέραιες κουκκίδες
      const x0 = Math.round(op.x * d + (op.size * d - cell * n) / 2);
      const y0 = Math.round(op.y * d + (op.size * d - cell * n) / 2);
      ctx.fillStyle = "#000";
      for (let r = 0; r < op.m.pixy; r++)
        for (let c = 0; c < op.m.pixx; c++) if (op.m.pixs[r * op.m.pixx + c] === 1) ctx.fillRect(x0 + c * cell, y0 + r * cell, cell, cell);
    }
    // λογότυπο: μόνο σε PDF (στο προεκτυπωμένο χαρτί δεν τυπώνεται)
  }
  const img = ctx.getImageData(0, 0, cw, ch).data;
  const bits = new Uint8Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) {
    const lum = 0.299 * img[i * 4] + 0.587 * img[i * 4 + 1] + 0.114 * img[i * 4 + 2];
    bits[i] = lum < 150 ? 1 : 0;
  }
  return { width: cw, height: ch, bits };
}

/** ZPL με όλη την ετικέτα ως εικόνα (^GFA): ελληνικά χωρίς γραμματοσειρές στον εκτυπωτή. */
export function bitmapToZpl(bmp: MonoBitmap, copies: number): string {
  const bpr = Math.ceil(bmp.width / 8);
  const total = bpr * bmp.height;
  const hex = "0123456789ABCDEF";
  let rows = "";
  for (let y = 0; y < bmp.height; y++) {
    let line = "";
    for (let b = 0; b < bpr; b++) {
      let v = 0;
      for (let i = 0; i < 8; i++) {
        const x = b * 8 + i;
        if (x < bmp.width && bmp.bits[y * bmp.width + x]) v |= 0x80 >> i;
      }
      line += hex[v >> 4] + hex[v & 15];
    }
    rows += line;
  }
  const n = Math.max(1, Math.floor(copies));
  return `^XA^PW${bmp.width}^LL${bmp.height}^LH0,0^FO0,0^GFA,${total},${total},${bpr},${rows}^FS^PQ${n},0,1,Y^XZ`;
}
