"use client";

import { useEffect, useMemo, useState } from "react";
import AppBar from "@/components/AppBar";
import LivePill from "@/components/LivePill";
import { createClient } from "@/lib/supabase/client";
import { loadPdfFonts } from "@/lib/pdfFonts";
import { useWmsLive } from "@/lib/live";
import { indexStock, type Recipe, type StockIndex, type StockRow } from "@/lib/repack";
import { evaluateOrders, isRepackCode, type OrderColor, type OrderEval } from "@/lib/sales";
import type { OrderRow } from "@/lib/exports";

type Status = "open" | "completed" | "all";
type F = { status: Status; customer: string; item: string; doc: string; erp: string; list: string; from: string; to: string };
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const EMPTY = (): F => ({ status: "open", customer: "", item: "", doc: "", erp: "", list: "", from: iso(new Date(Date.now() - 30 * 86400000)), to: iso(new Date()) });
const LS = "sales.filters.v1";
const LIMIT = 5000;
const esc = (s: string) => s.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
const fmtDt = (s: string | null) => (s ? new Date(s).toLocaleString("el-GR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
const fmtQ = (n: number) => n.toLocaleString("el-GR", { maximumFractionDigits: 3 });
const COLS =
  "id, order_id, list_no, doc_type, doc_no, erp_code, order_date, customer, item, description, lot, sn, qty, init_qty, from_pos, to_pos, wms_status, line_no, collected, collected_at, collected_by, picker, is_completed, is_strict";
const COLOR_LABEL: Record<OrderColor, string> = { green: "Όλα διαθέσιμα", yellow: "Μερική συλλογή", red: "Χωρίς απόθεμα" };
const STATE_LABEL = { ok: "Διαθέσιμο", repack: "Ανασυσκευασία", partial: "Μερικό", none: "Δεν υπάρχει" } as const;

async function inChunks<T>(values: string[], size: number, fn: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  const parts: string[][] = [];
  for (let i = 0; i < values.length; i += size) parts.push(values.slice(i, i + size));
  for (let i = 0; i < parts.length; i += 6) (await Promise.all(parts.slice(i, i + 6).map(fn))).forEach((r) => out.push(...r));
  return out;
}

export default function SalesBoard({ userEmail, role }: { userEmail: string | null; role: "admin" | "staff" }) {
  const [f, setF] = useState<F>(EMPTY);
  const [rows, setRows] = useState<OrderRow[] | null>(null);
  const [idx, setIdx] = useState<StockIndex>(new Map());
  const [recipes, setRecipes] = useState<Map<string, Recipe[]>>(new Map());
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [colorF, setColorF] = useState<OrderColor | "all">("all");
  const [repackOnly, setRepackOnly] = useState(false);
  const [repackCounts, setRepackCounts] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Set<string>>(new Set());

  useEffect(() => {
    let init = EMPTY();
    try {
      const raw = window.localStorage.getItem(LS);
      if (raw) init = { ...init, ...JSON.parse(raw), from: init.from, to: init.to };
    } catch {
      /* τίποτα */
    }
    setF(init);
    search(undefined, false, init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const live = useWmsLive((sig) => {
    if (rows !== null && (sig.key === "orders_sync" || sig.key === "stock" || sig.key === "stock_full")) search(undefined, true);
  });

  async function search(e?: React.FormEvent, silent = false, ff: F = f) {
    e?.preventDefault();
    if (!silent) setLoading(true);
    setError(null);
    try {
      window.localStorage.setItem(LS, JSON.stringify({ ...ff, from: undefined, to: undefined }));
    } catch {
      /* τίποτα */
    }
    try {
      const sb = createClient();
      let q = sb.from("wms_orders_v").select(COLS, { count: "exact" }).eq("doc_type", "SALEXPORTLS");
      if (ff.status === "open") q = q.eq("is_completed", false);
      if (ff.status === "completed") q = q.eq("is_completed", true);
      if (ff.customer.trim()) q = q.ilike("customer", `%${esc(ff.customer)}%`);
      if (ff.item.trim()) q = q.ilike("item", `${esc(ff.item)}%`);
      if (ff.doc.trim()) q = q.ilike("doc_no", `%${esc(ff.doc)}%`);
      if (ff.erp.trim()) q = q.ilike("erp_code", `%${esc(ff.erp)}%`);
      if (ff.list.trim()) {
        const lists = ff.list.split(/[\s,;]+/).filter(Boolean);
        q = lists.length > 1 ? q.in("list_no", lists) : q.eq("list_no", lists[0]);
      } else {
        // στο WMS μένουν ανοιχτές και πολύ παλιές λίστες -- προεπιλογή οι τελευταίες 30 ημέρες
        if (ff.from) q = q.gte("order_date", new Date(`${ff.from}T00:00:00`).toISOString());
        if (ff.to) q = q.lt("order_date", new Date(new Date(`${ff.to}T00:00:00`).getTime() + 86400000).toISOString());
      }
      const { data, error: err, count } = await q.order("order_date", { ascending: false }).order("list_no", { ascending: false }).order("line_no").limit(LIMIT);
      if (err) throw new Error(err.message);
      const list = ((data ?? []) as OrderRow[]).map((r) => ({ ...r, qty: r.qty == null ? null : Number(r.qty), init_qty: r.init_qty == null ? null : Number(r.init_qty) }));
      // προδιαγραφές ανασυσκευασίας για 00-* / 71-*
      const items = [...new Set(list.map((r) => r.item).filter(Boolean))];
      const finals = items.filter(isRepackCode);
      const recRows = await inChunks(finals, 150, async (part) => {
        const { data: d, error: e2 } = await sb.from("repack_recipes").select("id, product_code, description").in("product_code", part);
        if (e2) throw new Error(e2.message);
        return (d ?? []) as { id: string; product_code: string; description: string }[];
      });
      const compRows = await inChunks(
        recRows.map((r) => r.id),
        150,
        async (part) => {
          const { data: d, error: e2 } = await sb.from("repack_components").select("recipe_id, code, description, qty, unit").in("recipe_id", part).order("sort");
          if (e2) throw new Error(e2.message);
          return (d ?? []) as { recipe_id: string; code: string; description: string; qty: number | string; unit: string }[];
        }
      );
      const byRecipe = new Map<string, Recipe>();
      for (const r of recRows) byRecipe.set(r.id, { id: r.id, product_code: r.product_code, description: r.description, components: [] });
      for (const c of compRows) byRecipe.get(c.recipe_id)?.components.push({ code: c.code, description: c.description, qty: Number(c.qty), unit: c.unit });
      const recMap = new Map<string, Recipe[]>();
      for (const r of byRecipe.values()) if (r.components.length) recMap.set(r.product_code, [...(recMap.get(r.product_code) ?? []), r]);
      // απόθεμα: είδη + συστατικά
      const codes = [...new Set([...items, ...compRows.map((c) => c.code)])];
      const stock = await inChunks(codes, 150, async (part) => {
        const { data: d, error: e2 } = await sb.from("wms_stock_v").select("item, position, area, lot, expiry, qty, description").in("item", part).limit(10000);
        if (e2) throw new Error(e2.message);
        return ((d ?? []) as (Omit<StockRow, "unit" | "qty"> & { qty: number | string })[]).map((s) => ({ ...s, qty: Number(s.qty), unit: "", lot: s.lot ?? "", expiry: s.lot ? s.expiry ?? null : null }));
      });
      setIdx(indexStock(stock as StockRow[]));
      setRecipes(recMap);
      setRows(list);
      setTotal(count ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const evals = useMemo(() => (rows ? evaluateOrders(rows, idx, recipes, { repackCounts }) : []), [rows, idx, recipes, repackCounts]);
  const counts = useMemo(() => {
    const c = { green: 0, yellow: 0, red: 0, repack: 0 };
    for (const o of evals) {
      if (o.completed) continue;
      c[o.color]++;
      if (o.needsRepack) c.repack++;
    }
    return c;
  }, [evals]);
  const shown = evals.filter((o) => (colorF === "all" || (!o.completed && o.color === colorF)) && (!repackOnly || o.needsRepack));

  const meta = () => ({ generatedAt: new Date(), userEmail, filters: [], syncedAt: null });
  async function print(list: OrderEval[], id: string) {
    if (!list.length) return;
    setBusy(id);
    setError(null);
    try {
      const [{ jsPDF }, { autoTable }, ex, fonts] = await Promise.all([import("jspdf"), import("jspdf-autotable"), import("@/lib/exports"), loadPdfFonts()]);
      const { doc, fileName } = ex.salesListPdf(jsPDF, autoTable, fonts, list, meta());
      doc.autoPrint();
      const w = window.open(URL.createObjectURL(doc.output("blob")), "_blank");
      if (!w) doc.save(fileName);
    } catch (e) {
      setError(`Η εκτύπωση απέτυχε: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }
  const toggleOpen = (k: string) => setOpen((s) => (s.has(k) ? new Set([...s].filter((x) => x !== k)) : new Set([...s, k])));
  const toggleSel = (k: string, on: boolean) => setSel((s) => (on ? new Set([...s, k]) : new Set([...s].filter((x) => x !== k))));
  const allSel = shown.length > 0 && shown.every((o) => sel.has(o.key));

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
            <h1>Παραγγελίες</h1>
            <p>
              <LivePill connected={live.connected} lastAt={live.lastAt} /> Λίστες πωλήσεων (SALEXPORTLS) με διαθεσιμότητα αποθέματος και πιθανή ανασυσκευασία
              (00-* / 71-*).
            </p>
          </div>
          <div className="st-actions">
            <button type="button" className="btn ghost" disabled={!sel.size || !!busy} onClick={() => print(shown.filter((o) => sel.has(o.key)), "sel")}>
              {busy === "sel" ? "PDF…" : `Εκτύπωση επιλεγμένων (${sel.size})`}
            </button>
            <button type="button" className="btn primary" disabled={!shown.length || !!busy} onClick={() => print(shown, "all")}>
              {busy === "all" ? "PDF…" : `Εκτύπωση όλων (${shown.length})`}
            </button>
          </div>
        </div>

        <form className="st-filters mv-filters" onSubmit={search}>
          <label className="field">
            Κατάσταση λίστας
            <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as Status })}>
              <option value="open">Μη ολοκληρωμένες</option>
              <option value="completed">Ολοκληρωμένες</option>
              <option value="all">Όλες</option>
            </select>
          </label>
          {field("customer", "Πελάτης", "μέρος του ονόματος")}
          {field("item", "Κωδικός", "π.χ. 71-01-359")}
          {field("list", "Αριθμός λίστας", "π.χ. 544424")}
          {field("doc", "Παραστατικό")}
          {field("erp", "Κωδικός ERP")}
          {field("from", "Από ημερομηνία", "", "date")}
          {field("to", "Έως ημερομηνία", "", "date")}
          <div className="mv-buttons">
            <button type="submit" className="btn primary" disabled={loading}>
              {loading ? "Φόρτωση…" : "Αναζήτηση"}
            </button>
          </div>
        </form>

        {error && <p className="rp-notice error">{error}</p>}

        {rows !== null && (
          <div className="or-bar">
            <label className="st-check">
              <input type="checkbox" checked={allSel} onChange={(e) => setSel(e.target.checked ? new Set(shown.map((o) => o.key)) : new Set())} />
              Όλες
            </label>
            <div className="sl-chips">
              <button type="button" className={`sl-chip ${colorF === "all" ? "on" : ""}`} onClick={() => setColorF("all")}>
                Όλες <b>{evals.length}</b>
              </button>
              {(["green", "yellow", "red"] as const).map((c) => (
                <button key={c} type="button" className={`sl-chip ${c} ${colorF === c ? "on" : ""}`} onClick={() => setColorF(colorF === c ? "all" : c)}>
                  <span className="sl-dot" /> {COLOR_LABEL[c]} <b>{counts[c]}</b>
                </button>
              ))}
              <button type="button" className={`sl-chip blue ${repackOnly ? "on" : ""}`} onClick={() => setRepackOnly(!repackOnly)}>
                Χρειάζονται ανασυσκευασία <b>{counts.repack}</b>
              </button>
            </div>
            <label className="st-check" title="Αν η ανασυσκευασία καλύπτει την έλλειψη, η γραμμή μετρά ως διαθέσιμη για το χρώμα">
              <input type="checkbox" checked={repackCounts} onChange={(e) => setRepackCounts(e.target.checked)} />
              Η ανασυσκευασία μετρά ως διαθέσιμη
            </label>
            {total !== null && rows.length < total && <span className="rp-hint">Φορτώθηκαν {rows.length} από {total} γραμμές — στενέψτε τα φίλτρα.</span>}
          </div>
        )}

        {rows !== null && (
          <div className="st-tablewrap">
            <table className="st-table sl-table">
              <thead>
                <tr>
                  <th />
                  {["Λίστα", "Πελάτης", "Παραστατικό / ERP", "Ημερομηνία", "Συλλογή", "Γραμμές", "Κατάσταση", ""].map((h) => (
                    <th key={h}>
                      <span className="mv-th">{h}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              {shown.map((o) => {
                const isOpen = open.has(o.key);
                const missing = o.lines.filter((l) => l.state === "none" || l.state === "partial").length;
                return (
                  <tbody key={o.key}>
                    <tr className={`sl-row ${o.completed ? "done" : o.color}`} onClick={() => toggleOpen(o.key)}>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={sel.has(o.key)} onChange={(e) => toggleSel(o.key, e.target.checked)} aria-label={`Επιλογή λίστας ${o.key}`} />
                      </td>
                      <td className="mono">
                        <span className="sl-caret">{isOpen ? "▾" : "▸"}</span> <b>{o.key}</b>
                      </td>
                      <td className="st-desc">{o.head.customer}</td>
                      <td className="mono">
                        {o.head.doc_no}
                        {o.head.erp_code && <div className="dim">ERP {o.head.erp_code}</div>}
                      </td>
                      <td className="mono">{fmtDt(o.head.order_date)}</td>
                      <td>
                        <span className={`sl-tag ${o.strict ? "strict" : ""}`}>{o.strict ? "Αυστηρή" : "Μερική"}</span>
                      </td>
                      <td className="num">
                        {o.lines.length}
                        {missing > 0 && !o.completed && <div className="sl-miss">{missing} χωρίς απόθεμα</div>}
                      </td>
                      <td>
                        {o.completed ? (
                          <span className="sl-tag done">Ολοκληρωμένη</span>
                        ) : (
                          <span className={`sl-status ${o.color}`}>
                            <span className="sl-dot" />
                            {COLOR_LABEL[o.color]}
                          </span>
                        )}
                        {o.needsRepack && <span className="sl-tag blue">Ανασυσκευασία</span>}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <button type="button" className="st-link or-print" onClick={() => print([o], o.key)} disabled={!!busy}>
                          {busy === o.key ? "…" : "Εκτύπωση"}
                        </button>
                      </td>
                    </tr>
                    {isOpen &&
                      o.lines.map((l) => (
                        <tr key={l.line.id} className="sl-line">
                          <td />
                          <td className="mono">{l.line.item}</td>
                          <td className="st-desc" colSpan={2}>
                            {l.line.description}
                            {l.repack && (
                              <div className="sl-repack">
                                Ανασυσκευασία ×{fmtQ(l.repack.units)} από {l.repack.recipe.id}:{" "}
                                {l.repack.recipe.components.map((c) => `${c.code} ×${fmtQ(c.qty * l.repack!.units)}`).join(", ")}
                              </div>
                            )}
                          </td>
                          <td className="num">
                            ζητ. {fmtQ(l.need)}
                            <div className="dim">απόθ. {fmtQ(l.stock)}</div>
                          </td>
                          <td colSpan={2}>
                            <div className="st-poslist sl-pos">
                              {l.picks.slice(0, 4).map((p) => (
                                <span key={`${p.position}|${p.lot}`}>
                                  <span className="rack">{p.position}</span> {fmtQ(p.take)}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td colSpan={2}>
                            <span className={`sl-state ${l.state}`}>{STATE_LABEL[l.state]}</span>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                );
              })}
              {!shown.length && (
                <tbody>
                  <tr>
                    <td colSpan={9} className="st-empty">
                      Καμία παραγγελία.
                    </td>
                  </tr>
                </tbody>
              )}
            </table>
          </div>
        )}
        {rows === null && loading && <p className="rp-hint">Φόρτωση παραγγελιών και αποθέματος…</p>}
      </div>
    </>
  );
}
