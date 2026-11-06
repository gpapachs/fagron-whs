"use client";

import { useEffect, useMemo, useState } from "react";
import KpiTiles from "@/components/KpiTiles";
import PalInput from "@/components/analysis/PalInput";
import { createClient } from "@/lib/supabase/client";
import { CATEGORY_TXT, defaultAreaClass, normRel, planRelocation, withRelPallet, type AreaClass, type ItemPlan, type MoveLine, type RelRow } from "@/lib/relocation";

type View = "lines" | "items" | "dead" | "returns" | "freed" | "areas";
const LS = "relocation.v1";
const fq = (n: number | null | undefined, d = 2) => (n == null ? "" : n.toLocaleString("el-GR", { maximumFractionDigits: d }));
const fd = (s: string | null) => (s ? s.slice(0, 10).split("-").reverse().join("/") : "");
const yearStart = () => `${new Date().getFullYear()}-01-01`;
const AREA_LBL: Record<AreaClass, string> = { movable: "Μεταφέρσιμη", fixed: "Σταθερή", offsite: "Εξωτερική" };

type Saved = { prefix: string; from: string; keepMonths: number; includeNew: boolean; partial: boolean; areaClass: Record<string, AreaClass>; excluded: string[] };
const DEF: Saved = { prefix: "41", from: yearStart(), keepMonths: 3, includeNew: false, partial: true, areaClass: {}, excluded: [] };

export default function RelocationBoard({ userEmail }: { userEmail: string | null }) {
  const [s, setS] = useState<Saved>(DEF);
  const [rows, setRows] = useState<RelRow[] | null>(null);
  const [loaded, setLoaded] = useState<{ prefix: string; from: string } | null>(null);
  const [view, setView] = useState<View>("lines");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const v = JSON.parse(window.localStorage.getItem(LS) ?? "null");
      if (v) setS({ ...DEF, ...v });
    } catch {
      /* τίποτα */
    }
  }, []);
  const save = (n: Saved) => {
    setS(n);
    try {
      window.localStorage.setItem(LS, JSON.stringify(n));
    } catch {
      /* τίποτα */
    }
  };

  async function load(e?: React.FormEvent) {
    e?.preventDefault();
    const prefix = s.prefix.replace(/[^0-9A-Za-z-]/g, "");
    if (!prefix) return setError("Δώσε πρόθεμα κωδικού (π.χ. 41).");
    setLoading(true);
    setError(null);
    save({ ...s, prefix });
    const { data, error } = await createClient().rpc("wms_relocation_data", { p_prefix: prefix, p_from: s.from });
    setLoading(false);
    if (error) return setError(`Ο υπολογισμός απέτυχε: ${error.message}`);
    setRows(((data as Record<string, unknown>[]) ?? []).map(normRel));
    setLoaded({ prefix, from: s.from });
  }

  // ο υπολογισμός ξανατρέχει τοπικά σε κάθε αλλαγή ρύθμισης (χωρίς νέο ερώτημα στη βάση)
  const plan = useMemo(
    () => (rows && loaded ? planRelocation(rows, { prefix: loaded.prefix, from: loaded.from, keepMonths: s.keepMonths, includeNew: s.includeNew, partial: s.partial, areaClass: s.areaClass, excluded: s.excluded }) : null),
    [rows, loaded, s.keepMonths, s.includeNew, s.partial, s.areaClass, s.excluded]
  );

  async function savePallet(item: string, qty: number | null) {
    const prev = rows;
    setRows((r) => (r ? withRelPallet(r, item, qty, userEmail) : r));
    const { error } = await createClient().rpc("item_pallet_set", { p_item: item, p_qty: qty ?? 0 });
    if (error) {
      setRows(prev);
      setError(`Δεν αποθηκεύτηκε η ποσότητα/παλέτα για ${item}: ${error.message}`);
    }
  }
  const toggleExcluded = (item: string) => save({ ...s, excluded: s.excluded.includes(item) ? s.excluded.filter((x) => x !== item) : [...s.excluded, item] });
  const setArea = (area: string, c: AreaClass) => save({ ...s, areaClass: { ...s.areaClass, [area]: c } });

  const meta = () => ({ generatedAt: new Date(), userEmail, filters: [], syncedAt: null });
  const excel = async () => {
    if (!plan) return;
    setBusy("xlsx");
    try {
      const [XLSX, ex] = await Promise.all([import("xlsx"), import("@/lib/exports")]);
      const { wb, fileName } = ex.relocationWorkbook(XLSX, plan, meta());
      XLSX.writeFile(wb, fileName);
    } finally {
      setBusy(null);
    }
  };
  const pdf = async () => {
    if (!plan) return;
    setBusy("pdf");
    try {
      const [{ jsPDF }, { autoTable }, ex, { loadPdfFonts }] = await Promise.all([import("jspdf"), import("jspdf-autotable"), import("@/lib/exports"), import("@/lib/pdfFonts")]);
      const { doc, fileName } = ex.relocationPdf(jsPDF, autoTable, await loadPdfFonts(), plan, meta());
      doc.save(fileName);
    } finally {
      setBusy(null);
    }
  };

  const t = q.trim().toLowerCase();
  const m = (x: { item: string; description: string | null; pos?: string }) => !t || [x.item, x.description ?? "", x.pos ?? ""].some((v) => v.toLowerCase().includes(t));
  const dead = plan?.items.filter((i) => i.category === "dead") ?? [];

  return (
    <>
      <form className="st-filters an-filters" onSubmit={load}>
        <label className="field">
          Πρόθεμα κωδικού
          <input value={s.prefix} onChange={(e) => setS({ ...s, prefix: e.target.value })} placeholder="π.χ. 41" />
        </label>
        <label className="field">
          Κατανάλωση από
          <input type="date" value={s.from} onChange={(e) => setS({ ...s, from: e.target.value })} />
        </label>
        <button type="submit" className="btn primary" disabled={loading}>
          {loading ? "Υπολογισμός…" : "Υπολογισμός"}
        </button>
        <div className="rl-params">
          <label className="field">
            Μένουν στην κεντρική
            <span className="rl-months">
              <input type="number" min={0.5} step={0.5} value={s.keepMonths} onChange={(e) => save({ ...s, keepMonths: Math.max(0, Number(e.target.value) || 0) })} />
              μήνες κατανάλωσης
            </span>
          </label>
          <label className="st-check">
            <input type="checkbox" checked={s.partial} onChange={(e) => save({ ...s, partial: e.target.checked })} />
            Μέρος θέσης (ολόκληρες παλέτες)
          </label>
          <label className="st-check" title="Κωδικοί που κινήθηκαν για πρώτη φορά τις τελευταίες 90 ημέρες και δεν έχουν ακόμα κατανάλωση">
            <input type="checkbox" checked={s.includeNew} onChange={(e) => save({ ...s, includeNew: e.target.checked })} />
            Να φύγουν και οι νέοι κωδικοί
          </label>
        </div>
      </form>

      {error && <p className="rp-notice error">{error}</p>}
      {!plan && !loading && (
        <p className="rp-hint">
          Υπολογίζει για κάθε κωδικό πόσο πρέπει να μείνει στην κεντρική αποθήκη (κατανάλωση των επόμενων μηνών + ανοιχτές παραγγελίες, σε ολόκληρες παλέτες) και ποιες θέσεις /
          παρτίδες να μεταφερθούν: μένουν οι παλαιότερες, φεύγουν οι νεότερες. Πάτησε «Υπολογισμός».
        </p>
      )}

      {plan && (
        <>
          <div className="an-overview">
            <b>{plan.params.prefix}*</b>: να φύγουν <b>{plan.totals.items}</b> κωδικοί, <b>{plan.totals.lines}</b> γραμμές θέσεων, <b>≈ {plan.totals.pallets} παλέτες</b>
            {plan.totals.palletsMissing > 0 && <span className="dim"> (+{plan.totals.palletsMissing} γραμμές χωρίς ποσότητα/παλέτα — συμπλήρωσέ τη στο «Ανά κωδικό»)</span>} ·{" "}
            <b>{plan.freedPositions.length}</b> θέσεις αδειάζουν εντελώς. Κατανάλωση {fq(plan.months, 1)} μηνών.
            <div className="st-actions rl-actions">
              <button type="button" className="btn ghost sm" onClick={pdf} disabled={!!busy || !plan.lines.length}>
                {busy === "pdf" ? "PDF…" : "Λίστα μεταφοράς PDF"}
              </button>
              <button type="button" className="btn ghost sm" onClick={excel} disabled={!!busy}>
                {busy === "xlsx" ? "Excel…" : "Excel"}
              </button>
            </div>
          </div>
          <KpiTiles
            active={view}
            onPick={(k) => setView(k as View)}
            items={[
              { key: "lines", label: "Λίστα μεταφοράς", value: plan.totals.lines, tone: "blue", hint: "Ανά θέση, με τη σειρά της διαδρομής" },
              { key: "items", label: "Ανά κωδικό", value: plan.items.length, tone: "neutral", hint: "Τι μένει, τι φεύγει, κάλυψη, πότε θα χρειαστεί πίσω" },
              { key: "dead", label: "Χωρίς κατανάλωση", value: dead.length, tone: "red", hint: "Καμία έξοδο στην περίοδο: φεύγουν ολόκληρα" },
              { key: "freed", label: "Θέσεις αδειάζουν", value: plan.freedPositions.length, tone: "green", hint: "Όλο το περιεχόμενο της θέσης φεύγει" },
              { key: "returns", label: "Επιστροφή από έξω", value: plan.returns.length, tone: "orange", hint: "Η κεντρική δεν καλύπτει τους μήνες — υπάρχει απόθεμα στην εξωτερική" },
              { key: "areas", label: "Περιοχές", value: plan.areas.length, tone: "neutral", hint: "Ποιες περιοχές μετρούν ως κεντρική / εξωτερική" },
            ]}
          />
          <div className="an-bar">
            <span className="dim">Αλλαγές στις ρυθμίσεις υπολογίζονται αμέσως.</span>
            <input className="an-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Αναζήτηση κωδικού / περιγραφής / θέσης…" />
          </div>

          {view === "lines" && <LinesTable rows={plan.lines.filter(m)} />}
          {view === "items" && <ItemsTable rows={plan.items.filter(m)} excluded={s.excluded} onExclude={toggleExcluded} onPal={savePallet} />}
          {view === "dead" && <ItemsTable rows={dead.filter(m)} excluded={s.excluded} onExclude={toggleExcluded} onPal={savePallet} />}
          {view === "returns" && <ItemsTable rows={plan.returns.filter(m)} excluded={s.excluded} onExclude={toggleExcluded} onPal={savePallet} returns />}
          {view === "freed" && (
            <div className="rl-freed">
              {plan.freedPositions.filter((p) => !t || p.toLowerCase().includes(t)).map((p) => (
                <span key={p} className="rack">{p}</span>
              ))}
              {!plan.freedPositions.length && <p className="dim">Καμία θέση δεν αδειάζει εντελώς με αυτές τις ρυθμίσεις.</p>}
            </div>
          )}
          {view === "areas" && (
            <div className="st-tablewrap">
              <table className="st-table st-cards">
                <thead>
                  <tr>
                    <th>Περιοχή</th>
                    <th>Γραμμές</th>
                    <th>Ποσότητα</th>
                    <th>Μετράει ως</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.areas.map((a) => (
                    <tr key={a.area}>
                      <td data-label="Περιοχή">{a.area || <span className="dim">(χωρίς όνομα)</span>}</td>
                      <td className="num" data-label="Γραμμές">{a.rows}</td>
                      <td className="num" data-label="Ποσότητα">{fq(a.qty, 0)}</td>
                      <td data-label="Μετράει ως">
                        <select value={s.areaClass[a.area] ?? defaultAreaClass(a.area)} onChange={(e) => setArea(a.area, e.target.value as AreaClass)}>
                          {(["movable", "fixed", "offsite"] as AreaClass[]).map((c) => (
                            <option key={c} value={c}>
                              {AREA_LBL[c]}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="rp-hint">
                <b>Μεταφέρσιμη</b>: μετράει στην κεντρική και μπορεί να φύγει · <b>Σταθερή</b>: μετράει στην κεντρική αλλά δεν μετακινείται (π.χ. αναλώσεων, εισερχόμενα) ·{" "}
                <b>Εξωτερική</b>: ήδη έξω — δεν μετράει στην κεντρική.
              </p>
            </div>
          )}
        </>
      )}
    </>
  );
}

function LinesTable({ rows }: { rows: MoveLine[] }) {
  return (
    <div className="st-tablewrap">
      <table className="st-table st-cards">
        <thead>
          <tr>
            {["Θέση", "Κωδικός", "Περιγραφή", "Παρτίδα", "Λήξη", "Στη θέση", "Να φύγει", "Παλέτες", ""].map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr key={`${l.pos}|${l.item}|${l.lot}|${l.expiry}`}>
              <td data-label="Θέση"><span className="rack">{l.pos}</span></td>
              <td className="mono" data-label="Κωδικός">{l.item}</td>
              <td className="st-desc" data-label="Περιγραφή">{l.description}</td>
              <td className="mono" data-label="Παρτίδα">{l.lot}</td>
              <td className="mono" data-label="Λήξη">{fd(l.expiry)}</td>
              <td className="num" data-label="Στη θέση">{fq(l.posQty)}</td>
              <td className="num" data-label="Να φύγει">
                <b>{fq(l.moveQty)}</b> {!l.full && <span className="dim">(μέρος)</span>}
              </td>
              <td className="num" data-label="Παλέτες">{l.pallets ?? <span className="dim">—</span>}</td>
              <td data-label="">{l.freesPosition && <span className="sl-chip on rl-free">αδειάζει</span>}</td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={9} className="st-empty">Τίποτα να μεταφερθεί με αυτές τις ρυθμίσεις.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ItemsTable({ rows, excluded, onExclude, onPal, returns }: { rows: ItemPlan[]; excluded: string[]; onExclude: (i: string) => void; onPal: (i: string, q: number | null) => void; returns?: boolean }) {
  return (
    <div className="st-tablewrap">
      <table className="st-table st-cards">
        <thead>
          <tr>
            {["Κωδικός", "Περιγραφή", "Κατηγορία", "Κεντρική", "Εξωτ.", "/ μήνα", "Κάλυψη", "Μένει", returns ? "Να έρθει πίσω" : "Φεύγει", "Παλ.", "Ποσ./παλέτα", "Χρειάζεται πίσω", "Κράτα όλο"].map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i.item}>
              <td className="mono" data-label="Κωδικός">{i.item}</td>
              <td className="st-desc" data-label="Περιγραφή">{i.description}</td>
              <td data-label="Κατηγορία"><span className={`rl-cat ${i.category}`}>{CATEGORY_TXT[i.category]}</span></td>
              <td className="num" data-label="Κεντρική">{fq(i.onsite, 0)}</td>
              <td className="num" data-label="Εξωτερική">{i.offsite ? fq(i.offsite, 0) : ""}</td>
              <td className="num" data-label="/ μήνα">{i.perMonth ? fq(i.perMonth, 1) : "—"}</td>
              <td className="num" data-label="Κάλυψη">{i.cover == null ? "—" : i.cover >= 24 ? `${fq(i.cover / 12, 1)} έτη` : `${fq(i.cover, 0)} μ.`}</td>
              <td className="num" data-label="Μένει">{fq(i.keep, 0)}</td>
              <td className="num" data-label={returns ? "Πίσω" : "Φεύγει"}><b>{returns ? fq(i.returnQty, 0) : i.moveQty ? fq(i.moveQty, 0) : ""}</b></td>
              <td className="num" data-label="Παλέτες">{returns ? "" : i.movePallets ?? (i.moveQty ? <span className="dim">—</span> : "")}</td>
              <td data-label="Ποσ./παλέτα"><PalInput item={i.item} qty={i.palQty} source={i.palSource} by={i.palBy} onPal={onPal} /></td>
              <td className="mono" data-label="Χρειάζεται πίσω">{fd(i.neededBack)}</td>
              <td data-label="Κράτα όλο">
                <input type="checkbox" checked={excluded.includes(i.item)} onChange={() => onExclude(i.item)} aria-label={`Να μείνει όλο το ${i.item}`} />
              </td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={13} className="st-empty">Τίποτα.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
