"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { logEvent, queueMail } from "@/components/logistics/data";
import { roundEmail, roundTarget, type Carrier, type Invite, type Quote, type Rfq } from "@/lib/logistics";

const fm = (n: number | null | undefined) => (n == null ? "" : n.toLocaleString("el-GR", { maximumFractionDigits: 2 }));
const toNum = (s: string) => {
  const t = s.trim().replace(/\s/g, "");
  const x = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t) ? t.replace(/\./g, "").replace(",", ".") : t.replace(",", ".");
  const n = Number(x);
  return t && isFinite(n) ? n : null;
};
// datetime-local σε τοπική ώρα
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

/** Νέος γύρος τιμών: τιμή-στόχος = χαμηλότερη − X %, προθεσμία, email στις μεταφορικές με το link τους. */
export default function RoundPanel({
  rfq,
  quotes,
  invites,
  cById,
  sender,
  userEmail,
  onDone,
}: {
  rfq: Rfq;
  quotes: Quote[];
  invites: Invite[];
  cById: Map<string, Carrier>;
  sender: string;
  userEmail: string | null;
  onDone: (msg: string | null, err?: string) => void;
}) {
  const eur = quotes.filter((q) => q.currency === "EUR");
  const lowest = eur.length ? Math.min(...eur.map((q) => q.price)) : null;
  const [open, setOpen] = useState(false);
  const [pct, setPct] = useState("10");
  const [target, setTarget] = useState<string>("");
  const [deadline, setDeadline] = useState(() => {
    const d = new Date(Date.now() + 24 * 3600e3);
    d.setMinutes(0, 0, 0);
    return localInput(d);
  });
  const quoted = new Set(quotes.map((q) => q.carrier_id));
  const [pick, setPick] = useState<Set<string>>(() => new Set(invites.filter((i) => quoted.has(i.carrier_id) && !i.declined).map((i) => i.carrier_id)));
  const [busy, setBusy] = useState(false);

  const auto = lowest != null && toNum(pct) != null ? roundTarget(lowest, toNum(pct)!) : null;
  const tgt = target.trim() ? toNum(target) : auto;
  const active = (rfq.round_no ?? 0) > 0 && rfq.round_deadline && new Date(rfq.round_deadline) > new Date();
  const answered = useMemo(() => quotes.filter((q) => (q.round_no ?? 0) === rfq.round_no && rfq.round_no), [quotes, rfq.round_no]);
  const inRound = invites.filter((i) => (i.round_no ?? 0) === rfq.round_no && rfq.round_no);

  async function send() {
    if (tgt == null || tgt <= 0) return onDone(null, "Συμπληρώστε τιμή-στόχο.");
    const dl = new Date(deadline);
    if (!(dl > new Date())) return onDone(null, "Η προθεσμία πρέπει να είναι στο μέλλον.");
    const list = invites.filter((i) => pick.has(i.carrier_id));
    if (!list.length) return onDone(null, "Επιλέξτε μεταφορικές.");
    const noMail = list.filter((i) => !(cById.get(i.carrier_id)?.emails.length || i.emails.length));
    if (noMail.length) return onDone(null, `Χωρίς email: ${noMail.map((i) => cById.get(i.carrier_id)?.name).join(", ")}`);
    setBusy(true);
    try {
      const sb = createClient();
      const no = (rfq.round_no ?? 0) + 1;
      const { error } = await sb
        .from("rfqs")
        .update({ round_no: no, round_target: tgt, round_currency: "EUR", round_pct: toNum(pct), round_deadline: dl.toISOString() })
        .eq("id", rfq.id);
      if (error) throw new Error(error.message);
      const upd = await sb.from("rfq_invites").update({ round_no: no }).in("id", list.map((i) => i.id));
      if (upd.error) throw new Error(upd.error.message);
      for (const i of list) {
        const c = cById.get(i.carrier_id)!;
        const q = quotes.find((x) => x.carrier_id === i.carrier_id) ?? null;
        const m = roundEmail(rfq, c, q, i.token, tgt, "EUR", dl.toISOString(), sender);
        await queueMail({ to_addrs: c.emails.length ? c.emails : i.emails, subject: m.subject, html: m.html, rfq_id: rfq.id, created_by: userEmail });
      }
      await logEvent(
        rfq.id,
        `Γύρος τιμών ${no}: τιμή-στόχος ${fm(tgt)} EUR${lowest != null ? ` (χαμηλότερη ${fm(lowest)} − ${pct}%)` : ""}, προθεσμία ${dl.toLocaleString("el-GR", { dateStyle: "short", timeStyle: "short" })} → ${list
          .map((i) => cById.get(i.carrier_id)?.name)
          .join(", ")}`,
        userEmail
      );
      setOpen(false);
      onDone(`Γύρος ${no}: τα email μπήκαν στην ουρά για ${list.length} μεταφορικές.`);
    } catch (e) {
      onDone(null, (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lg-round">
      {(rfq.round_no ?? 0) > 0 && (
        <p className={active ? "lg-round-on" : "dim"}>
          <b>Γύρος τιμών {rfq.round_no}</b> — τιμή-στόχος <b>{fm(rfq.round_target)} {rfq.round_currency ?? "EUR"}</b>, προθεσμία{" "}
          {rfq.round_deadline ? new Date(rfq.round_deadline).toLocaleString("el-GR", { dateStyle: "short", timeStyle: "short" }) : ""}
          {active ? " (ανοιχτός)" : " (έληξε)"} · νέες τιμές: {answered.length} / {inRound.length}
        </p>
      )}
      {!open ? (
        lowest != null && (
          <button type="button" className="btn ghost sm" onClick={() => setOpen(true)}>
            ↓ Νέος γύρος τιμών (τιμή-στόχος)
          </button>
        )
      ) : (
        <div className="lg-card lg-sub">
          <div className="lg-row">
            <label className="field">
              Χαμηλότερη τιμή
              <input value={`${fm(lowest)} EUR`} disabled />
            </label>
            <label className="field">
              Κάτω από τη χαμηλότερη (%)
              <input value={pct} inputMode="decimal" onChange={(e) => (setPct(e.target.value), setTarget(""))} />
            </label>
            <label className="field">
              Τιμή-στόχος (EUR)
              <input value={target || (auto != null ? String(auto) : "")} inputMode="decimal" onChange={(e) => setTarget(e.target.value)} />
            </label>
            <label className="field">
              Προθεσμία νέας τιμής
              <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            </label>
          </div>
          <div className="lg-row">
            {invites.map((i) => {
              const q = quotes.find((x) => x.carrier_id === i.carrier_id);
              return (
                <label key={i.id} className="st-check">
                  <input
                    type="checkbox"
                    checked={pick.has(i.carrier_id)}
                    onChange={(e) => {
                      const s = new Set(pick);
                      if (e.target.checked) s.add(i.carrier_id);
                      else s.delete(i.carrier_id);
                      setPick(s);
                    }}
                  />
                  {cById.get(i.carrier_id)?.name}
                  <span className="dim">{q ? ` (${fm(q.price)} ${q.currency})` : i.declined ? " (αρνήθηκε)" : " (χωρίς προσφορά)"}</span>
                </label>
              );
            })}
          </div>
          <p className="dim">
            Κάθε μεταφορική παίρνει email με την τιμή-στόχο και το link της φόρμας της· μπορεί να δώσει νέα τιμή μέχρι την προθεσμία (ακόμα κι αν έχει λήξει η αρχική). Αν δεν
            απαντήσει, ισχύει η προηγούμενη προσφορά της. Στο email δεν αναφέρονται άλλες μεταφορικές ή τιμές τους.
          </p>
          <span className="st-actions">
            <button type="button" className="btn primary sm" onClick={send} disabled={busy || !pick.size}>
              {busy ? "Αποστολή…" : `Αποστολή σε ${pick.size}`}
            </button>
            <button type="button" className="btn ghost sm" onClick={() => setOpen(false)} disabled={busy}>
              Άκυρο
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
