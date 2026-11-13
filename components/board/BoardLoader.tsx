"use client";

import { useEffect, useState } from "react";
import AuthGate, { PageLoading, type SessionInfo } from "@/components/auth/AuthGate";
import Board from "@/components/board/Board";
import WmsPlanBoard from "@/components/board/WmsPlanBoard";
import { createClient } from "@/lib/supabase/client";
import { fetchAll } from "@/lib/supabase/fetchAll";
import type { Position } from "@/lib/types";

const LS_MODE = "board.mode.v1";

function Manual({ session, onLive }: { session: SessionInfo; onLive: () => void }) {
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAll<Position>(createClient(), "positions", "*", ["code"])
      .then(setPositions)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <PageLoading text={`Σφάλμα φόρτωσης: ${error}`} />;
  if (!positions) return <PageLoading text="Φόρτωση θέσεων…" />;
  return <Board initialPositions={positions} userId={session.userId} userEmail={session.email} role={session.role} onLive={onLive} />;
}

// Πλάνο Αποθήκης: live από το WMS (προεπιλογή) ή το παλιό χειροκίνητο πλάνο E01–E12
function Loaded({ session }: { session: SessionInfo }) {
  const [mode, setMode] = useState<"live" | "manual" | null>(null);
  useEffect(() => {
    let m: "live" | "manual" = "live";
    try {
      if (window.localStorage.getItem(LS_MODE) === "manual") m = "manual";
    } catch {
      /* τίποτα */
    }
    setMode(m);
  }, []);
  const set = (m: "live" | "manual") => {
    setMode(m);
    try {
      window.localStorage.setItem(LS_MODE, m);
    } catch {
      /* τίποτα */
    }
  };
  if (!mode) return <PageLoading text="Φόρτωση…" />;
  return mode === "live" ? (
    <WmsPlanBoard userEmail={session.email} role={session.role} onManual={() => set("manual")} />
  ) : (
    <Manual session={session} onLive={() => set("live")} />
  );
}

export default function BoardLoader() {
  return <AuthGate>{(session) => <Loaded session={session} />}</AuthGate>;
}
