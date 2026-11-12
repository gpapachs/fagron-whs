"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppBar from "@/components/AppBar";
import KpiTiles from "@/components/KpiTiles";
import LivePill from "@/components/LivePill";
import { createClient } from "@/lib/supabase/client";
import { useCoalesced, useWmsLive } from "@/lib/live";
import { relDate } from "@/lib/format";
import { displayUser } from "@/lib/users";
import { evaluateShipments, isoWeek, parseShipments, weekRank, type CustomerEval, type LineState, type ShipRow, type StockPos } from "@/lib/shipments";

type Upload = { file_name: string | null; rows: number | null; source: string | null; uploaded_by: string | null; uploaded_at: string };
type Scope = "current" | "all" | number;
const LS = "shipments.v1";
const STATE_TXT: Record<LineState, string> = { ok: "Διαθέσιμο", partial: "Μερικώς", none: "Χωρίς απόθεμα" };
const fq = (n: number | null | undefined) => (n == null ? "" : n.toLocaleString("el-GR", { maximumFractionDigits: 3 }));
const fexp = (s: string | null) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(2, 4)}` : "");
const SHIP_COLS = "sheet, row_no, customer, ship_date, week, order_date, doc, po, item, bulk, product, sku, qty_ordered, qty_initial, qty_confirmed, requirements, comments";

const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
function normLine(r: Record<string, unknown>): ShipRow {
  return {
    sheet: String(r.sheet ?? ""),
    row_no: Number(r.row_no) || 0,
    customer: String(r.customer ?? ""),
    ship_date: (r.ship_date as string) ?? null,
    week: num(r.week),
    order_date: (r.order_date as string) ?? null,
    doc: String(r.doc ?? ""),
    po: String(r.po ?? ""),
    item: String(r.item ?? ""),
    bulk: String(r.bulk ?? ""),
    product: String(r.product ?? ""),
    sku: String(r.sku ?? ""),
    qty_ordered: num(r.qty_ordered),
    qty_initial: num(r.qty_initial),
    qty_confirmed: num(r.qty_confirmed),
    requirements: String(r.requirements ?? ""),
    comments: String(r.comments ?? ""),
  };
}

async function loadStockFor(codes: string[]): Promise<StockPos[]> {
  const sb = createClient();
  const out: StockPos[] = [];
  for (let i = 0; i < codes.length; i += 150) {
    const { data, error } = await sb
      .from("wms_stock_v")
      .select("item, position, area, lot, expiry, qty")
      .in("item", codes.slice(i, i + 150))
      .gt("qty", 0)
      .range(0, 9999);
    if (error) throw new Error(error.message);
    for (const r of (data as Record<string, unknown>[]) ?? [])
      out.push({ item: String(r.item), position: String(r.position ?? ""), area: (r.area as string) ?? null, lot: (r.lot as string) ?? null, expiry: (r.expiry as string) ?? null, qty: Number(r.qty) || 0 });
  }
  return out;
}

const codesOf = (rows: ShipRow[]) => [...new Set(rows.flatMap((r) => [r.item, r.bulk].filter(Boolean)))];

export default function ShipmentsBoard({ userEmail, role }: { userEmail: string | null; role: "admin" | "staff" }) {
  const [rows, setRows] = useState<ShipRow[] | null>(null);
  const [stock, setStock] = useState<StockPos[]>([]);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState(0);
  const [scope, setScope] = useState<Scope>("current");
  const [noWeek, setNoWeek] = useState(true);
  const [cust, setCust] = useState("");
  const [state, setState] = useState<"all" | LineState>("all");
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);
  const current = isoWeek(new Date()).week;

  useEffect(() => {
    try {
      const s = JSON.parse(window.localStorage.getItem(LS) ?? "{}");
      if (s.scope != null) setScope(s.scope);
      if (typeof s.noWeek === "boolean") setNoWeek(s.noWeek);
    } catch {
      /* τίποτα */
    }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(LS, JSON.stringify({ scope, noWeek }));
    } catch {
      /* τίποτα */
    }
  }, [scope, noWeek]);

  const loadAll = useCallback(async () => {
    setError(null);
    const sb = createClient();
    const [l, u] = await Promise.all([
      sb.from("shipment_lines").select(SHIP_COLS).order("sheet").order("row_no").range(0, 9999),
      sb.from("shipment_uploads").select("file_name, rows, source, uploaded_by, uploaded_at").order("uploaded_at", { ascending: false }).limit(1),
    ]);
    if (l.error) {
      setLoading(false);
      return setError(`Οι αποστολές δεν φορτώθηκαν: ${l.error.message}`);
    }
    const r = ((l.data as Record<string, unknown>[]) ?? []).map(normLine);
    setUpload(((u.data as Upload[] | null) ?? [])[0] ?? null);
    try {
      setStock(await loadStockFor(codesOf(r)));
    } catch (e) {
      setError(`Το απόθεμα δεν φορτώθηκε: ${(e as Error).message}`);
    }
    setRows(r);
    setLoading(false);
  }, []);
  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // live: αλλαγή αποθέματος κωδικών που μας αφορούν, πλήρης συγχρονισμός ή νέο Excel
  const pending = useRef<Set<string>>(new Set());
  const full = useRef(false);
  const flush = useCoalesced(async () => {
    const items = [...pending.current];
    const all = full.current;
    pending.current = new Set();
    full.current = false;
    try {
      if (all) await loadAll();
      else if (items.length) {
        const fresh = await loadStockFor(items);
        const set = new Set(items);
        setStock((cur) => [...cur.filter((s) => !set.has(s.item)), ...fresh]);
      }
      setFlash((x) => x + 1);
    } catch {
      /* επόμενο σήμα */
    }
  });
  const codeSet = useMemo(() => new Set(codesOf(rows ?? [])), [rows]);
  const live = useWmsLive((sig) => {
    if (sig.key === "shipments" || sig.key === "stock_full") {
      full.current = true;
      flush();
    } else if (sig.key === "stock") {
      const mine = sig.items.filter((i) => codeSet.has(i));
      if (!mine.length) return;
      mine.forEach((i) => pending.current.add(i));
      flush();
    }
  });

  const evals = useMemo<CustomerEval[]>(() => (rows ? evaluateShipments(rows, stock, { currentWeek: current, scope, includeNoWeek: noWeek }) : []), [rows, stock, current, scope, noWeek]);
  const weeks = useMemo(
    () => [...new Set((rows ?? []).map((r) => r.week).filter((w): w is number => w != null))].sort((a, b) => (weekRank(a, current) ?? 0) - (weekRank(b, current) ?? 0)),
    [rows, current]
  );

  const t = q.trim().toLowerCase();
  const shown = useMemo(
    () =>
      evals
        .filter((c) => !cust || c.sheet === cust)
        .map((c) => ({
          ...c,
          lines: c.lines.filter(
            (l) => (state === "all" || l.state === state) && (!t || [l.item, l.bulk, l.product, l.doc, l.po, c.customer, c.sheet].some((x) => x.toLowerCase().includes(t)))
          ),
        }))
        .filter((c) => c.lines.length),
    [evals, cust, state, t]
  );
  const tot = evals
    .filter((c) => !cust || c.sheet === cust)
    .reduce((a, c) => ({ lines: a.lines + c.lines.length, ok: a.ok + c.ok, partial: a.partial + c.partial, none: a.none + c.none }), { lines: 0, ok: 0, partial: 0, none: 0 });

  const scopeTxt = scope === "current" ? `Εβδομάδα ${current} και μετά` : scope === "all" ? "Όλες οι εβδομάδες" : `Εβδομάδα ${scope}`;

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setBusy("upload");
    setError(null);
    setNotice(null);
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await f.arrayBuffer(), { cellDates: true });
      const sheets = wb.SheetNames.map((n) => ({ name: n, rows: XLSX.utils.sheet_to_json<(string | number | Date | null)[]>(wb.Sheets[n], { header: 1, raw: true, defval: null }) }));
      const parsed = parseShipments(sheets);
      if (!parsed.length) throw new Error("Δεν βρέθηκαν γραμμές με «ITEM CODE» — είναι το σωστό αρχείο;");
      const { error: err } = await createClient().rpc("shipments_replace", { p_rows: parsed, p_file: f.name, p_source: "upload" });
      if (err) throw new Error(err.message);
      setNotice(`Φορτώθηκαν ${parsed.length} γραμμές από ${new Set(parsed.map((r) => r.sheet)).size} φύλλα (${f.name}).`);
      await loadAll();
    } catch (er) {
      setError(`Το Excel δεν φορτώθηκε: ${(er as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const meta = () => ({ generatedAt: new Date(), userEmail, filters: [], syncedAt: null, scope: scopeTxt, source: upload?.file_name ?? undefined });
  async function excel() {
    setBusy("excel");
    try {
      const [XLSX, ex] = await Promise.all([import("xlsx"), import("@/lib/exports")]);
      const { wb, fileName } = ex.shipmentsWorkbook(XLSX, shown, meta());
      XLSX.writeFile(wb, fileName);
    } finally {
      setBusy(null);
    }
  }
  async function pdf() {
    setBusy("pdf");
    try {
      const [{ jsPDF }, { autoTable }, ex, { loadPdfFonts }] = await Promise.all([import("jspdf"), import("jspdf-autotable"), import("@/lib/exports"), import("@/lib/pdfFonts")]);
      const { doc, fileName } = ex.shipmentsPdf(jsPDF, autoTable, await loadPdfFonts(), shown, meta());
      doc.save(fileName);
    } finally {
      setBusy(null);
    }
  }

  const toggle = (s: string) =>
    setClosed((cur) => {
      const n = new Set(cur);
      if (n.has(s)) n.delete(s);
      else n.add(s);
      return n;
    });

  return (
    <>
      <AppBar email={userEmail} role={role} />
      <div className="wrap stock">
        <div className="header">
          <div className="titleblock">
            <h1>Αποστολές FSSE</h1>
            <p>
              <LivePill connected={live.connected} lastAt={live.lastAt} flash={flash} /> Οι ανοιχτές γραμμές του κοινόχρηστου Excel ανά πελάτη, με το διαθέσιμο απόθεμα του WMS
              τώρα. Ποσότητα: Confirmed → Initial → Ordered. Το ίδιο απόθεμα μοιράζεται με σειρά εβδομάδας αποστολής.
            </p>
            {upload && (
              <p className="dim sh-src">
                Πηγή: <b>{upload.file_name ?? "Excel"}</b> · {upload.rows ?? 0} γραμμές · {relDate(upload.uploaded_at)}
                {upload.uploaded_by ? ` · ${displayUser(upload.uploaded_by)}` : ""}
              </p>
            )}
          </div>
          <div className="st-actions">
            <input ref={fileRef} type="file" accept=".xlsx,.xlsm,.xls" hidden onChange={onFile} />
            <button type="button" className="btn primary" onClick={() => fileRef.current?.click()} disabled={busy === "upload"}>
              {busy === "upload" ? "Φόρτωση…" : "Ανέβασμα Excel"}
            </button>
            <button type="button" className="btn ghost" onClick={pdf} disabled={!!busy || !shown.length}>
              {busy === "pdf" ? "PDF…" : "PDF"}
            </button>
            <button type="button" className="btn ghost" onClick={excel} disabled={!!busy || !shown.length}>
              {busy === "excel" ? "Excel…" : "Excel"}
            </button>
          </div>
        </div>

        <div className="st-filters an-filters">
          <label className="field">
            Εβδομάδα
            <select
              value={String(scope)}
              onChange={(e) => {
                const v = e.target.value;
                setScope(v === "current" || v === "all" ? v : Number(v));
              }}
            >
              <option value="current">Τρέχουσα ({current}) και μετά</option>
              <option value="all">Όλες</option>
              {weeks.map((w) => (
                <option key={w} value={w}>
                  W{w}
                  {w === current ? " (τρέχουσα)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Πελάτης
            <select value={cust} onChange={(e) => setCust(e.target.value)}>
              <option value="">Όλοι</option>
              {evals.map((c) => (
                <option key={c.sheet} value={c.sheet}>
                  {c.sheet}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Αναζήτηση
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="κωδικός, περιγραφή, ΠΑΡ, PO" />
          </label>
          <label className="st-check">
            <input type="checkbox" checked={noWeek} onChange={(e) => setNoWeek(e.target.checked)} /> Και γραμμές χωρίς εβδομάδα
          </label>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              setScope("current");
              setNoWeek(true);
              setCust("");
              setState("all");
              setQ("");
            }}
          >
            Καθαρισμός
          </button>
        </div>

        {error && <p className="rp-notice error">{error}</p>}
        {notice && <p className="rp-notice ok">{notice}</p>}
        {loading && <p className="rp-hint">Φόρτωση…</p>}
        {!loading && rows && !rows.length && <p className="rp-hint">Δεν υπάρχουν γραμμές. Πάτησε «Ανέβασμα Excel» και διάλεξε το «FSSE SHIPMENTS».</p>}

        {rows && rows.length > 0 && (
          <>
            <KpiTiles
              active={state}
              onPick={(k) => setState((cur) => (cur === k ? "all" : (k as LineState)))}
              items={[
                { key: "all", label: `Γραμμές · ${shown.length} πελάτες`, value: tot.lines, tone: "neutral" },
                { key: "ok", label: "Διαθέσιμες", value: tot.ok, tone: "green", hint: "Το απόθεμα του κωδικού καλύπτει την ποσότητα" },
                { key: "partial", label: "Μερικώς", value: tot.partial, tone: "yellow", hint: "Υπάρχει απόθεμα αλλά λιγότερο από την ποσότητα" },
                { key: "none", label: "Χωρίς απόθεμα", value: tot.none, tone: "red", hint: "Ο κωδικός δεν έχει απόθεμα (δες το bulk)" },
              ]}
            />
            <div className="an-bar">
              <span className="dim">
                {scopeTxt}
                {noWeek ? " · μαζί οι γραμμές χωρίς εβδομάδα" : ""}
              </span>
              <span className="an-right">
                <button type="button" className="btn ghost sm" onClick={() => setClosed(new Set())}>
                  Άνοιγμα όλων
                </button>
                <button type="button" className="btn ghost sm" onClick={() => setClosed(new Set(shown.map((c) => c.sheet)))}>
                  Κλείσιμο όλων
                </button>
              </span>
            </div>
            {!shown.length && <p className="rp-hint">Καμία γραμμή με αυτά τα φίλτρα.</p>}
            {shown.map((c) => (
              <section key={c.sheet} className={`sh-cust ${c.color}`}>
                <button type="button" className="sh-head" onClick={() => toggle(c.sheet)} aria-expanded={!closed.has(c.sheet)}>
                  <span className="sh-name">
                    <b>{c.sheet}</b> <span className="dim">{c.customer !== c.sheet ? c.customer : ""}</span>
                  </span>
                  <span className="sh-weeks">{c.weeks.map((w) => `W${w}`).join(" ")}</span>
                  <span className="sh-counts">
                    <span className="sh-badge ok">{c.ok}</span>
                    <span className="sh-badge partial">{c.partial}</span>
                    <span className="sh-badge none">{c.none}</span>
                  </span>
                  <span className="sh-caret">{closed.has(c.sheet) ? "▸" : "▾"}</span>
                </button>
                {!closed.has(c.sheet) && (
                  <div className="st-tablewrap">
                    <table className="st-table st-cards sh-table">
                      <thead>
                        <tr>
                          <th>Εβδ.</th>
                          <th>ΠΑΡ / PO</th>
                          <th>Κωδικός</th>
                          <th>Περιγραφή</th>
                          <th className="num">Ποσότητα</th>
                          <th className="num">Απόθεμα</th>
                          <th>Κατάσταση</th>
                          <th>Θέσεις</th>
                          <th>Bulk</th>
                          <th>Σημειώσεις</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.lines.map((l) => (
                          <tr key={`${l.sheet}-${l.row_no}`} className={`sh-row ${l.state}`}>
                            <td data-label="Εβδ.">{l.week ? `W${l.week}` : <span className="dim">—</span>}</td>
                            <td data-label="ΠΑΡ / PO">
                              {l.doc}
                              {l.po && <div className="dim">{l.po}</div>}
                            </td>
                            <td data-label="Κωδικός">
                              <b>{l.item}</b>
                            </td>
                            <td data-label="Περιγραφή">
                              {l.product}
                              {l.sku && <span className="dim"> · {l.sku}</span>}
                            </td>
                            <td className="num" data-label="Ποσότητα" title={`Ordered ${fq(l.qty_ordered)} · Initial ${fq(l.qty_initial)} · Confirmed ${fq(l.qty_confirmed)}`}>
                              <b>{fq(l.need)}</b>
                            </td>
                            <td className="num" data-label="Απόθεμα">
                              {fq(l.itemStock)}
                              {l.state !== "ok" && l.allocated > 0 && l.allocated < l.need ? <div className="dim">λείπουν {fq(l.need - l.allocated)}</div> : null}
                              {l.state === "none" && l.itemStock > 0 ? <div className="dim">δεσμευμένο σε προηγούμενες</div> : null}
                            </td>
                            <td data-label="Κατάσταση">
                              <span className={`sh-state ${l.state}`}>{STATE_TXT[l.state]}</span>
                            </td>
                            <td data-label="Θέσεις" className="sh-pos">
                              {l.positions.length ? (
                                l.positions.map((p, i) => (
                                  <div key={i}>
                                    <span className="rack">{p.position}</span> {fq(p.qty)}
                                    {(p.lot || p.expiry) && (
                                      <span className="dim">
                                        {" "}
                                        · {p.lot}
                                        {p.expiry ? ` · ${fexp(p.expiry)}` : ""}
                                      </span>
                                    )}
                                    {p.area && <div className="dim sh-area">{p.area}</div>}
                                  </div>
                                ))
                              ) : (
                                <span className="dim">—</span>
                              )}
                            </td>
                            <td data-label="Bulk">
                              {l.bulk ? (
                                <>
                                  {l.bulk}
                                  <div className={l.bulkStock ? "" : "dim"}>{fq(l.bulkStock ?? 0)}</div>
                                </>
                              ) : (
                                <span className="dim">—</span>
                              )}
                            </td>
                            <td data-label="Σημειώσεις" className="sh-notes">
                              {l.requirements && <div className="sh-req">{l.requirements}</div>}
                              {l.comments && <div>{l.comments}</div>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            ))}
          </>
        )}
      </div>
    </>
  );
}
