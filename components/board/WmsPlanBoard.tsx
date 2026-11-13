"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import AppBar from "@/components/AppBar";
import LivePill from "@/components/LivePill";
import { createClient } from "@/lib/supabase/client";
import { fetchAll } from "@/lib/supabase/fetchAll";
import { useCoalesced, useWmsLive } from "@/lib/live";
import { buildPlan, cellMatches, monthsTo, type PlanCell, type PlanRoom, type PosStock, type WmsPos } from "@/lib/wmsPlan";

type StockLine = PosStock & { position: string; area: string | null };
type View = "all" | "occupied" | "free" | "expiring";
const LS = "wmsplan.v1";
const fq = (n: number) => n.toLocaleString("el-GR", { maximumFractionDigits: 3 });
const fexp = (s: string | null) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "");

async function loadStock(): Promise<StockLine[]> {
  const rows = await fetchAll<{ position: string; area: string | null; item: string; description: string | null; lot: string | null; expiry: string | null; qty: number | string }>(
    createClient(),
    "wms_stock_v",
    "position, area, item, description, lot, expiry, qty",
    ["position", "item", "lot"]
  );
  return rows
    .map((r) => ({ position: (r.position ?? "").trim(), area: r.area, item: r.item, description: r.description ?? "", lot: r.lot ?? "", expiry: r.lot ? r.expiry ?? null : r.expiry ?? null, qty: Number(r.qty) || 0 }))
    .filter((r) => r.qty > 0 && r.position);
}
/** ενεργές θέσεις του WMS (οι ανενεργές φαίνονται μόνο αν έχουν απόθεμα) */
async function loadPositions(): Promise<WmsPos[]> {
  const sb = createClient();
  const out: WmsPos[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("wms_positions").select("code, descr").eq("attrs->>isActive", "true").order("code").range(from, from + 999);
    if (error) return out;
    out.push(...((data ?? []) as WmsPos[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** θέσεις που απενεργοποιήθηκαν στην εφαρμογή (το WMS δεν αλλάζει) */
async function loadDisabled(): Promise<Set<string>> {
  const rows = await fetchAll<{ code: string }>(createClient(), "position_disabled", "code", ["code"]).catch(() => [] as { code: string }[]);
  return new Set(rows.map((r) => r.code));
}

const expSoon = (c: PlanCell) => c.stock.some((s) => {
  const m = monthsTo(s.expiry);
  return m != null && m < 6;
});

export default function WmsPlanBoard({ userEmail, role, onManual }: { userEmail: string | null; role: "admin" | "staff"; onManual: () => void }) {
  const [positions, setPositions] = useState<WmsPos[] | null>(null);
  const [stock, setStock] = useState<StockLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(0);
  const [room, setRoom] = useState<string>("");
  const [view, setView] = useState<View>("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<PlanCell | null>(null);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [allLoose, setAllLoose] = useState<Set<string>>(new Set());
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [showDisabled, setShowDisabled] = useState(false);
  const [selMode, setSelMode] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const isAdmin = role === "admin";

  useEffect(() => {
    try {
      const s = JSON.parse(window.localStorage.getItem(LS) ?? "{}");
      if (typeof s.room === "string") setRoom(s.room);
      if (s.view) setView(s.view);
    } catch {
      /* τίποτα */
    }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(LS, JSON.stringify({ room, view }));
    } catch {
      /* τίποτα */
    }
  }, [room, view]);

  useEffect(() => {
    Promise.all([loadPositions(), loadStock(), loadDisabled()])
      .then(([p, s, d]) => {
        setPositions(p);
        setStock(s);
        setDisabled(d);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const what = useRef({ stock: false, positions: false });
  const flush = useCoalesced(async () => {
    const w = what.current;
    what.current = { stock: false, positions: false };
    try {
      if (w.positions) {
        setPositions(await loadPositions());
        setDisabled(await loadDisabled());
      }
      if (w.stock) setStock(await loadStock());
      setFlash((x) => x + 1);
    } catch {
      /* επόμενο σήμα */
    }
  }, 2500);
  const live = useWmsLive((sig) => {
    if (sig.key === "stock" || sig.key === "stock_full") what.current.stock = true;
    else if (sig.key === "positions") what.current.positions = true;
    else return;
    flush();
  });

  // απενεργοποιημένες: έξω από το πλάνο (εκτός αν «εμφάνιση» ή αν έχουν απόθεμα)
  const plan = useMemo<PlanRoom[]>(
    () => (positions && stock ? buildPlan(showDisabled ? positions : positions.filter((p) => !disabled.has(p.code)), stock) : []),
    [positions, stock, disabled, showDisabled]
  );
  const t = q.trim().toLowerCase();
  // κωδικός θέσης -> κελί, και είδος -> θέσεις (για «βρίσκεται και σε»)
  const cellByCode = useMemo(() => {
    const m = new Map<string, PlanCell>();
    for (const r of plan) {
      for (const a of r.aisles) for (const k of a.racks) for (const l of k.levels) for (const c of l.cells) m.set(c.code, c);
      for (const c of r.loose) m.set(c.code, c);
    }
    return m;
  }, [plan]);
  const posByItem = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const sl of stock ?? []) {
      const list = m.get(sl.item) ?? [];
      if (!list.includes(sl.position)) list.push(sl.position);
      m.set(sl.item, list);
    }
    return m;
  }, [stock]);
  const tot = useMemo(() => {
    const rs = plan.filter((r) => !room || r.room === room);
    const total = rs.reduce((n, r) => n + r.total, 0);
    const occ = rs.reduce((n, r) => n + r.occupied, 0);
    return { total, occ, free: total - occ, pct: total ? Math.round((occ / total) * 100) : 0 };
  }, [plan, room]);

  const visibleCell = (c: PlanCell) =>
    (view === "all" || (view === "occupied" && c.stock.length > 0) || (view === "free" && !c.stock.length) || (view === "expiring" && expSoon(c))) && cellMatches(c, t);
  const hits = useMemo(() => {
    if (!t) return null;
    let n = 0;
    for (const r of plan) {
      if (room && r.room !== room) continue;
      for (const a of r.aisles) for (const k of a.racks) for (const l of k.levels) n += l.cells.filter((c) => cellMatches(c, t) && c.stock.length).length;
      n += r.loose.filter((c) => cellMatches(c, t) && c.stock.length).length;
    }
    return n;
  }, [plan, t, room]);

  const noMaster = positions != null && positions.length === 0;
  const cellCls = (c: PlanCell) =>
    ["cell", "wp-cell", c.stock.length ? "occupied" : "free", disabled.has(c.code) ? "off" : "", picked.has(c.code) ? "picked" : "", expSoon(c) ? "exp" : "", visibleCell(c) ? "" : "dim", t && cellMatches(c, t) && c.stock.length ? "match" : "", sel?.code === c.code ? "selected" : ""]
      .filter(Boolean)
      .join(" ");
  const tip = (c: PlanCell) =>
    `${c.code}${disabled.has(c.code) ? " · ΑΠΕΝΕΡΓΟΠΟΙΗΜΕΝΗ" : ""}${c.area ? ` · ${c.area}` : ""}${c.stock.length ? `\n${c.stock.map((s) => `${s.item} ${fq(s.qty)}${s.lot ? ` · ${s.lot}` : ""}`).join("\n")}` : "\nελεύθερη"}`;

  const onCell = (c: PlanCell) => {
    if (!selMode) return setSel(c);
    setPicked((cur) => {
      const n = new Set(cur);
      if (n.has(c.code)) n.delete(c.code);
      else n.add(c.code);
      return n;
    });
  };
  /** επιλογή όλων των ορατών (με τα τρέχοντα φίλτρα) κελιών μιας ομάδας· ξανά = αποεπιλογή */
  const pickMany = (cells: PlanCell[]) => {
    const codes = cells.filter(visibleCell).map((c) => c.code);
    setPicked((cur) => {
      const n = new Set(cur);
      const all = codes.length > 0 && codes.every((x) => n.has(x));
      for (const x of codes) {
        if (all) n.delete(x);
        else n.add(x);
      }
      return n;
    });
  };
  const roomCells = (r: PlanRoom) => [...r.aisles.flatMap((a) => a.racks.flatMap((k) => k.levels.flatMap((l) => l.cells))), ...r.loose];
  async function applyDisabled(off: boolean) {
    const codes = [...picked];
    if (!codes.length) return;
    const withStock = codes.filter((x) => cellByCode.get(x)?.stock.length).length;
    if (
      off &&
      !window.confirm(
        `Απενεργοποίηση ${codes.length} θέσεων στην εφαρμογή;${withStock ? `\n\nΠροσοχή: ${withStock} από αυτές έχουν απόθεμα — θα συνεχίσουν να φαίνονται όσο έχουν απόθεμα.` : ""}\n\nΤο WMS δεν αλλάζει.`
      )
    )
      return;
    setBusy(true);
    setNotice(null);
    const { error: e } = await createClient().rpc("positions_set_disabled", { p_codes: codes, p_disabled: off });
    setBusy(false);
    if (e) return setNotice({ tone: "error", text: `Δεν έγινε: ${e.message}` });
    setDisabled((cur) => {
      const n = new Set(cur);
      for (const x of codes) {
        if (off) n.add(x);
        else n.delete(x);
      }
      return n;
    });
    setPicked(new Set());
    setNotice({ tone: "ok", text: `${off ? "Απενεργοποιήθηκαν" : "Ενεργοποιήθηκαν"} ${codes.length} θέσεις.` });
  }

  return (
    <>
      <AppBar email={userEmail} role={role} />
      <div className="wrap">
        <div className="header">
          <div className="titleblock">
            <h1>Πλάνο Αποθήκης</h1>
            <p>
              <LivePill connected={live.connected} lastAt={live.lastAt} flash={flash} /> Όλες οι θέσεις του WMS ανά χώρο, διάδρομο, ραφιέρα και επίπεδο, με το απόθεμα τώρα.
              Πατήστε μια θέση για να δείτε τι έχει.
            </p>
            <button type="button" className="rp-link" onClick={onManual}>
              Παλιό χειροκίνητο πλάνο (E01–E12)
            </button>
          </div>
          <div className="stats">
            <div className="stat total">
              <div className="n">{fq(tot.total)}</div>
              <div className="l">Θέσεις</div>
            </div>
            <div className="stat occupied">
              <div className="n">{fq(tot.occ)}</div>
              <div className="l">Με απόθεμα</div>
            </div>
            <div className="stat free">
              <div className="n">{fq(tot.free)}</div>
              <div className="l">Ελεύθερες</div>
            </div>
            <div className="stat">
              <div className="n">{tot.pct}%</div>
              <div className="l">Πληρότητα</div>
            </div>
          </div>
        </div>

        {error && <p className="rp-notice error">Το πλάνο δεν φορτώθηκε: {error}</p>}
        {noMaster && (
          <p className="rp-notice warn">
            Δεν έχουν έρθει ακόμη όλες οι θέσεις του WMS από τον συγχρονισμό — φαίνονται μόνο όσες έχουν απόθεμα. Οι άδειες θέσεις θα εμφανιστούν μόλις τρέξει (σε λίγα λεπτά).
          </p>
        )}

        <div className="st-filters wp-filters">
          <label className="field">
            Αναζήτηση
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="κωδικός είδους, περιγραφή, παρτίδα ή θέση" />
          </label>
          <div className="wp-views" role="group" aria-label="Προβολή">
            {(
              [
                ["all", "Όλες"],
                ["occupied", "Με απόθεμα"],
                ["free", "Ελεύθερες"],
                ["expiring", "Λήξη < 6μ"],
              ] as [View, string][]
            ).map(([k, l]) => (
              <button key={k} type="button" className={`sl-chip ${view === k ? "on" : ""}`} aria-pressed={view === k} onClick={() => setView(k)}>
                {l}
              </button>
            ))}
          </div>
          {hits != null && <span className="dim">{hits} θέσεις με «{q.trim()}»</span>}
          {isAdmin && (
            <span className="wp-admin">
              <label className="st-check">
                <input type="checkbox" checked={showDisabled} onChange={(e) => setShowDisabled(e.target.checked)} /> Εμφάνιση απενεργοποιημένων ({disabled.size})
              </label>
              <button
                type="button"
                className={`btn ${selMode ? "primary" : "ghost"} sm`}
                onClick={() => {
                  setSelMode((x) => !x);
                  setPicked(new Set());
                }}
              >
                {selMode ? "Τέλος επιλογής" : "Μαζική επιλογή"}
              </button>
            </span>
          )}
        </div>
        {notice && <p className={`rp-notice ${notice.tone}`}>{notice.text}</p>}
        {selMode && (
          <p className="rp-hint">
            Πατήστε θέσεις για να τις επιλέξετε, ή «επιλογή» σε χώρο / διάδρομο / ραφιέρα (με τα τρέχοντα φίλτρα — π.χ. «Ελεύθερες» για να πάρει μόνο τις άδειες).
          </p>
        )}

        <div className="wp-rooms" role="group" aria-label="Χώροι">
          <button type="button" className={`wp-chip ${room === "" ? "on" : ""}`} onClick={() => setRoom("")}>
            Όλοι οι χώροι <span>{plan.length}</span>
          </button>
          {plan.map((r) => (
            <button key={r.room} type="button" className={`wp-chip ${room === r.room ? "on" : ""}`} onClick={() => setRoom(room === r.room ? "" : r.room)} title={r.areas.map((a) => `${a.area} (${a.n})`).join("\n")}>
              <b>{r.room}</b> {r.name} <span>{r.occupied}/{r.total}</span>
            </button>
          ))}
        </div>

        {!positions || !stock ? (
          <p className="rp-hint">Φόρτωση θέσεων και αποθέματος…</p>
        ) : (
          <div className="board">
            {plan
              .filter((r) => !room || r.room === room)
              .map((r) => {
                const isClosed = closed.has(r.room) && room !== r.room;
                const pct = r.total ? Math.round((r.occupied / r.total) * 100) : 0;
                return (
                  <section className="corridor wp-room" key={r.room}>
                    <button
                      type="button"
                      className="chead wp-head"
                      onClick={() =>
                        setClosed((cur) => {
                          const n = new Set(cur);
                          if (n.has(r.room)) n.delete(r.room);
                          else n.add(r.room);
                          return n;
                        })
                      }
                      aria-expanded={!isClosed}
                    >
                      <div className="name">{r.room}</div>
                      <span className="wp-name">{r.name}</span>
                      {r.areas.slice(1, 5).map((a) => (
                        <span key={a.area} className="zone-tag" title={`${a.n} θέσεις`}>
                          {a.area}
                        </span>
                      ))}
                      {r.areas.length > 5 && <span className="zone-tag">+{r.areas.length - 5}</span>}
                      <div className="meter">{r.occupied > 0 && <i style={{ width: `${pct}%`, background: "var(--occupied)" }} />}</div>
                      <div className="pct">
                        {r.occupied}/{r.total} · {pct}%
                      </div>
                      <span className="sh-caret">{isClosed ? "▸" : "▾"}</span>
                    </button>
                    {!isClosed && (
                      <>
                        {selMode && (
                          <div>
                            <button type="button" className="rp-link" onClick={() => pickMany(roomCells(r))}>
                              Επιλογή όλου του χώρου {r.room}
                            </button>
                          </div>
                        )}
                        {r.aisles.map((a) => (
                          <div className="wp-aisle" key={a.aisle}>
                            <div className="wp-aisle-h">
                              Διάδρομος {a.aisle} <span className="dim">· {a.occupied}/{a.total}</span>
                              {selMode && (
                                <button type="button" className="rp-link" onClick={() => pickMany(a.racks.flatMap((k) => k.levels.flatMap((l) => l.cells)))}>
                                  επιλογή διαδρόμου
                                </button>
                              )}
                            </div>
                            <div className="cols">
                              {a.racks.map((k) => (
                                <div className="colgroup" key={k.rack}>
                                  {selMode ? (
                                    <button type="button" className="collabel wp-pickrack" title="Επιλογή ραφιέρας" onClick={() => pickMany(k.levels.flatMap((l) => l.cells))}>
                                      Ρ.{k.rack} ☐
                                    </button>
                                  ) : (
                                    <div className="collabel">Ρ.{k.rack}</div>
                                  )}
                                  <div className="rows">
                                    {k.levels.map((l) => (
                                      <div className="rowline" key={l.level}>
                                        {l.cells.map((c) => (
                                          <button type="button" key={c.code} className={cellCls(c)} title={tip(c)} onClick={() => onCell(c)}>
                                            {c.code}
                                          </button>
                                        ))}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                        {r.loose.length > 0 && (() => {
                          // πολλές «χύμα» θέσεις (π.χ. 900 θέσεις picking): δείχνουμε όσες έχουν απόθεμα + πλήθος
                          const many = r.loose.length > 60 && !allLoose.has(r.room);
                          const list = many ? r.loose.filter((c) => c.stock.length || (t && cellMatches(c, t))) : r.loose;
                          return (
                          <div className="wp-aisle">
                            <div className="wp-aisle-h">
                              Άλλες θέσεις <span className="dim">· {r.loose.filter((c) => c.stock.length).length}/{r.loose.length}</span>
                              {r.loose.length > 60 && (
                                <button type="button" className="rp-link" onClick={() => setAllLoose((cur) => { const n = new Set(cur); if (n.has(r.room)) n.delete(r.room); else n.add(r.room); return n; })}>
                                  {many ? `εμφάνιση και των ${r.loose.length - list.length} ελεύθερων` : "μόνο με απόθεμα"}
                                </button>
                              )}
                            </div>
                            <div className="special-pills">
                              {list.map((c) => (
                                <button type="button" key={c.code} className={`special-pill ${cellCls(c).replace("cell wp-cell", "")}`} title={tip(c)} onClick={() => onCell(c)}>
                                  {c.code}
                                </button>
                              ))}
                            </div>
                          </div>
                          );
                        })()}
                      </>
                    )}
                  </section>
                );
              })}
          </div>
        )}

        {selMode && (
          <div className="wp-bulk" role="region" aria-label="Μαζικές ενέργειες">
            <b>{picked.size}</b> επιλεγμένες
            <button type="button" className="btn primary sm" disabled={!picked.size || busy} onClick={() => applyDisabled(true)}>
              Απενεργοποίηση
            </button>
            <button type="button" className="btn ghost sm" disabled={!picked.size || busy} onClick={() => applyDisabled(false)}>
              Ενεργοποίηση
            </button>
            <button type="button" className="btn ghost sm" disabled={!picked.size} onClick={() => setPicked(new Set())}>
              Καθαρισμός
            </button>
            <span className="dim">Μόνο στην εφαρμογή — το WMS δεν αλλάζει</span>
          </div>
        )}

        <div className="legend">
          <span>
            <i style={{ background: "var(--occupied-bg)", border: "1px solid var(--occupied)" }} /> με απόθεμα
          </span>
          <span>
            <i style={{ background: "var(--free-bg)", border: "1px solid var(--free)" }} /> ελεύθερη
          </span>
          <span>
            <i style={{ boxShadow: "inset 0 0 0 2px #d97706" }} /> λήξη &lt; 6 μήνες
          </span>
          <span>Στήλες = ραφιέρες (Ρ.), γραμμές = επίπεδα (ψηλότερο επάνω)</span>
        </div>
      </div>

      {sel && (
        <div className="wp-panel-bg" onClick={() => setSel(null)}>
          <aside className="wp-panel" role="dialog" aria-label={`Θέση ${sel.code}`} onClick={(e) => e.stopPropagation()}>
            <div className="wp-panel-h">
              <div>
                <div className="wp-code">{sel.code}</div>
                <div className="dim">{sel.area || "—"}</div>
              </div>
              <button type="button" className="btn ghost sm" onClick={() => setSel(null)}>
                Κλείσιμο
              </button>
            </div>
            {sel.stock.length ? (
              <table className="st-table wp-ptable">
                <thead>
                  <tr>
                    <th>Είδος</th>
                    <th>Παρτίδα</th>
                    <th>Λήξη</th>
                    <th className="num">Ποσ.</th>
                  </tr>
                </thead>
                <tbody>
                  {sel.stock.map((s, i) => {
                    const m = monthsTo(s.expiry);
                    return (
                      <tr key={i}>
                        <td>
                          <b>{s.item}</b>
                          <div className="dim">{s.description}</div>
                        </td>
                        <td>{s.lot || "—"}</td>
                        <td className={m != null && m < 6 ? "wp-exp" : ""}>{fexp(s.expiry) || "—"}</td>
                        <td className="num">
                          <b>{fq(s.qty)}</b>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="rp-hint">Ελεύθερη θέση — χωρίς απόθεμα στο WMS.</p>
            )}
            {[...new Set(sel.stock.map((x) => x.item))].map((item) => {
              const others = (posByItem.get(item) ?? []).filter((p) => p !== sel.code).sort();
              if (!others.length) return null;
              return (
                <div key={item} className="wp-others">
                  <div className="dim">
                    Το <b>{item}</b> βρίσκεται και σε {others.length} {others.length === 1 ? "θέση" : "θέσεις"}:
                  </div>
                  <div className="special-pills">
                    {others.slice(0, 24).map((p) => (
                      <button key={p} type="button" className="special-pill occupied" onClick={() => cellByCode.get(p) && setSel(cellByCode.get(p) as PlanCell)}>
                        {p}
                      </button>
                    ))}
                    {others.length > 24 && <span className="dim">+{others.length - 24}</span>}
                  </div>
                </div>
              );
            })}
          </aside>
        </div>
      )}
    </>
  );
}
