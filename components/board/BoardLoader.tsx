"use client";

import { useEffect, useState } from "react";
import AuthGate, { PageLoading, type SessionInfo } from "@/components/auth/AuthGate";
import Board from "@/components/board/Board";
import { createClient } from "@/lib/supabase/client";
import { fetchAll } from "@/lib/supabase/fetchAll";
import type { Position } from "@/lib/types";

function Loaded({ session }: { session: SessionInfo }) {
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAll<Position>(createClient(), "positions", "*", ["code"])
      .then(setPositions)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <PageLoading text={`Σφάλμα φόρτωσης: ${error}`} />;
  if (!positions) return <PageLoading text="Φόρτωση θέσεων…" />;
  return <Board initialPositions={positions} userId={session.userId} userEmail={session.email} role={session.role} />;
}

export default function BoardLoader() {
  return <AuthGate>{(session) => <Loaded session={session} />}</AuthGate>;
}
