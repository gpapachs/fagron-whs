"use client";

// «Live» ενημερώσεις από το sync -Live: ο πίνακας wms_live έχει μία γραμμή ανά
// είδος σήματος (stock = άλλαξε το απόθεμα συγκεκριμένων κωδικών, stock_full =
// πλήρης συγχρονισμός, moves = νέες κινήσεις). Οι σελίδες ακούν μόνο αυτό το
// μικρό σήμα και ξαναφέρνουν ό,τι χρειάζονται -- όχι χιλιάδες αλλαγές γραμμών.
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type LiveSignal = { key: "stock" | "stock_full" | "moves" | string; at: string; items: string[]; n: number };

export function useWmsLive(onSignal: (s: LiveSignal) => void) {
  const cb = useRef(onSignal);
  cb.current = onSignal;
  const [connected, setConnected] = useState(false);
  const [lastAt, setLastAt] = useState<string | null>(null);
  useEffect(() => {
    const supabase = createClient();
    // ώρα τελευταίου σήματος (για την ένδειξη «Live»)
    supabase
      .from("wms_live")
      .select("key, at")
      .order("at", { ascending: false })
      .limit(1)
      .then(({ data }) => {
        const r = (data as { at: string }[] | null)?.[0];
        if (r) setLastAt(r.at);
      });
    const channel = supabase
      // μοναδικό όνομα ανά χρήση: δύο οθόνες στην ίδια σελίδα (π.χ. λίστα + παράθυρο λίστας)
      // με το ίδιο όνομα μοιράζονται κανάλι και το supabase-js πετάει σφάλμα
      .channel(`wms_live:${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "wms_live" }, (payload) => {
        const row = payload.new as LiveSignal;
        if (!row?.key) return;
        setLastAt(row.at);
        cb.current(row);
      })
      .subscribe((status) => setConnected(status === "SUBSCRIBED"));
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);
  return { connected, lastAt };
}

/** «πριν 12"» / «πριν 3'» / ώρα */
export function ago(iso: string | null, now = Date.now()) {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `πριν ${s}"`;
  if (s < 3600) return `πριν ${Math.round(s / 60)}'`;
  return new Date(iso).toLocaleString("el-GR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Πολλά σήματα σε λίγα δευτερόλεπτα (Live κάθε 5") -> μία ανανέωση. */
export function useCoalesced(fn: () => void, ms = 1500) {
  const f = useRef(fn);
  f.current = fn;
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  return () => {
    if (t.current) return;
    t.current = setTimeout(() => {
      t.current = null;
      f.current();
    }, ms);
  };
}
