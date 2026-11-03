"use client";

import { useEffect, useMemo, useState } from "react";
import LivePill from "@/components/LivePill";
import { createClient } from "@/lib/supabase/client";
import { loadPdfFonts } from "@/lib/pdfFonts";
import { useWmsLive } from "@/lib/live";
import { evaluateOrders, reservedByOthers, type OrderColor, type Reservations } from "@/lib/sales";
import { loadReservations, loadSalesContext, normOrder, SALES_COLS } from "@/lib/salesData";
import type { Recipe, StockIndex } from "@/lib/repack";
import type { OrderRow } from "@/lib/exports";
import { addPlanOrder, closePlanOrder, loadPlanOrders, type PlanOrder } from "@/lib/planOrders";
import type { LineEval } from "@/lib/sales";

const fmtDt = (s: string | null) => (s ? new Date(s).toLocaleString("el-GR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const fmtQ = (n: number) => n.toLocaleString("el-GR", { maximumFractionDigits: 3 });
const fmtExp = (e: string | null | undefined) => (e ? `${e.slice(8, 10)}/${e.slice(5, 7)}/${e.slice(0, 4)}` : "");
const COLOR_LABEL: Record<OrderColor, string> = { green: "Όλα διαθέσιμα", yellow: "Μερική συλλογή", red: "Χωρίς απόθεμα" };
const STATE_LABEL = { ok: "Διαθέσιμο", repack: "Ανασυσκευασία", partial: "Μερικό", none: "Δεν υπάρχει" } as const;

/** Μία λίστα πώλησης σε δικό της παράθυρο: γραμμές + ΟΛΟ το απόθεμα κάθε είδους. */
export default function SalesView({ userEmail }: { userEmail: string | null; role?: "admin" | "staff" }) {
  const [list, setList] = useState("");
  const [rows, setRows] = useState<OrderRow[] | null>(null);
  const [idx, setIdx] = useState<StockIndex>(new Map());
  const [recipes, setRecipes] = useState<Map<string, Recipe[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [repackCounts, setRepackCounts] = useState(true);
  const [reservations, setReservations] = useState<Reservations>(new Map());
  const [planOrders, setPlanOrders] = useState<PlanOrder[]>([]);
  const [planBusy, setPlanBusy] = useState<string | null>(null);
  const reloadPlan = () => loadPlanOrders().then(setPlanOrders).catch(() => undefined);

  async function load(l: string) {
    setError(null);
    try {
      const { data, error: err } = await createClient()
        .from("wms_orders_v")
        .select(SALES_COLS)
        .eq("doc_type", "SALEXPORTLS")
        .eq("list_no", l)
        .order("line_no")
        .limit(2000);
      if (err) throw new Error(err.message);
      const r = ((data ?? []) as OrderRow[]).map(normOrder);
      const [ctx, res] = await Promise.all([loadSalesContext(r), loadReservations(), reloadPlan()]);
      setReservations(res);
      setIdx(ctx.idx);
      setRecipes(ctx.recipes);
      setRows(r);
      document.title = `Λίστα ${l} · ${r[0]?.customer ?? ""}`;
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    const l = new URLSearchParams(window.location.search).get("list") ?? "";
    setList(l);
    if (l) load(l);
    else setError("Δεν δόθηκε αριθμός λίστας.");
  }, []);
  const live = useWmsLive((sig) => {
    if (list && (sig.key === "orders_sync" || sig.key === "stock" || sig.key === "stock_full")) load(list);
  });

  const o = useMemo(() => (rows && rows.length ? evaluateOrders(rows, idx, recipes, { repackCounts, reservations })[0] ?? null : null), [rows, idx, recipes, repackCounts, reservations]);

  // ---- σύνδεση με το πλάνο ανασυσκευασίας
  const planFor = (lineId: string) => planOrders.filter((p) => p.order_line_id === lineId);
  async function addToPlan(l: LineEval, ask = true) {
    if (!l.repack || !o) return;
    if (ask && o.collecting && !o.completed && !window.confirm(`Η λίστα ${o.key} είναι σε συλλογή${o.picker ? ` από ${o.picker}` : ""}. Να μπει στο πλάνο ανασυσκευασίας;`)) return;
    setPlanBusy(l.line.id);
    try {
      await addPlanOrder({
        recipe_id: l.repack.recipe.id,
        product_code: l.line.item,
        qty: Math.max(1, Math.ceil(l.repack.units)),
        list_no: o.key,
        order_line_id: l.line.id,
        customer: o.head.customer,
        created_by: userEmail ?? "",
      });
      await reloadPlan();
    } catch (e) {
      setError(`Η προσθήκη στο πλάνο απέτυχε: ${(e as Error).message}`);
    } finally {
      setPlanBusy(null);
    }
  }
  async function removeFromPlan(id: string) {
    setPlanBusy(id);
    try {
      await closePlanOrder(id);
      await reloadPlan();
    } catch (e) {
      setError(`Η αφαίρεση απέτυχε: ${(e as Error).message}`);
    } finally {
      setPlanBusy(null);
    }
  }
  async function addAllToPlan() {
    if (!o) return;
    if (o.collecting && !o.completed && !window.confirm(`Η λίστα ${o.key} είναι σε συλλογή${o.picker ? ` από ${o.picker}` : ""}. Να μπουν οι ανασυσκευασίες στο πλάνο;`)) return;
    for (const l of o.lines) if (l.repack && !planFor(l.line.id).length) await addToPlan(l, false);
  }
  const repackLines = o?.lines.filter((l) => l.repack) ?? [];
  const notPlanned = repackLines.filter((l) => !planFor(l.line.id).length);

  async function print() {
    if (!o) return;
    setBusy(true);
    try {
      const [{ jsPDF }, { autoTable }, ex, fonts] = await Promise.all([import("jspdf"), import("jspdf-autotable"), import("@/lib/exports"), loadPdfFonts()]);
      const { doc, fileName } = ex.salesListPdf(jsPDF, autoTable, fonts, [o], { generatedAt: new Date(), userEmail, filters: [], syncedAt: null });
      doc.autoPrint();
      const w = window.open(URL.createObjectURL(doc.output("blob")), "_blank");
      if (!w) doc.save(fileName);
    } catch (e) {
      setError(`Η εκτύπωση απέτυχε: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const h = o?.head;
  return (
    <>
      <div className="wrap stock sv-popup">
        <div className="header">
          <div className="titleblock">
            <h1>
              Λίστα {list}{" "}
              {o &&
                (o.completed ? (
                  <span className="sl-tag done">Ολοκληρωμένη</span>
                ) : (
                  <span className={`sl-status big ${o.color}`}>
                    <span className="sl-dot" />
                    {COLOR_LABEL[o.color]}
                  </span>
                ))}
              {o?.needsRepack && <span className="sl-tag blue">Ανασυσκευασία</span>}
            </h1>
            <p>
              <LivePill connected={live.connected} lastAt={live.lastAt} />{" "}
              {h && (
                <>
                  <b>{h.customer}</b>
                  {h.customer_city && ` · ${h.customer_city}`}
                  {h.is_abroad && <span className="sl-tag abroad">Εξωτερικό</span>} · Παρ. {h.doc_no || "—"} · ERP {h.erp_code || "—"} · {fmtDt(h.order_date)} ·{" "}
                  {o?.strict ? "Αυστηρή συλλογή" : "Μερική συλλογή"}
                </>
              )}
            </p>
            {h?.comments && <p className="sv-comments">Σχόλια: {h.comments}</p>}
          </div>
          <div className="st-actions">
            <label className="st-check">
              <input type="checkbox" checked={repackCounts} onChange={(e) => setRepackCounts(e.target.checked)} />
              Η ανασυσκευασία μετρά ως διαθέσιμη
            </label>
            <button type="button" className="btn ghost" onClick={() => list && load(list)}>
              Ανανέωση
            </button>
            {notPlanned.length > 0 && (
              <button type="button" className="btn sv-plan" onClick={addAllToPlan} disabled={!!planBusy}>
                Όλες οι ανασυσκευασίες στο πλάνο ({notPlanned.length})
              </button>
            )}
            <button type="button" className="btn primary" onClick={print} disabled={!o || busy}>
              {busy ? "PDF…" : "Εκτύπωση λίστας"}
            </button>
          </div>
        </div>
        {o?.collecting && !o.completed && (
          <p className="sv-collecting">
            <span className="sl-live" /> Η λίστα είναι <b>σε συλλογή</b> αυτή τη στιγμή{o.picker ? ` από ${o.picker}` : ""}. Συνεννοηθείτε με τον
            χρήστη πριν από αλλαγές ή ανασυσκευασία για αυτή τη λίστα.
          </p>
        )}
        {error && <p className="rp-notice error">{error}</p>}
        {rows === null && !error && <p className="rp-hint">Φόρτωση…</p>}
        {rows !== null && !rows.length && <p className="rp-notice warn">Δεν βρέθηκε η λίστα {list}.</p>}
        {rows !== null && rows.length > 0 && !o && <p className="rp-notice ok">Όλες οι γραμμές της λίστας {list} έχουν ήδη εκτελεστεί.</p>}

        {o &&
          o.lines.map((l) => {
            const st = idx.get(l.line.item)?.rows ?? [];
            const pick = new Map(l.picks.map((p) => [`${p.position}|${p.lot}`, p.take]));
            return (
              <section key={l.line.id} className={`sv-line ${l.state}`}>
                <div className="sv-head">
                  <span className="mono sv-code">{l.line.item}</span>
                  <span className="sv-desc">{l.line.description}</span>
                  <span className="sv-nums">
                    ζητ. <b>{fmtQ(l.need)}</b> · απόθεμα <b>{fmtQ(l.stock)}</b>
                  </span>
                  {l.line.lot && <span className="sl-lot">Δεσμευμένη παρτίδα {l.line.lot}</span>}
                  <span className={`sl-state ${l.state}`}>{STATE_LABEL[l.state]}</span>
                </div>
                {st.length ? (
                  <table className="st-table sv-stock">
                    <thead>
                      <tr>
                        {["Θέση", "Περιοχή", "Παρτίδα", "Λήξη", "Ποσότητα", "Δεσμ. άλλων", "Πάρε"].map((x, i) => (
                          <th key={x} className={i >= 4 ? "num" : ""}>
                            <span className="mv-th">{x}</span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...st]
                        .sort((a, b) => (a.expiry ?? "9999").localeCompare(b.expiry ?? "9999") || a.position.localeCompare(b.position, "el", { numeric: true }))
                        .map((r) => {
                          const take = pick.get(`${r.position}|${r.lot ?? ""}`);
                          const resv = r.lot ? reservedByOthers(reservations, l.line.item, r.lot, o.key) : 0;
                          const other = l.line.lot && r.lot !== l.line.lot;
                          return (
                            <tr key={`${r.position}|${r.lot}`} className={take ? "sv-take" : other ? "sv-other" : ""}>
                              <td>
                                <span className="rack">{r.position}</span>
                              </td>
                              <td className="dim">{r.area}</td>
                              <td className="mono">{r.lot}</td>
                              <td className="mono">{fmtExp(r.expiry)}</td>
                              <td className="num">{fmtQ(r.qty)}</td>
                              <td className="num sv-resv" title={resv ? (reservations.get(`${l.line.item}|${r.lot}`) ?? []).filter((x) => x.list !== o.key).map((x) => `λίστα ${x.list}: ${fmtQ(x.qty)}`).join("\n") : ""}>
                                {resv ? fmtQ(resv) : ""}
                              </td>
                              <td className="num">{take ? fmtQ(take) : ""}</td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                ) : (
                  <p className="rp-hint sv-none">Δεν υπάρχει απόθεμα.</p>
                )}
                {l.repack && (
                  <div className="sv-repack">
                    <div className="sv-repack-head">
                      Ανασυσκευασία ×{fmtQ(l.repack.units)} (λείπουν {fmtQ(l.need - l.covered)} · βγαίνουν έως {fmtQ(l.repack.max)}) — {l.repack.recipe.id}
                      {planFor(l.line.id).length ? (
                        planFor(l.line.id).map((p) => (
                          <span key={p.id} className="sv-inplan">
                            ✓ Στο πλάνο ×{fmtQ(p.qty)}
                            <span className="dim"> · {p.created_by || "—"}</span>
                            <button type="button" className="st-link" onClick={() => removeFromPlan(p.id)} disabled={planBusy === p.id}>
                              Αφαίρεση
                            </button>
                          </span>
                        ))
                      ) : (
                        <button type="button" className="btn sm sv-plan" onClick={() => addToPlan(l)} disabled={planBusy === l.line.id}>
                          {planBusy === l.line.id ? "…" : "Πρόσθεση στο πλάνο ανασυσκευασίας"}
                        </button>
                      )}
                    </div>
                    <table className="st-table sv-stock">
                      <thead>
                        <tr>
                          {["Συστατικό", "Περιγραφή", "Θέλει", "Απόθεμα", "Θέσεις (πάρε · παρτίδα)"].map((x, i) => (
                            <th key={x} className={i === 2 || i === 3 ? "num" : ""}>
                              <span className="mv-th">{x}</span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {l.repack.recipe.components.map((c) => (
                          <tr key={c.code}>
                            <td className="mono">{c.code}</td>
                            <td className="st-desc">{c.description}</td>
                            <td className="num">{fmtQ(c.qty * l.repack!.units)}</td>
                            <td className="num">{fmtQ(idx.get(c.code)?.total ?? 0)}</td>
                            <td>
                              <div className="st-poslist sl-pos">
                                {l.repack!.picks
                                  .filter((p) => p.item === c.code)
                                  .map((p) => (
                                    <span key={`${p.position}|${p.lot}`}>
                                      <span className="rack">{p.position}</span> {fmtQ(p.take)}
                                      {p.lot && <span className="dim"> · {p.lot}</span>}
                                    </span>
                                  ))}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            );
          })}
      </div>
    </>
  );
}
