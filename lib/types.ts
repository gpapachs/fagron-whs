export type PositionStatus = "free" | "occupied" | "reserved";

export type Position = {
  code: string;
  corridor_id: string;
  zone: string;
  status: PositionStatus;
  product: string;
  qty: number;
  notes: string;
  slot_date: string | null;
  updated_at: string;
  updated_by: string | null;
};

export type PositionHistoryEntry = {
  id: string;
  code: string;
  changed_at: string;
  changed_by: string | null;
  changed_by_email: string | null;
  old_status: PositionStatus | null;
  new_status: PositionStatus | null;
  old_product: string | null;
  new_product: string | null;
  old_qty: number | null;
  new_qty: number | null;
  old_notes: string | null;
  new_notes: string | null;
};

export type Profile = {
  id: string;
  email: string | null;
  role: "admin" | "staff";
  created_at: string;
};
