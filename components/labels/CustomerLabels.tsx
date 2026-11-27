"use client";

import { useEffect, useRef, useState } from "react";
import { CUSTOMER_TEMPLATE, readCustomers, type CustomerRow } from "@/lib/customerLabels";
import { loadPartners, searchPartners } from "@/components/logistics/partnerData";
import type { Partner } from "@/components/logistics/PartnersTab";
import type { AnyLabel, CustomerLabel } from "@/lib/labels";

const LS = "labels.customers.v1";
type Item = { data: AnyLabel; copies: number };

/** Ετικέτες διεύθυνσης πελατών (70×35, προεκτυπωμένο χαρτί): λίστα από Excel / WMS / χειροκίνητα. */
export default function CustomerLabels({
  busy,
  error,
  notice,
  onPreview,
  onPrint,
  onPdf,
}: {
  busy: boolean;
  error: string | null;
  notice: string | null;
  onPreview: (c: CustomerLabel | null) => void;
  onPrint: (items: Item[]) => void;
  onPdf: (items: Item[]) => void;
}) {
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [partners, setPartners] = useState<Partner[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // η λίστα κρατιέται στη συσκευή (για επανεκτύπωση)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS);
      if (raw) setRows(JSON.parse(raw));
    } catch {
      /* τίποτα */
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(LS, JSON.stringify(rows.slice(0, 2000)));
    } catch {
      /* τίποτα */
    }
  }, [rows]);

  const current = rows.find((r) => r.key === sel) ?? rows.find((r) => r.on) ?? null;
  useEffect(() => {
    onPreview(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.key, current?.name, current?.address, current?.zip, current?.city, current?.country, current?.phone, current?.note]);

  const upd = (key: string, p: Partial<CustomerRow>) => setRows((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const add = (r: Omit<CustomerRow, "key" | "kind" | "on" | "copies"> & { copies?: number }) => {
    const key = `c${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    setRows((xs) => [{ kind: "customer", key, on: true, copies: r.copies ?? 1, ...r }, ...xs]);
    setSel(key);
  };

  async function pickFile(f: File | undefined) {
    if (!f) return;
    setErr(null);
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
      const list = readCustomers(XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: false }));
      if (!list.length) throw new Error("Δεν βρέθηκαν πελάτες κάτω από τις επικεφαλίδες.");
      const stamp = Date.now();
      setRows(list.map((r, i) => ({ ...r, key: `f${stamp}-${i}` })));
      setSel(null);
      setMsg(`Από το ${f.name}: ${list.length} πελάτες.`);
    } catch (e) {
      setErr(`Το Excel δεν διαβάστηκε: ${(e as Error).message}`);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function template() {
    const XLSX = await import("xlsx");
    const ws = XLSX.utils.aoa_to_sheet(CUSTOMER_TEMPLATE);
    ws["!cols"] = CUSTOMER_TEMPLATE[0].map((h) => ({ wch: Math.max(12, String(h).length + 6) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Πελάτες");
    XLSX.writeFile(wb, "etiketes-pelaton-protypo.xlsx");
  }

  const hits = partners && q.trim().length >= 2 ? searchPartners(partners, q, "customer", 8) : [];
  const chosen = rows.filter((r) => r.on);
  const total = chosen.reduce((t, r) => t + r.copies, 0);
  const items = (): Item[] => chosen.map(({ key: _k, on: _o, copies, ...data }) => ({ data: { ...data, kind: "customer" }, copies }));

  return (
    <section className="lb-form lb-cust">
      <div className="lg-row">
        <button type="button" className="btn primary sm" onClick={() => fileRef.current?.click()}>
          ⇪ Λίστα από Excel
        </button>
        <button type="button" className="btn ghost sm" onClick={template} title="Excel με τις στήλες που αναγνωρίζονται">
          Πρότυπο
        </button>
        <button type="button" className="btn ghost sm" onClick={() => add({ name: "", address: "", zip: "", city: "", country: "", phone: "", note: "" })}>
          + Χειροκίνητα
        </button>
        {rows.length > 0 && (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              if (window.confirm("Καθαρισμός όλης της λίστας;")) setRows([]);
            }}
          >
            Καθαρισμός
          </button>
        )}
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
      </div>
      <label className="field lb-search">
        Ή πελάτης από το WMS
        <input
          value={q}
          placeholder="επωνυμία, κωδικός, πόλη ή ΑΦΜ"
          onFocus={() => {
            if (!partners) loadPartners().then(setPartners, () => setPartners([]));
          }}
          onChange={(e) => setQ(e.target.value)}
        />
        {q.trim().length >= 2 && (
          <ul className="lb-matches" role="listbox">
            {!partners && <li className="dim">Φόρτωση…</li>}
            {partners && !hits.length && <li className="dim">Δεν βρέθηκε.</li>}
            {hits.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    add({ name: p.name ?? "", address: p.address ?? "", zip: p.zip ?? "", city: p.city ?? "", country: p.country ?? "", phone: [p.phone, p.phone2].filter(Boolean)[0] ?? "", note: "" });
                    setQ("");
                  }}
                >
                  <span className="mono">{p.code}</span> {p.name} <span className="dim">{[p.zip, p.city].filter(Boolean).join(" ")}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </label>
      {msg && <p className="dim">{msg}</p>}
      {err && <p className="st-error">{err}</p>}

      {rows.length ? (
        <div className="st-tablewrap">
          <table className="st-table lb-ctable">
            <thead>
              <tr>
                <th>
                  <input type="checkbox" checked={chosen.length === rows.length} onChange={(e) => setRows((xs) => xs.map((x) => ({ ...x, on: e.target.checked })))} title="Όλοι" />
                </th>
                {["Επωνυμία", "Διεύθυνση", "ΤΚ", "Πόλη", "Χώρα", "Τηλέφωνο", "Σημείωση", "Ετικ.", ""].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={r.key === current?.key ? "lb-sel" : ""} onClick={() => setSel(r.key)}>
                  <td>
                    <input type="checkbox" checked={r.on} onChange={(e) => upd(r.key, { on: e.target.checked })} />
                  </td>
                  {(["name", "address", "zip", "city", "country", "phone", "note"] as const).map((k) => (
                    <td key={k}>
                      <input className={`c-${k}`} value={r[k] ?? ""} onChange={(e) => upd(r.key, { [k]: e.target.value })} onFocus={() => setSel(r.key)} />
                    </td>
                  ))}
                  <td>
                    <input className="c-n" inputMode="numeric" value={r.copies} onChange={(e) => upd(r.key, { copies: Math.max(1, Math.min(500, Math.floor(Number(e.target.value) || 1))) })} />
                  </td>
                  <td>
                    <button type="button" className="btn ghost sm" onClick={() => setRows((xs) => xs.filter((x) => x.key !== r.key))} title="Αφαίρεση">
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="dim">
          Φόρτωσε Excel με στήλες π.χ. <b>Επωνυμία, Διεύθυνση, ΤΚ, Πόλη, Τηλέφωνο</b> (προαιρετικά Χώρα, Σημείωση, Ετικέτες = πόσες ανά πελάτη) — ή διάλεξε πελάτη από το WMS.
          Τυπώνεται στο ίδιο προεκτυπωμένο χαρτί 70×35 της Fagron.
        </p>
      )}

      {error && <p className="rp-notice error">{error}</p>}
      {notice && <p className="rp-hint">{notice}</p>}
      <div className="lb-actions">
        <button type="button" className="btn primary" disabled={busy || !total} onClick={() => onPrint(items())}>
          {busy ? "…" : `🖨 Εκτύπωση (${total} ετικέτ${total === 1 ? "α" : "ες"})`}
        </button>
        <button type="button" className="btn ghost" disabled={busy || !total} onClick={() => onPdf(items())}>
          PDF
        </button>
      </div>
    </section>
  );
}
