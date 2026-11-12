"use client";

import AuthGate from "@/components/auth/AuthGate";
import ShipmentsBoard from "@/components/shipments/ShipmentsBoard";

export default function ShipmentsLoader() {
  return <AuthGate>{(session) => <ShipmentsBoard userEmail={session.email} role={session.role} />}</AuthGate>;
}
