"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { MODES, MODE_TXT, parseList, type Carrier } from "@/lib/logistics";
import type { LogData } from "@/components/logistics/data";

const fm = (n: number | null | undefined) => (n == null ? "" : n.toLocaleString("el-GR", { maximumFractionDigits: 0 }));
type Edit = { id?: string; name: string; emails: string; contact: string; phone: string; modes: string[]; countries: string; notes: string; rating: string; active: boolean };
const blank: Edit = { name: "", emails: "", contact: "", phone: "", modes: ["groupage"], countries: "", notes: "", rating: "", active: true };

export default function CarriersTab({ data, userEmail, reload }: { data: LogData; userEmail: string | null; reload: () => void }) {
  const [ed, setEd] = useState<Edit | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        </span>
      </div>

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
