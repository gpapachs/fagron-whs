"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { logEvent } from "@/components/logistics/data";
import { manifestFromRfq } from "@/lib/manifestPdf";
import { adrText, englishUrl, hazardTotal, parseHazardText, pickLang, readHazards, type Hazard } from "@/lib/hazardImport";
import type { Rfq, RfqDoc } from "@/lib/logistics";

const LANGS = ["GB", "USA", "GR", "DE", "IT", "FR", "ES", "NL"];

/** Επικίνδυνα είδη (ADR) του αιτήματος: λίστα από Excel / επικόλληση, αυτόματη εύρεση MSDS στο fagron.com, προσθήκη στα έγγραφα και στο manifest. */
export default function HazardCard({ rfq, docs, userEmail, onDone }: { rfq: Rfq; docs: RfqDoc[]; userEmail: string | null; onDone: (msg: string | null, err?: string) => void }) {
  const [items, setItems] = useState<Hazard[]>([]);
  const [paste, setPaste] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [quick, setQuick] = useState({ name: "", qty: "", pack: "" });
  const fileRef = useRef<HTMLInputElement>(null);
  const sb = createClient();
  const attachedUrls = new Set(docs.filter((d) => d.kind === "msds").map((d) => d.notes ?? ""));

  useEffect(() => {
    sb.from("rfq_hazards")
      .select("items")
      .eq("rfq_id", rfq.id)
      .maybeSingle()
      .then(({ data }) => setItems(((data as { items: Hazard[] } | null)?.items ?? []) as Hazard[]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfq.id]);

  const upd = (key: string, patch: Partial<Hazard>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  /** αποθήκευση λίστας (χωρίς ξαναφόρτωμα οθόνης)· withRfq: και ADR / UN στο αίτημα (+ manifest) */
  async function persist(list: Hazard[], withRfq = false, extra: Record<string, unknown> = {}) {
    const { error } = await sb.from("rfq_hazards").upsert({ rfq_id: rfq.id, items: list, updated_at: new Date().toISOString(), updated_by: userEmail });
    if (error) throw new Error(error.message);
    if (!withRfq) return;
    const uns = [...new Set(list.map((h) => adrText(h)).filter(Boolean))];
    const patch = { ...(uns.length ? { adr: true, adr_info: uns.join(", ").slice(0, 300) } : {}), ...extra };
    if (Object.keys(patch).length) {
      const r = await sb.from("rfqs").update(patch).eq("id", rfq.id);
      if (r.error) throw new Error(r.error.message);
    }
  }
  const save = (list = items) => persist(list).catch((e) => onDone(null, (e as Error).message));

  // κωδικοί WMS χωρίς όνομα: αγγλική (ή ελληνική) περιγραφή από τον κατάλογο
  async function fillNames(list: Hazard[]) {
    const codes = [...new Set(list.filter((h) => h.code && !h.name).map((h) => h.code.toUpperCase()))];
    if (!codes.length) return list;
    const { data } = await sb.from("wms_items").select("code, description, description_en").in("code", codes);
    const m = new Map(((data as { code: string; description: string | null; description_en: string | null }[] | null) ?? []).map((r) => [r.code.toUpperCase(), r.description_en || r.description || ""]));
    return list.map((h) => (h.code && !h.name ? { ...h, name: m.get(h.code.toUpperCase()) ?? "" } : h));
  }

  async function load(list: Hazard[], from: string) {
    if (!list.length) return onDone(null, "Δεν βρέθηκαν είδη στη λίστα.");
    setBusy("load");
    try {
      const full = await fillNames(list.map((h, i) => ({ ...h, key: `${Date.now()}-${i}` })));
      const merged = [...items, ...full];
      setItems(merged);
      await persist(merged, true);
      await logEvent(rfq.id, `Λίστα επικίνδυνων (${from}): ${full.length} είδη`, userEmail);
      setPaste(null);
      await find(full, merged);
    } catch (e) {
      onDone(null, (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function pickFile(f: File | undefined) {
    if (!f) return;
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
      const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: false });
      await load(readHazards(rows), f.name);
    } catch (e) {
      onDone(null, `Το Excel δεν διαβάστηκε: ${(e as Error).message}`);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  /** αναζήτηση στο fagron.com (μέσω edge function) — CAS πρώτα, μετά όνομα */
  async function find(which: Hazard[], all = items) {
    const todo = which.filter((h) => h.cas || h.name);
    if (!todo.length) return;
    setBusy("find");
    try {
      const { data, error } = await sb.functions.invoke("msds-find", { body: { action: "search", items: todo.map((h) => ({ key: h.key, cas: h.cas, name: h.name })) } });
      if (error) throw new Error(error.message);
      const res = (data as { results: { key: string; hits: NonNullable<Hazard["alts"]>; error?: string }[] }).results;
      const next = all.map((h) => {
        const r = res.find((x) => x.key === h.key);
        if (!r) return h;
        const top = r.hits[0];
        const alts = r.hits.slice(0, 6);
        if (!top) return { ...h, msds: null, alts, status: (r.error ? "error" : "none") as Hazard["status"] };
        const lang = pickLang(top.links);
        return { ...h, alts, cas: h.cas || (/^\d{2,7}-\d{2}-\d$/.test(top.number) ? top.number : ""), msds: { name: top.name, number: top.number, lang, url: top.links[lang] }, status: "found" as const };
      });
      setItems(next);
      await persist(next);
      const found = next.filter((h) => todo.some((t) => t.key === h.key) && h.msds).length;
      // UN / κλάση / PG από την ενότητα 14 (μόνο όπου δεν τα έδωσε ο χρήστης)
      const withAdr = await readTransport(next.filter((h) => todo.some((t) => t.key === h.key) && h.msds && !h.un), next);
      const adrN = withAdr.filter((h) => todo.some((t) => t.key === h.key) && h.auto && h.un).length;
      onDone(`MSDS: βρέθηκαν ${found} από ${todo.length}${adrN ? ` · UN / κλάση / PG από το MSDS για ${adrN}` : ""}. Έλεγξε τις αντιστοιχίσεις και πάτα «Προσθήκη στα έγγραφα».`);
    } catch (e) {
      onDone(null, `Αναζήτηση MSDS: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  /** ενότητα 14 των MSDS (αγγλική έκδοση) -> UN / κλάση / PG */
  async function readTransport(which: Hazard[], all: Hazard[]) {
    const todo = which.map((h) => ({ key: h.key, url: englishUrl((h.alts ?? []).find((a) => a.name === h.msds?.name && a.number === h.msds?.number)?.links) })).filter((x) => x.url);
    if (!todo.length) return all;
    setBusy("adr");
    let next = all;
    try {
      for (let i = 0; i < todo.length; i += 10) {
        const { data, error } = await sb.functions.invoke("msds-find", { body: { action: "transport", items: todo.slice(i, i + 10) } });
        if (error) throw new Error(error.message);
        const res = (data as { results: { key: string; t: { regulated: boolean; un: string; cls: string; pg: string; psn: string } | null }[] }).results;
        next = next.map((h) => {
          const r = res.find((x) => x.key === h.key)?.t;
          if (!r) return h;
          if (!r.regulated) return { ...h, regulated: false, auto: true };
          return { ...h, regulated: true, auto: true, un: h.un || r.un, cls: h.cls || r.cls, pg: h.pg || r.pg, psn: r.psn };
        });
        setItems(next);
      }
      await persist(next, true);
    } catch (e) {
      onDone(null, `UN / κλάση από MSDS: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
    return next;
  }

  const setOne = (key: string, patch: Partial<Hazard>) => {
    const next = items.map((x) => (x.key === key ? { ...x, ...patch } : x));
    setItems(next);
    save(next);
  };
  const choose = (h: Hazard, idx: number, lang?: string) => {
    const hit = (h.alts ?? [])[idx];
    if (!hit) return;
    const l = lang && hit.links[lang] ? lang : pickLang(hit.links, lang);
    const patch: Partial<Hazard> = { msds: { name: hit.name, number: hit.number, lang: l, url: hit.links[l] }, status: "found" };
    // αν τα UN ήρθαν από το προηγούμενο MSDS, ξαναδιαβάζονται από το νέο
    if (h.auto) Object.assign(patch, { un: "", cls: "", pg: "", psn: "", regulated: null, auto: false });
    const next = items.map((x) => (x.key === h.key ? { ...x, ...patch } : x));
    setItems(next);
    save(next);
    if (!next.find((x) => x.key === h.key)!.un) readTransport([next.find((x) => x.key === h.key)!], next);
  };
  const setLang = (h: Hazard, lang: string) => {
    const hit = (h.alts ?? []).find((x) => x.name === h.msds?.name && x.number === h.msds?.number);
    if (hit?.links[lang]) setOne(h.key, { msds: { ...h.msds!, lang, url: hit.links[lang] } });
  };

  async function attach() {
    const todo = items.filter((h) => h.msds?.url && !attachedUrls.has(h.msds.url));
    if (!todo.length) return onDone("Όλα τα MSDS που βρέθηκαν είναι ήδη στα έγγραφα.");
    setBusy("attach");
    const fails: string[] = [];
    let next = items;
    for (const h of todo) {
      const fileName = `MSDS ${h.msds!.name} (${h.msds!.lang}).pdf`;
      const { data, error } = await sb.functions.invoke("msds-find", { body: { action: "attach", rfq_id: rfq.id, url: h.msds!.url, name: fileName } });
      const err = error?.message ?? (data as { error?: string })?.error;
      if (err) fails.push(`${h.name || h.cas}: ${err}`);
      else next = next.map((x) => (x.key === h.key ? { ...x, status: "attached" as const, msds: { ...x.msds!, docId: (data as { doc: { id: string } }).doc.id } } : x));
    }
    setItems(next);
    try {
      await persist(next, true);
      await logEvent(rfq.id, `MSDS από fagron.com στα έγγραφα: ${todo.length - fails.length}`, userEmail);
    } catch {}
    setBusy(null);
    onDone(fails.length ? null : `Προστέθηκαν ${todo.length} MSDS στα έγγραφα (ορατά στις μεταφορικές).`, fails.length ? fails.join(" · ") : undefined);
  }

  async function toManifest() {
    const base = manifestFromRfq(rfq);
    const keep = base.lines.filter((l) => l.desc || l.pallets || l.weight);
    const lines = items.map((h) => {
      const t = hazardTotal(h);
      return {
        desc: h.name || h.code,
        pallets: "",
        packages: h.qty,
        weight: t?.unit === "kg" ? String(t.v).replace(".", ",") : "",
        dims: "",
        adr: adrText(h),
        notes: [h.pack ? `${h.qty || 1} × ${h.pack}${t ? ` = ${t.text}` : ""}` : "", h.cas ? `CAS ${h.cas}` : ""].filter(Boolean).join(" · "),
      };
    });
    const msdsNames = items.filter((h) => h.msds).map((h) => `MSDS ${h.msds!.name}`);
    setBusy("mf");
    try {
      await persist(items, true, { manifest: { ...base, lines: [...keep, ...lines], docs: [...new Set([...base.docs, ...msdsNames])] } });
      onDone(`${lines.length} γραμμές προστέθηκαν στο loading manifest.`);
    } catch (e) {
      onDone(null, (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function removeItem(key: string) {
    const next = items.filter((x) => x.key !== key);
    setItems(next);
    await persist(next).catch((e) => onDone(null, (e as Error).message));
  }

  const found = items.filter((h) => h.msds).length;
  const pending = items.filter((h) => h.msds?.url && !attachedUrls.has(h.msds.url)).length;

  return (
    <section className="lg-card">
      <h3>
        Επικίνδυνα είδη (ADR) & MSDS{" "}
        {items.length ? (
          <span className="dim">
            · {items.length} είδη · MSDS {found}
            {(() => {
              const sum = { kg: 0, L: 0 };
              for (const h of items) {
                const t = hazardTotal(h);
                if (t) sum[t.unit] += t.v;
              }
              const parts = [sum.kg ? `${sum.kg.toLocaleString("el-GR", { maximumFractionDigits: 3 })} kg` : "", sum.L ? `${sum.L.toLocaleString("el-GR", { maximumFractionDigits: 3 })} L` : ""].filter(Boolean);
              return parts.length ? ` · σύνολο ${parts.join(" + ")}` : "";
            })()}
          </span>
        ) : null}
      </h3>
      <form
        className="lg-row lg-quick"
        onSubmit={(e) => {
          e.preventDefault();
          if (!quick.name.trim()) return;
          load(parseHazardText(quick.name).map((h) => ({ ...h, qty: quick.qty.trim(), pack: quick.pack.trim() })), "χειροκίνητα");
          setQuick({ name: "", qty: "", pack: quick.pack });
        }}
      >
        <label className="field lg-wide">
          Προϊόν (όνομα στα αγγλικά ή CAS)
          <input value={quick.name} onChange={(e) => setQuick({ ...quick, name: e.target.value })} placeholder="π.χ. Ethanol 96% ή 64-17-5" />
        </label>
        <label className="field">
          Τμχ
          <input value={quick.qty} inputMode="decimal" onChange={(e) => setQuick({ ...quick, qty: e.target.value })} />
        </label>
        <label className="field">
          Ανά τμχ
          <input value={quick.pack} onChange={(e) => setQuick({ ...quick, pack: e.target.value })} placeholder="π.χ. 5 g, 1 L, 25 kg" />
        </label>
        {(() => {
          const t = hazardTotal({ qty: quick.qty, pack: quick.pack, weight: "" });
          return t ? <span className="lg-total">= {t.text}</span> : null;
        })()}
        <button type="submit" className="btn primary sm" disabled={!!busy || !quick.name.trim()}>
          {busy === "load" || busy === "find" || busy === "adr" ? "Αναζήτηση…" : "+ Προσθήκη & εύρεση UN / MSDS"}
        </button>
      </form>
      <div className="lg-row">
        <button type="button" className="btn ghost sm" onClick={() => fileRef.current?.click()} disabled={!!busy}>
          ⇪ Λίστα από Excel
        </button>
        <button type="button" className="btn ghost sm" onClick={() => setPaste(paste == null ? "" : null)} disabled={!!busy}>
          ✎ Επικόλληση λίστας
        </button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
        {items.length > 0 && (
          <>
            <button type="button" className="btn ghost sm" onClick={() => find(items)} disabled={!!busy}>
              {busy === "find" ? "Αναζήτηση…" : "🔍 Εύρεση MSDS στο fagron.com"}
            </button>
            <button type="button" className="btn primary sm" onClick={attach} disabled={!!busy || !pending}>
              {busy === "attach" ? "Λήψη…" : `⇩ Προσθήκη στα έγγραφα (${pending})`}
            </button>
            <button type="button" className="btn ghost sm" onClick={toManifest} disabled={!!busy} title="Προσθέτει τα είδη ως γραμμές (με UN / κλάση / PG) και τα MSDS στα συνοδευτικά του loading manifest">
              → Γραμμές στο manifest
            </button>
          </>
        )}
      </div>
      {paste != null && (
        <div className="lg-row">
          <label className="field lg-wide">
            Ένα είδος ανά γραμμή — όνομα (στα αγγλικά, όπως στο fagron.com) ή / και CAS, προαιρετικά UN
            <textarea rows={4} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"Ethanol 96%; 64-17-5; UN1170\nPhenoxyethanol 122-99-6\nIsopropyl alcohol"} />
          </label>
          <button type="button" className="btn primary sm" onClick={() => load(parseHazardText(paste), "επικόλληση")} disabled={!!busy || !paste.trim()}>
            Προσθήκη & αναζήτηση
          </button>
        </div>
      )}
      {items.length ? (
        <div className="st-tablewrap">
          <table className="st-table lg-hz">
            <thead>
              <tr>
                {["Κωδικός", "Είδος", "CAS", "UN", "Κλάση", "PG", "Τμχ", "Ανά τμχ", "Σύνολο", "MSDS (fagron.com)", "Γλώσσα", ""].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((h) => {
                const hs = h.alts ?? [];
                const sel = hs.findIndex((x) => x.name === h.msds?.name && x.number === h.msds?.number);
                const inDocs = !!h.msds?.url && attachedUrls.has(h.msds.url);
                return (
                  <tr key={h.key}>
                    <td className="mono">{h.code}</td>
                    <td>
                      <input value={h.name} onBlur={() => save()} onChange={(e) => upd(h.key, { name: e.target.value })} />
                    </td>
                    <td>
                      <input className="lg-cas" value={h.cas} onBlur={() => save()} onChange={(e) => upd(h.key, { cas: e.target.value })} />
                    </td>
                    <td>
                      <input className="lg-un" value={h.un} onBlur={() => save()} onChange={(e) => upd(h.key, { un: e.target.value.replace(/[^0-9]/g, "").slice(0, 4), auto: false })} />
                      {h.regulated === false && <div className="lg-badge green" title="Ενότητα 14 του MSDS: not regulated">όχι ADR</div>}
                      {h.auto && h.regulated && h.psn && <div className="dim lg-small" title="Από την ενότητα 14 του MSDS">{h.psn}</div>}
                    </td>
                    <td>
                      <input className="lg-un" value={h.cls} onBlur={() => save()} onChange={(e) => upd(h.key, { cls: e.target.value })} />
                    </td>
                    <td>
                      <input className="lg-un" value={h.pg} onBlur={() => save()} onChange={(e) => upd(h.key, { pg: e.target.value.toUpperCase() })} />
                    </td>
                    <td>
                      <input className="lg-un" value={h.qty} onBlur={() => save()} onChange={(e) => upd(h.key, { qty: e.target.value })} />
                    </td>
                    <td>
                      <input className="lg-pack" value={h.pack ?? ""} placeholder="5 g" onBlur={() => save()} onChange={(e) => upd(h.key, { pack: e.target.value })} />
                    </td>
                    <td className="num">
                      {h.pack ? (
                        <b>{hazardTotal(h)?.text ?? <span className="dm-r" title="Δεν αναγνωρίστηκε η μονάδα (g, kg, mg, ml, L)">?</span>}</b>
                      ) : (
                        <input className="lg-un" value={h.weight} placeholder="kg" title="Συνολικό βάρος (kg) — ή συμπλήρωσε «Ανά τμχ»" onBlur={() => save()} onChange={(e) => upd(h.key, { weight: e.target.value })} />
                      )}
                    </td>
                    <td>
                      {hs.length > 1 ? (
                        <select className="lg-mini" value={sel} onChange={(e) => choose(h, Number(e.target.value), h.msds?.lang)}>
                          {sel < 0 && <option value={-1}>{h.msds?.name ?? "—"}</option>}
                          {hs.map((x, i) => (
                            <option key={i} value={i}>
                              {x.name} · {x.number}
                            </option>
                          ))}
                        </select>
                      ) : h.msds ? (
                        <span>
                          {h.msds.name} <span className="dim">· {h.msds.number}</span>
                        </span>
                      ) : (
                        <span className={h.status === "none" || h.status === "error" ? "dm-r" : "dim"}>{h.status === "none" ? "δεν βρέθηκε — άλλαξε όνομα / CAS" : h.status === "error" ? "σφάλμα αναζήτησης" : "—"}</span>
                      )}
                      {h.msds && (
                        <div>
                          <a href={h.msds.url} target="_blank" rel="noreferrer" className="lg-small">
                            άνοιγμα PDF
                          </a>
                          {inDocs && <span className="lg-badge green">στα έγγραφα</span>}
                        </div>
                      )}
                    </td>
                    <td>
                      {h.msds && (
                        <select className="lg-mini" value={h.msds.lang} onChange={(e) => setLang(h, e.target.value)}>
                          {[...new Set([h.msds.lang, ...LANGS, ...Object.keys(hs[sel]?.links ?? {})])].map((l) => (
                            <option key={l}>{l}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>
                      <span className="lg-acts">
                        <button type="button" className="btn ghost sm" onClick={() => find([h])} disabled={!!busy} title="Ξανά αναζήτηση με το όνομα / CAS της γραμμής">
                          🔍
                        </button>
                        <button type="button" className="btn ghost sm" onClick={() => removeItem(h.key)} disabled={!!busy} title="Αφαίρεση">
                          ✕
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="dim">
          Φόρτωσε τη λίστα με τα επικίνδυνα του φορτίου (Excel με στήλες π.χ. Κωδικός, Περιγραφή, CAS, UN, Κλάση, PG, Ποσότητα, Βάρος — ή επικόλληση). Τα MSDS βρίσκονται
          αυτόματα στο fagron.com (αγγλική έκδοση, αλλιώς ελληνική) και μπαίνουν στα έγγραφα, ορατά στις μεταφορικές.
        </p>
      )}
      {items.length > 0 && <p className="dim lg-small">Οι αλλαγές αποθηκεύονται αυτόματα. Με λίστα που έχει UN, το αίτημα σημειώνεται ADR = Ναι με τα UN / κλάσεις.</p>}
    </section>
  );
}
