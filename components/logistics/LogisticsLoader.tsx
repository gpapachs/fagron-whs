"use client";

import AuthGate from "@/components/auth/AuthGate";
import LogisticsBoard from "@/components/logistics/LogisticsBoard";

export default function LogisticsLoader() {
  return <AuthGate>{(session) => <LogisticsBoard userEmail={session.email} role={session.role} />}</AuthGate>;
}
