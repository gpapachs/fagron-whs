"use client";

import { useEffect, useMemo, useState } from "react";
import AppBar from "@/components/AppBar";
import KpiTiles from "@/components/KpiTiles";
import { createClient } from "@/lib/supabase/client";
import { analyse, normReceipt, sumPallets, sumStock, withPallet, type Analysis, type Batch, type Coverage, type FifoCase, type PalSource, type ReceiptRow } from "@/lib/analysis";
import PalInput from "@/components/analysis/PalInput";
import RelocationBoard from "@/components/analysis/RelocationBoard";

type View = "noConsumption" | "overstock" | "fifo" | "expiring" | "toCheck" | "old" | "untouched" | "partial";
const LS = "analysis.v1";
const QUICK = ["60", "41", "00", "71", "40"];
const yearStart = () => `${new Date().getFullYear()}-01-01`;
const fq = (n: number | null | undefined, d = 3) => (n == null ? "" : n.toLocaleString("el-GR", { maximumFractionDigits: d }));
const fd = (s: string | null) => (s ? new Date(s.length <= 10 ? `${s}T00:00:00` : s).toLocaleDateString("el-GR", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "");

const EXP_MONTHS = 6;
const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export type ExpRow = { item: string; description: string | null; position: string; area: string | null; lot: string | null; expiry: string; qty: number };

const VIEWS: { key: View; label: string; hint: string }[] = [
  { key: "noConsumption", label: "Χωρίς κατανάλωση", hint: "Ανέγγιχτες παρτίδες κωδικών χωρίς καμία έξοδο/ανάλωση στην περίοδο" },
  { key: "overstock", label: "Κάλυψη > 24 μ.", hint: "Απόθεμα κωδικού ÷ μέση μηνιαία κατανάλωση της περιόδου" },
  { key: "fifo", label: "FIFO / FEFO", hint: "Ανέγγιχτη παλαιότερη παρτίδα ενώ καταναλώνεται νεότερη" },
  { key: "expiring", label: "Λήξεις < 6 μ.", hint: "Όλο το απόθεμα του προθέματος (κάθε προέλευση) που έχει λήξει ή λήγει μέσα σε 6 μήνες" },
  { key: "toCheck", label: "Για έλεγχο", hint: "Μοναδική παρτίδα· η τελευταία έξοδος του κωδικού έγινε πριν την παραλαβή" },
  { key: "old", label: "Ανέγγιχτες > 90 ημ.", hint: "Παραλαβή πριν από 90+ ημέρες, τίποτα δεν έχει φύγει" },
  { key: "untouched", label: "Όλες οι ανέγγιχτες", hint: "Σημερινό απόθεμα παρτίδας ≥ παραληφθείσα ποσότητα" },
  { key: "partial", label: "Μερικώς αναλωμένες", hint: "Υπάρχει απόθεμα, λιγότερο από όσο παραλήφθηκε" },
];

export default function AnalysisBoard({ userEmail, role }: { userEmail: string | null; role: "admin" | "staff" }) {
  const [mode, setMode] = useState<"receipts" | "relocate">("receipts");
  const [prefix, setPrefix] = useState("60");
  const [from, setFrom] = useState(yearStart());
  const [raw, setRaw] = useState<{ rows: ReceiptRow[]; prefix: string; from: string } | null>(null);
  const a = useMemo<Analysis | null>(() => (raw ? analyse(raw.rows, { prefix: raw.prefix, from: raw.from }) : null), [raw]);
  const [palErr, setPalErr] = useState<string | null>(null);
  const [view, setView] = useState<View>("noConsumption");
  const [q, setQ] = useState("");
  const [exp, setExp] = useState<ExpRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      const s = JSON.parse(window.localStorage.getItem(LS) ?? "{}");
      if (s.prefix) setPrefix(s.prefix);
      if (s.mode === "relocate") setMode("relocate");
      if (s.from) setFrom(s.from);
    } catch {
      /* τίποτα */
    }
  }, []);

  async function run(e?: React.FormEvent, p = prefix) {
    e?.preventDefault();
    const clean = p.replace(/[^0-9A-Za-z-]/g, "");
    if (!clean) return setError("Δώσε πρόθεμα κωδικού (π.χ. 60).");
    setPrefix(clean);
    setLoading(true);
    setError(null);
    try {
      window.localStorage.setItem(LS, JSON.stringify({ prefix: clean, from, mode }));
    } catch {
      /* τίποτα */
    }
    const sb = createClient();
    // λήξεις: όλο το απόθεμα του προθέματος, όχι μόνο οι παραλαβές της περιόδου (π.χ. έτοιμα
    // προϊόντα παραγωγής ή απόθεμα προηγούμενων ετών δεν έχουν «παραλαβή» στην περίοδο)
    const until = new Date();
    until.setMonth(until.getMonth() + EXP_MONTHS);
    const [res, ex] = await Promise.all([
      sb.rpc("wms_receipt_analysis", { p_prefix: clean, p_from: from }),
      sb
        .from("wms_stock_v")
        .select("item, description, position, area, lot, expiry, qty")
        .like("item", `${clean}%`)
        .not("expiry", "is", null)
        .lte("expiry", isoDate(until))
        .gt("qty", 0)
        .order("expiry")
        .range(0, 4999),
    ]);
    setLoading(false);
    if (res.error) return setError(`Η ανάλυση απέτυχε: ${res.error.message}`);
    setRaw({ rows: ((res.data as Record<string, unknown>[]) ?? []).map(normReceipt), prefix: clean, from });
    setExp(ex.error ? null : ((ex.data as ExpRow[]) ?? []).map((r) => ({ ...r, qty: Number(r.qty) || 0 })));
    if (ex.error) setError(`Οι λήξεις δεν φορτώθηκαν: ${ex.error.message}`);
  }

  function clearAll() {
    setPrefix("");
    setFrom(yearStart());
    setQ("");
    setView("noConsumption");
    setRaw(null);
    setExp(null);
    setError(null);
    setPalErr(null);
    try {
      window.localStorage.setItem(LS, JSON.stringify({ mode }));
    } catch {
      /* τίποτα */
    }
  }

  // χειροκίνητη ποσότητα ανά παλέτα: αποθηκεύεται για όλους, ισχύει σε όλες τις αναλύσεις
  async function savePallet(item: string, qty: number | null) {
    setPalErr(null);
    const prev = raw;
    setRaw((r) => (r ? { ...r, rows: withPallet(r.rows, item, qty, userEmail) } : r));
    const { error } = await createClient().rpc("item_pallet_set", { p_item: item, p_qty: qty ?? 0 });
    if (error) {
      setRaw(prev);
      setPalErr(`Δεν αποθηκεύτηκε η ποσότητα/παλέτα για ${item}: ${error.message}`);
    }
  }

  const excel = async () => {
    if (!a) return;
    setBusy(true);
    try {
      const [XLSX, ex] = await Promise.all([import("xlsx"), import("@/lib/exports")]);
      const { wb, fileName } = ex.analysisWorkbook(XLSX, a, { generatedAt: new Date(), userEmail, filters: [], syncedAt: null }, exp ?? undefined);
      XLSX.writeFile(wb, fileName);
    } finally {
      setBusy(false);
    }
  };

  const match = (item: string, desc: string | null, lot = "", sup: string | null = "") => {
    const t = q.trim().toLowerCase();
    return !t || [item, desc ?? "", lot, sup ?? ""].some((x) => x.toLowerCase().includes(t));
  };
  const batchesOf = (v: View): Batch[] =>
    !a ? [] : v === "noConsumption" ? a.noConsumption : v === "expiring" ? a.expiring : v === "toCheck" ? a.toCheck : v === "old" ? a.old : v === "untouched" ? a.untouched : v === "partial" ? a.partial : [];
  const shownBatches = useMemo(() => batchesOf(view).filter((b) => match(b.item, b.description, b.lot, b.supplier)), [a, view, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownCover = useMemo(() => (a?.overstock ?? []).filter((c) => match(c.item, c.description)), [a, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownExp = useMemo(() => (exp ?? []).filter((r) => match(r.item, r.description, r.lot ?? "", r.position)), [exp, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownFifo = useMemo(() => (a?.fifo ?? []).filter((f) => match(f.batch.item, f.batch.description, f.batch.lot)), [a, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const count = (v: View) => (!a ? 0 : v === "overstock" ? a.overstock.length : v === "fifo" ? a.fifo.length : v === "expiring" ? exp?.length ?? 0 : batchesOf(v).length);
  const tone: Record<View, "green" | "yellow" | "red" | "blue" | "orange" | "neutral"> = {
    noConsumption: "red",
    overstock: "orange",
    fifo: "yellow",
    expiring: "red",
    toCheck: "blue",
    old: "yellow",
    untouched: "green",
    partial: "neutral",
  };

  return (
    <>
      <AppBar email={userEmail} role={role} />
      <div className="wrap stock">
        <div className="header">
          <div className="titleblock">
            <h1>{mode === "receipts" ? "Ανάλυση παραλαβών" : "Μεταφορά αποθέματος"}</h1>
            <p>
              {mode === "receipts"
                ? "Παρτίδες που ήρθαν από προμηθευτή από μια ημερομηνία και μετά, σε σχέση με το σημερινό απόθεμα: τι δεν έχει αναλωθεί, τι δεν κινείται, υπεραπόθεμα, FIFO, λήξεις."
                : "Τι μπορεί να φύγει σε εξωτερική αποθήκη χωρίς να λείψει από την παραγωγή: μένει η κατανάλωση των επόμενων μηνών, φεύγει το υπόλοιπο, με λίστα θέσεων για την αποθήκη."}
            </p>
            <div className="an-modes" role="tablist">
              {(
                [
                  ["receipts", "Ανάλυση παραλαβών"],
                  ["relocate", "Μεταφορά αποθέματος"],
                ] as const
              ).map(([k, l]) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={mode === k}
                  className={`sl-chip ${mode === k ? "on" : ""}`}
                  onClick={() => {
                    setMode(k);
                    try {
                      const v = JSON.parse(window.localStorage.getItem(LS) ?? "{}");
                      window.localStorage.setItem(LS, JSON.stringify({ ...v, mode: k }));
                    } catch {
                      /* τίποτα */
                    }
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="st-actions" hidden={mode !== "receipts"}>
            <button type="button" className="btn ghost" onClick={excel} disabled={busy || !a}>
              {busy ? "Excel…" : "Excel"}
            </button>
          </div>
        </div>

        {mode === "relocate" ? (
          <RelocationBoard userEmail={userEmail} />
        ) : (
          <>
        <form className="st-filters an-filters" onSubmit={run}>
          <label className="field">
            Πρόθεμα κωδικού
            <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="π.χ. 60 ή 41-00" inputMode="text" />
          </label>
          <label className="field">
            Παραλαβές από
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <button type="submit" className="btn primary" disabled={loading}>
            {loading ? "Ανάλυση…" : "Ανάλυση"}
          </button>
          <button type="button" className="btn ghost sm" onClick={clearAll}>
            Καθαρισμός
          </button>
          <div className="an-quick">
            Γρήγορα:
            {QUICK.map((p) => (
              <button key={p} type="button" className={`sl-chip ${prefix === p ? "on" : ""}`} onClick={() => run(undefined, p)}>
                {p}*
              </button>
            ))}
          </div>
        </form>

        {error && <p className="rp-notice error">{error}</p>}
        {!a && !loading && <p className="rp-hint">Διάλεξε πρόθεμα και ημερομηνία και πάτησε «Ανάλυση». Η ανάλυση τρέχει πάνω στις κινήσεις και το απόθεμα του WMS.</p>}

        {a && (
          <>
            <div className="an-overview">
              <b>{a.prefix}*</b> από {fd(a.from)}: <b>{a.batches.length}</b> παρτίδες παραλήφθηκαν — <b>{a.untouched.length}</b> ανέγγιχτες ({fq(sumStock(a.untouched), 0)}),{" "}
              <b>{a.partial.length}</b> μερικώς, <b>{a.gone.length}</b> εξαντλήθηκαν. Από τις ανέγγιχτες <b>{a.recent.length}</b> είναι των τελευταίων 90 ημερών (φυσιολογικό).
              <PalletLine label="Ανέγγιχτες" bs={a.untouched} /> <PalletLine label="Μερικώς" bs={a.partial} />
            </div>
            {palErr && <p className="rp-notice error">{palErr}</p>}
            <KpiTiles
              active={view}
              onPick={(k) => setView(k as View)}
              items={VIEWS.map((v) => ({ key: v.key, label: v.label, value: count(v.key), tone: tone[v.key], hint: v.hint }))}
            />
            <div className="an-bar">
              <span className="dim">
                {VIEWS.find((v) => v.key === view)?.hint}
                {view !== "fifo" && view !== "expiring" && (
                  <>
                    {" · "}
                    <PalletLine label="Σε αυτή την ομάδα" bs={view === "overstock" ? shownCover : shownBatches} />
                  </>
                )}
              </span>
              <input className="an-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Αναζήτηση κωδικού / περιγραφής / παρτίδας…" />
            </div>
            {view === "overstock" ? (
              <CoverTable rows={shownCover} months={a.periodMonths} onPal={savePallet} />
            ) : view === "fifo" ? (
              <FifoTable rows={shownFifo} />
            ) : view === "expiring" ? (
              <ExpTable rows={shownExp} />
            ) : (
              <BatchTable rows={shownBatches} partial={view === "partial"} onPal={savePallet} />
            )}
          </>
        )}
          </>
        )}
      </div>
    </>
  );
}

function PalletLine({ label, bs }: { label: string; bs: { pallets: number | null }[] }) {
  const t = sumPallets(bs);
  return (
    <span className="an-palline">
      {label}: <b>≈ {fq(t.pallets, 0)} παλέτες</b>
      {t.missing > 0 && <span className="dim"> (+{t.missing} χωρίς ποσότητα/παλέτα)</span>}
    </span>
  );
}

function BatchTable({ rows, partial, onPal }: { rows: Batch[]; partial?: boolean; onPal: (item: string, q: number | null) => void }) {
  return (
    <div className="st-tablewrap">
      <table className="st-table st-cards">
        <thead>
          <tr>
            {["Κωδικός", "Περιγραφή", "Παρτίδα", "Παραλαβή", "Ημ.", "Προμηθευτής", partial ? "Παραλ. / Υπόλ." : "Απόθεμα", "Ποσ./παλέτα", "Παλέτες", "Λήξη", "Έξοδοι κωδ.", "Τελ. έξοδος κωδ.", "Θέσεις"].map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={`${b.item}|${b.lot}`}>
              <td className="mono" data-label="Κωδικός">{b.item}</td>
              <td className="st-desc" data-label="Περιγραφή">{b.description}</td>
              <td className="mono" data-label="Παρτίδα">{b.lot}</td>
              <td className="mono" data-label="Παραλαβή">{fd(b.first_receipt)}</td>
              <td className="num" data-label="Ημέρες">{b.ageDays}</td>
              <td className="dim" data-label="Προμηθευτής">{b.supplier}</td>
              <td className="num" data-label={partial ? "Παραλ. / Υπόλ." : "Απόθεμα"}>
                {partial ? (
                  <>
                    {fq(b.received)} / <b>{fq(b.stock)}</b> <span className="dim">({Math.round((b.stock / (b.received || 1)) * 100)}%)</span>
                  </>
                ) : (
                  <b>{fq(b.stock)}</b>
                )}
              </td>
              <td data-label="Ποσ./παλέτα">
                <PalInput item={b.item} qty={b.palQty} source={b.palSource} by={b.pal_manual_by} onPal={onPal} />
              </td>
              <td className="num" data-label="Παλέτες" title={`${b.lot_positions} θέσεις σήμερα`}>
                {b.pallets == null ? <span className="dim">{b.lot_positions ? `(${b.lot_positions} θέσ.)` : ""}</span> : <b>{b.pallets}</b>}
              </td>
              <td className={`mono ${b.monthsToExpiry != null && b.monthsToExpiry < 0 ? "st-expired" : b.monthsToExpiry != null && b.monthsToExpiry < 6 ? "st-soon" : ""}`} data-label="Λήξη">
                {fd(b.expiry)}
              </td>
              <td className="num" data-label="Έξοδοι κωδικού">{b.item_out_n || "—"}</td>
              <td className="mono" data-label="Τελ. έξοδος">{fd(b.item_out_last)}</td>
              <td className="dim an-pos" data-label="Θέσεις">{b.positions}</td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={13} className="st-empty">Τίποτα σε αυτή την ομάδα.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function CoverTable({ rows, months, onPal }: { rows: Coverage[]; months: number; onPal: (item: string, q: number | null) => void }) {
  return (
    <div className="st-tablewrap">
      <table className="st-table st-cards">
        <thead>
          <tr>
            {["Κωδικός", "Περιγραφή", "Απόθεμα κωδικού", "Ποσ./παλέτα", "Παλέτες", `Έξοδοι (${fq(months, 1)} μ.)`, "Ανά μήνα", "Κάλυψη", "Ανέγγιχτες παρτίδες"].map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.item}>
              <td className="mono" data-label="Κωδικός">{c.item}</td>
              <td className="st-desc" data-label="Περιγραφή">{c.description}</td>
              <td className="num" data-label="Απόθεμα"><b>{fq(c.stock, 0)}</b></td>
              <td data-label="Ποσ./παλέτα">
                <PalInput item={c.item} qty={c.palQty} source={c.palSource} onPal={onPal} />
              </td>
              <td className="num" data-label="Παλέτες" title={`${c.positions} θέσεις σήμερα`}>
                {c.pallets == null ? <span className="dim">{c.positions ? `(${c.positions} θέσ.)` : ""}</span> : <b>{c.pallets}</b>}
              </td>
              <td className="num" data-label="Έξοδοι">{fq(c.outQty, 0)}</td>
              <td className="num" data-label="Ανά μήνα">{fq(c.perMonth, 1)}</td>
              <td className="num an-cover" data-label="Κάλυψη">
                <b>{c.months == null ? "—" : c.months >= 24 ? `${fq(c.months / 12, 1)} έτη` : `${fq(c.months, 0)} μ.`}</b>
              </td>
              <td className="num" data-label="Ανέγγιχτες">
                {c.untouchedBatches} · {fq(c.untouchedQty, 0)}
              </td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={9} className="st-empty">Κανένας κωδικός με κάλυψη πάνω από 24 μήνες.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ExpTable({ rows }: { rows: ExpRow[] }) {
  const today = isoDate(new Date());
  return (
    <div className="st-tablewrap">
      <table className="st-table st-cards">
        <thead>
          <tr>
            {["Κωδικός", "Περιγραφή", "Παρτίδα", "Θέση", "Περιοχή", "Λήξη", "Ποσότητα"].map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.item}|${r.lot}|${r.position}|${i}`}>
              <td className="mono" data-label="Κωδικός">{r.item}</td>
              <td className="st-desc" data-label="Περιγραφή">{r.description}</td>
              <td className="mono" data-label="Παρτίδα">{r.lot}</td>
              <td data-label="Θέση"><span className="rack">{r.position}</span></td>
              <td className="dim" data-label="Περιοχή">{r.area}</td>
              <td className={`mono ${r.expiry < today ? "st-expired" : "st-soon"}`} data-label="Λήξη">
                {fd(r.expiry)} {r.expiry < today && <b>· ΛΗΓΜΕΝΟ</b>}
              </td>
              <td className="num" data-label="Ποσότητα"><b>{fq(r.qty)}</b></td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={7} className="st-empty">Καμία λήξη μέσα σε 6 μήνες.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function FifoTable({ rows }: { rows: FifoCase[] }) {
  return (
    <div className="st-tablewrap">
      <table className="st-table st-cards">
        <thead>
          <tr>
            {["Κωδικός", "Περιγραφή", "Ανέγγιχτη (παλαιότερη)", "Παραλαβή", "Λήξη", "Απόθεμα", "Σε χρήση (νεότερη)", "Παραλαβή", "Λήξη", "FEFO"].map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={`${f.batch.item}|${f.batch.lot}`}>
              <td className="mono" data-label="Κωδικός">{f.batch.item}</td>
              <td className="st-desc" data-label="Περιγραφή">{f.batch.description}</td>
              <td className="mono" data-label="Ανέγγιχτη">{f.batch.lot}</td>
              <td className="mono" data-label="Παραλαβή">{fd(f.batch.first_receipt)}</td>
              <td className="mono" data-label="Λήξη">{fd(f.batch.expiry)}</td>
              <td className="num" data-label="Απόθεμα">{fq(f.batch.stock)}</td>
              <td className="mono" data-label="Σε χρήση">{f.newer.lot}</td>
              <td className="mono" data-label="Παραλαβή νεότερης">{fd(f.newer.first_receipt)}</td>
              <td className="mono" data-label="Λήξη νεότερης">{fd(f.newer.expiry)}</td>
              <td data-label="FEFO">{f.fefo ? <b className="st-expired">ΝΑΙ</b> : <span className="dim">όχι</span>}</td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={10} className="st-empty">Καμία περίπτωση.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
