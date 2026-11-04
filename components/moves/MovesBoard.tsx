"use client";

import FilterFold from "@/components/FilterFold";
import { fullDate, relDate } from "@/lib/format";
import { useEffect, useState } from "react";
import AppBar from "@/components/AppBar";
import { createClient } from "@/lib/supabase/client";
import { loadPdfFonts } from "@/lib/pdfFonts";
import LivePill from "@/components/LivePill";
import { useWmsLive } from "@/lib/live";
import type { MoveRow } from "@/lib/exports";

type F = { item: string; lot: string; serial: string; customer: string; from: string; to: string; fromPos: string; toPos: string; type: string; doc: string };
const LIMIT = 2000;
const LS = "moves.filters.v1";
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86400000));
const EMPTY = (): F => ({ item: "", lot: "", serial: "", customer: "", from: daysAgo(7), to: iso(new Date()), fromPos: "", toPos: "", type: "", doc: "" });
const fmtQty = (n: number | null) => (n == null ? "" : n.toLocaleString("el-GR", { maximumFractionDigits: 3 }));
// τα % και _ του χρήστη να μη γίνονται μπαλαντέρ στο ilike
const esc = (s: string) => s.trim().replace(/[\\%_]/g, (c) => `\\${c}`);

export default function MovesBoard({ userEmail, role }: { userEmail: string | null; role: "admin" | "staff" }) {
  const [f, setF] = useState<F>(EMPTY);
  const [rows, setRows] = useState<MoveRow[] | null>(null); // null = δεν έγινε αναζήτηση ακόμα
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<string | null | undefined>(undefined);
  const [auto, setAuto] = useState(true); // live: ξανατρέχει την αναζήτηση όταν έρθουν νέες κινήσεις
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const searched = rows !== null;
  const live = useWmsLive((sig) => {
    if (sig.key !== "moves") return;
    setLast(sig.at);
    if (auto && searched) search(undefined, true);
  });

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LS);
      // κρατά τα φίλτρα κειμένου· οι ημερομηνίες ξεκινούν πάντα από την τελευταία εβδομάδα
      if (raw) setF({ ...EMPTY(), ...JSON.parse(raw), from: EMPTY().from, to: EMPTY().to });
    } catch {
      /* τίποτα */
    }
    // μόνο η ώρα της τελευταίας κίνησης (ελαφρύ) -- όχι κινήσεις
    createClient()
      .rpc("wms_moves_last")
      .then(({ data }) => setLast((data as string | null) ?? null), () => setLast(null));
  }, []);

  function filterLabels() {
    const out: string[] = [];
    if (f.from || f.to) out.push(`${f.from ? f.from.split("-").reverse().join("/") : "…"} – ${f.to ? f.to.split("-").reverse().join("/") : "…"}`);
    if (f.item) out.push(`κωδικός ${f.item}`);
    if (f.lot) out.push(`batch ${f.lot}`);
    if (f.serial) out.push(`serial ${f.serial}`);
    if (f.customer) out.push(`πελάτης «${f.customer}»`);
    if (f.fromPos) out.push(`από θέση ${f.fromPos}…`);
    if (f.toPos) out.push(`προς θέση ${f.toPos}…`);
    if (f.type) out.push(`κίνηση «${f.type}»`);
    if (f.doc) out.push(`παραστατικό ${f.doc}`);
    return out;
  }

  async function search(e?: React.FormEvent, silent = false) {
    e?.preventDefault();
    if (!silent) setLoading(true);
    setError(null);
    try {
      window.localStorage.setItem(LS, JSON.stringify({ ...f, from: undefined, to: undefined }));
    } catch {
      /* τίποτα */
    }
    try {
      let q = createClient()
        .from("wms_moves_v")
        .select("id, moved_at, type, doc, item, description, lot, serial, qty, from_pos, to_pos, customer, username", { count: "exact" });
      if (f.item.trim()) q = q.ilike("item", `${esc(f.item)}%`);
      if (f.lot.trim()) q = q.ilike("lot", `%${esc(f.lot)}%`);
      if (f.serial.trim()) q = q.ilike("serial", `%${esc(f.serial)}%`);
      if (f.customer.trim()) q = q.ilike("customer", `%${esc(f.customer)}%`);
      if (f.fromPos.trim()) q = q.ilike("from_pos", `${esc(f.fromPos)}%`);
      if (f.toPos.trim()) q = q.ilike("to_pos", `${esc(f.toPos)}%`);
      if (f.type.trim()) q = q.ilike("type", `%${esc(f.type)}%`);
      if (f.doc.trim()) q = q.ilike("doc", `%${esc(f.doc)}%`);
      if (f.from) q = q.gte("moved_at", new Date(`${f.from}T00:00:00`).toISOString());
      if (f.to) q = q.lt("moved_at", new Date(new Date(`${f.to}T00:00:00`).getTime() + 86400000).toISOString());
      const { data, error: err, count } = await q.order("moved_at", { ascending: false }).order("id").limit(LIMIT);
      if (err) throw new Error(err.message);
      const list = ((data ?? []) as MoveRow[]).map((r) => ({ ...r, qty: r.qty == null ? null : Number(r.qty) }));
      // live: φωτίζει όσες κινήσεις δεν υπήρχαν στην προηγούμενη λίστα
      setRows((prev) => {
        const old = new Set((prev ?? []).map((r) => r.id));
        setNewIds(silent && prev ? new Set(list.filter((r) => !old.has(r.id)).map((r) => r.id)) : new Set());
        return list;
      });
      setTotal(count ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const meta = () => ({ generatedAt: new Date(), userEmail, filters: filterLabels(), syncedAt: null });
  async function run(id: string, fn: () => Promise<void>) {
    setBusy(id);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(`Η εξαγωγή απέτυχε: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }
  const excel = () =>
    run("xlsx", async () => {
      const [XLSX, ex] = await Promise.all([import("xlsx"), import("@/lib/exports")]);
      const { wb, fileName } = ex.movesWorkbook(XLSX, rows ?? [], meta());
      XLSX.writeFile(wb, fileName);
    });
  const pdf = () =>
    run("pdf", async () => {
      const [{ jsPDF }, { autoTable }, ex, fonts] = await Promise.all([import("jspdf"), import("jspdf-autotable"), import("@/lib/exports"), loadPdfFonts()]);
      const { doc, fileName } = ex.movesPdf(jsPDF, autoTable, fonts, rows ?? [], meta());
      doc.save(fileName);
    });

  const field = (k: keyof F, label: string, ph = "", type = "text") => (
    <label className="field">
      {label}
      <input type={type} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder={ph} />
    </label>
  );

  return (
    <>
      <AppBar email={userEmail} role={role} />
      <div className="wrap stock">
        <div className="header">
          <div className="titleblock">
            <h1>Κινήσεις</h1>
            <p>
              <LivePill connected={live.connected} lastAt={live.lastAt ?? last ?? null} /> Κινήσεις του WMS. Δεν φορτώνεται τίποτα μέχρι να πατήσεις <b>Αναζήτηση</b>.{" "}
              {last === null && "Δεν έχουν συγχρονιστεί ακόμα κινήσεις."}
              {last && <span title={fullDate(last)}>Τελευταία κίνηση: {relDate(last)}.</span>}
            </p>
          </div>
          <div className="st-actions">
            <label className="st-check" title="Όταν έρθουν νέες κινήσεις, η αναζήτηση ξανατρέχει μόνη της">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
              Αυτόματη ανανέωση
            </label>
            <button type="button" className="btn ghost" onClick={excel} disabled={!!busy || !rows?.length}>
              {busy === "xlsx" ? "Excel…" : "Excel"}
            </button>
            <button type="button" className="btn ghost" onClick={pdf} disabled={!!busy || !rows?.length}>
              {busy === "pdf" ? "PDF…" : "PDF"}
            </button>
          </div>
        </div>

        <FilterFold active={[f.item, f.lot, f.serial, f.customer, f.fromPos, f.toPos, f.type, f.doc].filter((x) => x.trim()).length}>
<form className="st-filters mv-filters" onSubmit={search}>
          {field("item", "Κωδικός", "π.χ. 71-01-359 ή 71-01")}
          {field("lot", "Batch", "παρτίδα")}
          {field("serial", "Serial")}
          {field("customer", "Πελάτης", "μέρος του ονόματος")}
          {field("from", "Από ημερομηνία", "", "date")}
          {field("to", "Έως ημερομηνία", "", "date")}
          {field("fromPos", "Από θέση", "π.χ. 16.01")}
          {field("toPos", "Προς θέση", "π.χ. 99.")}
          {field("type", "Είδος κίνησης", "π.χ. αποστολή")}
          {field("doc", "Παραστατικό")}
          <div className="mv-buttons">
            <button type="submit" className="btn primary" disabled={loading}>
              {loading ? "Αναζήτηση…" : "Αναζήτηση"}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                setF(EMPTY());
                setRows(null);
                setTotal(null);
              }}
            >
              Καθάρισμα
            </button>
          </div>
        </form>
        </FilterFold>

        {error && <p className="rp-notice error">{error}</p>}
        {rows !== null && (
          <div className="st-summary">
            <span>
              <b>{rows.length.toLocaleString("el-GR")}</b> κινήσεις
              {total !== null && total > rows.length && ` (από ${total.toLocaleString("el-GR")} — στενέψτε τα φίλτρα για να δείτε όλες)`}
            </span>
          </div>
        )}

        {rows !== null && (
          <div className="st-tablewrap">
            <table className="st-table st-cards">
              <thead>
                <tr>
                  {["Ημερομηνία", "Κίνηση", "Παραστατικό", "Κωδικός", "Περιγραφή", "Batch", "Serial", "Ποσότητα", "Από", "Προς", "Πελάτης", "Χρήστης"].map((h, i) => (
                    <th key={h} className={i === 7 ? "num" : ""}>
                      <span className="mv-th">{h}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={newIds.has(r.id) ? "st-new" : ""}>
                    <td className="mono reldate" data-label="Ημερομηνία" title={fullDate(r.moved_at)}>{relDate(r.moved_at)}</td>
                    <td data-label="Κίνηση">{r.type}</td>
                    <td className="mono" data-label="Παραστατικό">{r.doc}</td>
                    <td className="mono" data-label="Κωδικός">
                      <button type="button" className="st-link" onClick={() => setF({ ...f, item: r.item })} title="Φίλτρο σε αυτόν τον κωδικό">
                        {r.item}
                      </button>
                    </td>
                    <td className="st-desc" data-label="Περιγραφή">{r.description}</td>
                    <td className="mono" data-label="Batch">{r.lot}</td>
                    <td className="mono" data-label="Serial">{r.serial}</td>
                    <td className="num" data-label="Ποσότητα">{fmtQty(r.qty)}</td>
                    <td data-label="Από">{r.from_pos && <span className="rack">{r.from_pos}</span>}</td>
                    <td data-label="Προς">{r.to_pos && <span className="rack">{r.to_pos}</span>}</td>
                    <td data-label="Πελάτης">{r.customer}</td>
                    <td className="dim" data-label="Χρήστης">{r.username}</td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={12} className="st-empty">
                      Καμία κίνηση με αυτά τα φίλτρα.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
