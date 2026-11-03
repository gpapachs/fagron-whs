"use client";

import { useEffect, useState } from "react";
import { ago } from "@/lib/live";

/** ένδειξη «● Live · πριν 12"» */
export default function LivePill({ connected, lastAt, flash }: { connected: boolean; lastAt: string | null; flash?: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className={`live-pill ${connected ? "on" : ""}`} key={flash} title={connected ? "Συνδεδεμένο σε ζωντανές ενημερώσεις" : "Χωρίς ζωντανή σύνδεση"}>
      <span className="dot" />
      {connected ? "Live" : "Offline"}
      {lastAt && <span className="when">· ενημέρωση {ago(lastAt)}</span>}
    </span>
  );
}
