"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { displayUser } from "@/lib/users";
import { ago } from "@/lib/live";
import RfqForm from "@/components/logistics/RfqForm";
import RoundPanel from "@/components/logistics/RoundPanel";
import DocsCard from "@/components/logistics/DocsCard";
import ManifestCard from "@/components/logistics/ManifestCard";
import { downloadDoc, logEvent, queueMail, type LogData } from "@/components/logistics/data";
import { roundSaving, awardEmail, htmlToText, mailtoHref, dmy, DIR_TXT, loadRows, MODE_TXT, quoteLink, rankQuotes, rfqEmail, route, STATUS_TONE, STATUS_TXT, suggestCarriers, type Quote, type Rfq } from "@/lib/logistics";

const fm = (n: number | null | undefined, d = 2) => (n == null ? "" : n.toLocaleString("el-GR", { minimumFractionDigits: 0, maximumFractionDigits: d }));
const toNum = (s: string) => {
  const t = s.trim().replace(/\s/g, "");
  if (!t) return null;
  const x = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t) ? t.replace(/\./g, "").replace(",", ".") : t.replace(",", ".");
  const n = Number(x);
  return isFinite(n) ? n : null;
};

export default function RfqDetail({ rfq, data, userEmail, onBack, reload }: { rfq: Rfq; data: LogData; userEmail: string | null; onBack: () => void; reload: () => void }) {
  const [edit, setEdit] = useState(false);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mq, setMq] = useState({ carrier: "", price: "", currency: "EUR", days: "", valid: "", notes: "" });
  const [notifyWin, setNotifyWin] = useState(true);
  const [notifyLose, setNotifyLose] = useState(true);
  const sb = createClient();
  const sender = displayUser(userEmail ?? "") || userEmail || "Fagron Hellas";

  const carriers = data.carriers;
  const cById = useMemo(() => new Map(carriers.map((c) => [c.id, c])), [carriers]);
  const invites = data.invites.filter((i) => i.rfq_id === rfq.id);
  const quotes = data.quotes.filter((q) => q.rfq_id === rfq.id);
  const events = data.events.filter((e) => e.rfq_id === rfq.id).slice().reverse();
  const mails = data.mails.filter((m) => m.rfq_id === rfq.id);
  const docs = data.docs.filter((d) => d.rfq_id === rfq.id);
  const done = (msg: string | null, err?: string) => {
    setError(err ?? null);
    setNotice(msg);
    if (!err) reload();
  };
  const ranked = rankQuotes(rfq, quotes);
  const invited = new Set(invites.map((i) => i.carrier_id));
  const suggestions = suggestCarriers(rfq, carriers).filter((c) => !invited.has(c.id));
  const awarded = quotes.find((q) => q.id === rfq.awarded_quote) ?? null;
  const open = ["draft", "sent", "quoted"].includes(rfq.status);

  async function run(key: string, fn: () => Promise<void>, ok?: string) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const sendInvites = () =>
    run(
      "send",
      async () => {
        const list = carriers.filter((c) => pick.has(c.id));
        if (!list.length) throw new Error("Επιλέξτε μεταφορικές.");
        const noMail = list.filter((c) => !c.emails.length);
        if (noMail.length) throw new Error(`Χωρίς email: ${noMail.map((c) => c.name).join(", ")} — συμπληρώστε το στο Μητρώο.`);
        for (const c of list) {
          const { data: inv, error } = await sb.from("rfq_invites").upsert({ rfq_id: rfq.id, carrier_id: c.id, emails: c.emails }, { onConflict: "rfq_id,carrier_id" }).select("token").single();
          if (error) throw new Error(error.message);
          const m = rfqEmail(rfq, c, (inv as { token: string }).token, sender);
          await queueMail({ to_addrs: c.emails, subject: m.subject, html: m.html, rfq_id: rfq.id, created_by: userEmail });
        }
        if (rfq.status === "draft") await sb.from("rfqs").update({ status: "sent" }).eq("id", rfq.id);
        await logEvent(rfq.id, `Αίτημα προς ${list.map((c) => c.name).join(", ")} (σε αναμονή αποστολής από Outlook)`, userEmail);
        setPick(new Set());
      },
      "Τα email μπήκαν στην ουρά — φεύγουν από το Outlook του υπολογιστή της αποθήκης σε λίγα δευτερόλεπτα."
    );

  const resend = (carrierId: string) =>
    run(
      `re-${carrierId}`,
      async () => {
        const c = cById.get(carrierId)!;
        const inv = invites.find((i) => i.carrier_id === carrierId)!;
        const m = rfqEmail(rfq, c, inv.token, sender);
        await queueMail({ to_addrs: c.emails.length ? c.emails : inv.emails, subject: m.subject, html: m.html, rfq_id: rfq.id, created_by: userEmail });
        await logEvent(rfq.id, `Υπενθύμιση προς ${c.name}`, userEmail);
      },
      "Η υπενθύμιση μπήκε στην ουρά."
    );

  // χειροκίνητη αποστολή: άνοιγμα στο Outlook (mailto) / αντιγραφή με μορφοποίηση / σημείωση ως σταλμένο
  const copyMail = async (subject: string, html: string) => {
    try {
      const ci = new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([htmlToText(html)], { type: "text/plain" }) });
      await navigator.clipboard.write([ci]);
      setNotice(`Αντιγράφηκε το κείμενο του email «${subject}» — επικόλλησέ το σε νέο email στο Outlook.`);
    } catch {
      await copy(htmlToText(html), "Αντιγράφηκε το κείμενο του email.");
    }
  };
  const markSent = (id: number) =>
    run(`ms-${id}`, async () => {
      const { error } = await sb.rpc("mail_outbox_done", { p_id: id, p_ok: true, p_error: null });
      if (error) throw new Error(error.message);
      await logEvent(rfq.id, "Το email στάλθηκε χειροκίνητα", userEmail);
    });
  const cancelMail = (id: number) =>
    run(`mc-${id}`, async () => {
      const { error } = await sb.from("mail_outbox").update({ status: "cancelled" }).eq("id", id);
      if (error) throw new Error(error.message);
    });
  const retryMail = (id: number) =>
    run(`mr-${id}`, async () => {
      const { error } = await sb.from("mail_outbox").update({ status: "pending", error: null }).eq("id", id);
      if (error) throw new Error(error.message);
    });
  const inviteMail = (carrierId: string) => {
    const c = cById.get(carrierId)!;
    const inv = invites.find((i) => i.carrier_id === carrierId)!;
    return { to: c.emails.length ? c.emails : inv.emails, ...rfqEmail(rfq, c, inv.token, sender) };
  };

  const copy = async (t: string, msg: string) => {
    try {
      await navigator.clipboard.writeText(t);
      setNotice(msg);
    } catch {
      setNotice(t);
    }
  };

  const saveManual = () =>
    run(
      "mq",
      async () => {
        const price = toNum(mq.price);
        if (!mq.carrier || !price) throw new Error("Επιλέξτε μεταφορική και τιμή.");
        const prev = quotes.find((x) => x.carrier_id === mq.carrier);
        const { error } = await sb.from("quotes").upsert(
          {
            rfq_id: rfq.id,
            carrier_id: mq.carrier,
            first_price: prev && prev.price !== price ? prev.first_price ?? prev.price : prev?.first_price ?? null,
            revised_at: prev && prev.price !== price ? new Date().toISOString() : prev?.revised_at ?? null,
            round_no: prev && prev.price !== price && (rfq.round_no ?? 0) > 0 ? rfq.round_no : prev?.round_no ?? 0,
            price,
            currency: mq.currency || "EUR",
            transit_days: toNum(mq.days),
            valid_until: mq.valid || null,
            notes: mq.notes || null,
            source: "manual",
            created_by: userEmail,
            created_at: new Date().toISOString(),
          },
          { onConflict: "rfq_id,carrier_id" }
        );
        if (error) throw new Error(error.message);
        if (rfq.status === "draft" || rfq.status === "sent") await sb.from("rfqs").update({ status: "quoted" }).eq("id", rfq.id);
        await logEvent(rfq.id, `Καταχώρηση προσφοράς ${cById.get(mq.carrier)?.name}: ${fm(price)} ${mq.currency}`, userEmail);
        setMq({ carrier: "", price: "", currency: "EUR", days: "", valid: "", notes: "" });
      },
      "Η προσφορά καταχωρήθηκε."
    );

  const award = (q: Quote) =>
    run(
      `aw-${q.id}`,
      async () => {
        const { error } = await sb.from("rfqs").update({ awarded_quote: q.id, status: "awarded", final_cost: rfq.final_cost ?? (q.currency === "EUR" ? q.price : null) }).eq("id", rfq.id);
        if (error) throw new Error(error.message);
        const win = cById.get(q.carrier_id)!;
        await logEvent(rfq.id, `Ανάθεση σε ${win.name}: ${fm(q.price)} ${q.currency}`, userEmail);
        const upd = { ...rfq, awarded_quote: q.id };
        if (notifyWin && win.emails.length) {
          const m = awardEmail(upd, win, q, true, sender);
          await queueMail({ to_addrs: win.emails, subject: m.subject, html: m.html, rfq_id: rfq.id, created_by: userEmail });
        }
        if (notifyLose)
          for (const o of quotes.filter((x) => x.id !== q.id)) {
            const c = cById.get(o.carrier_id);
            if (!c?.emails.length) continue;
            const m = awardEmail(upd, c, o, false, sender);
            await queueMail({ to_addrs: c.emails, subject: m.subject, html: m.html, rfq_id: rfq.id, created_by: userEmail });
          }
      },
      "Ανατέθηκε."
    );

  const [tr, setTr] = useState({
    carrier_ref: rfq.carrier_ref ?? "",
    tracking_no: rfq.tracking_no ?? "",
    tracking_url: rfq.tracking_url ?? "",
    picked_at: rfq.picked_at ?? "",
    eta: rfq.eta ?? "",
    delivered_at: rfq.delivered_at ?? "",
    final_cost: rfq.final_cost != null ? String(rfq.final_cost) : "",
    docs: rfq.docs ?? "",
  });
  const saveTracking = (status?: Rfq["status"]) =>
    run(
      "tr",
      async () => {
        const row: Record<string, unknown> = {
          carrier_ref: tr.carrier_ref || null,
          tracking_no: tr.tracking_no || null,
          tracking_url: tr.tracking_url || null,
          picked_at: tr.picked_at || null,
          eta: tr.eta || null,
          delivered_at: tr.delivered_at || null,
          final_cost: toNum(tr.final_cost),
          docs: tr.docs || null,
        };
        if (status) row.status = status;
        if (status === "in_transit" && !row.picked_at) row.picked_at = new Date().toISOString().slice(0, 10);
        if (status === "delivered" && !row.delivered_at) row.delivered_at = new Date().toISOString().slice(0, 10);
        const { error } = await sb.from("rfqs").update(row).eq("id", rfq.id);
        if (error) throw new Error(error.message);
        await logEvent(rfq.id, status ? `Κατάσταση: ${STATUS_TXT[status]}` : "Ενημέρωση παρακολούθησης", userEmail);
      },
      "Αποθηκεύτηκε."
    );

  const setStatus = (status: Rfq["status"], msg: string) =>
    run(status, async () => {
      const { error } = await sb.from("rfqs").update({ status, ...(status === "quoted" || status === "sent" ? { awarded_quote: null } : {}) }).eq("id", rfq.id);
      if (error) throw new Error(error.message);
      await logEvent(rfq.id, msg, userEmail);
    });

  if (edit)
    return (
      <div className="lg-detail">
        <h2>Επεξεργασία {rfq.ref}</h2>
        <RfqForm
          initial={rfq}
          userEmail={userEmail}
          onSaved={() => {
            setEdit(false);
            reload();
          }}
          onCancel={() => setEdit(false)}
        />
      </div>
    );

  return (
    <div className="lg-detail">
      <div className="lg-head">
        <button type="button" className="btn ghost sm" onClick={onBack}>
          ← Αιτήματα
        </button>
        <h2>
          {rfq.ref} <span className={`lg-badge ${STATUS_TONE[rfq.status]}`}>{STATUS_TXT[rfq.status]}</span>
        </h2>
        <span className="dim">
          {DIR_TXT[rfq.direction]} · {rfq.mode ? MODE_TXT[rfq.mode] ?? rfq.mode : ""} · {route(rfq)}
          {rfq.customer ? ` · ${rfq.customer}` : ""}
        </span>
        <span className="st-actions">
          {open && (
            <button type="button" className="btn ghost sm" onClick={() => setEdit(true)}>
              Επεξεργασία
            </button>
          )}
          {rfq.status !== "cancelled" && rfq.status !== "delivered" && (
            <button type="button" className="btn ghost sm" onClick={() => setStatus("cancelled", "Ακύρωση αιτήματος")} disabled={!!busy}>
              Ακύρωση
            </button>
          )}
          {rfq.status === "cancelled" && (
            <button type="button" className="btn ghost sm" onClick={() => setStatus(quotes.length ? "quoted" : "draft", "Επαναφορά αιτήματος")} disabled={!!busy}>
              Επαναφορά
            </button>
          )}
        </span>
      </div>
      {error && (
        <p className="st-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="st-notice">{notice}</p>}

      <div className="lg-cols">
        <section className="lg-card">
          <h3>Στοιχεία</h3>
          <table className="lg-kv">
            <tbody>
              {loadRows(rfq)
                .slice(1)
                .map(([k, v]) => (
                  <tr key={k}>
                    <th>{k.split(" / ")[0]}</th>
                    <td>{v}</td>
                  </tr>
                ))}
              {rfq.quote_deadline && (
                <tr>
                  <th>Προθεσμία προσφορών</th>
                  <td>{new Date(rfq.quote_deadline).toLocaleString("el-GR", { dateStyle: "short", timeStyle: "short" })}</td>
                </tr>
              )}
              {rfq.value_eur != null && (
                <tr>
                  <th>Αξία</th>
                  <td>{fm(rfq.value_eur)} €</td>
                </tr>
              )}
              {rfq.customer && (
                <tr>
                  <th>{rfq.direction === "import" ? "Προμηθευτής" : "Πελάτης"}</th>
                  <td>
                    {rfq.customer}
                    {rfq.customer_code ? <span className="dim"> · {rfq.customer_code}</span> : null}
                    {rfq.other_site && (
                      <div className="dim">
                        Έδρα: {[rfq.customer_address, [rfq.customer_zip, rfq.customer_city].filter(Boolean).join(" "), rfq.customer_country].filter(Boolean).join(", ") || "—"} ·{" "}
                        <b>διαφορετικός τόπος {rfq.direction === "import" ? "φόρτωσης" : "παράδοσης"}</b>
                      </div>
                    )}
                  </td>
                </tr>
              )}
              {rfq.order_ref && (
                <tr>
                  <th>Παραγγελία / PO</th>
                  <td>{rfq.order_ref}</td>
                </tr>
              )}
              {rfq.internal_notes && (
                <tr>
                  <th>Εσωτερικές σημειώσεις</th>
                  <td>{rfq.internal_notes}</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="lg-card">
          <h3>Μεταφορικές</h3>
          {invites.length ? (
            <table className="st-table lg-inv">
              <thead>
                <tr>
                  {["Μεταφορική", "Στάλθηκε", "Άνοιξε", "Απάντηση", ""].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {invites.map((i) => {
                  const c = cById.get(i.carrier_id);
                  const q = quotes.find((x) => x.carrier_id === i.carrier_id);
                  return (
                    <tr key={i.id}>
                      <td>
                        <b>{c?.name}</b>
                        <div className="dim">{(c?.emails.length ? c.emails : i.emails).join(", ")}</div>
                      </td>
                      <td>{i.sent_at ? ago(i.sent_at) : <span className="dim">σε αναμονή</span>}</td>
                      <td>{i.opened_at ? ago(i.opened_at) : "—"}</td>
                      <td>{q ? <b>{fm(q.price)} {q.currency}</b> : i.declined ? "δεν δίνει" : "—"}</td>
                      <td className="st-actions">
                        <button type="button" className="btn ghost sm" title="Αντιγραφή του link της φόρμας" onClick={() => copy(quoteLink(i.token), `Αντιγράφηκε το link για ${c?.name}.`)}>
                          Link
                        </button>
                        {open && (
                          <button type="button" className="btn ghost sm" title="Ξανά μέσω του Outlook του υπολογιστή της αποθήκης" onClick={() => resend(i.carrier_id)} disabled={busy === `re-${i.carrier_id}`}>
                            Ξανά
                          </button>
                        )}
                        {open && (
                          <a
                            className="btn ghost sm"
                            title="Άνοιγμα του email στο δικό σου Outlook (χειροκίνητη αποστολή)"
                            href={(() => {
                              const m = inviteMail(i.carrier_id);
                              return mailtoHref(m.to, m.subject, m.html);
                            })()}
                          >
                            ✉ Outlook
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="dim">Δεν έχει σταλεί ακόμα σε μεταφορική.</p>
          )}
          {open && (
            <>
              <h4>Αποστολή αιτήματος σε</h4>
              {suggestions.length ? (
                <div className="lg-pick">
                  {suggestions.map((c) => (
                    <label key={c.id} className="st-check" title={[c.modes.map((m) => MODE_TXT[m] ?? m).join(", "), c.countries.join(", ")].filter(Boolean).join(" · ")}>
                      <input
                        type="checkbox"
                        checked={pick.has(c.id)}
                        onChange={(e) =>
                          setPick((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.add(c.id);
                            else n.delete(c.id);
                            return n;
                          })
                        }
                      />
                      {c.name}
                      {c.rating ? <span className="dim"> {"★".repeat(c.rating)}</span> : null}
                      {!c.emails.length && <span className="dm-r"> (χωρίς email)</span>}
                    </label>
                  ))}
                </div>
              ) : (
                <p className="dim">Όλες οι ενεργές μεταφορικές έχουν ήδη λάβει το αίτημα — πρόσθεσε νέες στο Μητρώο.</p>
              )}
              <button type="button" className="btn primary sm" onClick={sendInvites} disabled={busy === "send" || !pick.size}>
                {busy === "send" ? "Αποστολή…" : `Αποστολή αιτήματος (${pick.size})`}
              </button>
            </>
          )}
        </section>
      </div>

      <section className="lg-card">
        <h3>Προσφορές {quotes.length ? `(${quotes.length})` : ""}</h3>
        {ranked.length ? (
          <div className="st-tablewrap">
            <table className="st-table">
              <thead>
                <tr>
                  {["Μεταφορική", "Τιμή", "vs φθηνότερη", "/ παλέτα", "/ kg", "Ημέρες", "Φόρτωση", "Ισχύει έως", "Περιλαμβάνει / σημειώσεις", "Πηγή", ""].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ranked.map(({ q, cheapest, fastest, vsBest, perPallet, perKg }) => (
                  <tr key={q.id} className={q.id === rfq.awarded_quote ? "lg-won" : ""}>
                    <td>
                      <b>{cById.get(q.carrier_id)?.name}</b>
                      {cheapest && <span className="lg-badge green">φθηνότερη</span>}
                      {fastest && <span className="lg-badge blue">ταχύτερη</span>}
                      {q.id === rfq.awarded_quote && <span className="lg-badge green">✓ ανατέθηκε</span>}
                    </td>
                    <td className="num">
                      <b>
                        {fm(q.price)} {q.currency}
                      </b>
                      {q.first_price != null && q.first_price !== q.price && (
                        <div className="dim">
                          <s>{fm(q.first_price)}</s>
                          {q.round_no ? ` · γύρος ${q.round_no}` : ""}
                        </div>
                      )}
                    </td>
                    <td className="num">{vsBest == null ? "" : vsBest === 0 ? "—" : `+${fm(vsBest * 100, 0)}%`}</td>
                    <td className="num">{fm(perPallet)}</td>
                    <td className="num">{fm(perKg, 3)}</td>
                    <td className="num">{fm(q.transit_days, 1)}</td>
                    <td className="mono">{dmy(q.pickup_date)}</td>
                    <td className="mono">{dmy(q.valid_until)}</td>
                    <td>{[q.includes, q.notes, q.contact].filter(Boolean).join(" · ")}</td>
                    <td className="dim">
                      {q.source === "form" ? "φόρμα" : "χειροκίνητα"} · {ago(q.created_at)}
                    </td>
                    <td>
                      {(open || rfq.status === "awarded") && q.id !== rfq.awarded_quote && (
                        <button type="button" className="btn primary sm" onClick={() => award(q)} disabled={!!busy}>
                          Ανάθεση
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="dim">Καμία προσφορά ακόμα. Οι μεταφορικές απαντούν από το link του email ή τις καταχωρείς εδώ.</p>
        )}
        {!open && (() => {
          const sv = roundSaving(rfq, quotes);
          return sv && sv.saving > 0 ? (
            <p className="lg-saving">
              Κέρδος από τους γύρους τιμών: <b>{fm(sv.saving)} €</b> ({fm(sv.base)} → {fm(sv.now)} €, −{fm((sv.saving / sv.base) * 100, 1)}%)
            </p>
          ) : null;
        })()}
        {open && ranked.length > 0 && (
          <RoundPanel key={`${rfq.round_no ?? 0}`} rfq={rfq} quotes={quotes} invites={invites} cById={cById} sender={sender} userEmail={userEmail} onDone={done} />
        )}
        {(open || rfq.status === "awarded") && ranked.length > 0 && (
          <div className="lg-row">
            <label className="st-check">
              <input type="checkbox" checked={notifyWin} onChange={(e) => setNotifyWin(e.target.checked)} />
              Email ανάθεσης στη μεταφορική
            </label>
            <label className="st-check">
              <input type="checkbox" checked={notifyLose} onChange={(e) => setNotifyLose(e.target.checked)} />
              Ενημέρωση των υπολοίπων
            </label>
          </div>
        )}
        {open && (
          <div className="lg-row lg-mq">
            <label className="field">
              Μεταφορική
              <select value={mq.carrier} onChange={(e) => setMq({ ...mq, carrier: e.target.value })}>
                <option value="">—</option>
                {carriers
                  .filter((c) => c.active)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              Τιμή
              <input value={mq.price} inputMode="decimal" onChange={(e) => setMq({ ...mq, price: e.target.value })} />
            </label>
            <label className="field">
              Νόμισμα
              <select value={mq.currency} onChange={(e) => setMq({ ...mq, currency: e.target.value })}>
                {["EUR", "USD", "GBP", "CHF"].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="field">
              Ημέρες
              <input value={mq.days} inputMode="decimal" onChange={(e) => setMq({ ...mq, days: e.target.value })} />
            </label>
            <label className="field">
              Ισχύει έως
              <input type="date" value={mq.valid} onChange={(e) => setMq({ ...mq, valid: e.target.value })} />
            </label>
            <label className="field lg-wide">
              Σημειώσεις
              <input value={mq.notes} onChange={(e) => setMq({ ...mq, notes: e.target.value })} placeholder="π.χ. από email, χωρίς καύσιμα" />
            </label>
            <button type="button" className="btn ghost sm" onClick={saveManual} disabled={busy === "mq"}>
              + Καταχώρηση προσφοράς
            </button>
          </div>
        )}
      </section>

      {["awarded", "in_transit", "delivered"].includes(rfq.status) && (
        <section className="lg-card">
          <h3>
            Παρακολούθηση {awarded ? `— ${cById.get(awarded.carrier_id)?.name} (${fm(awarded.price)} ${awarded.currency})` : ""}
          </h3>
          <div className="lg-row">
            {(
              [
                ["carrier_ref", "Αρ. μεταφορικής", "text"],
                ["tracking_no", "Tracking", "text"],
                ["tracking_url", "Link tracking", "url"],
                ["picked_at", "Φορτώθηκε", "date"],
                ["eta", "ETA", "date"],
                ["delivered_at", "Παραδόθηκε", "date"],
                ["final_cost", "Τελικό κόστος (€)", "text"],
              ] as const
            ).map(([k, l, t]) => (
              <label key={k} className="field">
                {l}
                <input type={t} value={tr[k]} onChange={(e) => setTr({ ...tr, [k]: e.target.value })} />
              </label>
            ))}
            <label className="field lg-wide">
              Έγγραφα (CMR, τιμολόγιο, σύνδεσμοι)
              <input value={tr.docs} onChange={(e) => setTr({ ...tr, docs: e.target.value })} />
            </label>
          </div>
          <span className="st-actions">
            <button type="button" className="btn ghost sm" onClick={() => saveTracking()} disabled={busy === "tr"}>
              Αποθήκευση
            </button>
            {rfq.status === "awarded" && (
              <button type="button" className="btn primary sm" onClick={() => saveTracking("in_transit")} disabled={busy === "tr"}>
                Φορτώθηκε → Σε μεταφορά
              </button>
            )}
            {rfq.status !== "delivered" && (
              <button type="button" className="btn primary sm" onClick={() => saveTracking("delivered")} disabled={busy === "tr"}>
                Παραδόθηκε
              </button>
            )}
            {rfq.tracking_url && (
              <a className="btn ghost sm" href={rfq.tracking_url} target="_blank" rel="noreferrer">
                Άνοιγμα tracking
              </a>
            )}
          </span>
        </section>
      )}

      {["awarded", "in_transit", "delivered"].includes(rfq.status) && awarded && (
        <ManifestCard
          key={`mf-${awarded.id}`}
          rfq={rfq}
          carrier={cById.get(awarded.carrier_id) ?? null}
          quote={awarded}
          invite={invites.find((i) => i.carrier_id === awarded.carrier_id) ?? null}
          docs={docs}
          sender={sender}
          userEmail={userEmail}
          onDone={done}
        />
      )}

      <DocsCard rfq={rfq} docs={docs} userEmail={userEmail} reload={reload} />

      <div className="lg-cols">
        <section className="lg-card">
          <h3>Ιστορικό</h3>
          <ul className="lg-events">
            {events.map((e) => (
              <li key={e.id}>
                <span className="dim">{new Date(e.at).toLocaleString("el-GR", { dateStyle: "short", timeStyle: "short" })}</span> {e.text}
                {e.by ? <span className="dim"> — {displayUser(e.by) || e.by}</span> : null}
              </li>
            ))}
          </ul>
        </section>
        <section className="lg-card">
          <h3>Email</h3>
          {mails.length ? (
            <ul className="lg-events">
              {mails.map((m) => (
                <li key={m.id}>
                  <span className={`lg-badge ${m.status === "sent" ? "green" : m.status === "error" ? "red" : "yellow"}`}>{m.status === "sent" ? "στάλθηκε" : m.status === "error" ? "σφάλμα" : "σε αναμονή"}</span>{" "}
                  {m.to_addrs.join(", ")} <span className="dim">— {m.subject}</span>
                  {!!m.attachments?.length && (
                    <div className="lg-atts">
                      📎{" "}
                      {m.attachments.map((a) => (
                        <button key={a.path} type="button" className="lg-linkbtn" onClick={() => downloadDoc(a.path, a.name).catch((e) => setError((e as Error).message))} title="Λήψη (για χειροκίνητη επισύναψη)">
                          {a.name}
                        </button>
                      ))}
                    </div>
                  )}
                  {m.error && <div className="dm-r lg-err">{m.error.slice(0, 160)}</div>}
                  {m.status !== "sent" && m.status !== "cancelled" && m.html && (
                    <div className="st-actions lg-manual">
                      <a className="btn ghost sm" href={mailtoHref(m.to_addrs, m.subject, m.html)} title="Ανοίγει νέο email στο Outlook σου με παραλήπτη, θέμα και κείμενο">
                        ✉ Άνοιγμα στο Outlook
                      </a>
                      <button type="button" className="btn ghost sm" onClick={() => copyMail(m.subject, m.html!)} title="Αντιγραφή με μορφοποίηση — επικόλληση σε νέο email">
                        Αντιγραφή κειμένου
                      </button>
                      <button type="button" className="btn primary sm" onClick={() => markSent(m.id)} disabled={busy === `ms-${m.id}`}>
                        Το έστειλα ✓
                      </button>
                      {m.status === "error" && (
                        <button type="button" className="btn ghost sm" onClick={() => retryMail(m.id)} disabled={busy === `mr-${m.id}`} title="Ξανά από το Outlook του υπολογιστή της αποθήκης">
                          Ξανά αυτόματα
                        </button>
                      )}
                      <button type="button" className="btn ghost sm" onClick={() => cancelMail(m.id)} disabled={busy === `mc-${m.id}`}>
                        Ακύρωση
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="dim">Κανένα email ακόμα.</p>
          )}
        </section>
      </div>
    </div>
  );
}
