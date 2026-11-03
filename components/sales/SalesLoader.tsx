"use client";

import AuthGate from "@/components/auth/AuthGate";
import SalesBoard from "@/components/sales/SalesBoard";

export default function SalesLoader() {
  return <AuthGate>{(session) => <SalesBoard userEmail={session.email} role={session.role} />}</AuthGate>;
}
