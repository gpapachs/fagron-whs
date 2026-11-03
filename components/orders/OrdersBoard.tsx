"use client";

import { useEffect, useMemo, useState } from "react";
import AppBar from "@/components/AppBar";
import LivePill from "@/components/LivePill";
import { createClient } from "@/lib/supabase/client";
import { loadPdfFonts } from "@/lib/pdfFonts";
import { useWmsLive } from "@/lib/live";
import { groupOrdersByList, type OrderRow } from "@/lib/exports";

type Status = "all" | "open" | "collected";
type F = { customer: string; item: string; lot: string; sn: string; doc: string; erp: string; list: string; picker: string; from: string; to: string; status: Status };
const LIMIT = 3000;
const LS = "orders.filters.v1";
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const EMPTY = (): F => ({ customer: "", item: "", lot: "", sn: "", doc: "", erp: "", list: "", picker: "", from: iso(new Date(Date.now() - 2 * 86400000)), to: iso(new Date()), status: "all" });
const fmtDt = (s: string | null) => (s ? new Date(s).toLocaleString("el-GR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
const fmtQty = (n: number | null) => (n == null ? "" : n.toLocaleString("el-GR", { maximumFractionDigits: 3 }));
const esc = (s: string) => s.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
const COLS =
  "id, order_id, list_no, doc_type, doc_no, erp_code, order_date, customer, item, description, lot, sn, qty, init_qty, from_pos, to_pos, wms_status, line_no, collected, collected_at, collected_by, picker";

export default function OrdersBoard({ userEmail, role }: { userEmail: string | null; role: "admin" | "staff" }) {
  const [f, setF] = useState<F>(EMPTY);
  const [rows, setRows] = useState<OrderRow[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [last, setLast] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LS);
      if (raw) setF({ ...EMPTY(), ...JSON.parse(raw), from: EMPTY().from, to: EMPTY().to });
    } catch {
      /* τίποτα */
    }
    createClient()
      .rpc("wms_orders_last")
      .then(({ data }) => setLast((data as string | null) ?? null), () => setLast(null));
  }, []);

  // live: νέα παραγγελίες από το sync ή αλλαγή κατάστασης από άλλο χρήστη
  const live = useWmsLive((sig) => {
    if (rows === null) return;
    if (sig.key === "orders" || sig.key === "orders_sync") search(undefined, true);
  });

  function filterLabels() {
    const out: string[] = [];
    out.push(`${f.from ? f.from.split("-").reverse().join("/") : "…"} – ${f.to ? f.to.split("-").reverse().join("/") : "…"}`);
    if (f.customer) out.push(`πελάτης «${f.customer}»`);
    if (f.item) out.push(`κωδικός ${f.item}`);
    if (f.lot) out.push(`batch ${f.lot}`);
    if (f.sn) out.push(`SN ${f.sn}`);
    if (f.doc) out.push(`παραστατικό ${f.doc}`);
    if (f.erp) out.push(`ERP ${f.erp}`);
    if (f.list) out.push(`λίστα ${f.list}`);
    if (f.picker) out.push(`συλλογή από «${f.picker}»`);
    if (f.status !== "all") out.push(f.status === "collected" ? "Collected" : "Non Collected");
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
      let q = createClient().from("wms_orders_v").select(COLS, { count: "exact" });
      if (f.customer.trim()) q = q.ilike("customer", `%${esc(f.customer)}%`);
      if (f.item.trim()) q = q.ilike("item", `${esc(f.item)}%`);
      if (f.lot.trim()) q = q.ilike("lot", `%${esc(f.lot)}%`);
      if (f.sn.trim()) q = q.ilike("sn", `%${esc(f.sn)}%`);
      if (f.doc.trim()) q = q.ilike("doc_no", `%${esc(f.doc)}%`);
      if (f.erp.trim()) q = q.ilike("erp_code", `%${esc(f.erp)}%`);
      if (f.picker.trim()) q = q.ilike("picker", `%${esc(f.picker)}%`);
      if (f.list.trim()) {
        // λίστα: ακριβής αριθμός ή πολλοί χωρισμένοι με κόμμα/κενό
        const lists = f.list.split(/[\s,;]+/).filter(Boolean);
        q = lists.length > 1 ? q.in("list_no", lists) : q.eq("list_no", lists[0]);
      } else {
        if (f.from) q = q.gte("order_date", new Date(`${f.from}T00:00:00`).toISOString());
        if (f.to) q = q.lt("order_date", new Date(new Date(`${f.to}T00:00:00`).getTime() + 86400000).toISOString());
      }
      if (f.status === "open") q = q.eq("collected", false);
      if (f.status === "collected") q = q.eq("collected", true);
      const { data, error: err, count } = await q
        .order("order_date", { ascending: false })
        .order("list_no", { ascending: false })
        .order("line_no", { ascending: true })
        .order("id")
        .limit(LIMIT);
      if (err) throw new Error(err.message);
      const list = ((data ?? []) as OrderRow[]).map((r) => ({
        ...r,
        qty: r.qty == null ? null : Number(r.qty),
        init_qty: r.init_qty == null ? null : Number(r.init_qty),
      }));
      setRows(list);
      setTotal(count ?? null);
      // κρατά μόνο επιλογές που υπάρχουν ακόμα
      setSel((cur) => new Set([...cur].filter((id) => list.some((r) => r.id === id))));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const pickers = (lines: OrderRow[]) => [...new Set(lines.map((l) => l.picker).filter(Boolean))].join(", ");
  const groups = useMemo(() => groupOrdersByList(rows ?? []), [rows]);
  const toggle = (ids: string[], on: boolean) =>
    setSel((cur) => {
      const n = new Set(cur);
      for (const id of ids) {
        if (on) n.add(id);
        else n.delete(id);
      }
      return n;
    });
  const allIds = (rows ?? []).map((r) => r.id);
  const allOn = allIds.length > 0 && allIds.every((id) => sel.has(id));
  const selRows = (rows ?? []).filter((r) => sel.has(r.id));
  const selLists = new Set(selRows.map((r) => r.list_no || r.order_id));

  async function setCollected(value: boolean) {
    if (!sel.size) return;
    setBusy(value ? "c1" : "c0");
    setError(null);
    try {
      const ids = [...sel];
      const { data, error: err } = await createClient().rpc("wms_orders_set_collected", { p_ids: ids, p_value: value });
      if (err) throw new Error(err.message);
      const now = new Date().toISOString();
      setRows((cur) =>
        (cur ?? []).map((r) => (sel.has(r.id) ? { ...r, collected: value, collected_at: value ? now : null, collected_by: value ? userEmail ?? "" : "" } : r))
      );
      setNotice(`${data ?? 0} γραμμές → ${value ? "Collected" : "Non Collected"}.`);
      setSel(new Set());
    } catch (e) {
      setError(`Η αλλαγή απέτυχε: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const meta = () => ({ generatedAt: new Date(), userEmail, filters: filterLabels(), syncedAt: null });
  async function printLists(list: OrderRow[], id: string) {
    setBusy(id);
    setError(null);
    try {
      const [{ jsPDF }, { autoTable }, ex, fonts] = await Promise.all([import("jspdf"), import("jspdf-autotable"), import("@/lib/exports"), loadPdfFonts()]);
      const { doc, fileName } = ex.ordersPdf(jsPDF, autoTable, fonts, list, meta());
      doc.autoPrint();
      const url = URL.createObjectURL(doc.output("blob"));
      const w = window.open(url, "_blank");
      if (!w) doc.save(fileName);
    } catch (e) {
      setError(`Η εκτύπωση απέτυχε: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }
  async function excel() {
    setBusy("xlsx");
    try {
      const [XLSX, ex] = await Promise.all([import("xlsx"), import("@/lib/exports")]);
      const { wb, fileName } = ex.ordersWorkbook(XLSX, rows ?? [], meta());
      XLSX.writeFile(wb, fileName);
    } catch (e) {
      setError(`Η εξαγωγή απέτυχε: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

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
            <h1>Orders</h1>
            <p>
              <LivePill connected={live.connected} lastAt={live.lastAt ?? last ?? null} /> Γραμμές πωλήσεων του WMS (salexportcl), ανά λίστα. Δεν φορτώνεται
              τίποτα μέχρι να πατήσεις <b>Αναζήτηση</b>.{" "}
              {last === null && "Δεν έχουν συγχρονιστεί ακόμα παραγγελίες."}
              {last && `Τελευταία: ${fmtDt(last)}.`}
            </p>
          </div>
          <div className="st-actions">
            <button type="button" className="btn ghost" onClick={excel} disabled={!!busy || !rows?.length}>
              Excel
            </button>
            <button type="button" className="btn primary" onClick={() => printLists(rows ?? [], "all")} disabled={!!busy || !rows?.length} title="Όλες οι λίστες της αναζήτησης, μία ανά σελίδα">
              {busy === "all" ? "PDF…" : `Εκτύπωση όλων (${groups.length})`}
            </button>
          </div>
        </div>

        <form className="st-filters mv-filters" onSubmit={search}>
          {field("customer", "Πελάτης", "μέρος του ονόματος")}
          {field("item", "Κωδικός", "π.χ. 71-01-359")}
          {field("lot", "Batch")}
          {field("sn", "SN")}
          {field("doc", "Παραστατικό")}
          {field("erp", "Κωδικός ERP")}
          {field("list", "Αριθμός λίστας", "π.χ. 5428 ή 5428, 5431")}
          {field("picker", "Χρήστης συλλογής", "όνομα")}
          {field("from", "Από ημερομηνία", "", "date")}
          {field("to", "Έως ημερομηνία", "", "date")}
          <label className="field">
            Κατάσταση
            <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as Status })}>
              <option value="all">Όλες</option>
              <option value="open">Non Collected</option>
              <option value="collected">Collected</option>
            </select>
          </label>
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
                setSel(new Set());
              }}
            >
              Καθάρισμα
            </button>
          </div>
        </form>
        {f.list.trim() && <p className="rp-hint">Με αριθμό λίστας οι ημερομηνίες αγνοούνται.</p>}

        {error && <p className="rp-notice error">{error}</p>}
        {notice && <p className="rp-notice ok">{notice}</p>}

        {rows !== null && (
          <div className="or-bar">
            <label className="st-check">
              <input type="checkbox" checked={allOn} onChange={(e) => toggle(allIds, e.target.checked)} />
              Όλες
            </label>
            <span className="st-summary">
              <span>
                <b>{groups.length.toLocaleString("el-GR")}</b> λίστες · <b>{rows.length.toLocaleString("el-GR")}</b> γραμμές
                {total !== null && total > rows.length && ` (από ${total.toLocaleString("el-GR")} — στενέψτε τα φίλτρα)`}
              </span>
              <span>
                <b>{rows.filter((r) => r.collected).length.toLocaleString("el-GR")}</b> collected
              </span>
            </span>
            <span className="or-sel">
              {sel.size ? `${sel.size} επιλεγμένες` : "Επίλεξε γραμμές"}
              <button type="button" className="btn sm or-c1" disabled={!sel.size || !!busy} onClick={() => setCollected(true)}>
                {busy === "c1" ? "…" : "Collected"}
              </button>
              <button type="button" className="btn ghost sm" disabled={!sel.size || !!busy} onClick={() => setCollected(false)}>
                {busy === "c0" ? "…" : "Non Collected"}
              </button>
              <button
                type="button"
                className="btn ghost sm"
                disabled={!sel.size || !!busy}
                onClick={() => printLists((rows ?? []).filter((r) => selLists.has(r.list_no || r.order_id)), "sel")}
                title="Εκτύπωση των λιστών που έχουν επιλεγμένες γραμμές"
              >
                Εκτύπωση {selLists.size || ""} λιστ{selLists.size === 1 ? "ας" : "ών"}
              </button>
            </span>
          </div>
        )}

        {rows !== null && (
          <div className="st-tablewrap">
            <table className="st-table or-table">
              <thead>
                <tr>
                  <th />
                  {["Κωδικός", "Περιγραφή", "Batch", "SN", "Ποσότητα", "Από θέση", "Κατάσταση"].map((h, i) => (
                    <th key={h} className={i === 4 ? "num" : ""}>
                      <span className="mv-th">{h}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              {groups.map((g) => {
                const ids = g.lines.map((l) => l.id);
                const on = ids.every((id) => sel.has(id));
                const done = g.lines.filter((l) => l.collected).length;
                const h = g.lines[0];
                return (
                  <tbody key={g.list}>
                    <tr className="or-head">
                      <td>
                        <input type="checkbox" checked={on} onChange={(e) => toggle(ids, e.target.checked)} aria-label={`Επιλογή λίστας ${g.list}`} />
                      </td>
                      <td colSpan={6}>
                        <span className="or-list">Λίστα {g.list}</span>
                        <span className="or-cust">{h.customer || "—"}</span>
                        <span className="or-meta">
                          {[h.doc_no && `Παρ. ${h.doc_no}`, h.erp_code && `ERP ${h.erp_code}`, fmtDt(h.order_date), `${g.lines.length} γρ.`].filter(Boolean).join(" · ")}
                        </span>
                        {pickers(g.lines) && <span className="or-picker">Συλλογή: {pickers(g.lines)}</span>}
                      </td>
                      <td className="or-head-end">
                        <span className={`or-status ${done === g.lines.length ? "on" : done ? "part" : ""}`}>
                          {done === g.lines.length ? "Collected" : done ? `Collected ${done}/${g.lines.length}` : "Non Collected"}
                        </span>
                        <button type="button" className="st-link or-print" onClick={() => printLists(g.lines, `l${g.list}`)} disabled={!!busy}>
                          {busy === `l${g.list}` ? "…" : "Εκτύπωση"}
                        </button>
                      </td>
                    </tr>
                    {g.lines.map((r) => (
                      <tr key={r.id} className={sel.has(r.id) ? "or-on" : ""} onClick={() => toggle([r.id], !sel.has(r.id))}>
                        <td onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" checked={sel.has(r.id)} onChange={(e) => toggle([r.id], e.target.checked)} aria-label={`Επιλογή γραμμής ${r.item}`} />
                        </td>
                        <td className="mono">{r.item}</td>
                        <td className="st-desc">{r.description}</td>
                        <td className="mono">{r.lot}</td>
                        <td className="mono">{r.sn}</td>
                        <td className="num">{fmtQty(r.qty ?? r.init_qty)}</td>
                        <td>{r.from_pos && <span className="rack">{r.from_pos}</span>}</td>
                        <td>
                          <span className={`or-status ${r.collected ? "on" : ""}`} title={r.collected ? `${r.collected_by} · ${fmtDt(r.collected_at)}` : ""}>
                            {r.collected ? "Collected" : "Non Collected"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                );
              })}
              {!rows.length && (
                <tbody>
                  <tr>
                    <td colSpan={8} className="st-empty">
                      Καμία παραγγελία με αυτά τα φίλτρα.
                    </td>
                  </tr>
                </tbody>
              )}
            </table>
          </div>
        )}
      </div>
    </>
  );
}
