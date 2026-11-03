"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import AppBar from "@/components/AppBar";
import { createClient } from "@/lib/supabase/client";
import { loadPdfFonts } from "@/lib/pdfFonts";
import { autoEnglish } from "@/lib/translate";
import { DEFAULT_LABEL_OPTIONS, dataMatrixText, isAscii, pageSize, type LabelData, type LabelOptions } from "@/lib/labels";
import { loadCanvasFonts, pickPrinter, zebraDpi, zebraPrinters, zebraSend, type ZebraDevice } from "@/lib/zebra";
import type { ProductSettings } from "@/lib/repack";

export type LabelProduct = { code: string; description: string; components: { code: string; description: string }[] };
export type LotRow = { item: string; lot: string; expiry: string | null; position: string; qty: number };

const LS_OPTS = "labels.options.v1";
const PRINTER_HINT = "Packaging Station 2";
const LS_PRINT = "labels.printer.v1";
type PrintCfg = { printer: string; dpi: "auto" | 203 | 300 | 600; detected: Record<string, number> };
const DEFAULT_PRINT: PrintCfg = { printer: PRINTER_HINT, dpi: "auto", detected: {} };
function loadPrint(): PrintCfg {
  try {
    const raw = window.localStorage.getItem(LS_PRINT);
    if (raw) return { ...DEFAULT_PRINT, ...JSON.parse(raw) };
  } catch {
    /* τίποτα */
  }
  return DEFAULT_PRINT;
}

function loadOpts(): LabelOptions {
  try {
    const raw = window.localStorage.getItem(LS_OPTS);
    if (raw) {
      const o = { ...DEFAULT_LABEL_OPTIONS, ...JSON.parse(raw), preprinted: true };
      if (![0, 90, 180, 270].includes(o.rotation)) o.rotation = 0;
      return o;
    }
  } catch {
    /* ιδιωτικό παράθυρο κ.λπ. */
  }
  return DEFAULT_LABEL_OPTIONS;
}

const searchKey = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

export default function LabelsBoard({
  products,
  initialSettings,
  lots,
  userEmail,
  role,
}: {
  products: LabelProduct[];
  initialSettings: ProductSettings[];
  lots: LotRow[];
  userEmail: string | null;
  role: "admin" | "staff";
}) {
  const [settings, setSettings] = useState<Record<string, ProductSettings>>(() =>
    Object.fromEntries(initialSettings.map((s) => [s.product_code, s]))
  );
  const [query, setQuery] = useState("");
  const [code, setCode] = useState<string>("");
  const [descEl, setDescEl] = useState("");
  const [descEn, setDescEn] = useState("");
  const [qty, setQty] = useState("");
  const [batch, setBatch] = useState("");
  const [copies, setCopies] = useState("1");
  const [opts, setOpts] = useState<LabelOptions>(DEFAULT_LABEL_OPTIONS);
  const [showSetup, setShowSetup] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const previewUrl = useRef<string | null>(null);
  const [printCfg, setPrintCfg] = useState<PrintCfg>(DEFAULT_PRINT);
  const [zebraList, setZebraList] = useState<ZebraDevice[] | null>(null); // null = άγνωστο / δεν τρέχει
  const [zebraErr, setZebraErr] = useState<string | null>(null);

  const byCode = useMemo(() => new Map(products.map((p) => [p.code, p])), [products]);

  useEffect(() => {
    setOpts(loadOpts());
    setPrintCfg(loadPrint());
    refreshPrinters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(LS_PRINT, JSON.stringify(printCfg));
    } catch {
      /* τίποτα */
    }
  }, [printCfg]);

  async function refreshPrinters() {
    try {
      const list = await zebraPrinters();
      setZebraList(list);
      setZebraErr(list.length ? null : "Το Zebra Browser Print τρέχει αλλά δεν βλέπει εκτυπωτή.");
      return list;
    } catch {
      setZebraList(null);
      setZebraErr("Δεν βρέθηκε το Zebra Browser Print σε αυτόν τον υπολογιστή.");
      return null;
    }
  }
  useEffect(() => {
    try {
      window.localStorage.setItem(LS_OPTS, JSON.stringify({ offsetXMm: opts.offsetXMm, offsetYMm: opts.offsetYMm, rotation: opts.rotation ?? 0 }));
    } catch {
      /* τίποτα */
    }
  }, [opts.offsetXMm, opts.offsetYMm, opts.rotation]);

  // ?code=71-01-359&qty=75&batch=... (από την Ανασυσκευασία)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const c = p.get("code");
    if (c && byCode.has(c)) {
      choose(c);
      if (p.get("qty")) setQty(p.get("qty") as string);
      if (p.get("batch")) setBatch(p.get("batch") as string);
      if (p.get("copies")) setCopies(p.get("copies") as string);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** σειρά: δική μας (αποθηκευμένη) > WMS (μόνο αν είναι λατινικά) > αυτόματη μετάφραση */
  function englishFor(c: string, el: string) {
    const st = settings[c];
    if (st?.description_en) return st.description_en;
    if (st?.description_en_wms && isAscii(st.description_en_wms)) return st.description_en_wms;
    return autoEnglish(el);
  }

  function choose(c: string) {
    const p = byCode.get(c);
    if (!p) return;
    const st = settings[c];
    setCode(c);
    setQuery("");
    setDescEl(p.description);
    setDescEn(englishFor(c, p.description));
    const upp = st?.units_per_package ?? st?.units_per_package_wms ?? null;
    setQty(upp ? String(upp) : "");
    setBatch("");
    setCopies("1");
    setError(null);
    setSaved(null);
  }

  const matches = useMemo(() => {
    const q = searchKey(query.trim());
    if (!q) return [];
    return products.filter((p) => searchKey(`${p.code} ${p.description}`).includes(q)).slice(0, 12);
  }, [query, products]);

  // παρτίδες των ΣΥΣΤΑΤΙΚΩΝ στο απόθεμα (η ετικέτα παίρνει την παρτίδα του συστατικού
  // που ανασυσκευάζεται). Κύριο συστατικό πρώτο: ίδιος αριθμός με τον τελικό
  // (71-01-359 -> 40-01-359), αλλιώς το πρώτο της προδιαγραφής. Νωρίτερη λήξη πρώτη.
  const compLots = useMemo(() => {
    const p = byCode.get(code);
    if (!p) return [] as { code: string; description: string; main: boolean; lots: LotRow[] }[];
    const suffix = code.slice(code.indexOf("-") + 1);
    const mainIdx = Math.max(0, p.components.findIndex((c) => c.code.slice(c.code.indexOf("-") + 1) === suffix));
    const ordered = p.components.map((c, i) => ({ ...c, main: i === mainIdx })).sort((a, b) => Number(b.main) - Number(a.main));
    return ordered.map((c) => {
      const m = new Map<string, LotRow>();
      for (const l of lots) {
        if (l.item !== c.code || !l.lot) continue;
        const prev = m.get(l.lot);
        if (prev) m.set(l.lot, { ...prev, qty: prev.qty + l.qty, position: prev.position === l.position ? prev.position : `${prev.position}, ${l.position}` });
        else m.set(l.lot, { ...l });
      }
      const list = [...m.values()].sort((a, b) => (a.expiry ?? "9999").localeCompare(b.expiry ?? "9999") || a.lot.localeCompare(b.lot));
      return { ...c, lots: list };
    });
  }, [byCode, code, lots]);
  const lotOptions = compLots.flatMap((c) => c.lots);

  // μία μόνο παρτίδα στο κύριο συστατικό -> μπαίνει αυτόματα
  useEffect(() => {
    const main = compLots[0];
    if (code && !batch && main?.main && main.lots.length === 1) setBatch(main.lots[0].lot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compLots]);

  const data: LabelData | null = code
    ? { code, descEl: descEl.trim(), descEn: descEn.trim(), quantity: qty ? Number(qty) : null, batch: batch.trim() }
    : null;
  const dmText = data ? dataMatrixText(data) : "";
  const asciiOk = isAscii(dmText);
  const nCopies = Math.max(1, Math.min(500, Math.floor(Number(copies) || 1)));
  const ready = !!data && !!data.batch && data.quantity !== null && data.quantity > 0;

  async function build(count: number) {
    if (!data) throw new Error("Διάλεξε κωδικό");
    const [{ jsPDF }, bwip, fonts, L] = await Promise.all([import("jspdf"), import("bwip-js"), loadPdfFonts(), import("@/lib/labels")]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = (bwip as any).default ?? bwip;
    return L.labelsPdf(jsPDF, engine, fonts, [{ data, copies: count }], { ...opts, preprinted: true });
  }

  // ζωντανή προεπισκόπηση (1 ετικέτα)
  useEffect(() => {
    if (!data) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const { doc } = await build(1);
        if (cancelled) return;
        const url = URL.createObjectURL(doc.output("blob"));
        if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
        previewUrl.current = url;
        setPreview(url);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(`Προεπισκόπηση: ${(e as Error).message}`);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, descEl, descEn, qty, batch, opts.offsetXMm, opts.offsetYMm, opts.rotation]);

  /** Απευθείας εκτύπωση: Zebra Browser Print (ZPL, χωρίς παράθυρο). Αν δεν υπάρχει,
   *  εκτύπωση από τον browser χωρίς PDF (ανοίγει μόνο το παράθυρο επιλογής εκτυπωτή). */
  async function print() {
    if (!data) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const [bwip, family, L] = await Promise.all([import("bwip-js"), loadCanvasFonts(), import("@/lib/labels")]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const engine = (bwip as any).default ?? bwip;
      const o = { ...opts, preprinted: true };
      const list = zebraList ?? (await refreshPrinters());
      const dev = list ? pickPrinter(list, printCfg.printer) : null;
      if (dev) {
        let dpi = printCfg.dpi === "auto" ? printCfg.detected[dev.name] : printCfg.dpi;
        if (!dpi) {
          dpi = (await zebraDpi(dev)) ?? 203;
          const got = dpi;
          setPrintCfg((c) => ({ ...c, detected: { ...c.detected, [dev.name]: got } }));
        }
        const bmp = L.labelBitmap(document.createElement("canvas"), engine, data, o, dpi, family);
        await zebraSend(dev, L.bitmapToZpl(bmp, nCopies));
        setSaved(`✓ Στάλθηκ${nCopies > 1 ? `αν ${nCopies} ετικέτες` : "ε 1 ετικέτα"} στον ${dev.name} (${dpi} dpi).`);
      } else {
        await browserPrint(L, engine, family, o);
      }
      rememberEnglish();
    } catch (e) {
      setError(`Η εκτύπωση απέτυχε: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  // εκτύπωση από τον browser με εικόνα ετικέτας (όχι PDF) σε κρυφό iframe
  async function browserPrint(
    L: typeof import("@/lib/labels"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: any,
    family: string,
    o: LabelOptions
  ) {
    if (!data) return;
    const canvas = document.createElement("canvas");
    L.labelBitmap(canvas, engine, data, o, 300, family);
    const url = canvas.toDataURL("image/png");
    const { PW, PH } = pageSize(o);
    const imgs = Array.from({ length: nCopies }, () => `<img src="${url}">`).join("");
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${PW}mm ${PH}mm;margin:0}html,body{margin:0;padding:0}img{display:block;width:${PW}mm;height:${PH}mm;break-after:page;page-break-after:always}img:last-child{break-after:auto;page-break-after:auto}</style></head><body>${imgs}</body></html>`;
    await new Promise<void>((resolve) => {
      frame.onload = () => {
        const w = frame.contentWindow;
        const imgsReady = Array.from(w?.document.images ?? []).map((im) => (im.complete ? Promise.resolve() : new Promise((r) => (im.onload = r))));
        Promise.all(imgsReady).then(() => {
          w?.focus();
          w?.print();
          setTimeout(() => frame.remove(), 60000);
          resolve();
        });
      };
      document.body.appendChild(frame);
    });
    setSaved(`Άνοιξε το παράθυρο εκτύπωσης — διάλεξε ${PRINTER_HINT}. Για εκτύπωση με ένα κλικ, εγκατάστησε το Zebra Browser Print (δες «Εκτυπωτής»).`);
  }

  async function openPdf() {
    setBusy(true);
    setError(null);
    try {
      const { doc } = await build(nCopies);
      const url = URL.createObjectURL(doc.output("blob"));
      const w = window.open(url, "_blank");
      if (!w) doc.save(`etiketa-${code}-${batch || "x"}.pdf`);
      rememberEnglish();
    } catch (e) {
      setError(`Η δημιουργία απέτυχε: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  /** αν ο χρήστης διόρθωσε αγγλικά / τμχ, κρατά τα για την επόμενη φορά */
  async function rememberEnglish() {
    if (!code) return;
    const st = settings[code];
    const wmsEn = st?.description_en_wms && isAscii(st.description_en_wms) ? st.description_en_wms : "";
    const curEn = st?.description_en ?? "";
    const auto = autoEnglish(byCode.get(code)?.description ?? "");
    // αποθηκεύεται μόνο αν ο χρήστης την άλλαξε (όχι αν είναι η αυτόματη ή του WMS)
    const t = descEn.trim();
    const wantEn = t === wmsEn || (!wmsEn && t === auto) ? "" : t;
    const patch: Record<string, unknown> = {};
    if (wantEn !== curEn) patch.description_en = wantEn;
    const n = Number(qty);
    const curUpp = st?.units_per_package ?? st?.units_per_package_wms ?? null;
    if (n > 0 && n !== curUpp && Number.isInteger(n)) patch.units_per_package = n;
    if (!Object.keys(patch).length) return;
    const { data: row, error: err } = await createClient()
      .from("repack_product_settings")
      .upsert({ product_code: code, ...patch }, { onConflict: "product_code" })
      .select()
      .single();
    if (!err && row) {
      setSettings((s) => ({ ...s, [code]: row as ProductSettings }));
      setSaved("Αποθηκεύτηκαν τα στοιχεία του κωδικού για την επόμενη φορά.");
    }
  }

  const st = code ? settings[code] : undefined;

  return (
    <>
      <AppBar email={userEmail} role={role} />
      <div className="wrap labels">
        <div className="header">
          <div className="titleblock">
            <h1>Ετικέτες</h1>
            <p>
              Ετικέτα 70 × 35 mm σε προεκτυπωμένο χαρτί (λογότυπο και διεύθυνση υπάρχουν ήδη). Εκτυπωτής: <b>{PRINTER_HINT}</b>.
            </p>
          </div>
        </div>

        <div className="lb-layout">
          <section className="lb-form">
            <label className="field lb-search">
              Τελικός κωδικός
              <input
                value={query || (code ? `${code} · ${descEl}` : "")}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={(e) => code && !query && e.target.select()}
                placeholder="Κωδικός ή περιγραφή, π.χ. 71-01-359 ή σωληνάριο"
                autoFocus
              />
              {matches.length > 0 && (
                <ul className="lb-matches" role="listbox">
                  {matches.map((p) => (
                    <li key={p.code}>
                      <button type="button" onClick={() => choose(p.code)}>
                        <span className="mono">{p.code}</span> {p.description}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </label>

            {code && (
              <>
                <label className="field">
                  Ελληνική περιγραφή
                  <input value={descEl} onChange={(e) => setDescEl(e.target.value)} />
                </label>
                <label className="field">
                  <span>
                    Αγγλική περιγραφή{" "}
                    <span className="field-hint">
                      {st?.description_en
                        ? "· αποθηκευμένη"
                        : st?.description_en_wms && isAscii(st.description_en_wms)
                          ? "· από το WMS"
                          : "· αυτόματη μετάφραση — έλεγξέ τη (αν τη διορθώσεις, κρατιέται)"}
                    </span>
                  </span>
                  <input value={descEn} onChange={(e) => setDescEn(e.target.value)} placeholder="π.χ. ALUMINIUM TUBE GALENPACK 30 ml" />
                </label>
                <div className="lb-row">
                  <label className="field">
                    Quantity (τεμ.)
                    <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} placeholder="π.χ. 75" />
                  </label>
                  <label className="field">
                    Batch
                    <input value={batch} onChange={(e) => setBatch(e.target.value.trim())} list="lb-lots" placeholder="π.χ. 1236095-01" />
                    <datalist id="lb-lots">
                      {lotOptions.map((l) => (
                        <option key={`${l.item}|${l.lot}`} value={l.lot}>
                          {`${l.item} · ${l.position} · ${l.qty}${l.expiry ? ` · λ. ${l.expiry}` : ""}`}
                        </option>
                      ))}
                    </datalist>
                  </label>
                  <label className="field">
                    Αντίτυπα
                    <input inputMode="numeric" value={copies} onChange={(e) => setCopies(e.target.value.replace(/\D/g, ""))} />
                  </label>
                </div>
                <div className="lb-comps">
                  <span className="l">Παρτίδες συστατικών στο απόθεμα</span>
                  {compLots.length === 0 && <span className="rp-hint">Ο κωδικός δεν έχει συστατικά στις προδιαγραφές.</span>}
                  {compLots.map((c) => (
                    <div key={c.code} className={`lb-comp ${c.main ? "main" : ""}`}>
                      <div className="lb-comp-head">
                        <span className="mono">{c.code}</span> <span className="desc">{c.description}</span>
                        {c.main && compLots.length > 1 && <span className="rp-alt">κύριο</span>}
                      </div>
                      {c.lots.length ? (
                        <div className="lb-lots">
                          {c.lots.slice(0, 8).map((l) => (
                            <button
                              key={l.lot}
                              type="button"
                              className={`lb-lotbtn ${batch === l.lot ? "on" : ""}`}
                              onClick={() => setBatch(l.lot)}
                              title={`Θέση ${l.position}`}
                            >
                              <span className="lot">{l.lot}</span>
                              <span className="meta">
                                {l.qty.toLocaleString("el-GR")} τεμ.{l.expiry ? ` · λ. ${l.expiry.slice(8, 10)}/${l.expiry.slice(5, 7)}/${l.expiry.slice(2, 4)}` : ""}
                              </span>
                            </button>
                          ))}
                          {c.lots.length > 8 && <span className="rp-hint">+{c.lots.length - 8} ακόμα (γράψε στο Batch)</span>}
                        </div>
                      ) : (
                        <span className="rp-hint">Χωρίς παρτίδα στο απόθεμα.</span>
                      )}
                    </div>
                  ))}
                </div>

                {!asciiOk && (
                  <p className="rp-notice warn">
                    Το DataMatrix θα περιέχει ελληνικούς χαρακτήρες (από την αγγλική περιγραφή). Οι σαρωτές συνήθως δεν τους διαβάζουν σωστά —
                    γράψε την αγγλική περιγραφή με λατινικούς χαρακτήρες.
                  </p>
                )}
                {error && <p className="rp-notice error">{error}</p>}
                {saved && <p className="rp-hint">{saved}</p>}

                <div className="lb-actions">
                  <button type="button" className="btn primary" onClick={print} disabled={!ready || busy}>
                    {busy ? "Δημιουργία…" : `Εκτύπωση ${nCopies > 1 ? `${nCopies} ετικετών` : "ετικέτας"}`}
                  </button>
                  <button type="button" className="btn ghost" onClick={openPdf} disabled={!ready || busy} title="Άνοιγμα ως PDF (αποθήκευση / αρχείο)">
                    PDF
                  </button>
                </div>
                {!ready && <p className="rp-hint">Συμπλήρωσε Quantity και Batch για εκτύπωση.</p>}
                {ready && (
                  <p className="rp-hint">
                    {zebraList?.length
                      ? `Απευθείας στον ${pickPrinter(zebraList, printCfg.printer)?.name} (Zebra Browser Print).`
                      : "Zebra Browser Print: δεν βρέθηκε — η εκτύπωση θα ανοίξει το παράθυρο επιλογής εκτυπωτή."}
                  </p>
                )}
              </>
            )}
          </section>

          <aside className="lb-preview">
            <h2>Προεπισκόπηση</h2>
            {preview ? (
              <iframe title="Προεπισκόπηση ετικέτας" src={`${preview}#toolbar=0&navpanes=0&view=Fit`} className="lb-frame" />
            ) : (
              <div className="lb-empty">Διάλεξε τελικό κωδικό.</div>
            )}
            {data && (
              <details className="lb-dm">
                <summary>Περιεχόμενο DataMatrix</summary>
                <code>{dmText}</code>
              </details>
            )}
            <details className="lb-setup">
              <summary>Εκτυπωτής</summary>
              {zebraList?.length ? (
                <>
                  <label className="field">
                    Εκτυπωτής Zebra
                    <select value={pickPrinter(zebraList, printCfg.printer)?.name ?? ""} onChange={(e) => setPrintCfg((c) => ({ ...c, printer: e.target.value }))}>
                      {zebraList.map((d) => (
                        <option key={d.uid} value={d.name}>
                          {d.name} ({d.connection})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    Ανάλυση κεφαλής
                    <select
                      value={String(printCfg.dpi)}
                      onChange={(e) => setPrintCfg((c) => ({ ...c, dpi: e.target.value === "auto" ? "auto" : (Number(e.target.value) as 203 | 300 | 600) }))}
                    >
                      <option value="auto">
                        Αυτόματα{printCfg.detected[pickPrinter(zebraList, printCfg.printer)?.name ?? ""] ? ` (${printCfg.detected[pickPrinter(zebraList, printCfg.printer)?.name ?? ""]} dpi)` : ""}
                      </option>
                      <option value="203">203 dpi (8 κουκκίδες/mm)</option>
                      <option value="300">300 dpi (12 κουκκίδες/mm)</option>
                      <option value="600">600 dpi</option>
                    </select>
                  </label>
                  <p className="rp-hint">
                    Αν η ετικέτα βγαίνει μικρότερη ή μεγαλύτερη από το χαρτί, άλλαξε την ανάλυση (τη γράφει το αυτοκόλλητο κάτω από τον εκτυπωτή).
                  </p>
                </>
              ) : (
                <div className="rp-hint">
                  <p>
                    {zebraErr ?? "Έλεγχος…"} Για εκτύπωση <b>με ένα κλικ</b> (χωρίς παράθυρο), στον υπολογιστή του {PRINTER_HINT}:
                  </p>
                  <ol>
                    <li>
                      Εγκατάστησε το δωρεάν <b>Zebra Browser Print</b> (zebra.com → Support → Software → Browser Print, Windows).
                    </li>
                    <li>Άνοιξέ το και βεβαιώσου ότι βλέπει τον {PRINTER_HINT} ως προεπιλεγμένο.</li>
                    <li>
                      Πάτα «Έλεγχος ξανά» εδώ και αποδέξου το μήνυμα που θα εμφανιστεί (επιτρέπει σε αυτή τη σελίδα να τυπώνει). Αν δεν συνδέεται, άνοιξε μία
                      φορά το <code>https://127.0.0.1:9101/ssl_support</code> και πάτα «Συνέχεια».
                    </li>
                  </ol>
                </div>
              )}
              <button type="button" className="btn ghost" onClick={refreshPrinters}>
                Έλεγχος ξανά
              </button>
            </details>
            <details className="lb-setup" open={showSetup} onToggle={(e) => setShowSetup((e.target as HTMLDetailsElement).open)}>
              <summary>Προσανατολισμός & ευθυγράμμιση</summary>
              <label className="field">
                Προσανατολισμός εκτύπωσης
                <select
                  value={opts.rotation ?? 0}
                  onChange={(e) => setOpts((o) => ({ ...o, rotation: Number(e.target.value) as LabelOptions["rotation"] }))}
                >
                  <option value={0}>Οριζόντια 70×35 (κανονικά)</option>
                  <option value={90}>Οριζόντια σε χαρτί δηλωμένο κάθετα 35×70 — στροφή 90°</option>
                  <option value={270}>Οριζόντια σε χαρτί δηλωμένο κάθετα 35×70 — στροφή 270°</option>
                  <option value={180}>Ανάποδα (180°)</option>
                </select>
              </label>
              <p className="rp-hint">
                Η ετικέτα σχεδιάζεται πάντα οριζόντια (70 πλάτος × 35 ύψος). Αν βγαίνει γυρισμένη, είτε στις <b>Προτιμήσεις εκτύπωσης</b> του {PRINTER_HINT}{" "}
                δήλωσε χαρτί <b>Πλάτος 70 mm × Ύψος 35 mm, Προσανατολισμός: Οριζόντιος (Landscape)</b>, είτε διάλεξε εδώ στροφή 90° ή 270°.
              </p>
              <p className="rp-hint">
                Αν η εκτύπωση πέφτει μετατοπισμένη πάνω στο προεκτυπωμένο χαρτί, μετακίνησε όλο το περιεχόμενο (θετικό = δεξιά / κάτω). Αποθηκεύεται σε
                αυτόν τον υπολογιστή.
              </p>
              <div className="lb-row">
                <label className="field">
                  Οριζόντια (mm)
                  <input
                    type="number"
                    step="0.5"
                    value={opts.offsetXMm}
                    onChange={(e) => setOpts((o) => ({ ...o, offsetXMm: Number(e.target.value) || 0 }))}
                  />
                </label>
                <label className="field">
                  Κάθετα (mm)
                  <input
                    type="number"
                    step="0.5"
                    value={opts.offsetYMm}
                    onChange={(e) => setOpts((o) => ({ ...o, offsetYMm: Number(e.target.value) || 0 }))}
                  />
                </label>
              </div>
              <p className="rp-hint">
                Στο παράθυρο εκτύπωσης: εκτυπωτής <b>{PRINTER_HINT}</b>, κλίμακα <b>Πραγματικό μέγεθος / 100%</b>, χωρίς περιθώρια.
              </p>
            </details>
          </aside>
        </div>
      </div>
    </>
  );
}
