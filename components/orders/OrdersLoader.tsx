"use client";

import AuthGate from "@/components/auth/AuthGate";
import OrdersBoard from "@/components/orders/OrdersBoard";

// Καμία προφόρτωση: ρωτά τη βάση μόνο στην «Αναζήτηση».
export default function OrdersLoader() {
  return <AuthGate>{(session) => <OrdersBoard userEmail={session.email} role={session.role} />}</AuthGate>;
}
