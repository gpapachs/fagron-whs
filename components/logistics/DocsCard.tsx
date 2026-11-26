"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ago } from "@/lib/live";
import { displayUser } from "@/lib/users";
import { downloadDoc, logEvent, uploadDoc } from "@/components/logistics/data";
import { DOC_KINDS, DOC_TXT, fileSize, VIS_TXT, type DocKind, type DocVis, type Rfq, type RfqDoc } from "@/lib/logistics";

/** Έγγραφα αιτήματος: τιμολόγια, MSDS, CMR… — ανέβασμα, λήψη, ορατότητα στη μεταφορική, διαγραφή. */
export default function DocsCard({ rfq, docs, userEmail, reload }: { rfq: Rfq; docs: RfqDoc[]; userEmail: string | null; reload: () => void }) {
  const [kind, setKind] = useState<DocKind>("invoice");
  const [vis, setVis] = useState<DocVis>("no");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const sb = createClient();

  async function upload(files: FileList | File[] | null) {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    setBusy("up");
    setError(null);
    const fails: string[] = [];
    for (const f of list) {
      try {
        await uploadDoc(rfq.id, f, f.name, kind, vis, userEmail);
      } catch (e) {
        fails.push((e as Error).message);
      }
    }
    const ok = list.length - fails.length;
    if (ok) await logEvent(rfq.id, `Ανέβηκαν ${ok} έγγραφα (${DOC_TXT[kind]}): ${list.slice(0, 5).map((f) => f.name).join(", ")}`, userEmail);
    if (fails.length) setError(fails.join(" · "));
    if (fileRef.current) fileRef.current.value = "";
    setBusy(null);
    reload();
  }

  async function act(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const setVisibility = (d: RfqDoc, v: DocVis) =>
    act(`v-${d.id}`, async () => {
      const { error } = await sb.from("rfq_docs").update({ visible: v }).eq("id", d.id);
      if (error) throw new Error(error.message);
      await logEvent(rfq.id, `Έγγραφο «${d.name}»: ${VIS_TXT[v]}`, userEmail);
    });
  const setKindOf = (d: RfqDoc, k: DocKind) =>
    act(`k-${d.id}`, async () => {
      const { error } = await sb.from("rfq_docs").update({ kind: k }).eq("id", d.id);
      if (error) throw new Error(error.message);
    });
  const remove = (d: RfqDoc) => {
    if (!window.confirm(`Διαγραφή του «${d.name}»; Δεν αναιρείται.`)) return;
    act(`d-${d.id}`, async () => {
      const { error } = await sb.from("rfq_docs").delete().eq("id", d.id);
      if (error) throw new Error(error.message);
      await sb.storage.from("logistics").remove([d.path]);
      await logEvent(rfq.id, `Διαγραφή εγγράφου «${d.name}»`, userEmail);
    });
  };
  const download = (d: RfqDoc) => act(`g-${d.id}`, () => downloadDoc(d.path, d.name));

  const order: DocKind[] = DOC_KINDS.map((k) => k.key);
  const sorted = docs.slice().sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.created_at.localeCompare(a.created_at));

  return (
    <section
      className={`lg-card ${drag ? "lg-drop" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        upload(e.dataTransfer.files);
      }}
    >
      <h3>Έγγραφα {docs.length ? `(${docs.length})` : ""}</h3>
      <div className="lg-row">
        <label className="field">
          Είδος
          <select
            value={kind}
            onChange={(e) => {
              const k = e.target.value as DocKind;
              setKind(k);
              setVis(DOC_KINDS.find((x) => x.key === k)!.vis);
            }}
          >
            {DOC_KINDS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.gr}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Ορατό στη μεταφορική
          <select value={vis} onChange={(e) => setVis(e.target.value as DocVis)}>
            {(Object.keys(VIS_TXT) as DocVis[]).map((v) => (
              <option key={v} value={v}>
                {VIS_TXT[v]}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn primary sm" onClick={() => fileRef.current?.click()} disabled={busy === "up"}>
          {busy === "up" ? "Ανέβασμα…" : "⇪ Ανέβασμα αρχείων"}
        </button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
        <span className="dim">ή σύρε αρχεία εδώ (έως 50 MB το καθένα)</span>
      </div>
      {error && <p className="st-error">{error}</p>}
      {sorted.length ? (
        <div className="st-tablewrap">
          <table className="st-table st-cards">
            <thead>
              <tr>
                {["Είδος", "Αρχείο", "Μέγεθος", "Ορατό στη μεταφορική", "Ανέβηκε", ""].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((d) => (
                <tr key={d.id}>
                  <td data-label="Είδος">
                    <select className="lg-mini" value={d.kind} onChange={(e) => setKindOf(d, e.target.value as DocKind)} disabled={!!busy}>
                      {DOC_KINDS.map((k) => (
                        <option key={k.key} value={k.key}>
                          {k.gr}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td data-label="Αρχείο">
                    <button type="button" className="lg-linkbtn" onClick={() => download(d)} disabled={busy === `g-${d.id}`} title="Λήψη">
                      {d.name}
                    </button>
                  </td>
                  <td className="num" data-label="Μέγεθος">{fileSize(d.size)}</td>
                  <td data-label="Ορατό">
                    <select className={`lg-mini vis-${d.visible}`} value={d.visible} onChange={(e) => setVisibility(d, e.target.value as DocVis)} disabled={!!busy}>
                      {(Object.keys(VIS_TXT) as DocVis[]).map((v) => (
                        <option key={v} value={v}>
                          {VIS_TXT[v]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="dim" data-label="Ανέβηκε">
                    {ago(d.created_at)}
                    {d.created_by ? ` · ${displayUser(d.created_by)}` : ""}
                  </td>
                  <td>
                    <span className="lg-acts">
                      <button type="button" className="btn ghost sm" onClick={() => download(d)} disabled={busy === `g-${d.id}`}>
                        ⇩ Λήψη
                      </button>
                      <button type="button" className="btn ghost sm" onClick={() => remove(d)} disabled={!!busy} title="Διαγραφή">
                        ✕
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="dim">
          Κανένα έγγραφο. Τα τιμολόγια μένουν εσωτερικά· MSDS και άλλα συνοδευτικά μπορούν να είναι ορατά στη μεταφορική (στη φόρμα της, με λήψη) — «Μόνο ο νικητής» σημαίνει
          μόνο αφού γίνει η ανάθεση.
        </p>
      )}
    </section>
  );
}
