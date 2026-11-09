"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import AppBar from "@/components/AppBar";
import LivePill from "@/components/LivePill";
import { createClient } from "@/lib/supabase/client";
import { useCoalesced, useWmsLive } from "@/lib/live";
import { fullDate, relDate } from "@/lib/format";
import { displayUser } from "@/lib/users";
import type { OrderRow } from "@/lib/exports";
import { siteOf, type Site, type SiteFilter } from "@/lib/site";
import { loadAssignments, type Assignments } from "@/lib/assignments";
import { AssignBadge } from "@/components/AssignControls";

// Pick list για κινητό / tablet: ο χρήστης διαλέγει λίστα από τις εκτελεσμένες (SALEXPORTCL) και
// τσεκάρει ό,τι βγάζει. Το τσεκάρισμα είναι το ίδιο «Collected» της καρτέλας Εκτελεσμένες
// (wms_orders_set_collected) — φαίνεται αμέσως σε όλες τις συσκευές.

const COLS =
  "id, order_id, list_no, doc_type, doc_no, erp_code, order_date, customer, item, description, lot, sn, qty, init_qty, from_pos, to_pos, wms_status, line_no, collected, collected_at, collected_by, picker, comments";
type Range = "today" | "yesterday" | "7" | "30";
type ListCard = { list: string; customer: string; date: string | null; lines: number; done: number; picker: string; doc: string };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fq = (n: number | null) => (n == null ? "" : n.toLocaleString("el-GR", { maximumFractionDigits: 3 }));
const posKey = (p: string | null) => (p ?? "").replace(/\d+/g, (d) => d.padStart(4, "0"));

/** γρήγορες επιλογές -> [από, έως] (συμπεριλαμβάνονται και οι δύο ημέρες) */
function rangeOf(r: Range): [string, string] {
  const t = new Date();
  const d = (n: number) => iso(new Date(t.getFullYear(), t.getMonth(), t.getDate() - n));
  if (r === "yesterday") return [d(1), d(1)];
  if (r === "7") return [d(6), d(0)];
  if (r === "30") return [d(29), d(0)];
  return [d(0), d(0)];
}

export default function PickBoard({ userEmail, role }: { userEmail: string | null; role: "admin" | "staff" }) {
  const [list, setList] = useState<string | null>(null);
  const [dFrom, setDFrom] = useState(() => rangeOf("today")[0]);
  const [dTo, setDTo] = useState(() => rangeOf("today")[1]);
  const setRange = (r: Range) => {
    const [a, b] = rangeOf(r);
    setDFrom(a);
    setDTo(b);
  };
  const range = (["today", "yesterday", "7", "30"] as Range[]).find((r) => rangeOf(r)[0] === dFrom && rangeOf(r)[1] === dTo) ?? null;
  const [selL, setSelL] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [find, setFind] = useState("");
  const [lists, setLists] = useState<ListCard[] | null>(null);
  const [lines, setLines] = useState<OrderRow[] | null>(null);
  const [hideDone, setHideDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ text: string; ok: boolean } | null>(null);
  const [scan, setScan] = useState("");
  // αποθήκη συσκευής: π.χ. το tablet του Μεγαλοχωρίου μένει στην «Εξωτερική»
  const [siteF, setSiteFState] = useState<SiteFilter>("all");
  const [allRows, setAllRows] = useState<OrderRow[]>([]);
  const [assign, setAssign] = useState<Assignments>(new Map());
  const [withUnassigned, setWithUnassigned] = useState(false); // + λίστες χωρίς ανάθεση με θέσεις της αποθήκης
  const [doneF, setDoneF] = useState<"open" | "done" | "all">("open");
  const aSite = (doc: string | null | undefined): Site | null => (doc ? assign.get(doc)?.site ?? null : null);
  // γραμμή που αφορά την αποθήκη της συσκευής: ανατέθηκε εκεί όλη η λίστα, ή (χωρίς ανάθεση) η θέση είναι εκεί
  const rowIn = (r: OrderRow, site: SiteFilter, unassigned: boolean) => {
    if (site === "all") return true;
    const a = aSite(r.doc_no);
    if (a) return a === site;
    return unassigned && siteOf(r.from_pos) === site;
  };
  useEffect(() => {
    try {
      const v = window.localStorage.getItem("pick.site");
      if (v === "central" || v === "external") setSiteFState(v);
    } catch {
      /* τίποτα */
    }
  }, []);
  const setSiteF = (v: SiteFilter) => {
    setSiteFState(v);
    try {
      window.localStorage.setItem("pick.site", v);
    } catch {
      /* τίποτα */
    }
  };
  const scanRef = useRef<HTMLInputElement>(null);

  // ?list=544527 για άμεσο άνοιγμα (π.χ. από την καρτέλα Εκτελεσμένες)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("list");
    if (p) setList(p);
    const onPop = () => setList(new URLSearchParams(window.location.search).get("list"));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const openList = (l: string | null) => {
    const u = new URL(window.location.href);
    if (l) u.searchParams.set("list", l);
    else u.searchParams.delete("list");
    window.history.pushState(null, "", u.toString());
    setList(l);
    setScan("");
    setFlash(null);
  };

  async function loadLists(silent = false) {
    if (!silent) setLists(null);
    setError(null);
    const a = new Date(`${dFrom || dTo}T00:00:00`);
    const b = new Date(new Date(`${dTo || dFrom}T00:00:00`).getTime() + 86400000);
    if (!(a < b)) {
      setLists([]);
      setAllRows([]);
      return setError("Η ημερομηνία «από» είναι μετά την «έως».");
    }
    const sb = createClient();
    const out: OrderRow[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb
        .from("wms_orders_v")
        .select("id, list_no, customer, order_date, collected, picker, doc_no, from_pos")
        .eq("doc_type", "SALEXPORTCL")
        .gte("order_date", a.toISOString())
        .lt("order_date", b.toISOString())
        .order("order_date", { ascending: false })
        .range(from, from + 999);
      if (error) return setError(`Οι λίστες δεν φορτώθηκαν: ${error.message}`);
      out.push(...((data as OrderRow[]) ?? []));
      if (!data || data.length < 1000) break;
    }
    setAllRows(out);
    setAssign(await loadAssignments(out.map((r) => r.doc_no)));
    setLists([]);
  }
  const lists2 = useMemo(() => {
    if (!lists) return null;
    const m = new Map<string, ListCard>();
    for (const r of allRows) {
      if (!rowIn(r, siteF, withUnassigned)) continue;
      const k = r.list_no ?? "";
      const c = m.get(k) ?? { list: k, customer: r.customer ?? "", date: r.order_date, lines: 0, done: 0, picker: r.picker ?? "", doc: r.doc_no ?? "" };
      c.lines++;
      if (r.collected) c.done++;
      m.set(k, c);
    }
    return [...m.values()]
      .filter((c) => doneF === "all" || (doneF === "done" ? c.done === c.lines : c.done < c.lines))
      .sort((x, y) => (x.done === x.lines ? 1 : 0) - (y.done === y.lines ? 1 : 0) || (y.date ?? "").localeCompare(x.date ?? ""));
  }, [lists, allRows, siteF, withUnassigned, doneF, assign]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadLines(l: string, silent = false) {
    if (!silent) setLines(null);
    setError(null);
    const { data, error } = await createClient().from("wms_orders_v").select(COLS).eq("doc_type", "SALEXPORTCL").eq("list_no", l).order("line_no");
    if (error) return setError(`Η λίστα δεν φορτώθηκε: ${error.message}`);
    const ls = ((data as OrderRow[]) ?? []).map((r) => ({ ...r, qty: r.qty == null ? null : Number(r.qty), init_qty: r.init_qty == null ? null : Number(r.init_qty) }));
    setAssign(await loadAssignments(ls.map((r) => r.doc_no)));
    setLines(ls);
  }

  useEffect(() => {
    if (list) loadLines(list);
    else loadLists();
  }, [list, dFrom, dTo]); // eslint-disable-line react-hooks/exhaustive-deps

  // αλλαγές από άλλες συσκευές / το sync
  const refresh = useCoalesced(() => (list ? loadLines(list, true) : loadLists(true)), 1200);
  const live = useWmsLive((sig) => {
    if (sig.key === "orders" || sig.key === "orders_sync") refresh();
  });

  async function setCollected(ids: string[], value: boolean) {
    if (!ids.length) return;
    const prev = lines;
    const now = new Date().toISOString();
    setLines((cur) => (cur ?? []).map((r) => (ids.includes(r.id) ? { ...r, collected: value, collected_at: value ? now : null, collected_by: value ? userEmail ?? "" : "" } : r)));
    const { error } = await createClient().rpc("wms_orders_set_collected", { p_ids: ids, p_value: value });
    if (error) {
      setLines(prev);
      setFlash({ text: `Δεν αποθηκεύτηκε: ${error.message}`, ok: false });
    }
  }

  // μαζικό collected / not collected για τις επιλεγμένες λίστες (μόνο οι γραμμές της αποθήκης της συσκευής)
  async function bulkCollected(value: boolean) {
    const ids = allRows.filter((r) => selL.has(r.list_no ?? "") && rowIn(r, siteF, withUnassigned)).map((r) => r.id);
    if (!ids.length) return;
    if (!window.confirm(`${value ? "Collected" : "Not collected"} για ${ids.length} γραμμές σε ${selL.size} λίστες;`)) return;
    setBulkBusy(true);
    const sb = createClient();
    let err: string | null = null;
    for (let i = 0; i < ids.length && !err; i += 500) {
      const { error } = await sb.rpc("wms_orders_set_collected", { p_ids: ids.slice(i, i + 500), p_value: value });
      if (error) err = error.message;
    }
    setBulkBusy(false);
    if (err) setError(`Δεν αποθηκεύτηκε: ${err}`);
    setSelL(new Set());
    loadLists(true);
  }

  // σάρωση: κωδικός είδους ή DataMatrix ετικέτας (κωδικός#παρτίδα#serial#ποσότητα)
  function onScan(e: React.FormEvent) {
    e.preventDefault();
    const raw = scan.trim();
    setScan("");
    if (!raw || !lines) return;
    const [code, lot, sn] = raw.split("#").map((x) => (x ?? "").trim().toUpperCase());
    const cand = siteLines.filter(
      (r) => (r.item ?? "").toUpperCase() === code && (!lot || !r.lot || r.lot.toUpperCase() === lot) && (!sn || !r.sn || r.sn.toUpperCase() === sn)
    );
    const open = cand.find((r) => !r.collected);
    if (open) {
      setCollected([open.id], true);
      setFlash({ text: `✓ ${open.item}${open.lot ? ` · ${open.lot}` : ""} — ${fq(open.qty ?? open.init_qty)}`, ok: true });
    } else if (cand.length) setFlash({ text: `${code}: όλες οι γραμμές είναι ήδη τσεκαρισμένες`, ok: false });
    else setFlash({ text: `${code}${lot ? ` · ${lot}` : ""}: δεν υπάρχει στη λίστα`, ok: false });
    scanRef.current?.focus();
  }

  const siteLines = useMemo(() => (lines ?? []).filter((r) => rowIn(r, siteF, true)), [lines, siteF, assign]); // eslint-disable-line react-hooks/exhaustive-deps
  const sorted = useMemo(
    () => [...siteLines].sort((a, b) => Number(a.collected) - Number(b.collected) || posKey(a.from_pos).localeCompare(posKey(b.from_pos)) || (a.line_no ?? 0) - (b.line_no ?? 0)),
    [siteLines]
  );
  const shown = hideDone ? sorted.filter((r) => !r.collected) : sorted;
  const done = siteLines.filter((r) => r.collected).length;
  const total = siteLines.length;
  const otherSite = (lines?.length ?? 0) - total;
  const head = lines?.[0];
  const shownLists = (lists2 ?? []).filter((c) => {
    const t = find.trim().toLowerCase();
    return !t || c.list.includes(t) || c.customer.toLowerCase().includes(t) || c.doc.toLowerCase().includes(t);
  });

  return (
    <>
      <AppBar email={userEmail} role={role} />
      <div className="wrap pk">
        {!list ? (
          <>
            <div className="pk-top">
              <div>
                <h1>Pick list</h1>
                <p className="dim">Διάλεξε λίστα εκτελεσμένης παραγγελίας και τσέκαρε ό,τι βγάζεις.</p>
              </div>
              <LivePill connected={live.connected} lastAt={live.lastAt} />
            </div>
            <div className="pk-ranges pk-sites" role="group" aria-label="Αποθήκη">
              {(
                [
                  ["all", "Όλες"],
                  ["central", "Κεντρική"],
                  ["external", "Εξωτερική"],
                ] as const
              ).map(([k, l]) => (
                <button key={k} type="button" className={`pk-chip ${siteF === k ? "on" : ""}`} onClick={() => setSiteF(k)}>
                  {l}
                </button>
              ))}
            </div>
            <div className="pk-ranges pk-sites" role="group" aria-label="Συλλογή">
              {(
                [
                  ["open", "Εκκρεμούν"],
                  ["done", "Συλλέχθηκαν"],
                  ["all", "Όλες"],
                ] as const
              ).map(([k, l]) => (
                <button key={k} type="button" className={`pk-chip ${doneF === k ? "on" : ""}`} onClick={() => setDoneF(k)}>
                  {l}
                </button>
              ))}
            </div>
            {siteF !== "all" && (
              <label className="st-check pk-unassigned">
                <input type="checkbox" checked={withUnassigned} onChange={(e) => setWithUnassigned(e.target.checked)} />
                Και λίστες χωρίς ανάθεση με θέσεις {siteF === "external" ? "της εξωτερικής" : "της κεντρικής"}
              </label>
            )}
            <div className="pk-ranges">
              {(
                [
                  ["today", "Σήμερα"],
                  ["yesterday", "Χθες"],
                  ["7", "7 ημ."],
                  ["30", "30 ημ."],
                ] as const
              ).map(([k, l]) => (
                <button key={k} type="button" className={`pk-chip ${range === k ? "on" : ""}`} onClick={() => setRange(k)}>
                  {l}
                </button>
              ))}
            </div>
            <div className="pk-dates">
              <label>
                Από
                <input type="date" value={dFrom} onChange={(e) => setDFrom(e.target.value)} />
              </label>
              <label>
                Έως
                <input type="date" value={dTo} onChange={(e) => setDTo(e.target.value)} />
              </label>
            </div>
            <input className="pk-find" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Αριθμός λίστας, πελάτης ή παραστατικό…" inputMode="search" />
            <form
              className="pk-open"
              onSubmit={(e) => {
                e.preventDefault();
                const v = find.trim();
                if (/^\d+$/.test(v)) openList(v);
              }}
            >
              {/^\d+$/.test(find.trim()) && !shownLists.some((c) => c.list === find.trim()) && (
                <button type="submit" className="btn primary">
                  Άνοιγμα λίστας {find.trim()}
                </button>
              )}
            </form>
            {error && <p className="rp-notice error">{error}</p>}
            {lists === null && !error && <p className="dim">Φόρτωση…</p>}
            {lists2 && !shownLists.length && <p className="dim">Καμία λίστα σε αυτό το διάστημα{siteF !== "all" ? " για αυτή την αποθήκη" : ""}.</p>}
            {shownLists.length > 0 && (
              <div className="pk-bulk">
                <label className="st-check">
                  <input
                    type="checkbox"
                    checked={shownLists.every((c) => selL.has(c.list))}
                    onChange={(e) => setSelL(e.target.checked ? new Set(shownLists.map((c) => c.list)) : new Set())}
                  />
                  Επιλογή όλων ({shownLists.length})
                </label>
                {selL.size > 0 && (
                  <span className="pk-bulk-btns">
                    <span className="dim">{selL.size} λίστες</span>
                    <button type="button" className="btn sm or-c1" disabled={bulkBusy} onClick={() => bulkCollected(true)}>
                      Collected
                    </button>
                    <button type="button" className="btn ghost sm" disabled={bulkBusy} onClick={() => bulkCollected(false)}>
                      Not collected
                    </button>
                  </span>
                )}
              </div>
            )}
            <div className="pk-lists">
              {shownLists.map((c) => {
                const pct = c.lines ? Math.round((c.done / c.lines) * 100) : 0;
                return (
                  <button key={c.list} type="button" className={`pk-card ${c.done === c.lines ? "done" : c.done ? "part" : ""} ${selL.has(c.list) ? "sel" : ""}`} onClick={() => openList(c.list)}>
                    <span className="pk-card-top">
                      <span className="pk-sel" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selL.has(c.list)}
                          aria-label={`Επιλογή λίστας ${c.list}`}
                          onChange={(e) =>
                            setSelL((cur) => {
                              const n = new Set(cur);
                              if (e.target.checked) n.add(c.list);
                              else n.delete(c.list);
                              return n;
                            })
                          }
                        />
                        <b className="pk-list">{c.list}</b>
                      </span>
                      <span className="pk-count">
                        {c.done}/{c.lines}
                      </span>
                    </span>
                    <span className="pk-cust">
                      {c.customer}
                      <AssignBadge a={c.doc ? assign.get(c.doc) : undefined} />
                    </span>
                    <span className="pk-meta">
                      {relDate(c.date)}
                      {c.picker && ` · ${c.picker}`}
                    </span>
                    <span className="pk-bar">
                      <i style={{ width: `${pct}%` }} />
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <>
            <div className="pk-head">
              <button type="button" className="pk-back" onClick={() => openList(null)} aria-label="Πίσω στις λίστες">
                ‹ Λίστες
              </button>
              <LivePill connected={live.connected} lastAt={live.lastAt} />
            </div>
            <div className="pk-title">
              <h1>Λίστα {list}</h1>
              {head && (
                <p>
                  <b>{head.customer}</b>
                  <AssignBadge a={head.doc_no ? assign.get(head.doc_no) : undefined} auto={new Set((lines ?? []).map((r) => siteOf(r.from_pos)).filter((x): x is Site => !!x))} />
                  <br />
                  <span className="dim" title={fullDate(head.order_date)}>
                    {[head.doc_no, head.erp_code && `ERP ${head.erp_code}`, relDate(head.order_date), head.picker && `Συλλογή WMS: ${head.picker}`].filter(Boolean).join(" · ")}
                  </span>
                </p>
              )}
              {head?.comments && <div className="sl-comments">Σχόλια: {head.comments}</div>}
            </div>

            <div className="pk-ranges pk-sites" role="group" aria-label="Αποθήκη">
              {(
                [
                  ["all", "Όλες"],
                  ["central", "Κεντρική"],
                  ["external", "Εξωτερική"],
                ] as const
              ).map(([k, l]) => (
                <button key={k} type="button" className={`pk-chip ${siteF === k ? "on" : ""}`} onClick={() => setSiteF(k)}>
                  {l}
                </button>
              ))}
            </div>
            {otherSite > 0 && (
              <p className="dim pk-other">
                + {otherSite} γραμμές για {siteF === "central" ? "την εξωτερική" : "την κεντρική"} αποθήκη (κρυμμένες)
              </p>
            )}
            {error && <p className="rp-notice error">{error}</p>}
            {lines === null && !error && <p className="dim">Φόρτωση…</p>}
            {lines && !lines.length && <p className="rp-notice">Η λίστα {list} δεν βρέθηκε στις εκτελεσμένες.</p>}

            {lines && lines.length > 0 && (
              <>
                <div className={`pk-progress ${done === total ? "done" : ""}`}>
                  <div className="pk-progress-txt">
                    <b>
                      {done}/{total}
                    </b>{" "}
                    {done === total ? "— η λίστα συλλέχθηκε ✓" : "συλλέχθηκαν"}
                  </div>
                  <span className="pk-bar big">
                    <i style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
                  </span>
                </div>

                <form className="pk-scan" onSubmit={onScan}>
                  <input ref={scanRef} value={scan} onChange={(e) => setScan(e.target.value)} placeholder="Σάρωση ετικέτας ή κωδικός…" autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
                  <button type="submit" className="btn ghost">
                    OK
                  </button>
                </form>
                {flash && <div className={`pk-flash ${flash.ok ? "ok" : "bad"}`}>{flash.text}</div>}

                <div className="pk-tools">
                  <label className="st-check">
                    <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
                    Κρύψε τα τσεκαρισμένα
                  </label>
                  {done < total ? (
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => window.confirm(`Τσεκάρισμα και των ${total - done} γραμμών που απομένουν;`) && setCollected(siteLines.filter((r) => !r.collected).map((r) => r.id), true)}
                    >
                      Όλα ✓
                    </button>
                  ) : (
                    <button type="button" className="btn ghost sm" onClick={() => window.confirm("Ξετσεκάρισμα όλων των γραμμών;") && setCollected(siteLines.map((r) => r.id), false)}>
                      Ξετσεκάρισμα όλων
                    </button>
                  )}
                </div>

                <ul className="pk-lines">
                  {shown.map((r) => (
                    <li key={r.id}>
                      <button type="button" className={`pk-line ${r.collected ? "on" : ""}`} onClick={() => setCollected([r.id], !r.collected)} aria-pressed={!!r.collected}>
                        <span className="pk-box" aria-hidden>
                          {r.collected ? "✓" : ""}
                        </span>
                        <span className="pk-body">
                          <span className="pk-row1">
                            {r.from_pos ? <span className="rack">{r.from_pos}</span> : <span className="dim">χωρίς θέση</span>}
                            <b className="pk-qty">{fq(r.qty ?? r.init_qty)}</b>
                          </span>
                          <span className="pk-item">
                            <b>{r.item}</b> {r.description}
                          </span>
                          <span className="pk-lot">
                            {r.lot && (
                              <>
                                Παρτίδα <b>{r.lot}</b>
                              </>
                            )}
                            {r.sn && (
                              <>
                                {" "}
                                · SN <b>{r.sn}</b>
                              </>
                            )}
                          </span>
                          {r.collected && (
                            <span className="pk-who">
                              ✓ {displayUser(r.collected_by)} · {relDate(r.collected_at)}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {hideDone && !shown.length && <p className="dim">Όλες οι γραμμές είναι τσεκαρισμένες.</p>}
                <p className="pk-foot">
                  <Link href="/orders/">Εκτελεσμένες</Link> · Το τσεκάρισμα είναι το «Collected» της καρτέλας Εκτελεσμένες.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
