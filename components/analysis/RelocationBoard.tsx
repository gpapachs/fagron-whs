"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import KpiTiles from "@/components/KpiTiles";
import PalInput from "@/components/analysis/PalInput";
import { createClient } from "@/lib/supabase/client";
import { parseCodes, setLegacy } from "@/lib/legacy";
import { siteOf } from "@/lib/site";
import { isLeaflet } from "@/lib/leaflet";
import { ago, useCoalesced, useWmsLive } from "@/lib/live";
import { displayUser } from "@/lib/users";
import { CATEGORY_TXT, defaultAreaClass, itemKey, lineKey, normRel, pickPlan, planRelocation, withRelPallet, type AreaClass, type ItemPlan, type RelPlan, type RelRow } from "@/lib/relocation";

type View = "lines" | "pick" | "items" | "dead" | "returns" | "freed" | "areas";
const LS = "relocation.v1";
type PickRec = { keys: string[]; manual: number | null; lot_qty: Record<string, number> };
const fq = (n: number | null | undefined, d = 2) => (n == null ? "" : n.toLocaleString("el-GR", { maximumFractionDigits: d }));
const fd = (s: string | null) => (s ? s.slice(0, 10).split("-").reverse().join("/") : "");
const yearStart = () => `${new Date().getFullYear()}-01-01`;
const AREA_LBL: Record<AreaClass, string> = { movable: "Μεταφέρσιμη", fixed: "Σταθερή", offsite: "Εξωτερική" };

type Saved = {
  prefix: string;
  from: string;
  keepMonths: number;
  includeNew: boolean;
  partial: boolean;
  areaClass: Record<string, AreaClass>;
  excluded: string[];
  room: string; // χώρος από τον οποίο φεύγει απόθεμα (π.χ. 20)· "*" = όλοι· κενό = κατά περιοχή WMS
  legacy: string; // πρόθεμα παλιών κωδικών με ίδια περιγραφή (π.χ. 40 για τους 41)
  noLeaflets: boolean; // leaflets εκτός ανάλυσης
  sort: SortKey;
};
type SortKey = "default" | "cover" | "move" | "pallets" | "item";
const SORT_TXT: Record<SortKey, string> = {
  default: "Προτεινόμενη σειρά",
  cover: "Μεγαλύτερη κάλυψη πρώτα",
  move: "Μεγαλύτερη ποσότητα να φύγει",
  pallets: "Περισσότερες παλέτες",
  item: "Κωδικός",
};
// κάλυψη σε μήνες· χωρίς ανάλωση = άπειρη (πρώτα)
const coverOf = (i: ItemPlan) => (i.cover == null ? (i.onsite > 0 ? Infinity : -1) : i.cover);
function sortItems(list: ItemPlan[], k: SortKey) {
  if (k === "default") return list;
  const a = [...list];
  if (k === "cover") a.sort((x, y) => coverOf(y) - coverOf(x) || y.onsite - x.onsite);
  if (k === "move") a.sort((x, y) => y.moveQty - x.moveQty);
  if (k === "pallets") a.sort((x, y) => (y.movePallets ?? -1) - (x.movePallets ?? -1) || y.moveQty - x.moveQty);
  if (k === "item") a.sort((x, y) => x.item.localeCompare(y.item));
  return a;
}
const DEF: Saved = { prefix: "41", from: yearStart(), keepMonths: 3, includeNew: false, partial: true, areaClass: {}, excluded: [], room: "20", legacy: "40", noLeaflets: true, sort: "default" };

export default function RelocationBoard({ userEmail }: { userEmail: string | null }) {
  const [s, setS] = useState<Saved>(DEF);
  const [rows, setRows] = useState<RelRow[] | null>(null);
  const [loaded, setLoaded] = useState<{ prefix: string; from: string } | null>(null);
  const [view, setView] = useState<View>("lines");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [legacyOff, setLegacyOff] = useState(false);
  // κοινό Pick list (όλοι οι χρήστες): μία εγγραφή ανά κωδικό στη βάση
  const [shared, setShared] = useState<Record<string, PickRec>>({});
  const [sharedInfo, setSharedInfo] = useState<{ by: string | null; at: string | null }>({ by: null, at: null });
  const [skip, setSkip] = useState<string[]>([]);
  const picked = useMemo(() => new Set(Object.values(shared).flatMap((r) => r.keys)), [shared]);
  const manualMap = useMemo(() => Object.fromEntries(Object.entries(shared).filter(([, r]) => r.manual != null).map(([i, r]) => [i, Number(r.manual)])), [shared]);
  const lotMap = useMemo(() => Object.assign({}, ...Object.values(shared).map((r) => r.lot_qty ?? {})) as Record<string, number>, [shared]);

  useEffect(() => {
    try {
      const v = JSON.parse(window.localStorage.getItem(LS) ?? "null");
      if (v) setS({ ...DEF, ...v });
    } catch {
      /* τίποτα */
    }
    loadShared();
  }, []);
  async function loadShared() {
    const sb = createClient();
    const all: (PickRec & { item: string; updated_by: string | null; updated_at: string })[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("relocation_pick").select("item, keys, manual, lot_qty, updated_by, updated_at").range(from, from + 999);
      if (error) return setError(`Δεν φορτώθηκε το κοινό pick list: ${error.message}`);
      all.push(...((data as typeof all) ?? []));
      if (!data || data.length < 1000) break;
    }
    setShared(Object.fromEntries(all.map((r) => [r.item, { keys: r.keys ?? [], manual: r.manual == null ? null : Number(r.manual), lot_qty: r.lot_qty ?? {} }])));
    const last = all.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    setSharedInfo({ by: last?.updated_by ?? null, at: last?.updated_at ?? null });
    const { data: sk } = await sb.from("relocation_skip_pos").select("code").order("code");
    setSkip(((sk as { code: string }[] | null) ?? []).map((r) => r.code));
  }
  const reloadShared = useCoalesced(() => loadShared(), 800);
  useWmsLive((sig) => {
    if (sig.key === "relocation_pick") reloadShared();
  });
  // αλλαγή εγγραφών κωδικών (null = διαγραφή): αμέσως στην οθόνη, μετά στη βάση
  async function putRecs(recs: Record<string, PickRec | null>) {
    setShared((cur) => {
      const n = { ...cur };
      for (const [i, r] of Object.entries(recs)) {
        if (!r || (!r.keys.length && r.manual == null && !Object.keys(r.lot_qty).length)) delete n[i];
        else n[i] = r;
      }
      return n;
    });
    const rows = Object.entries(recs).map(([item, r]) => ({ item, keys: r?.keys ?? [], manual: r?.manual ?? null, lot_qty: r?.lot_qty ?? {} }));
    const { error } = await createClient().rpc("relocation_pick_put", { p_rows: rows });
    if (error) {
      setError(`Δεν αποθηκεύτηκε το pick list: ${error.message}`);
      loadShared();
    }
  }
  const recOf = (item: string): PickRec => shared[item] ?? { keys: [], manual: null, lot_qty: {} };
  const setPick = (keys: string[], on: boolean) => {
    const byItem = new Map<string, string[]>();
    for (const k of keys) {
      const i = k.split("|")[0];
      byItem.set(i, [...(byItem.get(i) ?? []), k]);
    }
    const recs: Record<string, PickRec> = {};
    for (const [i, ks] of byItem) {
      const r = recOf(i);
      const set = new Set(r.keys);
      for (const k of ks) {
        if (on) set.add(k);
        else {
          set.delete(k);
          set.delete(itemKey(i)); // ξετσεκάρισμα: φεύγει και το «όλος ο κωδικός»
        }
      }
      recs[i] = { ...r, keys: [...set] };
    }
    putRecs(recs);
  };
  const clearPick = async () => {
    setShared({});
    const { error } = await createClient().rpc("relocation_pick_clear");
    if (error) {
      setError(`Δεν άδειασε το pick list: ${error.message}`);
      loadShared();
    }
  };
  // πόσα τεμάχια να φύγουν: ο κωδικός μπαίνει αυτόματα ολόκληρος στο pick list
  const setManual = (item: string, qty: number | null) => {
    const r = recOf(item);
    const wasPicked = r.keys.length > 0;
    putRecs({ [item]: { manual: qty, lot_qty: {}, keys: (qty == null ? wasPicked : qty > 0) ? [itemKey(item)] : [] } });
  };
  // ποσότητα σε μία παρτίδα/θέση: οι υπόλοιπες κρατούν ό,τι δείχνουν τώρα· ο κωδικός μπαίνει στο pick list
  const setLot = (p: ItemPlan, key: string, qty: number | null) => {
    const lot_qty = { ...recOf(p.item).lot_qty };
    if (!p.byLot) for (const l of p.lines) lot_qty[lineKey(l)] = l.moveQty;
    lot_qty[key] = qty ?? 0;
    putRecs({ [p.item]: { manual: null, lot_qty, keys: [itemKey(p.item)] } });
  };
  async function saveSkip(text: string) {
    const codes = [...new Set(text.split(/[\s,;]+/).map((c) => c.trim()).filter(Boolean))];
    setSkip(codes);
    const { error } = await createClient().rpc("relocation_skip_set", { p_codes: codes });
    if (error) {
      setError(`Δεν αποθηκεύτηκαν οι θέσεις: ${error.message}`);
      loadShared();
    }
  }
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
    const sb = createClient();
    const legacy = s.legacy.replace(/[^0-9A-Za-z-]/g, "");
    let { data, error } = await sb.rpc("wms_relocation_data_v2", { p_prefix: prefix, p_from: s.from, p_legacy: legacy || null });
    // η βάση δεν έχει ακόμη την έκδοση με τους παλιούς κωδικούς: χωρίς αυτούς
    setLegacyOff(!!error);
    if (error) ({ data, error } = await sb.rpc("wms_relocation_data", { p_prefix: prefix, p_from: s.from }));
    setLoading(false);
    if (error) return setError(`Ο υπολογισμός απέτυχε: ${error.message}`);
    setRows(((data as Record<string, unknown>[]) ?? []).map(normRel));
    setLoaded({ prefix, from: s.from });
  }

  // ο υπολογισμός ξανατρέχει τοπικά σε κάθε αλλαγή ρύθμισης (χωρίς νέο ερώτημα στη βάση)
  const plan = useMemo(() => {
    if (!rows || !loaded) return null;
    const p = planRelocation(s.noLeaflets ? rows.filter((r) => !isLeaflet(r.description)) : rows, {
      prefix: loaded.prefix,
      from: loaded.from,
      keepMonths: s.keepMonths,
      includeNew: s.includeNew,
      partial: s.partial,
      areaClass: s.areaClass,
      excluded: s.excluded,
      room: s.room,
      manual: manualMap,
      lotQty: lotMap,
      skipPos: skip,
    });
    if (s.noLeaflets) {
      // θέση που κρατά και leaflets δεν «αδειάζει»
      const withLeaflets = new Set(rows.filter((r) => isLeaflet(r.description)).map((r) => r.pos));
      p.freedPositions = p.freedPositions.filter((x) => !withLeaflets.has(x));
      for (const l of p.lines) if (withLeaflets.has(l.pos)) l.freesPosition = false;
    }
    return p;
  }, [rows, loaded, s.keepMonths, s.includeNew, s.partial, s.areaClass, s.excluded, s.room, s.noLeaflets, manualMap, lotMap, skip]);

  async function savePallet(item: string, qty: number | null) {
    const prev = rows;
    setRows((r) => (r ? withRelPallet(r, item, qty, userEmail) : r));
    const { error } = await createClient().rpc("item_pallet_set", { p_item: item, p_qty: qty ?? 0 });
    if (error) {
      setRows(prev);
      setError(`Δεν αποθηκεύτηκε η ποσότητα/παλέτα για ${item}: ${error.message}`);
    }
  }
  // χώροι της κεντρικής με απόθεμα του προθέματος (+ ο επιλεγμένος)
  const rooms = useMemo(() => {
    const set = new Set<string>(["20"]);
    for (const r of rows ?? []) if (siteOf(r.pos) !== "external") set.add(r.pos.split(".")[0]);
    if (s.room && s.room !== "*") set.add(s.room);
    return [...set].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  }, [rows, s.room]);
  async function saveLegacy(item: string, text: string) {
    try {
      await setLegacy(item, parseCodes(text));
      await load();
    } catch (e) {
      setError(`Δεν αποθηκεύτηκε ο παλιός κωδικός για ${item}: ${(e as Error).message}`);
    }
  }
  const toggleExcluded = (item: string) => save({ ...s, excluded: s.excluded.includes(item) ? s.excluded.filter((x) => x !== item) : [...s.excluded, item] });
  const setArea = (area: string, c: AreaClass) => save({ ...s, areaClass: { ...s.areaClass, [area]: c } });

  // η λίστα συλλογής πάνω στο τρέχον πλάνο (γραμμές που δεν υπάρχουν πια με τις ρυθμίσεις αγνοούνται)
  const pick = useMemo(() => (plan ? pickPlan(plan, picked) : null), [plan, picked]);
  const stale = pick ? picked.size - pick.lines.length : 0;

  const meta = () => ({ generatedAt: new Date(), userEmail, filters: [], syncedAt: null });
  const excel = async (src: RelPlan | null = plan, asPick = false) => {
    if (!src) return;
    setBusy(asPick ? "pxlsx" : "xlsx");
    try {
      const [XLSX, ex] = await Promise.all([import("xlsx"), import("@/lib/exports")]);
      const { wb, fileName } = ex.relocationWorkbook(XLSX, src, meta(), asPick ? { sheet: "Pick list", file: "pick-list" } : {});
      XLSX.writeFile(wb, fileName);
    } finally {
      setBusy(null);
    }
  };
  const pdf = async (src: RelPlan | null = plan, asPick = false) => {
    if (!src) return;
    setBusy(asPick ? "ppdf" : "pdf");
    try {
      const [{ jsPDF }, { autoTable }, ex, { loadPdfFonts }] = await Promise.all([import("jspdf"), import("jspdf-autotable"), import("@/lib/exports"), import("@/lib/pdfFonts")]);
      const { doc, fileName } = ex.relocationPdf(jsPDF, autoTable, await loadPdfFonts(), src, meta(), asPick ? { title: "Pick list", file: "pick-list" } : {});
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
        <label className="field" title="Πρόθεμα των παλιών κωδικών (π.χ. 40 για τους 41): η κατανάλωσή τους μετράει μαζί, με βάση την αντιστοίχιση κωδικών (✎ στο «Ανά κωδικό»)">
          Παλιοί κωδικοί
          <input value={s.legacy} onChange={(e) => setS({ ...s, legacy: e.target.value })} placeholder="π.χ. 40" />
        </label>
        <label className="field">
          Κατανάλωση από
          <input type="date" value={s.from} onChange={(e) => setS({ ...s, from: e.target.value })} />
        </label>
        <button type="submit" className="btn primary" disabled={loading}>
          {loading ? "Υπολογισμός…" : "Υπολογισμός"}
        </button>
        <button
          type="button"
          className="btn ghost sm"
          title="Επαναφορά ρυθμίσεων· τα «Κράτα όλο» και οι περιοχές μένουν"
          onClick={() => {
            save({ ...DEF, prefix: "", areaClass: s.areaClass, excluded: s.excluded });
            setRows(null);
            setLoaded(null);
            setQ("");
            setView("lines");
            setError(null);
          }}
        >
          Καθαρισμός
        </button>
        <div className="rl-params">
          <label className="field">
            Μένουν στην κεντρική
            <span className="rl-months">
              <input type="number" min={0.5} step={0.5} value={s.keepMonths} onChange={(e) => save({ ...s, keepMonths: Math.max(0, Number(e.target.value) || 0) })} />
              μήνες κατανάλωσης
            </span>
          </label>
          <label className="field" title="Από ποιον χώρο (1ο τμήμα θέσης) μπορεί να φύγει απόθεμα. «Όλοι» = κάθε θέση της κεντρικής. «Κατά περιοχή» = όπως ορίζεται στην καρτέλα Περιοχές.">
            Χώρος
            <select value={s.room} onChange={(e) => save({ ...s, room: e.target.value })}>
              <option value="*">Όλοι οι χώροι της κεντρικής</option>
              {rooms.map((r) => (
                <option key={r} value={r}>
                  Χώρος {r}
                </option>
              ))}
              <option value="">Κατά περιοχή WMS</option>
            </select>
          </label>
          <SkipField codes={skip} onSave={saveSkip} />
          <label className="st-check">
            <input type="checkbox" checked={s.partial} onChange={(e) => save({ ...s, partial: e.target.checked })} />
            Μέρος θέσης (ολόκληρες παλέτες)
          </label>
          <label className="st-check" title="Τα leaflets (φύλλα οδηγιών) δεν μετράνε στην ανάλυση">
            <input type="checkbox" checked={s.noLeaflets} onChange={(e) => save({ ...s, noLeaflets: e.target.checked })} />
            Χωρίς leaflets
          </label>
          <label className="st-check" title="Κωδικοί που κινήθηκαν για πρώτη φορά τις τελευταίες 90 ημέρες και δεν έχουν ακόμα κατανάλωση">
            <input type="checkbox" checked={s.includeNew} onChange={(e) => save({ ...s, includeNew: e.target.checked })} />
            Να φύγουν και οι νέοι κωδικοί
          </label>
        </div>
      </form>

      {error && <p className="rp-notice error">{error}</p>}
      {legacyOff && plan && (
        <p className="rp-notice warn">Η σύνδεση με τους παλιούς κωδικούς ({s.legacy}*) δεν είναι ενεργή ακόμη στη βάση — η κατανάλωση μετράει μόνο τους {plan.params.prefix}*.</p>
      )}
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
            <b>{plan.freedPositions.length}</b> θέσεις αδειάζουν εντελώς. Κατανάλωση {fq(plan.months, 1)} μηνών
            {plan.params.room && plan.params.room !== "*" ? <> · μόνο απόθεμα στον χώρο <b>{plan.params.room}</b> ({plan.items.length} κωδικοί)</> : null}
            {plan.items.some((i) => i.legacyCodes) && (
              <>
                {" "}· <b>{plan.items.filter((i) => i.legacyCodes).length}</b> κωδικοί με παλιό κωδικό ({fq(plan.items.reduce((t, i) => t + i.legacyOut, 0), 0)} τεμ. κατανάλωσης από τους παλιούς)
              </>
            )}
            .
            <div className="st-actions rl-actions">
              <button type="button" className="btn ghost sm" onClick={() => pdf()} disabled={!!busy || !plan.lines.length}>
                {busy === "pdf" ? "PDF…" : "Λίστα μεταφοράς PDF"}
              </button>
              <button type="button" className="btn ghost sm" onClick={() => excel()} disabled={!!busy}>
                {busy === "xlsx" ? "Excel…" : "Excel"}
              </button>
            </div>
          </div>
          <KpiTiles
            active={view}
            onPick={(k) => setView(k as View)}
            items={[
              { key: "lines", label: "Τι φεύγει", value: plan.totals.items, tone: "blue", hint: "Ανά κωδικό· πατήστε έναν κωδικό για τις παρτίδες και τις θέσεις του" },
              { key: "pick", label: "Pick list", value: pick?.totals.items ?? 0, tone: "green", hint: "Οι κωδικοί / παρτίδες που τσέκαρες να σταλούν, με τις ποσότητες που όρισες — PDF και Excel μόνο γι' αυτές" },
              { key: "items", label: "Ανά κωδικό", value: plan.items.length, tone: "neutral", hint: "Τι μένει, τι φεύγει, κάλυψη, πότε θα χρειαστεί πίσω" },
              { key: "dead", label: "Χωρίς κατανάλωση", value: dead.length, tone: "red", hint: "Καμία έξοδο στην περίοδο: φεύγουν ολόκληρα" },
              { key: "freed", label: "Θέσεις αδειάζουν", value: plan.freedPositions.length, tone: "green", hint: "Όλο το περιεχόμενο της θέσης φεύγει" },
              { key: "returns", label: "Επιστροφή από έξω", value: plan.returns.length, tone: "orange", hint: "Η κεντρική δεν καλύπτει τους μήνες — υπάρχει απόθεμα στην εξωτερική" },
              { key: "areas", label: "Περιοχές", value: plan.areas.length, tone: "neutral", hint: "Ποιες περιοχές μετρούν ως κεντρική / εξωτερική" },
            ]}
          />
          <div className="an-bar">
            <label className="rl-sort">
              Ταξινόμηση
              <select value={s.sort} onChange={(e) => save({ ...s, sort: e.target.value as SortKey })}>
                {(Object.keys(SORT_TXT) as SortKey[]).map((k) => (
                  <option key={k} value={k}>
                    {SORT_TXT[k]}
                  </option>
                ))}
              </select>
            </label>
            <input className="an-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Αναζήτηση κωδικού / περιγραφής / θέσης…" />
          </div>

          {view === "lines" && <MoveGroups items={sortItems(plan.moving.filter(m), s.sort)} picked={picked} onPick={setPick} onQty={setManual} onLot={setLot} />}
          {view === "pick" && pick && (
            <>
              <div className="rl-pickbar">
                <span>
                  <b>{pick.totals.items}</b> κωδικοί · <b>{pick.totals.lines}</b> γραμμές · <b>{fq(pick.totals.moveQty, 0)}</b> τεμ. · ≈ <b>{pick.totals.pallets}</b> παλέτες
                  {pick.totals.palletsMissing > 0 && <span className="dim"> (+{pick.totals.palletsMissing} χωρίς ποσ./παλέτα)</span>}
                  {stale > 0 && <span className="dim"> · {stale} επιλογές δεν ισχύουν πια με τις τρέχουσες ρυθμίσεις</span>}
                  <span className="dim"> · κοινό για όλους τους χρήστες{sharedInfo.at ? ` · τελευταία αλλαγή ${ago(sharedInfo.at)}${sharedInfo.by ? ` από ${displayUser(sharedInfo.by)}` : ""}` : ""}</span>
                </span>
                <span className="st-actions">
                  <button type="button" className="btn primary sm" onClick={() => pdf(pick, true)} disabled={!!busy || !pick.lines.length}>
                    {busy === "ppdf" ? "PDF…" : "Pick list PDF"}
                  </button>
                  <button type="button" className="btn ghost sm" onClick={() => excel(pick, true)} disabled={!!busy || !pick.lines.length}>
                    {busy === "pxlsx" ? "Excel…" : "Excel"}
                  </button>
                  <button type="button" className="btn ghost sm" onClick={clearPick} disabled={!picked.size}>
                    Άδειασμα λίστας
                  </button>
                </span>
              </div>
              {pick.lines.length ? (
                <MoveGroups items={sortItems(pick.moving.filter(m), s.sort)} picked={picked} onPick={setPick} onQty={setManual} onLot={setLot} pickView />
              ) : (
                <p className="rp-hint">Το pick list είναι άδειο. Στο «Τι φεύγει» τσέκαρε τους κωδικούς (ή μεμονωμένες παρτίδες / θέσεις) που θέλεις να στείλεις, ή γράψε πόσα τεμάχια να φύγουν.</p>
              )}
            </>
          )}
          {view === "items" && <ItemsTable rows={sortItems(plan.items.filter(m), s.sort)} excluded={s.excluded} onExclude={toggleExcluded} onPal={savePallet} onLegacy={saveLegacy} onQty={setManual} />}
          {view === "dead" && <ItemsTable rows={sortItems(dead.filter(m), s.sort)} excluded={s.excluded} onExclude={toggleExcluded} onPal={savePallet} onLegacy={saveLegacy} onQty={setManual} />}
          {view === "returns" && <ItemsTable rows={sortItems(plan.returns.filter(m), s.sort)} excluded={s.excluded} onExclude={toggleExcluded} onPal={savePallet} onLegacy={saveLegacy} onQty={setManual} returns />}
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

/** Τι φεύγει: πρώτα ανά κωδικό, και με κλικ οι παρτίδες / θέσεις του κωδικού. */
/** Θέσεις από τις οποίες δεν παίρνουμε ποτέ απόθεμα (κοινές για όλους). */
function SkipField({ codes, onSave }: { codes: string[]; onSave: (text: string) => void }) {
  const txt = codes.join(", ");
  const [v, setV] = useState(txt);
  useEffect(() => setV(txt), [txt]);
  return (
    <label className="field rl-skip" title="Θέσεις από τις οποίες δεν φεύγει ποτέ απόθεμα — μετράνε όμως στην κεντρική. Χωρίστε με κόμμα· «06.01» = όλες οι θέσεις που ξεκινούν έτσι. Κοινό για όλους.">
      Δεν παίρνουμε από θέσεις
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v.trim() !== txt && onSave(v)}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), (e.target as HTMLInputElement).blur())}
        placeholder="π.χ. 06.01.01.02"
      />
    </label>
  );
}

function PickBox({ keys, picked, onPick, label, whole, disabled }: { keys: string[]; picked: Set<string>; onPick: (k: string[], on: boolean) => void; label: string; whole?: string; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const all = whole != null && picked.has(itemKey(whole));
  const n = all ? keys.length : keys.filter((k) => picked.has(k)).length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = n > 0 && n < keys.length;
  }, [n, keys.length]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="rl-pick"
      aria-label={label}
      title={n ? "Αφαίρεση από τη λίστα συλλογής" : "Προσθήκη στη λίστα συλλογής"}
      checked={n > 0 && n === keys.length}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={() => onPick(keys, n < keys.length)}
    />
  );
}

/** Πόσα τεμάχια να φύγουν: κενό = η πρόταση. Αποθηκεύεται με Enter ή όταν φύγεις από το πεδίο. */
function QtyInput({ item, value, suggested, manual, max, onQty }: { item: string; value: number; suggested: number; manual: number | null | undefined; max?: number; onQty: (i: string, q: number | null) => void }) {
  const shown = manual != null ? String(manual) : "";
  const [v, setV] = useState(shown);
  useEffect(() => setV(shown), [shown]);
  const commit = () => {
    const t = v.trim();
    if (t === "") return manual != null && onQty(item, null);
    const n = Number(t.replace(/\./g, "").replace(",", "."));
    if (!isFinite(n) || n < 0) return setV(shown);
    if (n !== manual) onQty(item, n);
  };
  return (
    <span className={`rl-qty ${manual != null ? "man" : ""}`} onClick={(e) => e.stopPropagation()}>
      <input
        value={v}
        inputMode="decimal"
        placeholder={fq(value, 0)}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        aria-label={`Τεμάχια να φύγουν ${item}`}
        title={manual != null ? `Χειροκίνητη ποσότητα — πρόταση ${fq(suggested, 0)}. Άδειασέ το για την πρόταση.` : "Γράψε πόσα τεμάχια θέλεις να φύγουν (κενό = η πρόταση)"}
      />
      {manual != null && manual > (max ?? value) + 1e-6 && <i className="dim" title="Δεν υπάρχει τόσο απόθεμα">έως {fq(max ?? value, 0)}</i>}
    </span>
  );
}

function MoveGroups({
  items,
  picked,
  onPick,
  onQty,
  onLot,
  pickView,
}: {
  items: ItemPlan[];
  picked: Set<string>;
  onPick: (k: string[], on: boolean) => void;
  onQty: (i: string, q: number | null) => void;
  onLot: (p: ItemPlan, key: string, q: number | null) => void;
  pickView?: boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const allKeys = items.flatMap((i) => i.lines.map(lineKey));
  const nPicked = allKeys.filter((k) => picked.has(k) || picked.has(itemKey(k.split("|")[0]))).length;
  const toggle = (i: string) =>
    setOpen((cur) => {
      const n = new Set(cur);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  const lotsOf = (p: ItemPlan) => new Set(p.lines.map((l) => `${l.lot}|${l.expiry ?? ""}`)).size;
  return (
    <>
      <div className="rl-groupbar">
        {!pickView && (
          <>
            <button type="button" className="btn ghost sm" onClick={() => onPick(allKeys, true)} disabled={!allKeys.length || nPicked === allKeys.length} title="Όλοι οι κωδικοί που φαίνονται τώρα (με την αναζήτηση) μπαίνουν στη λίστα συλλογής">
              + Όλα τα εμφανιζόμενα στη λίστα
            </button>
            {nPicked > 0 && (
              <button type="button" className="btn ghost sm" onClick={() => onPick(allKeys, false)}>
                Αφαίρεση εμφανιζόμενων
              </button>
            )}
            <span className="rl-gap" />
          </>
        )}
        <button type="button" className="btn ghost sm" onClick={() => setOpen(new Set(items.map((i) => i.item)))}>
          Άνοιγμα όλων
        </button>
        <button type="button" className="btn ghost sm" onClick={() => setOpen(new Set())}>
          Κλείσιμο όλων
        </button>
      </div>
      <div className="st-tablewrap">
        <table className="st-table st-cards rl-groups">
          <thead>
            <tr>
              {["", "✓", "Κωδικός", "Περιγραφή", "Κατηγορία", "Παρτίδες", "Θέσεις", "Κεντρική", "Κάλυψη", "Σύνολο να φύγει ✎", "Παλέτες", "Μένει"].map((h, i) => (
                <th key={i}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((p) => {
              const isOpen = open.has(p.item);
              const keys = p.lines.map(lineKey);
              const freed = p.lines.filter((l) => l.freesPosition).length;
              // παρτίδες με σειρά: νεότερη λήξη πρώτα (αυτές φεύγουν)
              const lines = [...(pickView ? p.lines : p.candidates ?? p.lines)].sort((a, b) => (b.expiry ?? "").localeCompare(a.expiry ?? "") || a.lot.localeCompare(b.lot) || a.pos.localeCompare(b.pos, "el", { numeric: true }));
              return (
                <Fragment key={p.item}>
                  <tr className={`rl-grow ${isOpen ? "open" : ""} ${picked.has(itemKey(p.item)) || keys.some((k) => picked.has(k)) ? "picked" : ""}`} onClick={() => toggle(p.item)} aria-expanded={isOpen}>
                    <td data-label="">
                      <button type="button" className="rl-caret" aria-label={isOpen ? "Κλείσιμο" : "Παρτίδες"} onClick={(e) => { e.stopPropagation(); toggle(p.item); }}>
                        {isOpen ? "▾" : "▸"}
                      </button>
                    </td>
                    <td data-label="Pick list">
                      <PickBox keys={keys} whole={p.item} picked={picked} onPick={(k, on) => onPick(on && p.manual != null ? [itemKey(p.item)] : k, on)} label={`Pick list: ${p.item}`} />
                    </td>
                    <td className="mono" data-label="Κωδικός">
                      <b>{p.item}</b>
                      {p.legacyCodes && <div className="dim rl-legacy">πρώην {p.legacyCodes}</div>}
                    </td>
                    <td className="st-desc" data-label="Περιγραφή">
                      {p.description}
                      <div className="rl-why">{p.why.short}</div>
                    </td>
                    <td data-label="Κατηγορία"><span className={`rl-cat ${p.category}`}>{CATEGORY_TXT[p.category]}</span></td>
                    <td className="num" data-label="Παρτίδες">{lotsOf(p)}</td>
                    <td className="num" data-label="Θέσεις">
                      {new Set(p.lines.map((l) => l.pos)).size}
                      {freed > 0 && <span className="dim"> ({freed} αδειάζουν)</span>}
                    </td>
                    <td className="num" data-label="Κεντρική">{fq(p.onsite, 0)}</td>
                    <td className="num" data-label="Κάλυψη">{p.cover == null ? <span title="Χωρίς ανάλωση">∞</span> : p.cover >= 24 ? `${fq(p.cover / 12, 1)} έτη` : `${fq(p.cover, 0)} μ.`}</td>
                    <td className="num" data-label="Να φύγει">
                      <QtyInput item={p.item} value={p.moveQty} suggested={p.suggested ?? p.moveQty} manual={p.manual} onQty={onQty} />
                    </td>
                    <td className="num" data-label="Παλέτες">{p.movePallets ?? <span className="dim">—</span>}</td>
                    <td className="num" data-label="Μένει">{fq(p.onsite - p.moveQty, 0)}</td>
                  </tr>
                  {isOpen && (
                    <tr className="rl-sub">
                      <td colSpan={12}>
                        <ul className="rl-whylong" aria-label="Γιατί">
                          {p.why.long.map((t, k) => (
                            <li key={k}>{t}</li>
                          ))}
                        </ul>
                        <table className="st-table rl-subtable">
                          <thead>
                            <tr>
                              {["Παρτίδα", "Λήξη", "Εισαγωγή", "✓", "Θέση", "Στη θέση", "Να φύγει ✎", "Παλέτες", ""].map((h, i) => (
                                <th key={i}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {lines.map((l, idx) => {
                              // μία παρτίδα σε πολλές θέσεις: παρτίδα / λήξη / σύνολο μία φορά
                              const key = `${l.lot}|${l.expiry ?? ""}`;
                              const first = idx === 0 || `${lines[idx - 1].lot}|${lines[idx - 1].expiry ?? ""}` !== key;
                              const span = first ? lines.filter((x) => `${x.lot}|${x.expiry ?? ""}` === key).length : 0;
                              const lotQty = first ? lines.filter((x) => `${x.lot}|${x.expiry ?? ""}` === key).reduce((t, x) => t + x.moveQty, 0) : 0;
                              return (
                              <tr key={`${l.pos}|${l.lot}|${l.expiry}`} className={`${first && idx > 0 ? "rl-lotstart" : ""} ${l.moveQty <= 0 ? "rl-stays" : ""}`}>
                                {first && (
                                  <td className="mono" data-label="Παρτίδα" rowSpan={span}>
                                    <b>{l.lot || "—"}</b>
                                    {span > 1 && <div className="dim">{span} θέσεις · {fq(lotQty)}</div>}
                                  </td>
                                )}
                                {first && (
                                  <td className="mono" data-label="Λήξη" rowSpan={span}>
                                    {fd(l.expiry)}
                                  </td>
                                )}
                                {first && (
                                  <td className="mono" data-label="Εισαγωγή" rowSpan={span} title="Πρώτη παραλαβή της παρτίδας">
                                    {fd(l.received) || <span className="dim">—</span>}
                                  </td>
                                )}
                                <td data-label="Pick list">
                                  <PickBox keys={[lineKey(l)]} whole={l.item} picked={picked} onPick={onPick} disabled={p.manual != null || l.moveQty <= 0} label={`Pick list: ${l.item} ${l.lot} ${l.pos}`} />
                                </td>
                                <td data-label="Θέση"><span className="rack">{l.pos}</span></td>
                                <td className="num" data-label="Στη θέση">{fq(l.posQty)}</td>
                                <td className="num" data-label="Να φύγει">
                                  <span className="rl-lotqty">
                                    <QtyInput item={`${l.item} ${l.lot} ${l.pos}`} value={l.moveQty} suggested={l.moveQty} manual={l.req ?? (p.byLot ? 0 : null)} max={l.posQty} onQty={(_, q) => onLot(p, lineKey(l), q)} />
                                    {l.moveQty > 0 && !l.full && <span className="dim">(μέρος)</span>}
                                  </span>
                                </td>
                                <td className="num" data-label="Παλέτες">{l.pallets ?? <span className="dim">—</span>}</td>
                                <td data-label="">{l.freesPosition && <span className="sl-chip on rl-free">αδειάζει</span>}</td>
                              </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {!items.length && (
              <tr>
                <td colSpan={12} className="st-empty">Τίποτα να μεταφερθεί με αυτές τις ρυθμίσεις.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function LegacyEdit({ item, codes, onSave }: { item: string; codes: string | null; onSave: (item: string, text: string) => void }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(codes ?? "");
  if (!edit)
    return (
      <div className="dim rl-legacy">
        {codes ? <span title="Η κατανάλωση μετράει και τους παλιούς κωδικούς">πρώην {codes}</span> : <span>χωρίς παλιό κωδικό</span>}{" "}
        <button type="button" className="rl-legacy-edit" title="Ορισμός / διόρθωση παλιού κωδικού" onClick={() => { setV(codes ?? ""); setEdit(true); }}>
          ✎
        </button>
      </div>
    );
  const done = (save: boolean) => {
    setEdit(false);
    if (save && v.trim() !== (codes ?? "")) onSave(item, v);
  };
  return (
    <input
      className="rl-legacy-input"
      autoFocus
      value={v}
      placeholder="π.χ. 40-00-163"
      aria-label={`Παλιός κωδικός για ${item}`}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") done(true);
        if (e.key === "Escape") done(false);
      }}
    />
  );
}

function ItemsTable({
  rows,
  excluded,
  onExclude,
  onPal,
  onLegacy,
  onQty,
  returns,
}: {
  rows: ItemPlan[];
  excluded: string[];
  onExclude: (i: string) => void;
  onPal: (i: string, q: number | null) => void;
  onLegacy: (i: string, text: string) => void;
  onQty: (i: string, q: number | null) => void;
  returns?: boolean;
}) {
  return (
    <div className="st-tablewrap">
      <table className="st-table st-cards">
        <thead>
          <tr>
            {["Κωδικός", "Περιγραφή", "Κατηγορία", "Κεντρική", "Εξωτ.", "/ μήνα", "Κάλυψη", "Μένει", returns ? "Να έρθει πίσω" : "Φεύγει ✎", "Παλ.", "Ποσ./παλέτα", "Χρειάζεται πίσω", "Κράτα όλο"].map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i.item}>
              <td className="mono" data-label="Κωδικός">
                {i.item}
                <LegacyEdit item={i.item} codes={i.legacyCodes} onSave={onLegacy} />
                {i.legacyOut > 0 && <div className="dim rl-legacy">{fq(i.legacyOut, 0)} τεμ. από τον παλιό</div>}
              </td>
              <td className="st-desc" data-label="Περιγραφή" title={i.why.long.join("\n")}>
                {i.description}
                <div className="rl-why">{i.why.short}</div>
              </td>
              <td data-label="Κατηγορία"><span className={`rl-cat ${i.category}`}>{CATEGORY_TXT[i.category]}</span></td>
              <td className="num" data-label="Κεντρική">{fq(i.onsite, 0)}</td>
              <td className="num" data-label="Εξωτερική">{i.offsite ? fq(i.offsite, 0) : ""}</td>
              <td className="num" data-label="/ μήνα">{i.perMonth ? fq(i.perMonth, 1) : "—"}</td>
              <td className="num" data-label="Κάλυψη">{i.cover == null ? (i.onsite > 0 ? "∞" : "—") : i.cover >= 24 ? `${fq(i.cover / 12, 1)} έτη` : `${fq(i.cover, 0)} μ.`}</td>
              <td className="num" data-label="Μένει">{fq(i.keep, 0)}</td>
              <td className="num" data-label={returns ? "Πίσω" : "Φεύγει"}>
                {returns ? <b>{fq(i.returnQty, 0)}</b> : i.movable > 0 ? <QtyInput item={i.item} value={i.moveQty} suggested={i.suggested ?? i.moveQty} manual={i.manual} onQty={onQty} /> : ""}
              </td>
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
