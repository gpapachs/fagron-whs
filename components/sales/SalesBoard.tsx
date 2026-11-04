"use client";

import FilterFold from "@/components/FilterFold";
import { useEffect, useMemo, useState } from "react";
import KpiTiles from "@/components/KpiTiles";
import { fullDate, relDate } from "@/lib/format";
import AppBar from "@/components/AppBar";
import LivePill from "@/components/LivePill";
import { createClient } from "@/lib/supabase/client";
import { loadPdfFonts } from "@/lib/pdfFonts";
import { useWmsLive } from "@/lib/live";
import type { Recipe, StockIndex } from "@/lib/repack";
import { loadReservations, loadSalesContext, SALES_COLS } from "@/lib/salesData";
import { loadPlanOrders, type PlanOrder } from "@/lib/planOrders";
import SalesView from "@/components/sales/SalesView";
import { evaluateOrders, type OrderColor, type OrderEval, type Reservations } from "@/lib/sales";
import type { OrderRow } from "@/lib/exports";

type Status = "open" | "completed" | "all";
type Region = "all" | "gr" | "abroad";
type F = { status: Status; region: Region; customer: string; item: string; doc: string; erp: string; list: string; from: string; to: string };
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const EMPTY = (): F => ({ status: "open", region: "all", customer: "", item: "", doc: "", erp: "", list: "", from: iso(new Date()), to: iso(new Date()) });
const LS = "sales.filters.v1";
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86400000));
const LIMIT = 5000;
const esc = (s: string) => s.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
const fmtQ = (n: number) => n.toLocaleString("el-GR", { maximumFractionDigits: 3 });
const COLS = SALES_COLS;
const COLOR_LABEL: Record<OrderColor, string> = { green: "Όλα διαθέσιμα", yellow: "Μερική συλλογή", red: "Χωρίς απόθεμα" };
const STATE_LABEL = { ok: "Διαθέσιμο", repack: "Ανασυσκευασία", partial: "Μερικό", none: "Δεν υπάρχει", done: "Εκτελεσμένο" } as const;

export default function SalesBoard({ userEmail, role }: { userEmail: string | null; role: "admin" | "staff" }) {
  const [f, setF] = useState<F>(EMPTY);
  const [rows, setRows] = useState<OrderRow[] | null>(null);
  const [idx, setIdx] = useState<StockIndex>(new Map());
  const [recipes, setRecipes] = useState<Map<string, Recipe[]>>(new Map());
  const [reservations, setReservations] = useState<Reservations>(new Map());
  const [planOrders, setPlanOrders] = useState<PlanOrder[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [colorF, setColorF] = useState<OrderColor | "all">("all");
  const [repackOnly, setRepackOnly] = useState(false);
  const [stockF, setStockF] = useState<"all" | "some" | "none">("all");
  const [modeF, setModeF] = useState<"all" | "strict" | "partial">("all");
  const [collectingOnly, setCollectingOnly] = useState(false);
  const [showExecuted, setShowExecuted] = useState(false);
  const [sortBy, setSortBy] = useState<"priority" | "newest" | "oldest">("priority");
  const [viewing, setViewing] = useState<string | null>(null); // λίστα ανοιχτή σε παράθυρο διαλόγου
  useEffect(() => {
    if (!viewing) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setViewing(null);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [viewing]);
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
    let se = false;
    try {
      se = window.localStorage.getItem("sales.showExecuted") === "1";
    } catch {
      /* τίποτα */
    }
    setShowExecuted(se);
    search(undefined, false, init, se);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const live = useWmsLive((sig) => {
    if (rows !== null && (sig.key === "orders_sync" || sig.key === "stock" || sig.key === "stock_full")) search(undefined, true);
  });

  async function search(e?: React.FormEvent, silent = false, ff: F = f, showExec = showExecuted) {
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
      if (!showExec) q = q.gt("qty", 0);
      if (ff.status === "open") q = q.eq("is_completed", false);
      if (ff.status === "completed") q = q.eq("is_completed", true);
      if (ff.region !== "all") q = q.eq("is_abroad", ff.region === "abroad");
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
      // εκτελεσμένες γραμμές (ποσότητα 0) δεν φορτώνονται καν
      const [{ idx: newIdx, recipes: recMap }, res, po] = await Promise.all([loadSalesContext(list), loadReservations(), loadPlanOrders().catch(() => [] as PlanOrder[])]);
      setPlanOrders(po);
      setReservations(res);
      setIdx(newIdx);
      setRecipes(recMap);
      setRows(list);
      setTotal(count ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const evals = useMemo(() => (rows ? evaluateOrders(rows, idx, recipes, { repackCounts, reservations, showExecuted }) : []), [rows, idx, recipes, repackCounts, reservations, showExecuted]);
  const counts = useMemo(() => {
    const c = { green: 0, yellow: 0, red: 0, repack: 0 };
    for (const o of evals) {
      if (o.completed) continue;
      c[o.color]++;
      if (o.needsRepack) c.repack++;
    }
    return c;
  }, [evals]);
  // «με απόθεμα» = τουλάχιστον ένα είδος μπορεί να συλλεχθεί τώρα· «χωρίς» = κανένα
  const hasStock = (o: OrderEval) => o.lines.some((l) => l.covered > 0);
  // προτεραιότητα: έτοιμες → μερικές → με έλλειψη, οι παλαιότερες πρώτα· ολοκληρωμένες στο τέλος
  const RANK: Record<string, number> = { green: 0, yellow: 1, red: 2 };
  const ts = (o: OrderEval) => (o.head.order_date ? new Date(o.head.order_date).getTime() : 0);
  const shown = evals
    .filter(
      (o) =>
        (colorF === "all" || (!o.completed && o.color === colorF)) &&
        (!repackOnly || o.needsRepack) &&
        (stockF === "all" || (stockF === "some" ? hasStock(o) : !hasStock(o))) &&
        (modeF === "all" || (modeF === "strict" ? o.strict : !o.strict)) &&
        (!collectingOnly || o.collecting)
    )
    .sort((a, b) =>
      sortBy === "newest"
        ? ts(b) - ts(a)
        : sortBy === "oldest"
          ? ts(a) - ts(b)
          : (a.completed ? 9 : RANK[a.color]) - (b.completed ? 9 : RANK[b.color]) || ts(a) - ts(b)
    );
  const nCollecting = evals.filter((o) => o.collecting && !o.completed).length;
  const nSome = evals.filter(hasStock).length;
  const nStrict = evals.filter((o) => o.strict).length;
  const nOpen = evals.filter((o) => !o.completed).length;
  const kpiActive = collectingOnly ? "collecting" : repackOnly ? "repack" : colorF !== "all" ? colorF : null;
  function pickKpi(k: string) {
    const again = k === kpiActive;
    setColorF(!again && (k === "green" || k === "yellow" || k === "red") ? k : "all");
    setRepackOnly(!again && k === "repack");
    setCollectingOnly(!again && k === "collecting");
  }

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

  // γρήγορα φίλτρα: αλλάζουν και ψάχνουν αμέσως
  function quick(patch: Partial<F>) {
    const nf = { ...f, ...patch };
    setF(nf);
    search(undefined, false, nf);
  }
  const viewUrl = (key: string) => `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/sales/view/?list=${encodeURIComponent(key)}`;
  // άνοιγμα μέσα στη σελίδα (παράθυρο διαλόγου), όχι νέο παράθυρο / καρτέλα
  const openView = (key: string) => setViewing(key);


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
              <LivePill connected={live.connected} lastAt={live.lastAt} /> Λίστες πωλήσεων με διαθεσιμότητα αποθέματος. Κλικ σε λίστα για λεπτομέρειες.
            </p>
          </div>
          <div className="st-actions">
{sel.size > 0 && (
            <button type="button" className="btn ghost" disabled={!sel.size || !!busy} onClick={() => print(shown.filter((o) => sel.has(o.key)), "sel")}>
              {busy === "sel" ? "PDF…" : `Εκτύπωση επιλεγμένων (${sel.size})`}
            </button>
            )}
            <button type="button" className="btn primary" disabled={!shown.length || !!busy} onClick={() => print(shown, "all")}>
              {busy === "all" ? "PDF…" : `Εκτύπωση όλων (${shown.length})`}
            </button>
          </div>
        </div>

        <FilterFold active={[f.customer, f.item, f.list, f.doc, f.erp].filter((x) => x.trim()).length + (f.region !== "all" ? 1 : 0)}>
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
          <label className="field">
            Ελλάδα / Εξωτερικό
            <select value={f.region} onChange={(e) => quick({ region: e.target.value as Region })}>
              <option value="all">Όλοι</option>
              <option value="gr">Ελλάδα</option>
              <option value="abroad">Εξωτερικό</option>
            </select>
          </label>
          <div className="mv-buttons">
            <button type="submit" className="btn primary" disabled={loading}>
              {loading ? "Φόρτωση…" : "Αναζήτηση"}
            </button>
          </div>
          <div className="sl-quick">
            <span className="rp-hint">Γρήγορα:</span>
            <button type="button" className={`sl-chip ${f.from === iso(new Date()) && f.to === iso(new Date()) ? "on" : ""}`} onClick={() => quick({ from: iso(new Date()), to: iso(new Date()) })}>
              Σήμερα
            </button>
            <button type="button" className={`sl-chip ${f.from === daysAgo(1) && f.to === iso(new Date()) ? "on" : ""}`} onClick={() => quick({ from: daysAgo(1), to: iso(new Date()) })}>
              Από χθες
            </button>
            <button type="button" className={`sl-chip ${f.from === daysAgo(7) ? "on" : ""}`} onClick={() => quick({ from: daysAgo(7), to: iso(new Date()) })}>
              7 ημέρες
            </button>
            <button type="button" className={`sl-chip ${f.from === daysAgo(30) ? "on" : ""}`} onClick={() => quick({ from: daysAgo(30), to: iso(new Date()) })}>
              30 ημέρες
            </button>
          </div>
        </form>
        </FilterFold>

        {error && <p className="rp-notice error">{error}</p>}

        {rows !== null && (
          <KpiTiles
            active={kpiActive}
            onPick={pickKpi}
            items={[
              { key: "all", label: "Ανοιχτές λίστες", value: nOpen, tone: "neutral" },
              { key: "green", label: "Έτοιμες", value: counts.green, tone: "green", hint: "Όλα τα είδη διαθέσιμα" },
              { key: "yellow", label: "Μερικές", value: counts.yellow, tone: "yellow", hint: "Μερική συλλογή με απόθεμα σε κάποια είδη" },
              { key: "red", label: "Με έλλειψη", value: counts.red, tone: "red", hint: "Δεν μπορούν να συλλεχθούν" },
              { key: "repack", label: "Ανασυσκευασία", value: counts.repack, tone: "blue" },
              { key: "collecting", label: "Σε συλλογή", value: nCollecting, tone: "orange", hint: "Ανοιχτές τώρα σε τερματικό" },
            ]}
          />
        )}

        {rows !== null && (
          <div className="sl-toolbar">
            <div className="sl-group">
              <span className="sl-glabel">Απόθεμα</span>
              <button type="button" className={`sl-chip ${stockF === "some" ? "on" : ""}`} onClick={() => setStockF(stockF === "some" ? "all" : "some")} title="Τουλάχιστον ένα είδος υπάρχει στο απόθεμα">
                Με απόθεμα <b>{nSome}</b>
              </button>
              <button type="button" className={`sl-chip ${stockF === "none" ? "on" : ""}`} onClick={() => setStockF(stockF === "none" ? "all" : "none")} title="Κανένα είδος στο απόθεμα">
                Χωρίς απόθεμα <b>{evals.length - nSome}</b>
              </button>
            </div>
            <div className="sl-group">
              <span className="sl-glabel">Συλλογή</span>
              <button type="button" className={`sl-chip ${modeF === "strict" ? "on" : ""}`} onClick={() => setModeF(modeF === "strict" ? "all" : "strict")}>
                Αυστηρή <b>{nStrict}</b>
              </button>
              <button type="button" className={`sl-chip ${modeF === "partial" ? "on" : ""}`} onClick={() => setModeF(modeF === "partial" ? "all" : "partial")}>
                Μερική <b>{evals.length - nStrict}</b>
              </button>
            </div>
            <div className="sl-group sl-opts">
              <label className="st-check sl-sort">
                Ταξινόμηση
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
                  <option value="priority">Προτεραιότητα</option>
                  <option value="oldest">Παλαιότερες πρώτα</option>
                  <option value="newest">Νεότερες πρώτα</option>
                </select>
              </label>
              <label className="st-check">
                <input type="checkbox" checked={allSel} onChange={(e) => setSel(e.target.checked ? new Set(shown.map((o) => o.key)) : new Set())} />
                Επιλογή όλων ({shown.length})
              </label>
              <label className="st-check" title="Γραμμές που έχουν ήδη συλλεχθεί (ποσότητα 0)">
                <input
                  type="checkbox"
                  checked={showExecuted}
                  onChange={(e) => {
                    setShowExecuted(e.target.checked);
                    try {
                      window.localStorage.setItem("sales.showExecuted", e.target.checked ? "1" : "");
                    } catch {
                      /* τίποτα */
                    }
                    search(undefined, false, f, e.target.checked);
                  }}
                />
                Μηδενικά (εκτελεσμένα) είδη
              </label>
              <label className="st-check" title="Αν η ανασυσκευασία καλύπτει την έλλειψη, η γραμμή μετρά ως διαθέσιμη για το χρώμα">
                <input type="checkbox" checked={repackCounts} onChange={(e) => setRepackCounts(e.target.checked)} />
                Ανασυσκευασία = διαθέσιμο
              </label>
            {total !== null && rows.length < total && <span className="rp-hint">Φορτώθηκαν {rows.length} από {total} γραμμές — στενέψτε τα φίλτρα.</span>}
            </div>
          </div>
        )}

        {rows !== null && (
          <div className="st-tablewrap">
            <table className="st-table sl-table">
              <thead>
                <tr>
                  <th />
                  {["Λίστα", "Πελάτης", "Ημερομηνία", "Συλλογή", "Γραμμές", "Κατάσταση", ""].map((h) => (
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
                    <tr className={`sl-row ${o.completed ? "done" : o.color}`} onClick={() => openView(o.key)} title="Άνοιγμα με τα αποθέματα">
                      <td onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={sel.has(o.key)} onChange={(e) => toggleSel(o.key, e.target.checked)} aria-label={`Επιλογή λίστας ${o.key}`} />
                      </td>
                      <td className="mono">
                        <button
                          type="button"
                          className="sl-caret"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleOpen(o.key);
                          }}
                          aria-label={isOpen ? "Κλείσιμο γραμμών" : "Γραμμές εδώ"}
                          title="Γραμμές εδώ (χωρίς νέο παράθυρο)"
                        >
                          {isOpen ? "▾" : "▸"}
                        </button>{" "}
                        <a
                          href={viewUrl(o.key)}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            openView(o.key);
                          }}
                          className="sl-open"
                        >
                          <b>{o.key}</b>
                        </a>
                      </td>
                      <td className="st-desc">
                        {o.head.customer}
                        {o.head.is_abroad && <span className="sl-tag abroad">Εξωτερικό</span>}
                        {o.head.comments && (
                          <div className="sl-comments" title={o.head.comments}>
                            {o.head.comments}
                          </div>
                        )}
                      </td>
                      <td className="sl-c-date reldate" title={fullDate(o.head.order_date)}>
                        {relDate(o.head.order_date)}
                      </td>
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
                        {o.collecting && !o.completed && (
                          <span className="sl-tag orange" title="Η λίστα είναι ανοιχτή σε τερματικό συλλογής">
                            <span className="sl-live" /> Σε συλλογή{o.picker ? ` · ${o.picker}` : ""}
                          </span>
                        )}
                        {o.needsRepack && <span className="sl-tag blue">Ανασυσκευασία</span>}
                        {planOrders.some((p) => p.list_no === o.key) && <span className="sl-tag done">Στο πλάνο</span>}
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
                          <td className="st-desc">
                            {l.line.description}
                            {l.line.lot && <div className="sl-lot">Δεσμευμένη παρτίδα: {l.line.lot}</div>}
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
                    <td colSpan={8} className="st-empty">
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
      {viewing && (
        <div className="sv-modal" role="dialog" aria-modal="true" aria-label={`Λίστα ${viewing}`} onClick={() => setViewing(null)}>
          <div className="sv-modal-box" onClick={(e) => e.stopPropagation()}>
            <SalesView userEmail={userEmail} listNo={viewing} onClose={() => setViewing(null)} />
          </div>
        </div>
      )}
    </>
  );
}
