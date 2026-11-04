"use client";

import KpiTiles from "@/components/KpiTiles";
import FilterFold from "@/components/FilterFold";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import AppBar from "@/components/AppBar";
import { loadPdfFonts } from "@/lib/pdfFonts";
import LivePill from "@/components/LivePill";
import { useWmsLive } from "@/lib/live";
import { loadStock, loadStockItems } from "@/lib/stockData";
import type { StockRow } from "@/lib/exports";

type SortKey = "position" | "area" | "item" | "description" | "lot" | "serial" | "expiry" | "qty";
type ExpFilter = "all" | "expired" | "30" | "90" | "180" | "none";
type Filters = { text: string; position: string; area: string; exp: ExpFilter; serialOnly: boolean };
const EMPTY: Filters = { text: "", position: "", area: "", exp: "all", serialOnly: false };
const PAGE = 100;
const LS = "stock.filters.v1";

const key = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
const nat = (a: string, b: string) => a.localeCompare(b, "el", { numeric: true, sensitivity: "base" });
const fmtExp = (e: string | null) => (e ? `${e.slice(8, 10)}/${e.slice(5, 7)}/${e.slice(0, 4)}` : "");
const fmtQty = (n: number) => n.toLocaleString("el-GR", { maximumFractionDigits: 3 });
/** παλιό sync: πολλές θέσεις σε ένα πεδίο «99.8, 99.11» -> λίστα */
const splitPos = (p: string) => p.split(/\s*,\s*/).filter(Boolean);
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

export default function StockBoard({
  rows: initialRows,
  syncedAt: initialSyncedAt,
  userEmail,
  role,
}: {
  rows: StockRow[];
  syncedAt: string | null;
  userEmail: string | null;
  role: "admin" | "staff";
}) {
  const [rows, setRows] = useState<StockRow[]>(initialRows);
  const [syncedAt, setSyncedAt] = useState<string | null>(initialSyncedAt);
  const [fresh, setFresh] = useState<Set<string>>(new Set()); // κωδικοί που άλλαξαν τώρα (φωτίζονται)
  const [flash, setFlash] = useState(0);
  // live: αλλαγές από το sync -Live (μόνο οι κωδικοί που κινήθηκαν) ή πλήρης συγχρονισμός
  const live = useWmsLive(async (sig) => {
    try {
      if (sig.key === "stock" && sig.items.length) {
        const changed = await loadStockItems(sig.items);
        const set = new Set(sig.items);
        setRows((cur) => [...cur.filter((r) => !set.has(r.item)), ...changed]);
        setFresh(set);
        setFlash((x) => x + 1);
      } else if (sig.key === "stock_full") {
        const d = await loadStock();
        setRows(d.rows);
        setSyncedAt(d.syncedAt);
        setFlash((x) => x + 1);
      }
    } catch {
      /* επόμενο σήμα */
    }
  });
  const [f, setF] = useState<Filters>(EMPTY);
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: "position", dir: 1 });
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LS);
      if (raw) setF({ ...EMPTY, ...JSON.parse(raw) });
    } catch {
      /* τίποτα */
    }
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) setF((x) => ({ ...x, text: q }));
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(LS, JSON.stringify(f));
    } catch {
      /* τίποτα */
    }
    setPage(0);
  }, [f]);

  const areas = useMemo(() => [...new Set(rows.map((r) => r.area).filter(Boolean))].sort(nat), [rows]);
  // κλειδί αναζήτησης μία φορά ανά γραμμή
  const indexed = useMemo(() => rows.map((r) => ({ r, k: key(`${r.item} ${r.description} ${r.lot} ${r.serial} ${r.position}`) })), [rows]);

  const filtered = useMemo(() => {
    const words = key(f.text).split(/\s+/).filter(Boolean);
    const pos = f.position.trim().toLowerCase();
    const t = today();
    const lim = f.exp === "30" || f.exp === "90" || f.exp === "180" ? plusDays(Number(f.exp)) : "";
    const out = indexed
      .filter(({ r, k }) => {
        if (words.length && !words.every((w) => k.includes(w))) return false;
        if (pos && !splitPos(r.position).some((p) => p.toLowerCase().startsWith(pos))) return false;
        if (f.area && r.area !== f.area) return false;
        if (f.serialOnly && !r.serial) return false;
        if (f.exp === "expired" && !(r.expiry && r.expiry < t)) return false;
        if (lim && !(r.expiry && r.expiry <= lim)) return false;
        if (f.exp === "none" && r.expiry) return false;
        return true;
      })
      .map((x) => x.r);
    const { k, dir } = sort;
    out.sort((a, b) => {
      let c: number;
      if (k === "qty") c = a.qty - b.qty;
      else if (k === "expiry") c = (a.expiry ?? "9999").localeCompare(b.expiry ?? "9999");
      else c = nat(a[k], b[k]);
      return c * dir || nat(a.position, b.position) || nat(a.item, b.item);
    });
    return out;
  }, [indexed, f, sort]);

  const totals = useMemo(() => {
    const items = new Set<string>();
    const positions = new Set<string>();
    let qty = 0;
    for (const r of filtered) {
      items.add(r.item);
      for (const p of splitPos(r.position)) positions.add(p);
      qty += r.qty;
    }
    return { items: items.size, positions: positions.size, qty };
  }, [filtered]);

  // μετρητές σε όλο το απόθεμα (για τα πλακίδια που φιλτράρουν)
  const flags = useMemo(() => {
    const t0 = today();
    const s90 = plusDays(90);
    let expired = 0,
      soon90 = 0,
      serial = 0;
    for (const r of rows) {
      if (r.expiry && r.expiry < t0) expired++;
      else if (r.expiry && r.expiry <= s90) soon90++;
      if (r.serial) serial++;
    }
    return { expired, soon90, serial };
  }, [rows]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const shown = filtered.slice(page * PAGE, page * PAGE + PAGE);
  const active = JSON.stringify(f) !== JSON.stringify(EMPTY);

  function filterLabels() {
    const out: string[] = [];
    if (f.text) out.push(`αναζήτηση «${f.text}»`);
    if (f.position) out.push(`θέση ${f.position}…`);
    if (f.area) out.push(`περιοχή ${f.area}`);
    if (f.serialOnly) out.push("μόνο με serial");
    const e: Record<ExpFilter, string> = { all: "", expired: "ληγμένα", "30": "λήγουν ≤30 ημ.", "90": "λήγουν ≤90 ημ.", "180": "λήγουν ≤180 ημ.", none: "χωρίς λήξη" };
    if (e[f.exp]) out.push(e[f.exp]);
    return out;
  }
  const meta = () => ({ generatedAt: new Date(), userEmail, filters: filterLabels(), syncedAt });

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
      const { wb, fileName } = ex.stockWorkbook(XLSX, filtered, meta());
      XLSX.writeFile(wb, fileName);
    });
  const pdf = () =>
    run("pdf", async () => {
      if (filtered.length > 4000 && !window.confirm(`Το PDF θα έχει ${filtered.length.toLocaleString("el-GR")} γραμμές (πολλές σελίδες). Συνέχεια;`)) return;
      const [{ jsPDF }, { autoTable }, ex, fonts] = await Promise.all([import("jspdf"), import("jspdf-autotable"), import("@/lib/exports"), loadPdfFonts()]);
      const { doc, fileName } = ex.stockPdf(jsPDF, autoTable, fonts, filtered, meta());
      doc.save(fileName);
    });

  const th = (k: SortKey, label: string, cls = "") => (
    <th className={cls}>
      <button type="button" onClick={() => setSort((s) => ({ k, dir: s.k === k ? ((-s.dir) as 1 | -1) : 1 }))} aria-sort={sort.k === k ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
        {label}
        <span className="st-arrow">{sort.k === k ? (sort.dir === 1 ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );
  const t = today();
  const soon = plusDays(90);

  return (
    <>
      <AppBar email={userEmail} role={role} />
      <div className="wrap stock">
        <div className="header">
          <div className="titleblock">
            <h1>Απόθεμα</h1>
            <p>
              <LivePill connected={live.connected} lastAt={live.lastAt ?? syncedAt} flash={flash} /> Όλο το απόθεμα του WMS ανά θέση, παρτίδα και serial.{" "}
              {syncedAt ? `Συγχρονισμός: ${new Date(syncedAt).toLocaleString("el-GR", { dateStyle: "short", timeStyle: "short" })}.` : ""}
            </p>
          </div>
          <div className="st-actions">
            <button type="button" className="btn ghost" onClick={excel} disabled={!!busy || !filtered.length}>
              {busy === "xlsx" ? "Excel…" : "Excel"}
            </button>
            <button type="button" className="btn primary" onClick={pdf} disabled={!!busy || !filtered.length}>
              {busy === "pdf" ? "PDF…" : "PDF"}
            </button>
          </div>
        </div>

        <FilterFold active={[f.text, f.position, f.area].filter((x) => x.trim()).length + (f.exp !== "all" ? 1 : 0) + (f.serialOnly ? 1 : 0)}>
<section className="st-filters">
          <label className="field st-grow">
            Αναζήτηση
            <input value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} placeholder="Κωδικός, περιγραφή, παρτίδα, serial…" autoFocus />
          </label>
          <label className="field">
            Θέση (αρχή)
            <input value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })} placeholder="π.χ. 16.01 ή 99." />
          </label>
          <label className="field">
            Περιοχή
            <select value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })}>
              <option value="">Όλες</option>
              {areas.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Λήξη
            <select value={f.exp} onChange={(e) => setF({ ...f, exp: e.target.value as ExpFilter })}>
              <option value="all">Όλες</option>
              <option value="expired">Ληγμένα</option>
              <option value="30">Λήγουν σε ≤30 ημέρες</option>
              <option value="90">Λήγουν σε ≤90 ημέρες</option>
              <option value="180">Λήγουν σε ≤180 ημέρες</option>
              <option value="none">Χωρίς λήξη</option>
            </select>
          </label>
          <label className="st-check">
            <input type="checkbox" checked={f.serialOnly} onChange={(e) => setF({ ...f, serialOnly: e.target.checked })} />
            Μόνο με serial
          </label>
          {active && (
            <button type="button" className="btn ghost sm" onClick={() => setF(EMPTY)}>
              Καθάρισμα
            </button>
          )}
        </section>
        </FilterFold>

        <KpiTiles
          active={f.exp === "expired" ? "expired" : f.exp === "90" ? "soon" : f.serialOnly ? "serial" : null}
          onPick={(k) => {
            if (k === "expired") setF({ ...f, exp: f.exp === "expired" ? "all" : "expired" });
            else if (k === "soon") setF({ ...f, exp: f.exp === "90" ? "all" : "90" });
            else if (k === "serial") setF({ ...f, serialOnly: !f.serialOnly });
          }}
          items={[
            { key: "rows", label: "Γραμμές", value: filtered.length, tone: "neutral" },
            { key: "items", label: "Κωδικοί", value: totals.items, tone: "blue" },
            { key: "pos", label: "Θέσεις", value: totals.positions, tone: "blue" },
            { key: "qty", label: "Ποσότητα", value: fmtQty(totals.qty), tone: "neutral" },
            { key: "expired", label: "Ληγμένα", value: flags.expired, tone: "red", hint: "Κλικ: μόνο ληγμένα" },
            { key: "soon", label: "Λήγουν ≤90 ημ.", value: flags.soon90, tone: "yellow", hint: "Κλικ: λήγουν σε ≤90 ημέρες" },
            { key: "serial", label: "Με serial", value: flags.serial, tone: "green", hint: "Κλικ: μόνο με serial" },
          ]}
        />
        {rows.length === 0 && <p className="rp-hint">Το απόθεμα γεμίζει με τον συγχρονισμό του WMS (νέο sync-stock.ps1).</p>}
        {error && <p className="rp-notice error">{error}</p>}

        <div className="st-tablewrap">
          <table className="st-table st-cards">
            <thead>
              <tr>
                {th("position", "Θέση")}
                {th("area", "Περιοχή", "st-hide-sm")}
                {th("item", "Κωδικός")}
                {th("description", "Περιγραφή")}
                {th("lot", "Παρτίδα")}
                {th("serial", "Serial")}
                {th("expiry", "Λήξη")}
                {th("qty", "Ποσότητα", "num")}
                <th aria-label="Ενέργειες" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={`${r.item}|${r.position}|${r.lot}|${r.serial}|${fresh.has(r.item) ? flash : 0}`} className={fresh.has(r.item) ? "st-new" : ""}>
                  <td data-label="Θέση">
                    {r.position ? (
                      <div className="st-poslist">
                        {splitPos(r.position).map((p) => (
                          <span key={p} className="rack">
                            {p}
                          </span>
                        ))}
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="st-hide-sm dim" data-label="Περιοχή">{r.area}</td>
                  <td className="mono" data-label="Κωδικός">
                    <button type="button" className="st-link" onClick={() => setF({ ...f, text: r.item })} title="Μόνο αυτός ο κωδικός">
                      {r.item}
                    </button>
                  </td>
                  <td className="st-desc" data-label="Περιγραφή">{r.description}</td>
                  <td className="mono" data-label="Παρτίδα">{r.lot}</td>
                  <td className="mono" data-label="Serial">{r.serial}</td>
                  <td data-label="Λήξη" className={`mono ${r.expiry && r.expiry < t ? "st-expired" : r.expiry && r.expiry <= soon ? "st-soon" : ""}`}>{fmtExp(r.expiry)}</td>
                  <td className="num" data-label="Ποσότητα">
                    {fmtQty(r.qty)}
                    {splitPos(r.position).length > 1 && <div className="st-sub">σύνολο {splitPos(r.position).length} θέσεων</div>}
                  </td>
                  <td>
                    <Link
                      className="st-label"
                      href={`/labels/?mode=all&code=${encodeURIComponent(r.item)}`}
                      title="Ετικέτα για αυτόν τον κωδικό"
                    >
                      Ετικέτα
                    </Link>
                  </td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={9} className="st-empty">
                    Δεν βρέθηκε απόθεμα με αυτά τα φίλτρα.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {pages > 1 && (
          <div className="st-pager">
            <button type="button" className="btn ghost sm" disabled={page === 0} onClick={() => setPage(0)}>
              «
            </button>
            <button type="button" className="btn ghost sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
              ‹ Προηγ.
            </button>
            <span>
              Σελίδα {page + 1} / {pages}
            </span>
            <button type="button" className="btn ghost sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
              Επόμ. ›
            </button>
            <button type="button" className="btn ghost sm" disabled={page >= pages - 1} onClick={() => setPage(pages - 1)}>
              »
            </button>
          </div>
        )}
      </div>
    </>
  );
}
