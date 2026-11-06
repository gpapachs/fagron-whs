"use client";

import AuthGate from "@/components/auth/AuthGate";
import AnalysisBoard from "@/components/analysis/AnalysisBoard";

export default function AnalysisLoader() {
  return <AuthGate>{(session) => <AnalysisBoard userEmail={session.email} role={session.role} />}</AuthGate>;
}
