"use client";

// Ζήτηση περιεκτών / υλικών συσκευασίας από το πλάνο παραγωγής και τις ανοιχτές παραγγελίες (Excel),
// μέσω των προδιαγραφών (ίδιες με το Repack), σε σχέση με το απόθεμα κεντρικής / εξωτερικής.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import KpiTiles from "@/components/KpiTiles";
import { useColSort } from "@/components/analysis/colSort";
import { createClient } from "@/lib/supabase/client";
import { loadLegacy } from "@/lib/legacy";
import { ago, useCoalesced, useWmsLive } from "@/lib/live";
import { displayUser } from "@/lib/users";
import { computeDemand, detectColumns, readDemand, KIND_TXT, type Cell, type ColMap, type ContainerNeed, type DemandLine, type Spec, type StockLite } from "@/lib/containerDemand";
import { loadDemandLines, loadSpecs, loadStockFor, loadWmsOrderLines, type DemandUpload } from "@/lib/demandData";

const fq = (n: number | null | undefined) => (n == null ? "" : n.toLocaleString("el-GR", { maximumFractionDigits: 0 }));
const fz = (n: number) => (n > 0.5 ? fq(n) : "—");
const fd = (s: string | null) => (s ? s.slice(0, 10).split("-").reverse().join("/") : "");
const LS = "demand.v1";
type View = "all" | "short" | "external" | "ok" | "nospec";
type Pending = { kind: "plan" | "orders"; file: string; rows: Cell[][]; header: number; cols: ColMap; names: string[] };

export default function DemandBoard() {
  const [lines, setLines] = useState<DemandLine[]>([]);
  const [uploads, setUploads] = useState<DemandUpload[]>([]);
  const [specs, setSpecs] = useState<Spec[] | null>(null);
  const [newOf, setNewOf] = useState<Map<string, string>>(new Map());
  const [stock, setStock] = useState<StockLite[]>([]);
  const [wms, setWms] = useState<DemandLine[]>([]);
  const [useWms, setUseWms] = useState(false);
  const [until, setUntil] = useState("");
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>("all");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const kindRef = useRef<"plan" | "orders">("plan");

  useEffect(() => {
    try {
      const v = JSON.parse(window.localStorage.getItem(LS) ?? "{}");
      if (typeof v.useWms === "boolean") setUseWms(v.useWms);
      if (typeof v.until === "string") setUntil(v.until);
    } catch {
      /* τίποτα */
    }
  }, []);
  const persist = (o: { useWms?: boolean; until?: string }) => {
    try {
      window.localStorage.setItem(LS, JSON.stringify({ useWms, until, ...o }));
    } catch {
      /* τίποτα */
    }
  };

  async function loadAll() {
    try {
      const [d, sp, lg] = await Promise.all([loadDemandLines(), specs ? Promise.resolve(specs) : loadSpecs(), loadLegacy("")]);
      setLines(d.lines);
      setUploads(d.uploads);
      setSpecs(sp);
      setNewOf(lg.newOf);
    } catch (e) {
      setError(`Η φόρτωση απέτυχε: ${(e as Error).message}`);
    }
  }
  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const reload = useCoalesced(() => loadAll(), 800);
  const reloadStock = useCoalesced(() => setStockTick((t) => t + 1), 3000);
  const [stockTick, setStockTick] = useState(0);
  useWmsLive((sig) => {
    if (sig.key === "demand") reload();
    if (sig.key === "stock" || sig.key === "stock_full") reloadStock();
  });

  // ανοιχτές λίστες WMS για τα τελικά των προδιαγραφών (αν ζητηθεί)
  useEffect(() => {
    if (!useWms || !specs) return setWms([]);
    loadWmsOrderLines([...new Set(specs.map((s) => s.product_code))]).then(setWms, (e) => setError(`Λίστες WMS: ${(e as Error).message}`));
  }, [useWms, specs]);

  const allLines = useMemo(() => [...lines, ...(useWms ? wms : [])], [lines, wms, useWms]);
  const base = useMemo(() => (specs ? computeDemand(allLines, specs, newOf, [], until || null) : null), [allLines, specs, newOf, until]);
  // απόθεμα live για τους κωδικούς που χρειάζονται (και τους παλιούς των προδιαγραφών)
  const codes = useMemo(() => [...new Set((base?.needs ?? []).flatMap((n) => [n.code, ...n.specCodes]))].sort(), [base]);
  const codesKey = codes.join(",");
  useEffect(() => {
    if (!codes.length) return setStock([]);
    loadStockFor(codes).then(
      (st) => {
        // απόθεμα παλιού κωδικού (40*) μετράει στον νέο (41*)
        setStock(st.map((s) => ({ ...s, item: newOf.get(s.item) ?? s.item })));
      },
      (e) => setError(`Απόθεμα: ${(e as Error).message}`)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codesKey, stockTick]);
  const res = useMemo(() => (specs ? computeDemand(allLines, specs, newOf, stock, until || null) : null), [allLines, specs, newOf, stock, until]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setError(null);
    setNotice(null);
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await f.arrayBuffer(), { cellDates: true });
      // το φύλλο με τους περισσότερους κωδικούς
      let best: Cell[][] = [];
      let bestN = -1;
      for (const n of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[n], { header: 1, raw: true, defval: null });
        const cnt = rows.filter((r) => r.some((c) => /^\d{2}-\d{2}-\d{3}/.test(String(c ?? "").trim()))).length;
        if (cnt > bestN) {
          best = rows;
          bestN = cnt;
        }
      }
      if (bestN <= 0) throw new Error("Δεν βρέθηκαν κωδικοί τύπου 71-00-052 σε κανένα φύλλο.");
      const d = detectColumns(best);
      setPending({ kind: kindRef.current, file: f.name, rows: best, header: d.header, cols: d.cols, names: d.names });
    } catch (er) {
      setError(`Το Excel δεν διαβάστηκε: ${(er as Error).message}`);
    }
  }
  const preview = useMemo(() => (pending ? readDemand(pending.rows, pending.cols, pending.header) : []), [pending]);

  async function savePending() {
    if (!pending) return;
    setBusy("save");
    try {
      const { data, error: err } = await createClient().rpc("demand_replace", { p_kind: pending.kind, p_rows: preview, p_file: pending.file });
      if (err) throw new Error(err.message);
      setNotice(`${KIND_TXT[pending.kind]}: φορτώθηκαν ${data ?? preview.length} γραμμές από «${pending.file}».`);
      setPending(null);
      await loadAll();
    } catch (er) {
      setError(`Δεν αποθηκεύτηκε: ${(er as Error).message}`);
    } finally {
      setBusy(null);
    }
  }
  async function clearKind(kind: "plan" | "orders") {
    setBusy(`clear-${kind}`);
    const { error: err } = await createClient().rpc("demand_clear", { p_kind: kind });
    setBusy(null);
    if (err) return setError(err.message);
    await loadAll();
  }

  async function excel() {
    if (!res) return;
    setBusy("xlsx");
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.utils.book_new();
      const s1 = XLSX.utils.json_to_sheet(
        res.needs.map((n) => ({
          "Κωδικός": n.code,
          "Στις προδιαγραφές": n.specCodes.filter((c) => c !== n.code).join(", "),
          "Περιγραφή": n.description,
          "Πλάνο παραγωγής": Math.round(n.need.plan),
          "Ανοιχτές παραγγελίες": Math.round(n.need.orders),
          "Λίστες WMS": Math.round(n.need.wms),
          "Σύνολο ζήτησης": Math.round(n.total),
          "Κεντρική": Math.round(n.central),
          "Εξωτερική": Math.round(n.external),
          "Να έρθει από εξωτερική": Math.round(n.fromExternal),
          "Λείπει": Math.round(n.short),
          "Πρώτη ημερομηνία": fd(n.firstDue),
        }))
      );
      XLSX.utils.book_append_sheet(wb, s1, "Ζήτηση περιεκτών");
      const s2 = XLSX.utils.json_to_sheet(
        res.needs.flatMap((n) =>
          n.sources.map((x) => ({ "Κωδικός": n.code, "Περιγραφή": n.description, "Πηγή": KIND_TXT[x.kind], "Τελικό": x.product, "Περιγραφή τελικού": x.productDesc ?? "", "Τεμ. τελικού": x.productQty, "Ανά τεμάχιο": x.perUnit, "Χρειάζονται": Math.round(x.need), "Ημερομηνία": fd(x.due), "Αναφορά": x.ref ?? "" }))
        )
      );
      XLSX.utils.book_append_sheet(wb, s2, "Ανά τελικό");
      const s3 = XLSX.utils.json_to_sheet(res.noSpec.map((x) => ({ "Τελικό": x.product, "Περιγραφή": x.description ?? "", "Ποσότητα": x.qty, "Πηγή": x.kinds.map((k) => KIND_TXT[k]).join(", ") })));
      XLSX.utils.book_append_sheet(wb, s3, "Χωρίς προδιαγραφή");
      XLSX.writeFile(wb, `zitisi-periekton-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } finally {
      setBusy(null);
    }
  }

  const needs = res?.needs ?? [];
  const short = needs.filter((n) => n.short > 0);
  const ext = needs.filter((n) => n.fromExternal > 0 && n.short <= 0);
  const ok = needs.filter((n) => n.short <= 0 && n.fromExternal <= 0);
  const ql = q.trim().toUpperCase();
  const match = (n: ContainerNeed) => !ql || n.code.includes(ql) || n.specCodes.some((c) => c.includes(ql)) || n.description.toUpperCase().includes(ql) || n.sources.some((x) => x.product.includes(ql));
  const shown = (view === "short" ? short : view === "external" ? ext : view === "ok" ? ok : needs).filter(match);
  const up = (k: "plan" | "orders") => uploads.find((u) => u.kind === k);

  const cs = useColSort<ContainerNeed>(
    [
      { h: "" },
      { h: "Κωδικός", v: (n) => n.code },
      { h: "Περιγραφή", v: (n) => n.description },
      { h: "Πλάνο", v: (n) => n.need.plan, num: true },
      { h: "Παραγγελίες", v: (n) => n.need.orders + n.need.wms, num: true },
      { h: "Σύνολο", v: (n) => n.total, num: true },
      { h: "Κεντρική", v: (n) => n.central, num: true },
      { h: "Εξωτερική", v: (n) => n.external, num: true },
      { h: "Από εξωτερική", v: (n) => n.fromExternal, num: true, title: "Πόσα πρέπει να έρθουν από την εξωτερική για να καλυφθεί η ζήτηση" },
      { h: "Λείπει", v: (n) => n.short, num: true },
      { h: "Πρώτη ημ/νία", v: (n) => n.firstDue },
    ],
    shown
  );

  return (
    <div className="dm">
      <div className="dm-uploads">
        {(["plan", "orders"] as const).map((k) => {
          const u = up(k);
          return (
            <div key={k} className="dm-up">
              <div>
                <b>{KIND_TXT[k]}</b>
                <div className="dim">
                  {u ? (
                    <>
                      {u.file_name} · {fq(u.rows)} γραμμές · {ago(u.uploaded_at)}
                      {u.uploaded_by ? ` · ${displayUser(u.uploaded_by)}` : ""}
                    </>
                  ) : (
                    "Δεν έχει ανέβει αρχείο"
                  )}
                </div>
              </div>
              <span className="st-actions">
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={() => {
                    kindRef.current = k;
                    fileRef.current?.click();
                  }}
                >
                  Ανέβασμα Excel
                </button>
                {u && (
                  <button type="button" className="btn ghost sm" onClick={() => clearKind(k)} disabled={busy === `clear-${k}`}>
                    Διαγραφή
                  </button>
                )}
              </span>
            </div>
          );
        })}
        <input ref={fileRef} type="file" accept=".xlsx,.xlsm,.xls,.csv" hidden onChange={onFile} />
      </div>

      {pending && (
        <div className="dm-map">
          <p>
            <b>{KIND_TXT[pending.kind]}</b> από «{pending.file}» — έλεγξε ότι οι στήλες βρέθηκαν σωστά:
          </p>
          <div className="dm-cols">
            {(
              [
                ["product", "Κωδικός τελικού *"],
                ["qty", "Ποσότητα *"],
                ["due", "Ημερομηνία"],
                ["desc", "Περιγραφή"],
                ["ref", "Αναφορά (παραγγελία / πελάτης)"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="field">
                {label}
                <select value={pending.cols[key]} onChange={(e) => setPending({ ...pending, cols: { ...pending.cols, [key]: Number(e.target.value) } })}>
                  <option value={-1}>—</option>
                  {pending.names.map((n, i) => (
                    <option key={i} value={i}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="st-tablewrap">
            <table className="st-table">
              <thead>
                <tr>
                  {["Γραμμή", "Τελικό", "Περιγραφή", "Ποσότητα", "Ημερομηνία", "Αναφορά"].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.slice(0, 8).map((r) => (
                  <tr key={r.row}>
                    <td className="num dim">{r.row}</td>
                    <td className="mono">{r.product}</td>
                    <td>{r.description}</td>
                    <td className="num">{fq(r.qty)}</td>
                    <td className="mono">{fd(r.due)}</td>
                    <td>{r.ref}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="dim">
            {fq(preview.length)} γραμμές με κωδικό και ποσότητα
            {specs ? ` · ${fq(preview.filter((r) => specs.some((s) => s.product_code === r.product)).length)} με προδιαγραφή` : ""}. Το νέο αρχείο αντικαθιστά το προηγούμενο {KIND_TXT[pending.kind].toLowerCase()}.
          </p>
          <span className="st-actions">
            <button type="button" className="btn primary sm" onClick={savePending} disabled={busy === "save" || !preview.length}>
              {busy === "save" ? "Αποθήκευση…" : "Αποθήκευση"}
            </button>
            <button type="button" className="btn ghost sm" onClick={() => setPending(null)}>
              Άκυρο
            </button>
          </span>
        </div>
      )}

      {error && (
        <p className="st-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="st-notice">{notice}</p>}

      <div className="st-filters an-filters">
        <label className="field">
          Αναζήτηση
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="κωδικός, περιγραφή ή τελικό" />
        </label>
        <label className="field">
          Ζήτηση έως
          <input
            type="date"
            value={until}
            onChange={(e) => {
              setUntil(e.target.value);
              persist({ until: e.target.value });
            }}
          />
        </label>
        <label className="st-check" title="Προσθέτει τις ανοιχτές λίστες πωλήσεων του WMS (SALEXPORTLS) για τα τελικά των προδιαγραφών — μην το τσεκάρεις αν το Excel παραγγελιών είναι οι ίδιες">
          <input
            type="checkbox"
            checked={useWms}
            onChange={(e) => {
              setUseWms(e.target.checked);
              persist({ useWms: e.target.checked });
            }}
          />
          Και οι ανοιχτές λίστες WMS
        </label>
        <span className="st-actions">
          <button type="button" className="btn ghost sm" onClick={excel} disabled={!!busy || !needs.length}>
            {busy === "xlsx" ? "Excel…" : "Excel"}
          </button>
        </span>
      </div>

      {!res ? (
        <p className="rp-hint">Φόρτωση προδιαγραφών…</p>
      ) : !res.lines ? (
        <p className="rp-hint">
          Ανέβασε το Excel με το <b>πλάνο παραγωγής</b> ή τις <b>ανοιχτές παραγγελίες</b> (κωδικός τελικού + ποσότητα, προαιρετικά ημερομηνία). Μέσω των προδιαγραφών ({fq(specs?.length)} τελικά, ίδιες με
          το Repack) βγαίνει πόσα υλικά συσκευασίας χρειάζονται — κάθε υλικό που δεν είναι 00* ή 71* — σε σχέση με το απόθεμα κεντρικής και εξωτερικής. Οι παλιοί κωδικοί 40* των προδιαγραφών
          μετράνε στους νέους 41*.
        </p>
      ) : (
        <>
          <KpiTiles
            active={view}
            onPick={(k) => setView(k as View)}
            items={[
              { key: "all", label: "Υλικά συσκευασίας", value: needs.length, tone: "blue", hint: "Όλα τα υλικά που χρειάζονται" },
              { key: "short", label: "Λείπουν", value: short.length, tone: "red", hint: "Η ζήτηση ξεπερνά όλο το απόθεμα (κεντρική + εξωτερική)" },
              { key: "external", label: "Να έρθουν από εξωτερική", value: ext.length, tone: "orange", hint: "Η κεντρική δεν φτάνει — υπάρχει στην εξωτερική" },
              { key: "ok", label: "Καλύπτονται", value: ok.length, tone: "green", hint: "Φτάνει το απόθεμα της κεντρικής" },
              { key: "nospec", label: "Τελικά χωρίς προδιαγραφή", value: res.noSpec.length, tone: "neutral", hint: "Κωδικοί του αρχείου που δεν υπάρχουν στις προδιαγραφές" },
            ]}
          />
          {view === "nospec" ? (
            <div className="st-tablewrap">
              <table className="st-table st-cards">
                <thead>
                  <tr>
                    {["Τελικό", "Περιγραφή", "Ποσότητα", "Πηγή"].map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {res.noSpec.map((x) => (
                    <tr key={x.product}>
                      <td className="mono" data-label="Τελικό">{x.product}</td>
                      <td data-label="Περιγραφή">{x.description}</td>
                      <td className="num" data-label="Ποσότητα">{fq(x.qty)}</td>
                      <td data-label="Πηγή">{x.kinds.map((k) => KIND_TXT[k]).join(", ")}</td>
                    </tr>
                  ))}
                  {!res.noSpec.length && (
                    <tr>
                      <td colSpan={4} className="st-empty">Όλα τα τελικά έχουν προδιαγραφή.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="st-tablewrap">
              <table className="st-table st-cards rl-groups">
                <thead>
                  <tr>{cs.head}</tr>
                </thead>
                <tbody>
                  {cs.sorted.map((n) => {
                    const isOpen = open.has(n.code);
                    return (
                      <Fragment key={n.code}>
                        <tr
                          className={`rl-grow ${isOpen ? "open" : ""} ${n.short > 0 ? "dm-short" : n.fromExternal > 0 ? "dm-ext" : ""}`}
                          onClick={() =>
                            setOpen((c) => {
                              const x = new Set(c);
                              if (x.has(n.code)) x.delete(n.code);
                              else x.add(n.code);
                              return x;
                            })
                          }
                        >
                          <td>
                            <button type="button" className="rl-tog" aria-expanded={isOpen} aria-label="Τελικά">
                              {isOpen ? "▾" : "▸"}
                            </button>
                          </td>
                          <td data-label="Κωδικός">
                            <b className="mono">{n.code}</b>
                            {n.specCodes.some((c) => c !== n.code) && <div className="dim rl-legacy">στις προδιαγραφές {n.specCodes.filter((c) => c !== n.code).join(", ")}</div>}
                          </td>
                          <td data-label="Περιγραφή">{n.description}</td>
                          <td className="num" data-label="Πλάνο">{fz(n.need.plan)}</td>
                          <td className="num" data-label="Παραγγελίες">{fz(n.need.orders + n.need.wms)}</td>
                          <td className="num" data-label="Σύνολο"><b>{fq(n.total)}</b></td>
                          <td className="num" data-label="Κεντρική">{fq(n.central)}</td>
                          <td className="num" data-label="Εξωτερική">{fz(n.external)}</td>
                          <td className="num" data-label="Από εξωτερική">{n.fromExternal > 0 ? <b className="dm-o">{fq(n.fromExternal)}</b> : "—"}</td>
                          <td className="num" data-label="Λείπει">{n.short > 0 ? <b className="dm-r">{fq(n.short)}</b> : "—"}</td>
                          <td className="mono" data-label="Πρώτη ημ/νία">{fd(n.firstDue)}</td>
                        </tr>
                        {isOpen && (
                          <tr className="rl-sub">
                            <td colSpan={11}>
                              <table className="st-table rl-subtable">
                                <thead>
                                  <tr>
                                    {["Πηγή", "Τελικό", "Περιγραφή", "Τεμ. τελικού", "Ανά τεμ.", "Χρειάζονται", "Ημερομηνία", "Αναφορά"].map((h) => (
                                      <th key={h}>{h}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {n.sources.map((x, i) => (
                                    <tr key={i}>
                                      <td data-label="Πηγή">{KIND_TXT[x.kind]}</td>
                                      <td className="mono" data-label="Τελικό">{x.product}</td>
                                      <td data-label="Περιγραφή">{x.productDesc}</td>
                                      <td className="num" data-label="Τεμ. τελικού">{fq(x.productQty)}</td>
                                      <td className="num" data-label="Ανά τεμ.">{x.perUnit.toLocaleString("el-GR", { maximumFractionDigits: 4 })}</td>
                                      <td className="num" data-label="Χρειάζονται"><b>{fq(x.need)}</b></td>
                                      <td className="mono" data-label="Ημερομηνία">{fd(x.due)}</td>
                                      <td data-label="Αναφορά">{x.ref}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                  {!shown.length && (
                    <tr>
                      <td colSpan={11} className="st-empty">Τίποτα εδώ.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <p className="dim dm-foot">
        Προδιαγραφές: {fq(specs?.length)} τελικά (ίδιες με το Repack — ανεβαίνουν εκεί). Μετράνε τα υλικά με κωδικό που δεν είναι 00* ή 71*· για εναλλακτικές προδιαγραφές του ίδιου τελικού
        χρησιμοποιείται η πρώτη. Οι ανάγκες μετράνε και στη «Μεταφορά αποθέματος» (δεν προτείνεται να φύγει ό,τι χρειάζεται).
      </p>
    </div>
  );
}
