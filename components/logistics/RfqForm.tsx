"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { HOME, INCOTERMS, MODES, partnerSide, type Direction, type PartnerSite, type Rfq } from "@/lib/logistics";
import { loadPartners, searchPartners } from "@/components/logistics/partnerData";
import { blankCargo, cargoSummary, cargoTotals, lineTotals, num as cnum, UNIT_TYPES, unitOf, type CargoLine } from "@/lib/cargo";

const DEFAULT_TEMPS = ["15-25°C", "2-8°C", "Έως 25°C", "Χωρίς απαίτηση θερμοκρασίας", "-20°C (κατεψυγμένο)"];
const fmn = (n: number, d = 2) => (n ? n.toLocaleString("el-GR", { maximumFractionDigits: d }) : "");
import type { Partner } from "@/components/logistics/PartnersTab";

const ADDR = ["company", "address", "city", "zip", "country"] as const;
// πεδία έδρας πελάτη <-> πεδία τόπου (company <- όνομα πελάτη)
const custKey = (k: (typeof ADDR)[number]) => (k === "company" ? "customer" : `customer_${k}`) as keyof Rfq;
/** Παλιά αιτήματα χωρίς έδρα πελάτη: η έδρα = ο τόπος της πλευράς του πελάτη */
function withCustomer(d: Draft): Draft {
  if (d.customer_address || d.customer_city) return d;
  const side = partnerSide(d.direction);
  const x: Draft = { ...d };
  for (const k of ADDR) if (k !== "company") (x as Record<string, unknown>)[custKey(k)] = (d as Record<string, unknown>)[`${side}_${k}`] ?? null;
  if (!x.customer) x.customer = (d as Record<string, unknown>)[`${side}_company`] as string | null;
  return x;
}

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
  const [d, setD] = useState<Draft>(() => withCustomer(initial));
  const [partners, setPartners] = useState<Partner[] | null>(null);
  const [q, setQ] = useState("");
  const [showHits, setShowHits] = useState(false);
  const [sites, setSites] = useState<PartnerSite[]>([]);
  const [siteMsg, setSiteMsg] = useState<string | null>(null);
  const [cargo, setCargo] = useState<CargoLine[]>(() => ((initial as { cargo?: CargoLine[] | null }).cargo ?? []) as CargoLine[]);
  const [temps, setTemps] = useState<string[]>(DEFAULT_TEMPS);
  const [newTemp, setNewTemp] = useState<string | null>(null);
  const tot = cargoTotals(cargo);
  const setLine = (i: number, p: Partial<CargoLine>) => setCargo((xs) => xs.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const addLine = (type: string) =>
    setCargo((xs) => {
      if (xs.length) return [...xs, blankCargo(type)];
      // 1η γραμμή: από τα υπάρχοντα σύνολα, αν υπάρχουν
      const first = blankCargo(type);
      const q = unitOf(type).pallet ? d.pallets : d.packages;
      if (q) first.qty = String(q);
      if (d.weight_kg && q) first.kg = String(Math.round((Number(d.weight_kg) / Number(q)) * 100) / 100).replace(".", ",");
      first.stack = d.id ? !!d.stackable : false;
      return [first];
    });
  useEffect(() => {
    createClient()
      .from("logistics_options")
      .select("value")
      .eq("kind", "temp")
      .order("created_at")
      .then(({ data }) => {
        const saved = ((data as { value: string }[] | null) ?? []).map((x) => x.value);
        setTemps([...new Set([...DEFAULT_TEMPS, ...saved])]);
      });
  }, []);
  async function addTemp() {
    const v = (newTemp ?? "").trim();
    if (!v) return;
    await createClient().from("logistics_options").upsert({ kind: "temp", value: v, created_by: userEmail });
    setTemps((t) => [...new Set([...t, v])]);
    set("temp", v);
    setNewTemp(null);
  }
  const side = partnerSide(d.direction);
  const other = !!d.other_site;
  const kind = d.direction === "import" ? "supplier" : "customer";
  const who = kind === "customer" ? "πελάτη" : "προμηθευτή";

  // αποθηκευμένοι τόποι του πελάτη (κωδικός WMS ή όνομα)
  async function loadSites(code: string | null | undefined, name: string | null | undefined) {
    if (!code && !name) return setSites([]);
    const sb = createClient();
    const res = code
      ? await sb.from("partner_sites").select("*").or(`partner_code.eq."${code.replace(/"/g, "")}",partner_name.ilike."${(name ?? "").replace(/["\\]/g, "")}"`).order("created_at")
      : await sb.from("partner_sites").select("*").ilike("partner_name", (name ?? "").replace(/[%_]/g, "")).order("created_at");
    setSites((res.data as PartnerSite[] | null) ?? []);
  }
  useEffect(() => {
    loadSites(d.customer_code, d.customer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.customer_code]);

  /** αλλαγή στοιχείου έδρας: αν ο τόπος είναι ο ίδιος, ενημερώνεται και ο τόπος */
  const setCust = (k: (typeof ADDR)[number], v: string) =>
    setD((x) => ({ ...x, [custKey(k)]: v, ...(x.other_site ? {} : { [`${partnerSide(x.direction)}_${k}`]: v }) }));
  const pickPartner = (p: Partner) => {
    setD((x) => {
      const sd = partnerSide(x.direction);
      const vals = { company: p.name ?? "", address: p.address ?? "", city: p.city ?? "", zip: p.zip ?? "", country: p.country ?? "" };
      const y: Draft = { ...x, customer_code: p.code, customer: vals.company, customer_address: vals.address, customer_city: vals.city, customer_zip: vals.zip, customer_country: vals.country };
      if (!x.other_site) for (const k of ADDR) (y as Record<string, unknown>)[`${sd}_${k}`] = vals[k];
      return y;
    });
    setQ("");
    setShowHits(false);
  };
  const toggleOther = (on: boolean) =>
    setD((x) => {
      const y: Draft = { ...x, other_site: on };
      // επιστροφή στην έδρα: ο τόπος ξαναγίνεται ίδιος με τη διεύθυνση του πελάτη
      if (!on) for (const k of ADDR) (y as Record<string, unknown>)[`${partnerSide(x.direction)}_${k}`] = (x as Record<string, unknown>)[custKey(k)] ?? "";
      return y;
    });
  const pickSite = (id: string) => {
    const st = sites.find((x) => x.id === id);
    if (!st) return;
    setD((x) => {
      const sd = partnerSide(x.direction);
      return {
        ...x,
        other_site: true,
        [`${sd}_company`]: st.company ?? x.customer ?? "",
        [`${sd}_address`]: st.address ?? "",
        [`${sd}_city`]: st.city,
        [`${sd}_zip`]: st.zip ?? "",
        [`${sd}_country`]: st.country ?? "",
        site_contact: st.contact ?? x.site_contact,
        site_phone: st.phone ?? x.site_phone,
        site_hours: st.hours ?? x.site_hours,
      };
    });
  };
  async function saveSite() {
    const g = (k: string) => ((d as Record<string, unknown>)[`${side}_${k}`] as string | null) || null;
    if (!d.customer || !g("city")) return setSiteMsg(`Συμπληρώστε ${who} και πόλη του τόπου.`);
    const { error } = await createClient()
      .from("partner_sites")
      .insert({
        partner_code: d.customer_code || null,
        partner_name: d.customer,
        label: [g("company"), g("city")].filter(Boolean).join(", "),
        company: g("company"),
        address: g("address"),
        city: g("city"),
        zip: g("zip"),
        country: g("country"),
        contact: d.site_contact || null,
        phone: d.site_phone || null,
        hours: d.site_hours || null,
        created_by: userEmail,
      });
    if (error) return setSiteMsg(error.message);
    setSiteMsg(`Ο τόπος αποθηκεύτηκε στον ${who} — θα τον βρίσκεις στη λίστα «Αποθηκευμένοι τόποι».`);
    loadSites(d.customer_code, d.customer);
  }
  const hits = partners && q.trim().length >= 2 ? searchPartners(partners, q, kind) : [];
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
    // (μετά τη μετατροπή αριθμών: π.χ. 1.235 m³ δεν είναι «χιλιάδες»)
    // ανάλυση φορτίου: τα σύνολα υπολογίζονται από τις γραμμές
    const lines = cargo.filter((l) => cnum(l.qty) > 0);
    row.cargo = lines.length ? lines : null;
    if (lines.length) {
      row.pallets = tot.pallets || null;
      row.packages = tot.packages || null;
      row.weight_kg = tot.kg || null;
      row.volume_m3 = tot.vol || null;
      row.ldm = tot.ldm || null;
      row.stackable = tot.stackable;
      row.dims = cargoSummary(lines);
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
        {txt("order_ref", "Αρ. παραγγελίας / PO")}
      </div>

      <fieldset>
        <legend>
          {kind === "customer" ? "Πελάτης" : "Προμηθευτής"} — έδρα{d.customer_code ? <span className="dim"> · {d.customer_code}</span> : null}
        </legend>
        <div className="lg-row">
          <label className="field lg-wide lg-search">
            Αναζήτηση στο WMS
            <input
              value={q}
              placeholder={`επωνυμία, κωδικός, πόλη ή ΑΦΜ ${who}`}
              onFocus={() => {
                setShowHits(true);
                if (!partners) loadPartners().then(setPartners, () => setPartners([]));
              }}
              onBlur={() => setTimeout(() => setShowHits(false), 200)}
              onChange={(e) => (setQ(e.target.value), setShowHits(true))}
            />
            {showHits && q.trim().length >= 2 && (
              <ul className="lg-hits">
                {!partners && <li className="dim">Φόρτωση…</li>}
                {partners && !hits.length && <li className="dim">Δεν βρέθηκε — συμπλήρωσε τα στοιχεία με το χέρι.</li>}
                {hits.map((p) => (
                  <li key={p.id}>
                    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pickPartner(p)}>
                      <b>{p.name}</b> <span className="dim">{[p.code, [p.zip, p.city].filter(Boolean).join(" "), p.country].filter(Boolean).join(" · ")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </label>
        </div>
        <div className="lg-row">
          <label className="field lg-wide">
            Επωνυμία
            <input value={d.customer ?? ""} onChange={(e) => setCust("company", e.target.value)} />
          </label>
          <label className="field lg-wide">
            Διεύθυνση
            <input value={d.customer_address ?? ""} onChange={(e) => setCust("address", e.target.value)} />
          </label>
          <label className="field">
            Τ.Κ.
            <input value={d.customer_zip ?? ""} onChange={(e) => setCust("zip", e.target.value)} />
          </label>
          <label className="field">
            Πόλη
            <input value={d.customer_city ?? ""} onChange={(e) => setCust("city", e.target.value)} />
          </label>
          <label className="field">
            Χώρα
            <input value={d.customer_country ?? ""} onChange={(e) => setCust("country", e.target.value.toUpperCase())} placeholder="π.χ. DE" />
          </label>
        </div>
      </fieldset>

      <div className="lg-cols">
        {(["from", "to"] as const).map((sd) => {
          const mine = sd === side;
          const locked = mine && !other;
          const f = (k: (typeof ADDR)[number], label: string, ph?: string) => {
            const key = `${sd}_${k}` as keyof Rfq;
            return (
              <label className="field">
                {label}
                <input
                  value={(d[key] as string | null | undefined) ?? ""}
                  placeholder={ph}
                  disabled={locked}
                  onChange={(e) => set(key, k === "country" ? e.target.value.toUpperCase() : e.target.value)}
                />
              </label>
            );
          };
          return (
            <fieldset key={sd} className={mine && other ? "lg-site-other" : ""}>
              <legend>{sd === "from" ? "Φόρτωση" : "Παράδοση"}</legend>
              {mine && (
                <label className="st-check">
                  <input type="checkbox" checked={other} onChange={(e) => toggleOther(e.target.checked)} />
                  Διαφορετικός τόπος {sd === "from" ? "φόρτωσης" : "παράδοσης"} από τη διεύθυνση του {who}
                </label>
              )}
              {mine && other && sites.length > 0 && (
                <label className="field">
                  Αποθηκευμένοι τόποι του {who}
                  <select value="" onChange={(e) => pickSite(e.target.value)}>
                    <option value="">— επιλογή ({sites.length}) —</option>
                    {sites.map((st) => (
                      <option key={st.id} value={st.id}>
                        {st.label || [st.company, st.city].filter(Boolean).join(", ")}
                        {st.address ? ` — ${st.address}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {locked && <p className="dim lg-note">Ίδιος με τη διεύθυνση του {who} — τσέκαρε το παραπάνω για άλλο τόπο (αποθήκη, εργοστάσιο, 3PL…).</p>}
              {f("company", mine && other ? "Εταιρεία / τόπος" : "Εταιρεία")}
              {f("address", "Διεύθυνση")}
              <div className="lg-row">
                {f("zip", "Τ.Κ.")}
                {f("city", "Πόλη *")}
                {f("country", "Χώρα", "π.χ. DE")}
              </div>
              {mine && (
                <div className="lg-row">
                  {txt("site_contact", "Υπεύθυνος στον τόπο")}
                  {txt("site_phone", "Τηλέφωνο")}
                  {txt("site_hours", "Ωράριο", { ph: "π.χ. Δε–Πα 08:00–15:00" })}
                </div>
              )}
              {mine && other && (
                <span className="st-actions">
                  <button type="button" className="btn ghost sm" onClick={saveSite}>
                    ★ Αποθήκευση τόπου στον {who}
                  </button>
                  {siteMsg && <span className="dim">{siteMsg}</span>}
                </span>
              )}
            </fieldset>
          );
        })}
      </div>

      <fieldset>
        <legend>Φορτίο</legend>
        <div className="lg-row">
          {txt("goods", "Εμπόρευμα", { wide: true, ph: "π.χ. φαρμακευτικές πρώτες ύλες, μη επικίνδυνα" })}
          <label className="field">
            Θερμοκρασία
            {newTemp == null ? (
              <select
                value={d.temp ?? ""}
                onChange={(e) => (e.target.value === "__new" ? setNewTemp("") : set("temp", e.target.value))}
              >
                <option value="">—</option>
                {[...new Set([...temps, ...(d.temp ? [d.temp] : [])])].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
                <option value="__new">+ Νέα επιλογή…</option>
              </select>
            ) : (
              <span className="lg-inline">
                <input autoFocus value={newTemp} onChange={(e) => setNewTemp(e.target.value)} placeholder="π.χ. 8-15°C" />
                <button type="button" className="btn primary sm" onClick={addTemp} disabled={!newTemp.trim()}>
                  ✓
                </button>
                <button type="button" className="btn ghost sm" onClick={() => setNewTemp(null)}>
                  ✕
                </button>
              </span>
            )}
          </label>
          <label className="st-check">
            <input type="checkbox" checked={!!d.adr} onChange={(e) => set("adr", e.target.checked)} />
            ADR
          </label>
          {d.adr && txt("adr_info", "UN / κλάση", { ph: "UN1170, 3, II" })}
          {txt("value_eur", "Αξία (€)")}
        </div>

        {cargo.length ? (
          <div className="st-tablewrap">
            <table className="st-table lg-cargo">
              <thead>
                <tr>
                  {["Τύπος", "Τεμ.", "Μήκος", "Πλάτος", "Ύψος (cm)", "kg / τεμ.", "Στοιβ.", "Σημείωση", "kg", "m³", "LDM", ""].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cargo.map((l, i) => {
                  const t = lineTotals(l);
                  const inp = (k: "qty" | "l" | "w" | "h" | "kg" | "note", cls = "") => (
                    <input className={cls} value={l[k]} inputMode={k === "note" ? undefined : "decimal"} onChange={(e) => setLine(i, { [k]: e.target.value })} />
                  );
                  return (
                    <tr key={i}>
                      <td>
                        <select
                          value={l.type}
                          onChange={(e) => {
                            const u = unitOf(e.target.value);
                            setLine(i, { type: u.key, ...(u.l ? { l: String(u.l), w: String(u.w) } : {}) });
                          }}
                        >
                          {UNIT_TYPES.map((u) => (
                            <option key={u.key} value={u.key}>
                              {u.gr}
                              {u.l ? ` ${u.l}×${u.w}` : ""}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>{inp("qty", "n")}</td>
                      <td>{inp("l", "n")}</td>
                      <td>{inp("w", "n")}</td>
                      <td>{inp("h", "n")}</td>
                      <td>{inp("kg", "n")}</td>
                      <td>
                        <input type="checkbox" checked={l.stack} onChange={(e) => setLine(i, { stack: e.target.checked })} title="Στοιβαζόμενο" />
                      </td>
                      <td>{inp("note")}</td>
                      <td className="num">{fmn(t.kg)}</td>
                      <td className="num">{fmn(t.vol, 3)}</td>
                      <td className="num">{fmn(t.ldm)}</td>
                      <td>
                        <span className="lg-acts">
                          <button type="button" className="btn ghost sm" title="Αντιγραφή γραμμής" onClick={() => setCargo([...cargo.slice(0, i + 1), { ...l }, ...cargo.slice(i + 1)])}>
                            ⧉
                          </button>
                          <button type="button" className="btn ghost sm" title="Αφαίρεση" onClick={() => setCargo(cargo.filter((_, j) => j !== i))}>
                            ✕
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={8}>
                    <b>Σύνολο:</b> {tot.pallets ? `${fmn(tot.pallets)} παλέτες` : ""}
                    {tot.pallets && tot.packages ? " · " : ""}
                    {tot.packages ? `${fmn(tot.packages)} δέματα` : ""}
                    {tot.stackable === false && cargo.some((l) => l.stack) ? " · μερικώς στοιβαζόμενο" : tot.stackable ? " · στοιβαζόμενο" : " · μη στοιβαζόμενο"}
                  </td>
                  <td className="num">
                    <b>{fmn(tot.kg)}</b>
                  </td>
                  <td className="num">
                    <b>{fmn(tot.vol, 3)}</b>
                  </td>
                  <td className="num">
                    <b>{fmn(tot.ldm)}</b>
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <div className="lg-row">
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
          </div>
        )}
        <span className="st-actions">
          <button type="button" className="btn ghost sm" onClick={() => addLine("eur")}>
            + Παλέτα
          </button>
          <button type="button" className="btn ghost sm" onClick={() => addLine("box")}>
            + Δέμα
          </button>
          <span className="dim lg-small">
            {cargo.length
              ? "Κάθε γραμμή με δικές της διαστάσεις· τα σύνολα (παλέτες, δέματα, kg, m³, LDM) υπολογίζονται αυτόματα. LDM: επιφάνεια / 2,4 m, τα στοιβαζόμενα ανά 2."
              : "Πρόσθεσε γραμμές για ανάλυση ανά τύπο παλέτας / δέμα με διαφορετικές διαστάσεις."}
          </span>
        </span>
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
