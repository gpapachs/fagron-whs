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

// Pick list για κινητό / tablet: ο χρήστης διαλέγει λίστα από τις εκτελεσμένες (SALEXPORTCL) και
// τσεκάρει ό,τι βγάζει. Το τσεκάρισμα είναι το ίδιο «Collected» της καρτέλας Εκτελεσμένες
// (wms_orders_set_collected) — φαίνεται αμέσως σε όλες τις συσκευές.

const COLS =
  "id, order_id, list_no, doc_type, doc_no, erp_code, order_date, customer, item, description, lot, sn, qty, init_qty, from_pos, to_pos, wms_status, line_no, collected, collected_at, collected_by, picker, comments";
type Range = "today" | "yesterday" | "7";
type ListCard = { list: string; customer: string; date: string | null; lines: number; done: number; picker: string; doc: string };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fq = (n: number | null) => (n == null ? "" : n.toLocaleString("el-GR", { maximumFractionDigits: 3 }));
const posKey = (p: string | null) => (p ?? "").replace(/\d+/g, (d) => d.padStart(4, "0"));

function rangeOf(r: Range): [Date, Date] {
  const t = new Date();
  const start = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  const end = new Date(start.getTime() + 86400000);
  if (r === "yesterday") return [new Date(start.getTime() - 86400000), start];
  if (r === "7") return [new Date(start.getTime() - 6 * 86400000), end];
  return [start, end];
}

export default function PickBoard({ userEmail, role }: { userEmail: string | null; role: "admin" | "staff" }) {
  const [list, setList] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("today");
  const [find, setFind] = useState("");
  const [lists, setLists] = useState<ListCard[] | null>(null);
  const [lines, setLines] = useState<OrderRow[] | null>(null);
  const [hideDone, setHideDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ text: string; ok: boolean } | null>(null);
  const [scan, setScan] = useState("");
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
    const [a, b] = rangeOf(range);
    const sb = createClient();
    const out: OrderRow[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb
        .from("wms_orders_v")
        .select("list_no, customer, order_date, collected, picker, doc_no")
        .eq("doc_type", "SALEXPORTCL")
        .gte("order_date", a.toISOString())
        .lt("order_date", b.toISOString())
        .order("order_date", { ascending: false })
        .range(from, from + 999);
      if (error) return setError(`Οι λίστες δεν φορτώθηκαν: ${error.message}`);
      out.push(...((data as OrderRow[]) ?? []));
      if (!data || data.length < 1000) break;
    }
    const m = new Map<string, ListCard>();
    for (const r of out) {
      const k = r.list_no ?? "";
      const c = m.get(k) ?? { list: k, customer: r.customer ?? "", date: r.order_date, lines: 0, done: 0, picker: r.picker ?? "", doc: r.doc_no ?? "" };
      c.lines++;
      if (r.collected) c.done++;
      m.set(k, c);
    }
    setLists([...m.values()].sort((x, y) => (x.done === x.lines ? 1 : 0) - (y.done === y.lines ? 1 : 0) || (y.date ?? "").localeCompare(x.date ?? "")));
  }

  async function loadLines(l: string, silent = false) {
    if (!silent) setLines(null);
    setError(null);
    const { data, error } = await createClient().from("wms_orders_v").select(COLS).eq("doc_type", "SALEXPORTCL").eq("list_no", l).order("line_no");
    if (error) return setError(`Η λίστα δεν φορτώθηκε: ${error.message}`);
    setLines(((data as OrderRow[]) ?? []).map((r) => ({ ...r, qty: r.qty == null ? null : Number(r.qty), init_qty: r.init_qty == null ? null : Number(r.init_qty) })));
  }

  useEffect(() => {
    if (list) loadLines(list);
    else loadLists();
  }, [list, range]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // σάρωση: κωδικός είδους ή DataMatrix ετικέτας (κωδικός#παρτίδα#serial#ποσότητα)
  function onScan(e: React.FormEvent) {
    e.preventDefault();
    const raw = scan.trim();
    setScan("");
    if (!raw || !lines) return;
    const [code, lot, sn] = raw.split("#").map((x) => (x ?? "").trim().toUpperCase());
    const cand = lines.filter(
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

  const sorted = useMemo(
    () => [...(lines ?? [])].sort((a, b) => Number(a.collected) - Number(b.collected) || posKey(a.from_pos).localeCompare(posKey(b.from_pos)) || (a.line_no ?? 0) - (b.line_no ?? 0)),
    [lines]
  );
  const shown = hideDone ? sorted.filter((r) => !r.collected) : sorted;
  const done = (lines ?? []).filter((r) => r.collected).length;
  const total = lines?.length ?? 0;
  const head = lines?.[0];
  const shownLists = (lists ?? []).filter((c) => {
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
            <div className="pk-ranges">
              {(
                [
                  ["today", "Σήμερα"],
                  ["yesterday", "Χθες"],
                  ["7", "7 ημέρες"],
                ] as const
              ).map(([k, l]) => (
                <button key={k} type="button" className={`pk-chip ${range === k ? "on" : ""}`} onClick={() => setRange(k)}>
                  {l}
                </button>
              ))}
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
            {lists && !shownLists.length && <p className="dim">Καμία λίστα σε αυτό το διάστημα.</p>}
            <div className="pk-lists">
              {shownLists.map((c) => {
                const pct = c.lines ? Math.round((c.done / c.lines) * 100) : 0;
                return (
                  <button key={c.list} type="button" className={`pk-card ${c.done === c.lines ? "done" : c.done ? "part" : ""}`} onClick={() => openList(c.list)}>
                    <span className="pk-card-top">
                      <b className="pk-list">{c.list}</b>
                      <span className="pk-count">
                        {c.done}/{c.lines}
                      </span>
                    </span>
                    <span className="pk-cust">{c.customer}</span>
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
                  <br />
                  <span className="dim" title={fullDate(head.order_date)}>
                    {[head.doc_no, head.erp_code && `ERP ${head.erp_code}`, relDate(head.order_date), head.picker && `Συλλογή WMS: ${head.picker}`].filter(Boolean).join(" · ")}
                  </span>
                </p>
              )}
              {head?.comments && <div className="sl-comments">Σχόλια: {head.comments}</div>}
            </div>

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
                      onClick={() => window.confirm(`Τσεκάρισμα και των ${total - done} γραμμών που απομένουν;`) && setCollected(lines.filter((r) => !r.collected).map((r) => r.id), true)}
                    >
                      Όλα ✓
                    </button>
                  ) : (
                    <button type="button" className="btn ghost sm" onClick={() => window.confirm("Ξετσεκάρισμα όλων των γραμμών;") && setCollected(lines.map((r) => r.id), false)}>
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
