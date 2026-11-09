"use client";

import AuthGate from "@/components/auth/AuthGate";
import PickBoard from "@/components/orders/PickBoard";

export default function PickLoader() {
  return <AuthGate>{(session) => <PickBoard userEmail={session.email} role={session.role} />}</AuthGate>;
}
