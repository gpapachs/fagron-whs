"use client";

import { createClient } from "@/lib/supabase/client";
import { fetchAll } from "@/lib/supabase/fetchAll";
import { isAbroad, partnerCountry } from "@/lib/partnerCountry";
import type { Partner } from "@/components/logistics/PartnersTab";

// πελάτες / προμηθευτές του WMS για αναζήτηση στη φόρμα (μία φόρτωση ανά σελίδα)
let cache: Promise<Partner[]> | null = null;
export function loadPartners(force = false): Promise<Partner[]> {
  if (force) cache = null;
  cache ??= fetchAll<Partner>(createClient(), "wms_partners_v", "*", ["name", "id"])
    .then((raw) =>
      raw.map((p) => {
        const country = partnerCountry(p);
        return { ...p, country, is_abroad: isAbroad(country), country_manual: !!p.manual_country };
      })
    )
    .catch((e) => {
      cache = null;
      throw e;
    });
  return cache;
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
export function searchPartners(all: Partner[], q: string, kind: "customer" | "supplier", limit = 8) {
  const words = norm(q.trim()).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: Partner[] = [];
  for (const p of all) {
    if (!p.active || !(kind === "customer" ? p.is_customer : p.is_supplier)) continue;
    const hay = norm([p.code, p.name, p.city, p.vat, p.vat_eu].filter(Boolean).join(" "));
    if (words.every((w) => hay.includes(w))) out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}
