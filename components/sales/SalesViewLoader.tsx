"use client";

import AuthGate from "@/components/auth/AuthGate";
import SalesView from "@/components/sales/SalesView";

export default function SalesViewLoader() {
  return <AuthGate>{(session) => <SalesView userEmail={session.email} role={session.role} />}</AuthGate>;
}
