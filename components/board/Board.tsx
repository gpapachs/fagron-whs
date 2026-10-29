"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { createClient } from "@/lib/supabase/client";
import {
  CORRIDORS,
  TOTAL_POSITIONS,
  codeFor,
  findByCode,
  pad,
  type StockEntry,
} from "@/lib/corridors";
import type { Position, PositionStatus } from "@/lib/types";
import Grid2D from "./Grid2D";
import PositionPanel from "./PositionPanel";
import QuickLookup from "./QuickLookup";
import ExcelImport from "./ExcelImport";
import LogoutButton from "@/components/auth/LogoutButton";
import NavTabs from "@/components/NavTabs";
import type { Board3DHandle } from "./Board3D";

const Board3D = dynamic(() => import("./Board3D"), { ssr: false });

type View = "2d" | "3d";
type Current = { cid: number | string; idx: number; code: string };

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    out.push(...(await Promise.all(batch.map(fn))));
  }
  return out;
}

export default function Board({
  initialPositions,
  userId,
  userEmail,
  role,
}: {
  initialPositions: Position[];
  userId: string | null;
  userEmail: string | null;
  role: "admin" | "staff";
}) {
  const [positionsByCode, setPositionsByCode] = useState<Record<string, Position>>(() => {
    const map: Record<string, Position> = {};
    initialPositions.forEach((p) => (map[p.code] = p));
    return map;
  });
  const [filter, setFilter] = useState<PositionStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("2d");
  const [current, setCurrent] = useState<Current | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const board3dRef = useRef<Board3DHandle>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("positions-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "positions" },
        (payload) => {
          setPositionsByCode((prev) => {
            if (payload.eventType === "DELETE") {
              const next = { ...prev };
              delete next[(payload.old as Position).code];
              return next;
            }
            const row = payload.new as Position;
            return { ...prev, [row.code]: row };
          });
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  function showToast(message: string) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  const stats = useMemo(() => {
    let free = 0;
    let occ = 0;
    let res = 0;
    Object.values(positionsByCode).forEach((p) => {
      if (p.status === "occupied") occ++;
      else if (p.status === "reserved") res++;
      else free++;
    });
    const total = Object.keys(positionsByCode).length || TOTAL_POSITIONS;
    return { total, free, occ, res, pct: total ? Math.round(((occ + res) / total) * 100) : 0 };
  }, [positionsByCode]);

  function openPanel(cid: number | string, idx: number, code: string) {
    setCurrent({ cid, idx, code });
  }
  function closePanel() {
    setCurrent(null);
  }

  async function handleSave(fields: {
    status: PositionStatus;
    product: string;
    qty: number;
    notes: string;
    slot_date: string | null;
  }): Promise<boolean> {
    if (!current) return false;
    const supabase = createClient();
    const { data, error } = await supabase
      .from("positions")
      .update({ ...fields, updated_by: userId })
      .eq("code", current.code)
      .select()
      .single();
    if (error || !data) {
      showToast("Η αποθήκευση απέτυχε — δοκιμάστε ξανά.");
      return false;
    }
    setPositionsByCode((prev) => ({ ...prev, [data.code]: data as Position }));
    showToast("Η θέση ενημερώθηκε.");
    return true;
  }

  async function handleClear(): Promise<boolean> {
    if (!current) return false;
    const supabase = createClient();
    const { data, error } = await supabase
      .from("positions")
      .update({
        status: "free",
        product: "",
        qty: 0,
        notes: "",
        slot_date: null,
        updated_by: userId,
      })
      .eq("code", current.code)
      .select()
      .single();
    if (error || !data) {
      showToast("Η αλλαγή απέτυχε — δοκιμάστε ξανά.");
      return false;
    }
    setPositionsByCode((prev) => ({ ...prev, [data.code]: data as Position }));
    showToast("Η θέση αδειάστηκε.");
    return true;
  }

  function handleQuickLookup(rawCode: string): boolean {
    const hit = findByCode(rawCode);
    if (!hit) return false;
    const code = codeFor(hit.cid, hit.idx);
    openPanel(hit.cid, hit.idx, code);
    if (view === "3d" && typeof hit.cid === "number") board3dRef.current?.focusAisle(hit.cid);
    return true;
  }

  function handleJump(cid: number) {
    if (view === "3d") {
      board3dRef.current?.focusAisle(cid);
      return;
    }
    const el = document.getElementById(`corridor-${cid}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("pulse");
      setTimeout(() => el.classList.remove("pulse"), 900);
    }
  }

  async function handleExcelEntries(
    entries: StockEntry[]
  ): Promise<{ matched: number; unmatched: string[] }> {
    const supabase = createClient();
    const unmatched: string[] = [];
    const updates: { code: string; product: string; qty?: number }[] = [];
    entries.forEach((e) => {
      const hit = findByCode(e.code);
      if (!hit) {
        unmatched.push(e.raw);
        return;
      }
      updates.push({ code: codeFor(hit.cid, hit.idx), product: e.product, qty: e.qty });
    });

    const results = await inBatches(updates, 20, (u) =>
      supabase
        .from("positions")
        .update({
          status: "occupied",
          ...(u.product ? { product: u.product } : {}),
          ...(u.qty !== undefined ? { qty: u.qty } : {}),
          updated_by: userId,
        })
        .eq("code", u.code)
        .select()
        .single()
    );

    setPositionsByCode((prev) => {
      const next = { ...prev };
      results.forEach((r) => {
        if (r.data) next[(r.data as Position).code] = r.data as Position;
      });
      return next;
    });

    return { matched: results.filter((r) => r.data).length, unmatched };
  }

  const currentPosition = current ? positionsByCode[current.code] : undefined;

  return (
    <div className="wrap">
      <NavTabs />
      <div className="header">
        <div className="titleblock">
          <p className="eyebrow">Fagron Hellas &middot; Διαχείριση χώρου &middot; Live</p>
          <h1>Πλάνο Αποθήκης</h1>
          <p>
            12 διάδρομοι με την πραγματική αρίθμηση θέσεών σας (E{"{διάδρομος}"}-{"{στήλη}"}-{"{σειρά}"}-
            {"{θέση}"}), συν τυχόν ειδικές θέσεις εκτός διαδρόμων. Πατήστε μια θέση για να τη δείτε ή να
            την αλλάξετε.
          </p>
          <div className="userbar">
            {userEmail && <span>{userEmail}</span>}
            <span className="role">{role === "admin" ? "Διαχειριστής" : "Προσωπικό"}</span>
            <LogoutButton />
          </div>
        </div>
        <div className="stats">
          <div className="stat total">
            <div className="n">{stats.total}</div>
            <div className="l">Σύνολο θέσεων</div>
          </div>
          <div className="stat free">
            <div className="n">{stats.free}</div>
            <div className="l">Ελεύθερες</div>
          </div>
          <div className="stat occupied">
            <div className="n">{stats.occ}</div>
            <div className="l">Κατειλημμένες</div>
          </div>
          <div className="stat reserved">
            <div className="n">{stats.res}</div>
            <div className="l">Δεσμευμένες</div>
          </div>
          <div className="stat">
            <div className="n">{stats.pct}%</div>
            <div className="l">Πληρότητα</div>
          </div>
        </div>
      </div>

      <QuickLookup onLookup={handleQuickLookup} />

      <div className="controls">
        <div className="search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="text"
            placeholder="Αναζήτηση προϊόντος ή SKU…"
            value={query}
            onChange={(e) => setQuery(e.target.value.trim().toLowerCase())}
          />
        </div>
        <div className="chips">
          {(["all", "free", "occupied", "reserved"] as const).map((f) => (
            <button
              key={f}
              className={`chip${filter === f ? ` active${f !== "all" ? " " + f : ""}` : ""}`}
              onClick={() => setFilter(f)}
              type="button"
            >
              {f !== "all" && (
                <span
                  className="dot"
                  style={{
                    background:
                      f === "free" ? "var(--free)" : f === "occupied" ? "var(--occupied)" : "var(--reserved)",
                  }}
                />
              )}
              {f === "all" ? "Όλες" : f === "free" ? "Ελεύθερες" : f === "occupied" ? "Κατειλημμένες" : "Δεσμευμένες"}
            </button>
          ))}
        </div>
        <ExcelImport onEntries={handleExcelEntries} />
        <div className="viewToggle">
          <button className={view === "2d" ? "active" : ""} onClick={() => setView("2d")} type="button">
            Κάτοψη 2Δ
          </button>
          <button className={view === "3d" ? "active" : ""} onClick={() => setView("3d")} type="button">
            Προβολή 3Δ
          </button>
        </div>
        <div className="jump">
          {Array.from({ length: CORRIDORS }, (_, i) => i + 1).map((c) => (
            <button key={c} onClick={() => handleJump(c)} type="button">
              E{pad(c)}
            </button>
          ))}
        </div>
      </div>

      <div className="legend">
        <span>
          <i style={{ background: "var(--free)" }} />
          Ελεύθερη
        </span>
        <span>
          <i style={{ background: "var(--occupied)" }} />
          Κατειλημμένη
        </span>
        <span>
          <i style={{ background: "var(--reserved)" }} />
          Δεσμευμένη (πλάνο)
        </span>
      </div>

      {view === "2d" && (
        <Grid2D
          positionsByCode={positionsByCode}
          filter={filter}
          query={query}
          currentCode={current?.code ?? null}
          onCellClick={openPanel}
        />
      )}

      {view === "3d" && (
        <div className="board3d-wrap">
          <Board3D
            ref={board3dRef}
            positionsByCode={positionsByCode}
            filter={filter}
            query={query}
            currentCode={current?.code ?? null}
            onSelect={openPanel}
          />
          <div className="hint3d">Σύρετε για περιστροφή · scroll για ζουμ · κλικ σε παλέτα για επεξεργασία</div>
        </div>
      )}

      <PositionPanel
        open={current !== null}
        cid={current?.cid ?? null}
        idx={current?.idx ?? null}
        code={current?.code ?? null}
        position={currentPosition}
        onClose={closePanel}
        onSave={handleSave}
        onClear={handleClear}
      />

      <div className={`toast${toast ? " show" : ""}`}>{toast}</div>
    </div>
  );
}
