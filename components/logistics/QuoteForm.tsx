"use client";

// Δημόσια φόρμα προσφοράς για μεταφορικές (χωρίς login): /quote/?t=<token>. Δίγλωσση (ελληνικά / English).
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { DOC_KINDS, docLink, fileSize, loadRows, type Rfq } from "@/lib/logistics";

type Got = {
  error?: string;
  carrier?: string;
  closed?: boolean;
  won?: boolean;
  declined?: boolean;
  rfq?: Partial<Rfq>;
  round?: { no: number; target: number; currency: string; deadline: string } | null;
  docs?: { id: string; kind: string; name: string; size: number | null }[];
  quote?: { price: number; first_price?: number | null; currency: string; transit_days: number | null; pickup_date: string | null; delivery_date: string | null; valid_until: string | null; includes: string | null; notes: string | null; contact: string | null; at: string } | null;
};

function Brand({ title, refNo }: { title: string; refNo?: string }) {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  return (
    <header className="qf-head">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`${base}/fagron-logo.svg`} alt="Fagron" width={170} height={40} />
      <div className="qf-head-r">
        <span>Logistics</span>
        {refNo && <b>{refNo}</b>}
      </div>
      <h1>{title}</h1>
    </header>
  );
}

export default function QuoteForm() {
  const [token, setToken] = useState<string | null>(null);
  const [got, setGot] = useState<Got | null>(null);
  const [f, setF] = useState({ price: "", currency: "EUR", transit_days: "", pickup_date: "", delivery_date: "", valid_until: "", includes: "", notes: "", contact: "" });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(t: string) {
    const { data, error: err } = await createClient().rpc("rfq_public_get", { p_token: t });
    if (err) return setGot({ error: err.message });
    const g = data as Got;
    setGot(g);
    if (g.quote)
      setF({
        price: String(g.quote.price ?? ""),
        currency: g.quote.currency ?? "EUR",
        transit_days: g.quote.transit_days != null ? String(g.quote.transit_days) : "",
        pickup_date: g.quote.pickup_date ?? "",
        delivery_date: g.quote.delivery_date ?? "",
        valid_until: g.quote.valid_until ?? "",
        includes: g.quote.includes ?? "",
        notes: g.quote.notes ?? "",
        contact: g.quote.contact ?? "",
      });
  }
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("t");
    setToken(t);
    if (t) load(t);
    else setGot({ error: "not_found" });
  }, []);

  async function submit(decline = false) {
    if (!token) return;
    setError(null);
    if (!decline && !f.price.trim()) return setError("Συμπληρώστε την τιμή / Please enter the price.");
    setBusy(true);
    const price = f.price.trim().replace(/\s/g, "");
    const norm = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(price) ? price.replace(/\./g, "").replace(",", ".") : price.replace(",", ".");
    const { error: err } = await createClient().rpc("rfq_public_submit", { p_token: token, p_quote: { ...f, price: norm, transit_days: f.transit_days.replace(",", "."), decline } });
    setBusy(false);
    if (err) return setError(err.message);
    setDone(decline ? (got?.round && got?.quote ? "Ευχαριστούμε — ισχύει η προηγούμενη τιμή σας. / Thank you — your previous price remains valid." : "Ευχαριστούμε για την ενημέρωση. / Thank you for letting us know.") : "Η προσφορά σας καταχωρήθηκε — ευχαριστούμε! / Your quote has been submitted — thank you!");
    load(token);
  }

  if (!got)
    return (
      <div className="qf qf-brand">
        <Brand title="Αίτημα προσφοράς / Quote request" />
        <p className="dim">Φόρτωση… / Loading…</p>
      </div>
    );
  if (got.error || !got.rfq)
    return (
      <div className="qf qf-brand">
        <Brand title="Αίτημα προσφοράς / Quote request" />
        <p>Το αίτημα δεν βρέθηκε. Ελέγξτε τον σύνδεσμο του email. / Request not found — please check the link in the email.</p>
      </div>
    );
  const r = got.rfq as Rfq;
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const inp = (k: keyof typeof f, label: string, type = "text", ph = "") => (
    <label className="field">
      {label}
      <input type={type} value={f[k]} placeholder={ph} inputMode={k === "price" || k === "transit_days" ? "decimal" : undefined} onChange={(e) => set(k, e.target.value)} disabled={got.closed} />
    </label>
  );
  return (
    <div className="qf qf-brand">
      <Brand title={got.round && !got.closed ? "Τιμή-στόχος / Target price" : "Αίτημα προσφοράς / Quote request"} refNo={r.ref} />
      <p>
        Για / For: <b>{got.carrier}</b>
      </p>
      <table className="lg-kv">
        <tbody>
          {loadRows(r).map(([k, v]) => (
            <tr key={k}>
              <th>{k}</th>
              <td>{v}</td>
            </tr>
          ))}
          {r.quote_deadline && (
            <tr>
              <th>Προθεσμία / Deadline</th>
              <td>{new Date(r.quote_deadline).toLocaleString("el-GR", { dateStyle: "short", timeStyle: "short" })}</td>
            </tr>
          )}
        </tbody>
      </table>

      {got.round && !got.closed && (
        <div className="qf-round">
          <b>
            Τιμή-στόχος / Target price: {Number(got.round.target).toLocaleString("el-GR")} {got.round.currency}
          </b>
          <br />
          Αν μπορείτε να την πιάσετε ή να πάτε χαμηλότερα, υποβάλετε τη νέα σας τιμή έως{" "}
          <b>{new Date(got.round.deadline).toLocaleString("el-GR", { dateStyle: "short", timeStyle: "short" })}</b>. Αλλιώς ισχύει η προηγούμενη προσφορά σας.
          <br />
          <i>If you can match or beat it, please submit your revised price by the deadline above. Otherwise your previous offer remains valid.</i>
        </div>
      )}
      {!!got.docs?.length && (
        <div>
          <b>Έγγραφα / Documents</b>
          <ul className="qf-docs">
            {got.docs.map((d) => {
              const k = DOC_KINDS.find((x) => x.key === d.kind);
              return (
                <li key={d.id}>
                  <a href={token ? docLink(token, d.id) : "#"} target="_blank" rel="noreferrer">
                    ⇩ {d.name}
                  </a>{" "}
                  <span className="dim">
                    {k ? `${k.gr} / ${k.en}` : d.kind}
                    {d.size ? ` · ${fileSize(d.size)}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {got.won && <p className="st-notice">✓ Η μεταφορά σας ανατέθηκε. / This transport has been awarded to you.</p>}
      {got.closed && !got.won && <p className="st-error">Το αίτημα έχει κλείσει. / This request is closed.</p>}
      {got.quote && !done && (
        <p className="dim">
          Έχετε ήδη στείλει προσφορά ({got.quote.price} {got.quote.currency}) — μπορείτε να την αλλάξετε. / You already submitted a quote — you can update it.
        </p>
      )}
      {got.declined && !got.quote && <p className="dim">Έχετε δηλώσει ότι δεν δίνετε προσφορά. / You declined this request.</p>}

      {!got.closed && (
        <form
          className="lg-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit(false);
          }}
        >
          <div className="lg-row">
            {inp("price", "Τιμή / Price *", "text", "π.χ. 450")}
            <label className="field">
              Νόμισμα / Currency
              <select value={f.currency} onChange={(e) => set("currency", e.target.value)}>
                {["EUR", "USD", "GBP", "CHF"].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            {inp("transit_days", "Ημέρες μεταφοράς / Transit days")}
            {inp("pickup_date", "Φόρτωση / Pick-up", "date")}
            {inp("delivery_date", "Παράδοση / Delivery", "date")}
            {inp("valid_until", "Ισχύει έως / Valid until", "date")}
          </div>
          <div className="lg-row">
            <label className="field lg-wide">
              Περιλαμβάνει / Includes
              <input value={f.includes} onChange={(e) => set("includes", e.target.value)} placeholder="καύσιμα, διόδια, εκτελωνισμός… / fuel, tolls, customs…" />
            </label>
            {inp("contact", "Υπεύθυνος / Contact")}
          </div>
          <label className="field">
            Σημειώσεις / Notes
            <textarea rows={3} value={f.notes} onChange={(e) => set("notes", e.target.value)} />
          </label>
          {error && <p className="st-error">{error}</p>}
          {done && <p className="st-notice">{done}</p>}
          <span className="st-actions">
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? "…" : got.quote ? "Ενημέρωση προσφοράς / Update quote" : "Αποστολή προσφοράς / Submit quote"}
            </button>
            <button type="button" className="btn ghost" onClick={() => submit(true)} disabled={busy}>
              {got.round && got.quote ? "Κρατάμε την τιμή μας / Keep our price" : "Δεν δίνουμε προσφορά / Decline"}
            </button>
          </span>
        </form>
      )}
      <p className="dim qf-foot">Fagron Hellas · 12 km N.R. Trikala - Larissa, 42100 Trikala, Greece</p>
    </div>
  );
}
