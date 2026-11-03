"use client";

import AuthGate from "@/components/auth/AuthGate";
import MovesBoard from "@/components/moves/MovesBoard";

// Καμία προφόρτωση: η σελίδα ρωτά τη βάση μόνο όταν πατηθεί «Αναζήτηση».
export default function MovesLoader() {
  return <AuthGate>{(session) => <MovesBoard userEmail={session.email} role={session.role} />}</AuthGate>;
}
