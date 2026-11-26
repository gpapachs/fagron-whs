"use client";

import { useEffect, useMemo, useState } from "react";
import AppBar from "@/components/AppBar";
import KpiTiles from "@/components/KpiTiles";
import LivePill from "@/components/LivePill";
import { useColSort } from "@/components/analysis/colSort";
import RfqForm, { emptyRfq } from "@/components/logistics/RfqForm";
import RfqDetail from "@/components/logistics/RfqDetail";
import CarriersTab from "@/components/logistics/CarriersTab";
import { loadLogistics, type LogData } from "@/components/logistics/data";
import { useCoalesced, useWmsLive } from "@/lib/live";
import { dmy, DIR_TXT, MODE_TXT, route, STATUS_TONE, STATUS_TXT, type Direction, type Rfq } from "@/lib/logistics";

type Tab = "open" | "transit" | "done" | "carriers";
const fm = (n: number | null | undefined) => (n == null ? "" : n.toLocaleString("el-GR", { maximumFractionDigits: 2 }));

export default function LogisticsBoard({ userEmail, role }: { userEmail: string | null; role: "admin" | "staff" }) {
  const [data, setData] = useState<LogData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("open");
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState<Direction | null>(null);
  const [q, setQ] = useState("");
  const [dir, setDir] = useState<"" | Direction>("");
  const [flash, setFlash] = useState(0);

  async function load() {
    try {
      setData(await loadLogistics());
    } catch (e) {
      setError(`Η φόρτωση απέτυχε: ${(e as Error).message}`);
    }
  }
  useEffect(() => {
    load();
    // άνοιγμα συγκεκριμένου αιτήματος από το URL (#RFQ-…)
    const h = decodeURIComponent(window.location.hash.slice(1));
    if (h) setSel(h);
  }, []);
  const reload = useCoalesced(() => {
    load();
    setFlash((f) => f + 1);
  }, 600);
  const live = useWmsLive((sig) => {
    if (sig.key === "logistics") reload();
  });

  const rfqs = data?.rfqs ?? [];
  const groups = useMemo(
    () => ({
      open: rfqs.filter((r) => ["draft", "sent", "quoted"].includes(r.status)),
      transit: rfqs.filter((r) => ["awarded", "in_transit"].includes(r.status)),
      done: rfqs.filter((r) => ["delivered", "cancelled"].includes(r.status)),
    }),
    [rfqs]
  );
  const selected = rfqs.find((r) => r.id === sel || r.ref === sel) ?? null;
  const pendingMail = (data?.mails ?? []).filter((m) => m.status === "pending").length;
  const errMail = (data?.mails ?? []).filter((m) => m.status === "error").length;

  const quotesOf = (r: Rfq) => (data?.quotes ?? []).filter((x) => x.rfq_id === r.id);
  const invitesOf = (r: Rfq) => (data?.invites ?? []).filter((x) => x.rfq_id === r.id);
  const best = (r: Rfq) => {
    const qs = quotesOf(r).filter((x) => x.currency === "EUR");
    return qs.length ? Math.min(...qs.map((x) => x.price)) : null;
  };
  const carrierOf = (r: Rfq) => {
    const qq = (data?.quotes ?? []).find((x) => x.id === r.awarded_quote);
    return qq ? data?.carriers.find((c) => c.id === qq.carrier_id)?.name ?? "" : "";
  };

  const ql = q.trim().toUpperCase();
  const list = (tab === "carriers" ? [] : groups[tab]).filter(
    (r) => (!dir || r.direction === dir) && (!ql || [r.ref, r.customer, r.order_ref, r.from_city, r.to_city, r.from_country, r.to_country, r.goods, r.tracking_no].some((x) => x?.toUpperCase().includes(ql)))
  );
  const cs = useColSort<Rfq>(
    [
      { h: "Αίτημα", v: (r) => r.ref },
      { h: "Είδος", v: (r) => r.direction },
      { h: "Διαδρομή", v: (r) => route(r) },
      { h: "Πελάτης / Προμ.", v: (r) => r.customer },
      { h: "Φορτίο", v: (r) => r.pallets ?? r.weight_kg },
      { h: "Φόρτωση", v: (r) => r.pickup_date },
      { h: tab === "open" ? "Απαντήσεις" : "Μεταφορική", v: (r) => (tab === "open" ? quotesOf(r).length : carrierOf(r)) },
      { h: tab === "open" ? "Καλύτερη" : "Κόστος", v: (r) => (tab === "open" ? best(r) : r.final_cost), num: true },
      { h: tab === "transit" ? "ETA" : "Κατάσταση", v: (r) => (tab === "transit" ? r.eta : r.status) },
    ],
    list
  );

  return (
    <>
      <AppBar email={userEmail} role={role} />
      <div className="wrap stock">
        <div className="header">
          <div className="titleblock">
            <h1>Logistics</h1>
            <p>
              <LivePill connected={live.connected} lastAt={live.lastAt} flash={flash} /> Αιτήματα προσφοράς για εισαγωγές και εξαγωγές: αποστολή σε μεταφορικές (email από το Outlook με link
              φόρμας), σύγκριση προσφορών, ανάθεση και παρακολούθηση μέχρι την παράδοση.
            </p>
            {(pendingMail > 0 || errMail > 0) && (
              <p className="dim">
                {pendingMail > 0 && <>✉ {pendingMail} email σε αναμονή αποστολής από το Outlook του υπολογιστή της αποθήκης. </>}
                {errMail > 0 && <span className="dm-r">{errMail} email απέτυχαν — δες το αίτημα.</span>}
              </p>
            )}
          </div>
          <div className="st-actions">
            <button type="button" className="btn primary" onClick={() => (setCreating("export"), setSel(null))}>
              + Εξαγωγή
            </button>
            <button type="button" className="btn primary" onClick={() => (setCreating("import"), setSel(null))}>
              + Εισαγωγή
            </button>
          </div>
        </div>
        {error && (
          <p className="st-error" role="alert">
            {error}
          </p>
        )}

        {creating ? (
          <div className="lg-detail">
            <h2>Νέο αίτημα — {DIR_TXT[creating]}</h2>
            <RfqForm
              initial={emptyRfq(creating)}
              userEmail={userEmail}
              onSaved={(id) => {
                setCreating(null);
                setSel(id);
                setTab("open");
                load();
              }}
              onCancel={() => setCreating(null)}
            />
          </div>
        ) : selected && data ? (
          <RfqDetail key={selected.id + selected.updated_at} rfq={selected} data={data} userEmail={userEmail} onBack={() => setSel(null)} reload={load} />
        ) : (
          <>
            <KpiTiles
              active={tab}
              onPick={(k) => setTab(k as Tab)}
              items={[
                { key: "open", label: "Ανοιχτά αιτήματα", value: groups.open.length, tone: "blue", hint: "Πρόχειρα, σταλμένα, με προσφορές" },
                { key: "transit", label: "Σε εξέλιξη", value: groups.transit.length, tone: "orange", hint: "Ανατεθειμένα και σε μεταφορά" },
                { key: "done", label: "Ολοκληρωμένα", value: groups.done.length, tone: "green", hint: "Παραδόθηκαν ή ακυρώθηκαν" },
                { key: "carriers", label: "Μεταφορικές", value: data?.carriers.filter((c) => c.active).length ?? 0, tone: "neutral", hint: "Μητρώο μεταφορικών" },
              ]}
            />
            {tab === "carriers" ? (
              data && <CarriersTab data={data} userEmail={userEmail} reload={load} />
            ) : (
              <>
                <div className="st-filters an-filters">
                  <label className="field">
                    Αναζήτηση
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="RFQ, πελάτης, πόλη, χώρα, tracking" />
                  </label>
                  <label className="field">
                    Είδος
                    <select value={dir} onChange={(e) => setDir(e.target.value as "" | Direction)}>
                      <option value="">Όλα</option>
                      <option value="export">Εξαγωγές</option>
                      <option value="import">Εισαγωγές</option>
                    </select>
                  </label>
                </div>
                <div className="st-tablewrap">
                  <table className="st-table st-cards lg-list">
                    <thead>
                      <tr>{cs.head}</tr>
                    </thead>
                    <tbody>
                      {cs.sorted.map((r) => {
                        const inv = invitesOf(r);
                        const qs = quotesOf(r);
                        return (
                          <tr key={r.id} onClick={() => setSel(r.id)} className="lg-click">
                            <td data-label="Αίτημα">
                              <b className="mono">{r.ref}</b>
                              <div className="dim">{r.mode ? MODE_TXT[r.mode] ?? r.mode : ""}</div>
                            </td>
                            <td data-label="Είδος">{DIR_TXT[r.direction]}</td>
                            <td data-label="Διαδρομή">{route(r)}</td>
                            <td data-label="Πελάτης">
                              {r.customer}
                              {r.order_ref ? <div className="dim">{r.order_ref}</div> : null}
                            </td>
                            <td data-label="Φορτίο">
                              {[r.pallets ? `${r.pallets} παλ.` : "", r.weight_kg ? `${fm(r.weight_kg)} kg` : "", r.adr ? "ADR" : ""].filter(Boolean).join(" · ")}
                            </td>
                            <td className="mono" data-label="Φόρτωση">{dmy(r.pickup_date)}</td>
                            <td data-label={tab === "open" ? "Απαντήσεις" : "Μεταφορική"}>{tab === "open" ? (inv.length ? `${qs.length} / ${inv.length}` : "—") : carrierOf(r)}</td>
                            <td className="num" data-label={tab === "open" ? "Καλύτερη" : "Κόστος"}>
                              {tab === "open" ? (best(r) != null ? `${fm(best(r))} €` : "") : r.final_cost != null ? `${fm(r.final_cost)} €` : ""}
                            </td>
                            <td data-label="Κατάσταση">
                              {tab === "transit" && r.eta ? <span className="mono">{dmy(r.eta)} </span> : null}
                              <span className={`lg-badge ${STATUS_TONE[r.status]}`}>{STATUS_TXT[r.status]}</span>
                            </td>
                          </tr>
                        );
                      })}
                      {!list.length && (
                        <tr>
                          <td colSpan={9} className="st-empty">
                            {data ? "Κανένα αίτημα εδώ. Ξεκίνα με «+ Εξαγωγή» ή «+ Εισαγωγή»." : "Φόρτωση…"}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
