"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { HOME, INCOTERMS, MODES, type Direction, type Rfq } from "@/lib/logistics";

export type Draft = Partial<Rfq>;
/** «1.234,5» / «12,5» / «12.5» -> αριθμός */
function toNumber(v: unknown): number | null {
  const t = String(v ?? "").trim().replace(/\s/g, "");
  if (!t) return null;
  const x = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t) ? t.replace(/\./g, "").replace(",", ".") : t.replace(",", ".");
  const n = Number(x);
  return isFinite(n) ? n : null;
}
const NUMS = ["pallets", "packages", "weight_kg", "volume_m3", "ldm", "value_eur"] as const;

export function emptyRfq(direction: Direction): Draft {
  const home = { company: HOME.company, address: HOME.address, city: HOME.city, zip: HOME.zip, country: HOME.country };
  const side = direction === "export" ? "from" : "to";
  return {
    direction,
    mode: "groupage",
    adr: false,
    stackable: true,
    incoterm: direction === "export" ? "DAP" : "EXW",
    temp: "15-25°C",
    ...Object.fromEntries(Object.entries(home).map(([k, v]) => [`${side}_${k}`, v])),
  };
}

/** Φόρμα αιτήματος (νέο ή επεξεργασία). onSaved με το id. */
export default function RfqForm({ initial, userEmail, onSaved, onCancel }: { initial: Draft; userEmail: string | null; onSaved: (id: string) => void; onCancel: () => void }) {
  const [d, setD] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof Rfq, v: unknown) => setD((x) => ({ ...x, [k]: v }));
  const txt = (k: keyof Rfq, label: string, opt: { ph?: string; wide?: boolean; type?: string } = {}) => (
    <label className={`field ${opt.wide ? "lg-wide" : ""}`}>
      {label}
      <input
        type={opt.type ?? "text"}
        value={(d[k] as string | number | null | undefined) ?? ""}
        placeholder={opt.ph}
        inputMode={(NUMS as readonly string[]).includes(k) ? "decimal" : undefined}
        onChange={(e) => set(k, e.target.value)}
      />
    </label>
  );
  const flip = (dir: Direction) => {
    // αλλαγή εισαγωγής/εξαγωγής: η Fagron Hellas πηγαίνει στη σωστή πλευρά
    if (dir === d.direction) return;
    const sw: Draft = { ...d, direction: dir };
    for (const k of ["company", "address", "city", "zip", "country"]) {
      const a = `from_${k}` as keyof Rfq;
      const b = `to_${k}` as keyof Rfq;
      (sw as Record<string, unknown>)[a] = d[b];
      (sw as Record<string, unknown>)[b] = d[a];
    }
    setD(sw);
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!d.from_city || !d.to_city) return setError("Συμπληρώστε τουλάχιστον πόλη φόρτωσης και παράδοσης.");
    setBusy(true);
    const row: Record<string, unknown> = { ...d };
    for (const k of ["id", "ref", "created_at", "updated_at", "status", "awarded_quote"]) delete row[k];
    for (const k of NUMS) {
      const v = row[k];
      row[k] = toNumber(v);
    }
    for (const k of ["pickup_date", "delivery_by", "quote_deadline"]) if (row[k] === "") row[k] = null;
    if (row.quote_deadline) row.quote_deadline = new Date(String(row.quote_deadline)).toISOString();
    const sb = createClient();
    const res = d.id ? await sb.from("rfqs").update(row).eq("id", d.id).select("id").single() : await sb.from("rfqs").insert({ ...row, created_by: userEmail }).select("id").single();
    setBusy(false);
    if (res.error) return setError(res.error.message);
    const id = (res.data as { id: string }).id;
    await sb.from("rfq_events").insert({ rfq_id: id, by: userEmail, text: d.id ? "Αλλαγή στοιχείων" : "Δημιουργία αιτήματος" });
    onSaved(id);
  }

  // datetime-local θέλει τοπική ώρα (όχι UTC)
  const dl = d.quote_deadline
    ? (() => {
        const t = new Date(d.quote_deadline);
        return new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      })()
    : "";
  return (
    <form className="lg-form" onSubmit={save}>
      <div className="lg-row">
        <div className="an-modes" role="tablist">
          {(["export", "import"] as const).map((k) => (
            <button key={k} type="button" className={`sl-chip ${d.direction === k ? "on" : ""}`} onClick={() => flip(k)}>
              {k === "export" ? "Εξαγωγή" : "Εισαγωγή"}
            </button>
          ))}
        </div>
        <label className="field">
          Τρόπος
          <select value={d.mode ?? ""} onChange={(e) => set("mode", e.target.value)}>
            {MODES.map((m) => (
              <option key={m.key} value={m.key}>
                {m.gr}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Incoterm
          <select value={d.incoterm ?? ""} onChange={(e) => set("incoterm", e.target.value)}>
            <option value="">—</option>
            {INCOTERMS.map((i) => (
              <option key={i}>{i}</option>
            ))}
          </select>
        </label>
        {txt("customer", d.direction === "export" ? "Πελάτης" : "Προμηθευτής")}
        {txt("order_ref", "Αρ. παραγγελίας / PO")}
      </div>

      <div className="lg-cols">
        <fieldset>
          <legend>Φόρτωση</legend>
          {txt("from_company", "Εταιρεία")}
          {txt("from_address", "Διεύθυνση")}
          <div className="lg-row">
            {txt("from_zip", "Τ.Κ.")}
            {txt("from_city", "Πόλη *")}
            {txt("from_country", "Χώρα", { ph: "π.χ. DE" })}
          </div>
        </fieldset>
        <fieldset>
          <legend>Παράδοση</legend>
          {txt("to_company", "Εταιρεία")}
          {txt("to_address", "Διεύθυνση")}
          <div className="lg-row">
            {txt("to_zip", "Τ.Κ.")}
            {txt("to_city", "Πόλη *")}
            {txt("to_country", "Χώρα", { ph: "π.χ. DE" })}
          </div>
        </fieldset>
      </div>

      <fieldset>
        <legend>Φορτίο</legend>
        <div className="lg-row">
          {txt("goods", "Εμπόρευμα", { wide: true, ph: "π.χ. φαρμακευτικές πρώτες ύλες, μη επικίνδυνα" })}
          {txt("pallets", "Παλέτες")}
          {txt("packages", "Δέματα")}
          {txt("weight_kg", "Βάρος (kg)")}
          {txt("volume_m3", "Όγκος (m³)")}
          {txt("ldm", "LDM")}
          {txt("dims", "Διαστάσεις", { ph: "120x80x150 cm" })}
          <label className="field">
            Στοιβαζόμενο
            <select value={d.stackable == null ? "" : d.stackable ? "1" : "0"} onChange={(e) => set("stackable", e.target.value === "" ? null : e.target.value === "1")}>
              <option value="">—</option>
              <option value="1">Ναι</option>
              <option value="0">Όχι</option>
            </select>
          </label>
          {txt("temp", "Θερμοκρασία")}
          <label className="st-check">
            <input type="checkbox" checked={!!d.adr} onChange={(e) => set("adr", e.target.checked)} />
            ADR
          </label>
          {d.adr && txt("adr_info", "UN / κλάση", { ph: "UN1170, 3, II" })}
          {txt("value_eur", "Αξία (€)")}
        </div>
      </fieldset>

      <fieldset>
        <legend>Ημερομηνίες</legend>
        <div className="lg-row">
          {txt("pickup_date", "Φόρτωση", { type: "date" })}
          {txt("delivery_by", "Παράδοση έως", { type: "date" })}
          <label className="field">
            Προθεσμία προσφορών
            <input type="datetime-local" value={dl} onChange={(e) => set("quote_deadline", e.target.value ? new Date(e.target.value).toISOString() : null)} />
          </label>
        </div>
      </fieldset>

      <div className="lg-cols">
        <label className="field">
          Σημειώσεις προς μεταφορικές
          <textarea rows={3} value={d.notes ?? ""} onChange={(e) => set("notes", e.target.value)} placeholder="π.χ. ράμπα φόρτωσης, ωράριο, απαιτείται tail-lift" />
        </label>
        <label className="field">
          Εσωτερικές σημειώσεις
          <textarea rows={3} value={d.internal_notes ?? ""} onChange={(e) => set("internal_notes", e.target.value)} placeholder="Δεν φαίνονται στις μεταφορικές" />
        </label>
      </div>

      {error && (
        <p className="st-error" role="alert">
          {error}
        </p>
      )}
      <span className="st-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? "Αποθήκευση…" : d.id ? "Αποθήκευση" : "Δημιουργία αιτήματος"}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          Άκυρο
        </button>
      </span>
    </form>
  );
}
