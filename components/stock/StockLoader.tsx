"use client";

import { useEffect, useState } from "react";
import AuthGate, { PageLoading, type SessionInfo } from "@/components/auth/AuthGate";
import StockBoard from "@/components/stock/StockBoard";
import { createClient } from "@/lib/supabase/client";
import { fetchAll } from "@/lib/supabase/fetchAll";
import type { StockRow } from "@/lib/exports";

type Data = { rows: StockRow[]; syncedAt: string | null };

async function load(): Promise<Data> {
  const supabase = createClient();
  const [stock, uploads] = await Promise.all([
    fetchAll<Omit<StockRow, "qty"> & { qty: number | string }>(
      supabase,
      "wms_stock_v",
      "item, position, area, lot, serial, expiry, qty, description",
      ["position", "item", "lot", "serial"]
    ),
    supabase.from("repack_uploads").select("kind, uploaded_at").eq("kind", "stock").maybeSingle(),
  ]);
  return {
    // χωρίς παρτίδα = χωρίς λήξη (δεν μετρά ως ληγμένο)
    rows: stock.map((s) => ({ ...s, qty: Number(s.qty), expiry: s.lot ? s.expiry : null })),
    syncedAt: (uploads.data as { uploaded_at?: string } | null)?.uploaded_at ?? null,
  };
}

function Loaded({ session }: { session: SessionInfo }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    load()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <PageLoading text={`Σφάλμα φόρτωσης: ${error}`} />;
  if (!data) return <PageLoading text="Φόρτωση αποθέματος…" />;
  return <StockBoard rows={data.rows} syncedAt={data.syncedAt} userEmail={session.email} role={session.role} />;
}

export default function StockLoader() {
  return <AuthGate>{(session) => <Loaded session={session} />}</AuthGate>;
}
