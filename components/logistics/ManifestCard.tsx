"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { loadLogo, loadPdfFonts } from "@/lib/pdfFonts";
import { logEvent, queueMail, uploadDoc } from "@/components/logistics/data";
import { manifestFromRfq, manifestTotals } from "@/lib/manifestPdf";
import { DOC_TXT, manifestEmail, type Carrier, type Invite, type Manifest, type ManifestLine, type Quote, type Rfq, type RfqDoc } from "@/lib/logistics";

const blankLine: ManifestLine = { desc: "", pallets: "", packages: "", weight: "", dims: "", adr: "", notes: "" };
const fm = (n: number) => n.toLocaleString("el-GR", { maximumFractionDigits: 2 });

/** Loading manifest: γραμμές φορτίου + όχημα / οδηγός / οδηγίες -> PDF, αποθήκευση στα έγγραφα και email στον νικητή. */
export default function ManifestCard({
  rfq,
  carrier,
  quote,
  invite,
  docs,
  sender,
  userEmail,
  onDone,
}: {
  rfq: Rfq;
  carrier: Carrier | null;
  quote: Quote | null;
  invite: Invite | null;
  docs: RfqDoc[];
  sender: string;
  userEmail: string | null;
  onDone: (msg: string | null, err?: string) => void;
}) {
  const [m, setM] = useState<Manifest>(() => {
    const base = manifestFromRfq(rfq);
    // προεπιλογή συνοδευτικών: τα έγγραφα που βλέπει ο νικητής (εκτός manifest)
    if (!rfq.manifest) base.docs = docs.filter((d) => d.visible !== "no" && d.kind !== "manifest").map((d) => d.name);
    return base;
  });
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const shareable = docs.filter((d) => d.visible !== "no" && d.kind !== "manifest");
  const last = docs.filter((d) => d.kind === "manifest").sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const tot = manifestTotals(m);

  const setLine = (i: number, k: keyof ManifestLine, v: string) => setM({ ...m, lines: m.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) });

  async function build() {
    const [{ jsPDF }, { autoTable }, { manifestPdf }, fonts, logo] = await Promise.all([
      import("jspdf"),
      import("jspdf-autotable"),
      import("@/lib/manifestPdf"),
      loadPdfFonts(),
      loadLogo().catch(() => null),
    ]);
    return manifestPdf(jsPDF, autoTable, fonts, rfq, carrier, quote, { ...m, docs: m.docs.map((x) => x.trim()).filter(Boolean) }, sender, logo);
  }

  async function preview() {
    setBusy("pv");
    try {
      const { doc, fileName } = await build();
      doc.save(fileName);
      await createClient().from("rfqs").update({ manifest: m }).eq("id", rfq.id);
      onDone(null);
    } catch (e) {
      onDone(null, (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function issue(send: boolean) {
    if (send && !carrier?.emails.length && !invite?.emails.length) return onDone(null, "Η μεταφορική δεν έχει email — συμπληρώστε το στο Μητρώο.");
    setBusy(send ? "send" : "save");
    try {
      const { doc, fileName } = await build();
      const blob: Blob = doc.output("blob");
      const saved = await uploadDoc(rfq.id, new File([blob], fileName, { type: "application/pdf" }), fileName, "manifest", "winner", userEmail);
      await createClient()
        .from("rfqs")
        .update({ manifest: { ...m, issued_at: new Date().toISOString() } })
        .eq("id", rfq.id);
      if (send && carrier) {
        const atts = [{ path: saved.path, name: fileName }, ...(attach ? shareable.map((d) => ({ path: d.path, name: d.name })) : [])];
        const mail = manifestEmail(rfq, carrier, invite?.token ?? null, invite ? shareable : [], sender);
        await queueMail({ to_addrs: carrier.emails.length ? carrier.emails : invite!.emails, subject: mail.subject, html: mail.html, rfq_id: rfq.id, created_by: userEmail, attachments: atts });
        await logEvent(rfq.id, `Loading manifest προς ${carrier.name}${atts.length > 1 ? ` (+${atts.length - 1} συνημμένα)` : ""}`, userEmail);
        onDone("Το manifest αποθηκεύτηκε στα έγγραφα και το email (με συνημμένο PDF) μπήκε στην ουρά του Outlook.");
      } else {
        await logEvent(rfq.id, "Έκδοση loading manifest", userEmail);
        onDone("Το manifest αποθηκεύτηκε στα έγγραφα.");
      }
    } catch (e) {
      onDone(null, (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="lg-card">
      <h3>
        Loading manifest {carrier ? `— ${carrier.name}` : ""}
        {last && <span className="dim"> · τελευταία έκδοση {new Date(last.created_at).toLocaleString("el-GR", { dateStyle: "short", timeStyle: "short" })}</span>}
      </h3>
      <div className="st-tablewrap">
        <table className="st-table lg-mf">
          <thead>
            <tr>
              {["Περιγραφή", "Παλέτες", "Δέματα", "Μικτό kg", "Διαστάσεις", "ADR (UN / κλάση)", "Σημειώσεις", ""].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.lines.map((l, i) => (
              <tr key={i}>
                {(["desc", "pallets", "packages", "weight", "dims", "adr", "notes"] as const).map((k) => (
                  <td key={k}>
                    <input value={l[k]} onChange={(e) => setLine(i, k, e.target.value)} inputMode={["pallets", "packages", "weight"].includes(k) ? "decimal" : undefined} />
                  </td>
                ))}
                <td>
                  {m.lines.length > 1 && (
                    <button type="button" className="btn ghost sm" onClick={() => setM({ ...m, lines: m.lines.filter((_, j) => j !== i) })} title="Αφαίρεση γραμμής">
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>
                <button type="button" className="btn ghost sm" onClick={() => setM({ ...m, lines: [...m.lines, { ...blankLine }] })}>
                  + Γραμμή
                </button>
              </td>
              <td className="num">
                <b>{fm(tot.pallets)}</b>
              </td>
              <td className="num">
                <b>{fm(tot.packages)}</b>
              </td>
              <td className="num">
                <b>{fm(tot.weight)}</b>
              </td>
              <td colSpan={4} />
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="lg-row">
        <label className="field">
          Αρ. κυκλοφορίας οχήματος
          <input value={m.plate} onChange={(e) => setM({ ...m, plate: e.target.value })} />
        </label>
        <label className="field">
          Οδηγός
          <input value={m.driver} onChange={(e) => setM({ ...m, driver: e.target.value })} />
        </label>
        <label className="field">
          Ώρα φόρτωσης
          <input value={m.loading_time} onChange={(e) => setM({ ...m, loading_time: e.target.value })} placeholder="π.χ. 08:00–10:00" />
        </label>
      </div>
      <label className="field">
        Οδηγίες φόρτωσης
        <textarea rows={2} value={m.instructions} onChange={(e) => setM({ ...m, instructions: e.target.value })} placeholder="π.χ. ράμπα 2, απαιτείται tail-lift, ιμάντες" />
      </label>
      <label className="field">
        Συνοδευτικά έγγραφα (ένα ανά γραμμή — τυπώνονται με κουτάκι ☐)
        <textarea rows={2} value={m.docs.join("\n")} onChange={(e) => setM({ ...m, docs: e.target.value.split("\n") })} placeholder="CMR, Τιμολόγιο, MSDS…" />
      </label>
      {shareable.length > 0 && (
        <label className="st-check">
          <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
          Επισύναψη και των εγγράφων που βλέπει η μεταφορική ({shareable.map((d) => `${DOC_TXT[d.kind]}: ${d.name}`).join(", ")})
        </label>
      )}
      <span className="st-actions">
        <button type="button" className="btn ghost sm" onClick={preview} disabled={!!busy}>
          {busy === "pv" ? "…" : "⇩ Προεπισκόπηση PDF"}
        </button>
        <button type="button" className="btn ghost sm" onClick={() => issue(false)} disabled={!!busy}>
          {busy === "save" ? "…" : "Αποθήκευση στα έγγραφα"}
        </button>
        {carrier && (
          <button type="button" className="btn primary sm" onClick={() => issue(true)} disabled={!!busy}>
            {busy === "send" ? "Αποστολή…" : `✉ Αποστολή στον νικητή (${carrier.name})`}
          </button>
        )}
      </span>
    </section>
  );
}
