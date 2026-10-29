"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { labelFor, layoutFor, zoneFor } from "@/lib/corridors";
import type { Position, PositionHistoryEntry, PositionStatus } from "@/lib/types";

const STATUS_LABEL: Record<PositionStatus, string> = {
  free: "Ελεύθερη",
  occupied: "Κατειλημμένη",
  reserved: "Δεσμευμένη",
};
const DATE_LABEL: Record<PositionStatus, string> = {
  free: "Ημερομηνία",
  occupied: "Σε χρήση από",
  reserved: "Προγρ. άφιξη",
};

export default function PositionPanel({
  open,
  cid,
  idx,
  code,
  position,
  onClose,
  onSave,
  onClear,
}: {
  open: boolean;
  cid: number | string | null;
  idx: number | null;
  code: string | null;
  position: Position | undefined;
  onClose: () => void;
  onSave: (fields: {
    status: PositionStatus;
    product: string;
    qty: number;
    notes: string;
    slot_date: string | null;
  }) => Promise<boolean>;
  onClear: () => Promise<boolean>;
}) {
  const [status, setStatus] = useState<PositionStatus>("free");
  const [product, setProduct] = useState("");
  const [qty, setQty] = useState("");
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<PositionHistoryEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStatus(position?.status ?? "free");
    setProduct(position?.product ?? "");
    setQty(position?.qty ? String(position.qty) : "");
    setNotes(position?.notes ?? "");
    setDate(position?.slot_date ?? "");
    setHistoryOpen(false);
    setHistory(null);
  }, [open, code, position]);

  async function loadHistory() {
    if (!code) return;
    setHistoryLoading(true);
    const supabase = createClient();
    const { data } = await supabase
      .from("position_history")
      .select("*")
      .eq("code", code)
      .order("changed_at", { ascending: false })
      .limit(50);
    setHistory((data as PositionHistoryEntry[] | null) ?? []);
    setHistoryLoading(false);
  }

  function toggleHistory() {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next && history === null) loadHistory();
  }

  if (!open || cid === null || idx === null || code === null) {
    return (
      <>
        <div className="overlay" onClick={onClose} />
        <div className="panel" />
      </>
    );
  }

  const title =
    cid === "special" ? "Ειδική θέση" : (() => {
      const loc = layoutFor(cid)[idx];
      return loc && !loc.special ? `${labelFor(cid)} · Στήλη ${loc.col} · Σειρά ${loc.row}` : labelFor(cid);
    })();

  async function handleSave() {
    setSaving(true);
    const ok = await onSave({
      status,
      product: product.trim(),
      qty: Number(qty) || 0,
      notes: notes.trim(),
      slot_date: date || null,
    });
    setSaving(false);
    if (ok) onClose();
  }

  async function handleClear() {
    setSaving(true);
    const ok = await onClear();
    setSaving(false);
    if (ok) onClose();
  }

  return (
    <>
      <div className="overlay open" onClick={onClose} />
      <div className="panel open">
        <div className="phead">
          <div>
            <div className="code">{code}</div>
            <h2>{title}</h2>
            <span className="zone-tag zonetag">{position?.zone ?? zoneFor(cid)}</span>
          </div>
          <button className="close" onClick={onClose} type="button">
            ✕
          </button>
        </div>

        <div className="seg">
          {(["free", "occupied", "reserved"] as PositionStatus[]).map((s) => (
            <button
              key={s}
              className={status === s ? `on ${s}` : ""}
              onClick={() => setStatus(s)}
              type="button"
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>

        <label className="field">
          Προϊόν / SKU
          <input
            type="text"
            placeholder="π.χ. Παλέτα ξηρών καρπών #4471"
            value={product}
            onChange={(e) => setProduct(e.target.value)}
          />
        </label>
        <label className="field">
          Ποσότητα (παλέτες)
          <input
            type="number"
            min={0}
            step={1}
            placeholder="0"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
        </label>
        <label className="field">
          {DATE_LABEL[status]}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          Σημειώσεις
          <textarea
            placeholder="π.χ. προτεραιότητα φόρτωσης, ψυκτικός θάλαμος…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>

        <div className="meta">
          {position?.updated_at
            ? "Τελ. ενημέρωση: " + new Date(position.updated_at).toLocaleString("el-GR")
            : "Δεν έχει ενημερωθεί ακόμη."}
        </div>

        <div className="panel-actions">
          <button className="btn ghost" onClick={handleClear} disabled={saving} type="button">
            Άδειασμα θέσης
          </button>
          <button className="btn primary" onClick={handleSave} disabled={saving} type="button">
            {saving ? "Αποθήκευση…" : "Αποθήκευση"}
          </button>
        </div>

        <div>
          <button className="history-toggle" onClick={toggleHistory} type="button">
            {historyOpen ? "▾" : "▸"} Ιστορικό αλλαγών
          </button>
          {historyOpen && (
            <div style={{ marginTop: 10 }}>
              {historyLoading && <p className="history-empty">Φόρτωση…</p>}
              {!historyLoading && history !== null && history.length === 0 && (
                <p className="history-empty">Καμία καταγεγραμμένη αλλαγή ακόμη.</p>
              )}
              {!historyLoading && history !== null && history.length > 0 && (
                <div className="history-list">
                  {history.map((h) => (
                    <div className="history-item" key={h.id}>
                      <span className="when">{new Date(h.changed_at).toLocaleString("el-GR")}</span>
                      <span className="who">{h.changed_by_email ?? "άγνωστος χρήστης"}</span>
                      <span className="change">{describeChange(h)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function describeChange(h: PositionHistoryEntry): string {
  const parts: string[] = [];
  if (h.old_status !== h.new_status) {
    parts.push(
      `κατάσταση: ${STATUS_LABEL[h.old_status as PositionStatus] ?? "—"} → ${
        STATUS_LABEL[h.new_status as PositionStatus] ?? "—"
      }`
    );
  }
  if (h.old_product !== h.new_product) {
    parts.push(`προϊόν: "${h.old_product || "—"}" → "${h.new_product || "—"}"`);
  }
  if (h.old_qty !== h.new_qty) {
    parts.push(`ποσότητα: ${h.old_qty ?? 0} → ${h.new_qty ?? 0}`);
  }
  if (h.old_notes !== h.new_notes) {
    parts.push("άλλαξαν οι σημειώσεις");
  }
  return parts.length ? parts.join(", ") : "ενημέρωση";
}
