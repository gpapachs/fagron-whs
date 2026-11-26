"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { MODES, MODE_TXT, parseList, type Carrier } from "@/lib/logistics";
import type { LogData } from "@/components/logistics/data";
import { CARRIER_TEMPLATE, mergeCarrier, readCarriers, type ImportLine } from "@/lib/carrierImport";

const fm = (n: number | null | undefined) => (n == null ? "" : n.toLocaleString("el-GR", { maximumFractionDigits: 0 }));
type Edit = { id?: string; name: string; emails: string; contact: string; phone: string; modes: string[]; countries: string; notes: string; rating: string; active: boolean };
const blank: Edit = { name: "", emails: "", contact: "", phone: "", modes: ["groupage"], countries: "", notes: "", rating: "", active: true };

export default function CarriersTab({ data, userEmail, reload }: { data: LogData; userEmail: string | null; reload: () => void }) {
  const [ed, setEd] = useState<Edit | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [imp, setImp] = useState<{ file: string; lines: ImportLine[]; skip: Set<number> } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function pickFile(f: File | undefined) {
    if (!f) return;
    setError(null);
    setMsg(null);
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
      let best: ImportLine[] | null = null;
      let lastErr: Error | null = null;
      // πρώτο φύλλο που έχει στήλη ονόματος μεταφορικής
      for (const n of wb.SheetNames) {
        try {
          const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[n], { header: 1, defval: "", raw: false });
          best = readCarriers(rows, data.carriers).lines;
          break;
        } catch (e) {
          lastErr = e as Error;
        }
      }
      if (!best) throw lastErr ?? new Error("Κενό αρχείο.");
      if (!best.length) throw new Error("Δεν βρέθηκαν γραμμές με μεταφορικές κάτω από τις επικεφαλίδες.");
      setImp({ file: f.name, lines: best, skip: new Set(best.filter((l) => l.error === "διπλή γραμμή στο αρχείο").map((l) => l.row)) });
    } catch (e) {
      setError(`Το Excel δεν διαβάστηκε: ${(e as Error).message}`);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function runImport() {
    if (!imp) return;
    setBusy(true);
    setError(null);
    const sb = createClient();
    let added = 0;
    let updated = 0;
    const fails: string[] = [];
    for (const l of imp.lines) {
      if (imp.skip.has(l.row)) continue;
      const res = l.match ? await sb.from("carriers").update(mergeCarrier(l.match, l.data)).eq("id", l.match.id) : await sb.from("carriers").insert({ ...l.data, created_by: userEmail });
      if (res.error) fails.push(`${l.data.name}: ${res.error.message}`);
      else if (l.match) updated++;
      else added++;
    }
    setBusy(false);
    setImp(null);
    setMsg(`Από το ${imp.file}: ${added} νέες, ${updated} ενημερώθηκαν.`);
    if (fails.length) setError(`Απέτυχαν ${fails.length}: ${fails.slice(0, 5).join(" · ")}`);
    reload();
  }

  async function template() {
    const XLSX = await import("xlsx");
    const ws = XLSX.utils.aoa_to_sheet(CARRIER_TEMPLATE);
    ws["!cols"] = CARRIER_TEMPLATE[0].map((h) => ({ wch: Math.max(14, String(h).length + 4) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Μεταφορικές");
    XLSX.writeFile(wb, "metaforikes-protypo.xlsx");
  }

  // στατιστικά ανά μεταφορική: αιτήματα, προσφορές, αναθέσεις, μέση απόκλιση από τη φθηνότερη
  const stats = (c: Carrier) => {
    const inv = data.invites.filter((i) => i.carrier_id === c.id).length;
    const qs = data.quotes.filter((x) => x.carrier_id === c.id);
    const won = data.rfqs.filter((r) => qs.some((x) => x.id === r.awarded_quote));
    const cost = won.reduce((t, r) => t + (r.final_cost ?? 0), 0);
    return { inv, quoted: qs.length, won: won.length, cost, rate: inv ? qs.length / inv : null };
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!ed) return;
    if (!ed.name.trim()) return setError("Συμπληρώστε όνομα.");
    setBusy(true);
    setError(null);
    const row = {
      name: ed.name.trim(),
      emails: parseList(ed.emails).map((x) => x.toLowerCase()),
      contact: ed.contact || null,
      phone: ed.phone || null,
      modes: ed.modes,
      countries: parseList(ed.countries).map((x) => x.toUpperCase()),
      notes: ed.notes || null,
      rating: ed.rating ? Number(ed.rating) : null,
      active: ed.active,
    };
    const sb = createClient();
    const res = ed.id ? await sb.from("carriers").update(row).eq("id", ed.id) : await sb.from("carriers").insert({ ...row, created_by: userEmail });
    setBusy(false);
    if (res.error) return setError(res.error.message);
    setEd(null);
    reload();
  }

  const ql = q.trim().toUpperCase();
  const list = data.carriers.filter((c) => !ql || c.name.toUpperCase().includes(ql) || c.countries.some((x) => x.includes(ql)) || c.emails.some((x) => x.toUpperCase().includes(ql)));

  return (
    <div>
      <div className="st-filters an-filters">
        <label className="field">
          Αναζήτηση
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="όνομα, χώρα, email" />
        </label>
        <span className="st-actions">
          <button type="button" className="btn primary sm" onClick={() => setEd({ ...blank })}>
            + Νέα μεταφορική
          </button>
          <button type="button" className="btn ghost sm" onClick={() => fileRef.current?.click()} disabled={busy}>
            ⇪ Φόρτωση από Excel
          </button>
          <button type="button" className="btn ghost sm" onClick={template} title="Excel με τις στήλες που αναγνωρίζονται">
            Πρότυπο
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
        </span>
      </div>
      {msg && <p className="dim">{msg}</p>}
      {!ed && error && <p className="st-error">{error}</p>}

      {imp && (
        <div className="lg-card">
          <h3>
            Φόρτωση από {imp.file} — {imp.lines.length - imp.skip.size} από {imp.lines.length} επιλεγμένες
          </h3>
          <p className="dim">
            Νέες μεταφορικές προστίθενται· όσες υπάρχουν ήδη (ίδιο όνομα ή email) ενημερώνονται χωρίς να χάσουν email, τρόπους ή χώρες που έχουν ήδη. Ξετσέκαρε όσες
            δεν θέλεις.
          </p>
          <div className="st-tablewrap">
            <table className="st-table st-cards">
              <thead>
                <tr>
                  {["", "Γραμμή", "Μεταφορική", "Email", "Τρόποι", "Χώρες", "Υπεύθυνος / τηλ.", "Ενέργεια"].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {imp.lines.map((l) => {
                  const on = !imp.skip.has(l.row);
                  return (
                    <tr key={l.row} className={on ? "" : "dim"}>
                      <td>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => {
                            const skip = new Set(imp.skip);
                            if (on) skip.add(l.row);
                            else skip.delete(l.row);
                            setImp({ ...imp, skip });
                          }}
                        />
                      </td>
                      <td className="num" data-label="Γραμμή">{l.row}</td>
                      <td data-label="Μεταφορική">
                        <b>{l.data.name}</b>
                        {l.data.rating ? <span className="dim"> {"★".repeat(l.data.rating)}</span> : null}
                      </td>
                      <td data-label="Email">{l.data.emails.join(", ") || <span className="dm-r">—</span>}</td>
                      <td data-label="Τρόποι">{l.data.modes.map((m) => MODE_TXT[m] ?? m).join(", ")}</td>
                      <td data-label="Χώρες">{l.data.countries.join(", ")}</td>
                      <td data-label="Υπεύθυνος">{[l.data.contact, l.data.phone].filter(Boolean).join(" · ")}</td>
                      <td data-label="Ενέργεια">
                        {l.match ? <span className="lg-badge blue">ενημέρωση «{l.match.name}»</span> : <span className="lg-badge green">νέα</span>}
                        {l.error && <div className="dm-r">{l.error}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <span className="st-actions">
            <button type="button" className="btn primary sm" disabled={busy || imp.skip.size === imp.lines.length} onClick={runImport}>
              {busy ? "Αποθήκευση…" : `Εισαγωγή ${imp.lines.length - imp.skip.size}`}
            </button>
            <button type="button" className="btn ghost sm" onClick={() => setImp(null)} disabled={busy}>
              Άκυρο
            </button>
          </span>
        </div>
      )}

      {ed && (
        <form className="lg-form lg-card" onSubmit={save}>
          <div className="lg-row">
            <label className="field lg-wide">
              Όνομα *
              <input value={ed.name} onChange={(e) => setEd({ ...ed, name: e.target.value })} />
            </label>
            <label className="field lg-wide">
              Email (για αιτήματα — χωρισμένα με κόμμα)
              <input value={ed.emails} onChange={(e) => setEd({ ...ed, emails: e.target.value })} placeholder="export@…, pricing@…" />
            </label>
            <label className="field">
              Υπεύθυνος
              <input value={ed.contact} onChange={(e) => setEd({ ...ed, contact: e.target.value })} />
            </label>
            <label className="field">
              Τηλέφωνο
              <input value={ed.phone} onChange={(e) => setEd({ ...ed, phone: e.target.value })} />
            </label>
          </div>
          <div className="lg-row">
            {MODES.map((m) => (
              <label key={m.key} className="st-check">
                <input type="checkbox" checked={ed.modes.includes(m.key)} onChange={(e) => setEd({ ...ed, modes: e.target.checked ? [...ed.modes, m.key] : ed.modes.filter((x) => x !== m.key) })} />
                {m.gr}
              </label>
            ))}
          </div>
          <div className="lg-row">
            <label className="field lg-wide">
              Χώρες (κωδικοί, π.χ. DE, NL, IT — «*» = όλες)
              <input value={ed.countries} onChange={(e) => setEd({ ...ed, countries: e.target.value })} />
            </label>
            <label className="field">
              Αξιολόγηση
              <select value={ed.rating} onChange={(e) => setEd({ ...ed, rating: e.target.value })}>
                <option value="">—</option>
                {[5, 4, 3, 2, 1].map((n) => (
                  <option key={n} value={n}>
                    {"★".repeat(n)}
                  </option>
                ))}
              </select>
            </label>
            <label className="st-check">
              <input type="checkbox" checked={ed.active} onChange={(e) => setEd({ ...ed, active: e.target.checked })} />
              Ενεργή
            </label>
          </div>
          <label className="field">
            Σημειώσεις
            <textarea rows={2} value={ed.notes} onChange={(e) => setEd({ ...ed, notes: e.target.value })} />
          </label>
          {error && <p className="st-error">{error}</p>}
          <span className="st-actions">
            <button type="submit" className="btn primary sm" disabled={busy}>
              Αποθήκευση
            </button>
            <button type="button" className="btn ghost sm" onClick={() => setEd(null)}>
              Άκυρο
            </button>
          </span>
        </form>
      )}

      <div className="st-tablewrap">
        <table className="st-table st-cards">
          <thead>
            <tr>
              {["Μεταφορική", "Email", "Τρόποι", "Χώρες", "Αιτήματα", "Προσφορές", "Αναθέσεις", "Κόστος αναθέσεων", ""].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map((c) => {
              const s = stats(c);
              return (
                <tr key={c.id} className={c.active ? "" : "dim"}>
                  <td data-label="Μεταφορική">
                    <b>{c.name}</b> {c.rating ? <span className="dim">{"★".repeat(c.rating)}</span> : null}
                    <div className="dim">{[c.contact, c.phone].filter(Boolean).join(" · ")}</div>
                  </td>
                  <td data-label="Email">{c.emails.join(", ") || <span className="dm-r">—</span>}</td>
                  <td data-label="Τρόποι">{c.modes.map((m) => MODE_TXT[m] ?? m).join(", ")}</td>
                  <td data-label="Χώρες">{c.countries.join(", ")}</td>
                  <td className="num" data-label="Αιτήματα">{s.inv || ""}</td>
                  <td className="num" data-label="Προσφορές">
                    {s.quoted || ""}
                    {s.rate != null && <span className="dim"> ({Math.round(s.rate * 100)}%)</span>}
                  </td>
                  <td className="num" data-label="Αναθέσεις">{s.won || ""}</td>
                  <td className="num" data-label="Κόστος">{s.cost ? `${fm(s.cost)} €` : ""}</td>
                  <td>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() =>
                        setEd({
                          id: c.id,
                          name: c.name,
                          emails: c.emails.join(", "),
                          contact: c.contact ?? "",
                          phone: c.phone ?? "",
                          modes: c.modes,
                          countries: c.countries.join(", "),
                          notes: c.notes ?? "",
                          rating: c.rating ? String(c.rating) : "",
                          active: c.active,
                        })
                      }
                    >
                      ✎
                    </button>
                  </td>
                </tr>
              );
            })}
            {!list.length && (
              <tr>
                <td colSpan={9} className="st-empty">
                  Δεν υπάρχουν μεταφορικές ακόμα — πρόσθεσε την πρώτη με «+ Νέα μεταφορική».
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
