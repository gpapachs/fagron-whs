"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { fetchAll } from "@/lib/supabase/fetchAll";
import { useColSort } from "@/components/analysis/colSort";
import type { Direction } from "@/lib/logistics";
import { isAbroad, partnerCountry } from "@/lib/partnerCountry";

export type Partner = {
  id: number;
  code: string | null;
  name: string | null;
  is_customer: boolean;
  is_supplier: boolean;
  active: boolean;
  vat: string | null;
  vat_eu: string | null;
  address: string | null;
  city: string | null;
  zip: string | null;
  phone: string | null;
  phone2: string | null;
  email: string | null;
  contact: string | null;
  manual_country: string | null;
  country: string | null;
  is_abroad: boolean;
  country_manual: boolean;
  synced_at: string;
};

const PAGE = 200;
const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();

/** Πελάτες / προμηθευτές από το WMS: Ελλάδα / εξωτερικό, αναζήτηση, και νέο αίτημα με τα στοιχεία τους. */
export default function PartnersTab({ userEmail, onNew }: { userEmail: string | null; onNew: (dir: Direction, p: Partner) => void }) {
  const [rows, setRows] = useState<Partner[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<"customer" | "supplier" | "">("customer");
  const [area, setArea] = useState<"gr" | "abroad" | "">("abroad");
  const [onlyActive, setOnlyActive] = useState(true);
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [fix, setFix] = useState<{ id: number; v: string } | null>(null);

  async function load() {
    try {
      const raw = await fetchAll<Partner>(createClient(), "wms_partners_v", "*", ["name", "id"]);
      setRows(
        raw.map((p) => {
          const country = partnerCountry(p);
          return { ...p, country, is_abroad: isAbroad(country), country_manual: !!p.manual_country };
        })
      );
    } catch (e) {
      setError(`Η φόρτωση απέτυχε: ${(e as Error).message}`);
    }
  }
  useEffect(() => {
    load();
  }, []);

  const base = (rows ?? []).filter((p) => (!onlyActive || p.active) && (!kind || (kind === "customer" ? p.is_customer : p.is_supplier)));
  const counts = {
    gr: base.filter((p) => !p.is_abroad).length,
    abroad: base.filter((p) => p.is_abroad).length,
  };
  const words = norm(q.trim()).split(/\s+/).filter(Boolean);
  const list = useMemo(
    () =>
      base.filter((p) => {
        if (area === "gr" && p.is_abroad) return false;
        if (area === "abroad" && !p.is_abroad) return false;
        if (!words.length) return true;
        const hay = norm([p.code, p.name, p.city, p.zip, p.address, p.country, p.vat, p.vat_eu, p.email, p.phone, p.contact].filter(Boolean).join(" "));
        return words.every((w) => hay.includes(w));
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, kind, area, onlyActive, q]
  );
  const cs = useColSort<Partner>(
    [
      { h: "Κωδικός", v: (p) => p.code },
      { h: "Επωνυμία", v: (p) => p.name },
      { h: "Τύπος", v: (p) => (p.is_customer ? "Π" : "") + (p.is_supplier ? "Σ" : "") },
      { h: "Χώρα", v: (p) => p.country },
      { h: "Πόλη / ΤΚ", v: (p) => p.city },
      { h: "Διεύθυνση", v: (p) => p.address },
      { h: "Επικοινωνία", v: (p) => p.email ?? p.phone },
      { h: "ΑΦΜ", v: (p) => p.vat_eu ?? p.vat },
      { h: "", v: () => null },
    ],
    list
  );
  const synced = rows?.length ? rows.reduce((m, p) => (p.synced_at > m ? p.synced_at : m), "") : null;

  async function saveCountry(id: number, v: string) {
    const sb = createClient();
    const c = v.trim().toUpperCase();
    const res = c ? await sb.from("wms_partner_country").upsert({ id, country: c, updated_by: userEmail, updated_at: new Date().toISOString() }) : await sb.from("wms_partner_country").delete().eq("id", id);
    if (res.error) return setError(res.error.message);
    setFix(null);
    load();
  }

  return (
    <div>
      <div className="st-filters an-filters">
        <label className="field">
          Αναζήτηση
          <input value={q} onChange={(e) => (setQ(e.target.value), setShown(PAGE))} placeholder="επωνυμία, κωδικός, πόλη, χώρα, ΑΦΜ, email" />
        </label>
        <label className="field">
          Τύπος
          <select value={kind} onChange={(e) => (setKind(e.target.value as typeof kind), setShown(PAGE))}>
            <option value="customer">Πελάτες</option>
            <option value="supplier">Προμηθευτές</option>
            <option value="">Όλοι</option>
          </select>
        </label>
        <div className="field">
          Περιοχή
          <div className="lg-seg">
            {(
              [
                ["abroad", `Εξωτερικό (${counts.abroad})`],
                ["gr", `Ελλάδα (${counts.gr})`],
                ["", `Όλοι (${counts.gr + counts.abroad})`],
              ] as const
            ).map(([k, t]) => (
              <button key={k} type="button" className={`btn sm ${area === k ? "primary" : "ghost"}`} onClick={() => (setArea(k), setShown(PAGE))}>
                {t}
              </button>
            ))}
          </div>
        </div>
        <label className="st-check">
          <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
          Μόνο ενεργοί
        </label>
      </div>
      <p className="dim">
        Από το WMS (ενημέρωση 1 φορά τη μέρα{synced ? `, τελευταία ${new Date(synced).toLocaleString("el-GR", { dateStyle: "short", timeStyle: "short" })}` : ""}). Η χώρα βγαίνει από το ΑΦΜ / ΤΚ / διεύθυνση — αν
        είναι λάθος, διόρθωσέ τη με ✎ στη στήλη «Χώρα». Με «→ Εξαγωγή» / «→ Εισαγωγή» ανοίγει νέο αίτημα με τα στοιχεία του.
      </p>
      {error && <p className="st-error">{error}</p>}
      <div className="st-tablewrap">
        <table className="st-table st-cards">
          <thead>
            <tr>{cs.head}</tr>
          </thead>
          <tbody>
            {cs.sorted.slice(0, shown).map((p) => (
              <tr key={p.id} className={p.active ? "" : "dim"}>
                <td className="mono" data-label="Κωδικός">{p.code}</td>
                <td data-label="Επωνυμία">
                  <b>{p.name}</b>
                  {p.contact ? <div className="dim">{p.contact}</div> : null}
                </td>
                <td data-label="Τύπος">{[p.is_customer ? "Πελάτης" : "", p.is_supplier ? "Προμηθευτής" : ""].filter(Boolean).join(" · ")}</td>
                <td data-label="Χώρα">
                  {fix?.id === p.id ? (
                    <form
                      className="lg-inline"
                      onSubmit={(e) => {
                        e.preventDefault();
                        saveCountry(p.id, fix.v);
                      }}
                    >
                      <input autoFocus size={3} maxLength={2} value={fix.v} onChange={(e) => setFix({ id: p.id, v: e.target.value.toUpperCase() })} placeholder="DE" />
                      <button type="submit" className="btn primary sm">
                        ✓
                      </button>
                      <button type="button" className="btn ghost sm" onClick={() => setFix(null)}>
                        ✕
                      </button>
                    </form>
                  ) : (
                    <>
                      {p.country ? <b className="mono">{p.country}</b> : p.is_abroad ? <span className="dm-r" title="Εξωτερικό — άγνωστη χώρα">?</span> : <span className="dim">—</span>}
                      {p.country_manual && <span className="dim" title="Χειροκίνητη διόρθωση"> ✓</span>}
                      <button type="button" className="btn ghost sm lg-ico" title="Διόρθωση χώρας (κενό = αυτόματα)" onClick={() => setFix({ id: p.id, v: p.country_manual ? p.country ?? "" : "" })}>
                        ✎
                      </button>
                    </>
                  )}
                </td>
                <td data-label="Πόλη / ΤΚ">{[p.city, p.zip].filter(Boolean).join(" ")}</td>
                <td data-label="Διεύθυνση">{p.address}</td>
                <td data-label="Επικοινωνία">
                  {p.email ? (
                    <a href={`mailto:${p.email}`} onClick={(e) => e.stopPropagation()}>
                      {p.email}
                    </a>
                  ) : null}
                  <div className="dim">{[p.phone, p.phone2].filter(Boolean).join(" · ")}</div>
                </td>
                <td className="mono" data-label="ΑΦΜ">{p.vat_eu || p.vat}</td>
                <td>
                  <span className="lg-acts">
                    {p.is_customer && (
                      <button type="button" className="btn ghost sm" title="Νέο αίτημα εξαγωγής προς αυτόν τον πελάτη" onClick={() => onNew("export", p)}>
                        → Εξαγωγή
                      </button>
                    )}
                    {p.is_supplier && (
                      <button type="button" className="btn ghost sm" title="Νέο αίτημα εισαγωγής από αυτόν τον προμηθευτή" onClick={() => onNew("import", p)}>
                        → Εισαγωγή
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
            {!list.length && (
              <tr>
                <td colSpan={9} className="st-empty">
                  {!rows ? "Φόρτωση…" : rows.length ? "Κανένα αποτέλεσμα με αυτά τα φίλτρα." : "Δεν έχουν ανέβει ακόμα από το WMS — το sync τα φέρνει μέσα σε λίγα λεπτά."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {list.length > shown && (
        <p className="st-actions">
          <span className="dim">
            {shown} από {list.length}
          </span>
          <button type="button" className="btn ghost sm" onClick={() => setShown(shown + PAGE * 5)}>
            Περισσότερα
          </button>
        </p>
      )}
    </div>
  );
}
