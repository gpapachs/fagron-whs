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
export type CatalogItem = { code: string; description: string; description_en: string };
type WmsRow = { item: string; lot: string; serial: string; expiry: string | null; qty: number; positions: string };
type Mode = "repack" | "all";
const LS_MODE = "labels.mode.v1";
const fmtExp = (e: string | null) => (e ? `${e.slice(8, 10)}/${e.slice(5, 7)}/${e.slice(2, 4)}` : "");

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
  catalog,
  userEmail,
  role,
}: {
  products: LabelProduct[];
  initialSettings: ProductSettings[];
  lots: LotRow[];
  catalog: CatalogItem[];
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
  const [mode, setModeState] = useState<Mode>("repack");
  const [kind, setKind] = useState<"batch" | "serial">("batch");
  const [serials, setSerials] = useState<string[]>([]); // πολλαπλή επιλογή serial -> μία ετικέτα το καθένα
  const [itemStock, setItemStock] = useState<WmsRow[] | null>(null);
  const [stockErr, setStockErr] = useState<string | null>(null);
  const byCatalog = useMemo(() => new Map(catalog.map((c) => [c.code, c])), [catalog]);

  function setMode(m: Mode) {
    setModeState(m);
    setCode("");
    setQuery("");
    setItemStock(null);
    setSerials([]);
    setKind("batch");
    try {
      window.localStorage.setItem(LS_MODE, m);
    } catch {
      /* τίποτα */
    }
  }

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
    let m: Mode = "repack";
    try {
      m = (p.get("mode") as Mode) || (window.localStorage.getItem(LS_MODE) as Mode) || "repack";
    } catch {
      /* τίποτα */
    }
    if (c && byCode.has(c) && p.get("mode") !== "all") m = "repack";
    if (m !== "all" && m !== "repack") m = "repack";
    setModeState(m);
    if (c && (m === "all" ? byCatalog.has(c.toUpperCase()) : byCode.has(c))) {
      choose(c.toUpperCase(), m);
      if (p.get("qty")) setQty(p.get("qty") as string);
      if (p.get("batch")) setBatch(p.get("batch") as string);
      if (p.get("copies")) setCopies(p.get("copies") as string);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** σειρά: δική μας (αποθηκευμένη) > WMS (μόνο αν είναι λατινικά) > αυτόματη μετάφραση */
  /** αγγλικά από το WMS: ανασυσκευασίες -> settings, όλα -> κατάλογος (μόνο αν είναι λατινικά) */
  function wmsEnglish(c: string) {
    const w = settings[c]?.description_en_wms || byCatalog.get(c)?.description_en || "";
    return w && isAscii(w) ? w : "";
  }
  function englishFor(c: string, el: string) {
    return settings[c]?.description_en || wmsEnglish(c) || autoEnglish(el);
  }

  function choose(c: string, m: Mode = mode) {
    const desc = m === "all" ? byCatalog.get(c)?.description : byCode.get(c)?.description;
    if (desc === undefined) return;
    const st = settings[c];
    setCode(c);
    setQuery("");
    setDescEl(desc);
    setDescEn(englishFor(c, desc));
    const upp = st?.units_per_package ?? st?.units_per_package_wms ?? null;
    setQty(upp ? String(upp) : m === "all" ? "1" : "");
    setBatch("");
    setSerials([]);
    setKind("batch");
    setCopies("1");
    setError(null);
    setSaved(null);
    setItemStock(null);
    setStockErr(null);
    if (m === "all") loadItemStock(c);
  }

  async function loadItemStock(c: string) {
    const { data: rows, error: err } = await createClient()
      .from("wms_stock")
      .select("item, lot, serial, expiry, qty, positions")
      .eq("item", c)
      .order("expiry", { ascending: true, nullsFirst: false })
      .limit(2000);
    if (err) {
      setStockErr(err.message);
      setItemStock([]);
      return;
    }
    const list = ((rows ?? []) as WmsRow[]).map((r) => ({ ...r, qty: Number(r.qty) }));
    setItemStock(list);
    const lotsOnly = [...new Set(list.filter((r) => r.lot).map((r) => r.lot))];
    const serialsOnly = list.filter((r) => r.serial);
    // κωδικός με serial (π.χ. εξοπλισμός) -> λειτουργία serial
    if (serialsOnly.length && !lotsOnly.length) setKind("serial");
    else if (lotsOnly.length === 1) setBatch(lotsOnly[0]);
  }

  // παρτίδες / serial του ίδιου του κωδικού (λειτουργία «Όλα τα προϊόντα»)
  const ownLots = useMemo(() => {
    const m = new Map<string, { lot: string; qty: number; expiry: string | null; positions: string }>();
    for (const r of itemStock ?? []) {
      if (!r.lot) continue;
      const p = m.get(r.lot);
      if (p) m.set(r.lot, { ...p, qty: p.qty + r.qty, expiry: p.expiry && r.expiry ? (p.expiry < r.expiry ? p.expiry : r.expiry) : p.expiry || r.expiry });
      else m.set(r.lot, { lot: r.lot, qty: r.qty, expiry: r.expiry, positions: r.positions });
    }
    return [...m.values()].sort((a, b) => (a.expiry ?? "9999").localeCompare(b.expiry ?? "9999") || a.lot.localeCompare(b.lot));
  }, [itemStock]);
  const ownSerials = useMemo(
    () => (itemStock ?? []).filter((r) => r.serial).sort((a, b) => a.serial.localeCompare(b.serial, "el", { numeric: true })),
    [itemStock]
  );
  function toggleSerial(sn: string) {
    setSerials((cur) => (cur.includes(sn) ? cur.filter((x) => x !== sn) : [...cur, sn]));
  }

  const matches = useMemo(() => {
    const q = searchKey(query.trim());
    if (!q) return [];
    const src: { code: string; description: string }[] = mode === "all" ? catalog : products;
    return src.filter((p) => searchKey(`${p.code} ${p.description}`).includes(q)).slice(0, 15);
  }, [query, products, catalog, mode]);

  // παρτίδες των ΣΥΣΤΑΤΙΚΩΝ στο απόθεμα (η ετικέτα παίρνει την παρτίδα του συστατικού
  // που ανασυσκευάζεται). Κύριο συστατικό πρώτο: ίδιος αριθμός με τον τελικό
  // (71-01-359 -> 40-01-359), αλλιώς το πρώτο της προδιαγραφής. Νωρίτερη λήξη πρώτη.
  const compLots = useMemo(() => {
    const p = mode === "repack" ? byCode.get(code) : undefined;
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
  }, [byCode, code, lots, mode]);
  const lotOptions = compLots.flatMap((c) => c.lots);

  // μία μόνο παρτίδα στο κύριο συστατικό -> μπαίνει αυτόματα
  useEffect(() => {
    const main = compLots[0];
    if (code && !batch && main?.main && main.lots.length === 1) setBatch(main.lots[0].lot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compLots]);

  const qtyValue: number | string | null = !qty.trim() ? null : /^\d+$/.test(qty.trim()) ? Number(qty.trim()) : qty.trim();
  const effKind = mode === "all" ? kind : "batch";
  // όλες οι ετικέτες που θα τυπωθούν: μία ανά επιλεγμένο serial, αλλιώς μία με το Batch/Serial του πεδίου
  const ids = effKind === "serial" && serials.length ? serials : batch.trim() ? [batch.trim()] : [];
  const labelList: LabelData[] = code
    ? (ids.length ? ids : [""]).map((id) => {
        const base = { code, descEl: descEl.trim(), descEn: descEn.trim(), quantity: qtyValue };
        if (effKind !== "serial") return { ...base, batch: id, serial: "" };
        // serial: η παρτίδα έρχεται από το απόθεμα του ίδιου serial (αν υπάρχει)
        const lot = ownSerials.find((r) => r.serial === id)?.lot ?? "";
        return { ...base, batch: lot, serial: id };
      })
    : [];
  const data: LabelData | null = labelList[0] ?? null;
  const dmText = data ? dataMatrixText(data) : "";
  const asciiOk = isAscii(dmText);
  const nCopies = Math.max(1, Math.min(500, Math.floor(Number(copies) || 1)));
  const total = ids.length * nCopies;
  const ready = !!data && ids.length > 0 && qtyValue !== null && qtyValue !== 0;

  async function build(count: number, list: LabelData[] = labelList) {
    if (!list.length) throw new Error("Διάλεξε κωδικό");
    const [{ jsPDF }, bwip, fonts, L] = await Promise.all([import("jspdf"), import("bwip-js"), loadPdfFonts(), import("@/lib/labels")]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = (bwip as any).default ?? bwip;
    return L.labelsPdf(jsPDF, engine, fonts, list.map((d) => ({ data: d, copies: count })), { ...opts, preprinted: true });
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
        const { doc } = await build(1, data ? [data] : []);
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
  }, [code, descEl, descEn, qty, batch, kind, serials[0], opts.offsetXMm, opts.offsetYMm, opts.rotation]);

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
        const canvas = document.createElement("canvas");
        const zpl = labelList.map((d) => L.bitmapToZpl(L.labelBitmap(canvas, engine, d, o, dpi as number, family), nCopies)).join("\n");
        await zebraSend(dev, zpl);
        setSaved(`✓ Στάλθηκ${total > 1 ? `αν ${total} ετικέτες` : "ε 1 ετικέτα"} στον ${dev.name} (${dpi} dpi).`);
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
    if (!labelList.length) return;
    const canvas = document.createElement("canvas");
    const urls = labelList.map((d) => {
      L.labelBitmap(canvas, engine, d, o, 300, family);
      return canvas.toDataURL("image/png");
    });
    const { PW, PH } = pageSize(o);
    const imgs = urls.map((url) => Array.from({ length: nCopies }, () => `<img src="${url}">`).join("")).join("");
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
    const wmsEn = wmsEnglish(code);
    const curEn = st?.description_en ?? "";
    const auto = autoEnglish((mode === "all" ? byCatalog.get(code)?.description : byCode.get(code)?.description) ?? "");
    // αποθηκεύεται μόνο αν ο χρήστης την άλλαξε (όχι αν είναι η αυτόματη ή του WMS)
    const t = descEn.trim();
    const wantEn = t === wmsEn || (!wmsEn && t === auto) ? "" : t;
    const patch: Record<string, unknown> = {};
    if (wantEn !== curEn) patch.description_en = wantEn;
    const n = Number(qty);
    const curUpp = st?.units_per_package ?? st?.units_per_package_wms ?? null;
    if (n > 0 && n !== curUpp && Number.isInteger(n) && !(mode === "all" && n === 1 && curUpp == null)) patch.units_per_package = n;
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

        <div className="lb-modes" role="tablist">
          <button type="button" role="tab" aria-selected={mode === "repack"} className={mode === "repack" ? "on" : ""} onClick={() => setMode("repack")}>
            Ανασυσκευασίες
          </button>
          <button type="button" role="tab" aria-selected={mode === "all"} className={mode === "all" ? "on" : ""} onClick={() => setMode("all")}>
            Όλα τα προϊόντα <span className="n">{catalog.length.toLocaleString("el-GR")}</span>
          </button>
        </div>

        <div className="lb-layout">
          <section className="lb-form">
            <label className="field lb-search">
              {mode === "all" ? "Κωδικός προϊόντος" : "Τελικός κωδικός"}
              <input
                value={query || (code ? `${code} · ${descEl}` : "")}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={(e) => code && !query && e.target.select()}
                placeholder={mode === "all" ? "Οποιοσδήποτε κωδικός ή περιγραφή του WMS" : "Κωδικός ή περιγραφή, π.χ. 71-01-359 ή σωληνάριο"}
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
              {mode === "all" && catalog.length === 0 && (
                <span className="rp-hint">Ο κατάλογος γεμίζει με τον επόμενο συγχρονισμό του WMS (νέο sync-stock.ps1).</span>
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
                    Quantity{mode === "repack" ? " (τεμ.)" : ""}
                    {mode === "repack" ? (
                      <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} placeholder="π.χ. 75" />
                    ) : (
                      <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="π.χ. 1 ή 500 G" />
                    )}
                  </label>
                  <label className="field">
                    {mode === "all" ? (
                      <span className="lb-kind">
                        <button type="button" className={kind === "batch" ? "on" : ""} onClick={() => setKind("batch")}>
                          Batch
                        </button>
                        <button type="button" className={kind === "serial" ? "on" : ""} onClick={() => setKind("serial")}>
                          Serial
                        </button>
                      </span>
                    ) : (
                      "Batch"
                    )}
                    {effKind === "serial" && serials.length > 0 ? (
                      <input value={`${serials.length} επιλεγμένα serial`} readOnly onClick={() => setSerials([])} title="Κλικ για καθάρισμα" />
                    ) : (
                      <input
                        value={batch}
                        onChange={(e) => setBatch(e.target.value.trim())}
                        list="lb-lots"
                        placeholder={effKind === "serial" ? "π.χ. SN123456" : "π.χ. 1236095-01"}
                      />
                    )}
                    <datalist id="lb-lots">
                      {(mode === "all"
                        ? effKind === "serial"
                          ? ownSerials.map((r) => ({ item: r.item, lot: r.serial, position: r.positions, qty: r.qty, expiry: r.expiry }))
                          : ownLots.map((l) => ({ item: code, lot: l.lot, position: l.positions, qty: l.qty, expiry: l.expiry }))
                        : lotOptions
                      ).map((l) => (
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
                {mode === "all" && (
                  <div className="lb-comps">
                    <span className="l">{effKind === "serial" ? "Serial στο απόθεμα" : "Παρτίδες στο απόθεμα"}</span>
                    {itemStock === null && <span className="rp-hint">Φόρτωση αποθέματος…</span>}
                    {stockErr && <span className="rp-notice error">{stockErr}</span>}
                    {itemStock !== null && effKind === "batch" && (
                      ownLots.length ? (
                        <div className="lb-lots">
                          {ownLots.slice(0, 30).map((l) => (
                            <button key={l.lot} type="button" className={`lb-lotbtn ${batch === l.lot ? "on" : ""}`} onClick={() => setBatch(l.lot)} title={`Θέση ${l.positions}`}>
                              <span className="lot">{l.lot}</span>
                              <span className="meta">
                                {l.qty.toLocaleString("el-GR")}
                                {l.expiry ? ` · λ. ${fmtExp(l.expiry)}` : ""}
                                {l.positions ? ` · ${l.positions}` : ""}
                              </span>
                            </button>
                          ))}
                          {ownLots.length > 30 && <span className="rp-hint">+{ownLots.length - 30} ακόμα (γράψε στο πεδίο)</span>}
                        </div>
                      ) : (
                        <span className="rp-hint">
                          Χωρίς παρτίδα στο απόθεμα{ownSerials.length ? ` — έχει ${ownSerials.length} serial (πάτα «Serial»)` : ""}. Μπορείς να τη γράψεις.
                        </span>
                      )
                    )}
                    {itemStock !== null && effKind === "serial" && (
                      ownSerials.length ? (
                        <>
                          <div className="lb-serial-tools">
                            <span className="rp-hint">Διάλεξε ένα ή περισσότερα — μία ετικέτα ανά serial.</span>
                            <button type="button" className="btn ghost sm" onClick={() => setSerials(ownSerials.map((r) => r.serial))}>
                              Όλα ({ownSerials.length})
                            </button>
                            {serials.length > 0 && (
                              <button type="button" className="btn ghost sm" onClick={() => setSerials([])}>
                                Καθάρισμα
                              </button>
                            )}
                          </div>
                          <div className="lb-lots">
                            {ownSerials.slice(0, 200).map((r) => (
                              <button
                                key={`${r.lot}|${r.serial}`}
                                type="button"
                                className={`lb-lotbtn ${serials.includes(r.serial) ? "on" : ""}`}
                                onClick={() => toggleSerial(r.serial)}
                                title={`Θέση ${r.positions}`}
                              >
                                <span className="lot">{r.serial}</span>
                                <span className="meta">
                                  {[r.lot && `παρτ. ${r.lot}`, r.positions].filter(Boolean).join(" · ")}
                                </span>
                              </button>
                            ))}
                          </div>
                        </>
                      ) : (
                        <span className="rp-hint">Δεν υπάρχουν serial στο απόθεμα για αυτόν τον κωδικό — γράψε το serial στο πεδίο.</span>
                      )
                    )}
                  </div>
                )}
                {mode === "repack" && (
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
                )}

                {!asciiOk && (
                  <p className="rp-notice warn">
                    Το DataMatrix θα περιέχει μη λατινικούς χαρακτήρες (στον κωδικό, στο Batch/Serial ή στο Quantity). Οι σαρωτές συνήθως δεν τους διαβάζουν σωστά.
                  </p>
                )}
                {error && <p className="rp-notice error">{error}</p>}
                {saved && <p className="rp-hint">{saved}</p>}

                <div className="lb-actions">
                  <button type="button" className="btn primary" onClick={print} disabled={!ready || busy}>
                    {busy ? "Εκτύπωση…" : `Εκτύπωση ${total > 1 ? `${total} ετικετών` : "ετικέτας"}`}
                  </button>
                  <button type="button" className="btn ghost" onClick={openPdf} disabled={!ready || busy} title="Άνοιγμα ως PDF (αποθήκευση / αρχείο)">
                    PDF
                  </button>
                </div>
                {!ready && <p className="rp-hint">Συμπλήρωσε Quantity και {effKind === "serial" ? "Serial" : "Batch"} για εκτύπωση.</p>}
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
