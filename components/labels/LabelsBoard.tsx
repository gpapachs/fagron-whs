"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import AppBar from "@/components/AppBar";
import { createClient } from "@/lib/supabase/client";
import { loadPdfFonts } from "@/lib/pdfFonts";
import { DEFAULT_LABEL_OPTIONS, dataMatrixText, isAscii, type LabelData, type LabelOptions } from "@/lib/labels";
import type { ProductSettings } from "@/lib/repack";

export type LabelProduct = { code: string; description: string };
export type LotRow = { item: string; lot: string; expiry: string | null; position: string; qty: number };

const LS_OPTS = "labels.options.v1";
const PRINTER_HINT = "Packaging Station 2";

function loadOpts(): LabelOptions {
  try {
    const raw = window.localStorage.getItem(LS_OPTS);
    if (raw) return { ...DEFAULT_LABEL_OPTIONS, ...JSON.parse(raw), preprinted: true };
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

  const byCode = useMemo(() => new Map(products.map((p) => [p.code, p])), [products]);

  useEffect(() => setOpts(loadOpts()), []);
  useEffect(() => {
    try {
      window.localStorage.setItem(LS_OPTS, JSON.stringify({ offsetXMm: opts.offsetXMm, offsetYMm: opts.offsetYMm }));
    } catch {
      /* τίποτα */
    }
  }, [opts.offsetXMm, opts.offsetYMm]);

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

  function choose(c: string) {
    const p = byCode.get(c);
    if (!p) return;
    const st = settings[c];
    setCode(c);
    setQuery("");
    setDescEl(p.description);
    setDescEn(st?.description_en || st?.description_en_wms || "");
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

  // παρτίδες που υπάρχουν στο απόθεμα για τον τελικό κωδικό (προτάσεις)
  const lotOptions = useMemo(() => {
    const m = new Map<string, LotRow>();
    for (const l of lots) if (l.item === code && l.lot && !m.has(l.lot)) m.set(l.lot, l);
    return [...m.values()];
  }, [lots, code]);

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
  }, [code, descEl, descEn, qty, batch, opts.offsetXMm, opts.offsetYMm]);

  async function print() {
    setBusy(true);
    setError(null);
    try {
      const { doc } = await build(nCopies);
      doc.autoPrint();
      const url = URL.createObjectURL(doc.output("blob"));
      const w = window.open(url, "_blank");
      if (!w) setError("Ο browser μπλόκαρε το νέο παράθυρο — επίτρεψε τα αναδυόμενα για αυτή τη σελίδα, ή πάτα «Λήψη PDF».");
      rememberEnglish();
    } catch (e) {
      setError(`Η δημιουργία απέτυχε: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    setBusy(true);
    try {
      const { doc } = await build(nCopies);
      doc.save(`etiketa-${code}-${batch || "x"}.pdf`);
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
    const wmsEn = st?.description_en_wms ?? "";
    const curEn = st?.description_en ?? "";
    const wantEn = descEn.trim() === wmsEn ? "" : descEn.trim();
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
                      {st?.description_en ? "· αποθηκευμένη" : st?.description_en_wms ? "· από το WMS" : "· δεν υπάρχει — γράψ' τη"}
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
                        <option key={l.lot} value={l.lot}>
                          {`${l.position} · ${l.qty}${l.expiry ? ` · λ. ${l.expiry}` : ""}`}
                        </option>
                      ))}
                    </datalist>
                  </label>
                  <label className="field">
                    Αντίτυπα
                    <input inputMode="numeric" value={copies} onChange={(e) => setCopies(e.target.value.replace(/\D/g, ""))} />
                  </label>
                </div>
                {lotOptions.length > 0 && !batch && (
                  <p className="rp-hint">
                    Παρτίδες στο απόθεμα:{" "}
                    {lotOptions.slice(0, 6).map((l) => (
                      <button key={l.lot} type="button" className="rp-link lb-lot" onClick={() => setBatch(l.lot)}>
                        {l.lot}
                      </button>
                    ))}
                  </p>
                )}

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
                  <button type="button" className="btn ghost" onClick={download} disabled={!ready || busy}>
                    Λήψη PDF
                  </button>
                </div>
                {!ready && <p className="rp-hint">Συμπλήρωσε Quantity και Batch για εκτύπωση.</p>}
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
            <details className="lb-setup" open={showSetup} onToggle={(e) => setShowSetup((e.target as HTMLDetailsElement).open)}>
              <summary>Ευθυγράμμιση με το χαρτί</summary>
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
