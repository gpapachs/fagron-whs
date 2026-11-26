// Εβδομαδιαία αναφορά «Τι πρέπει να φύγει» (email κάθε Πέμπτη) — ίδιος υπολογισμός με τη Μεταφορά αποθέματος,
// με τις προεπιλεγμένες ρυθμίσεις (χώρος 20, 41* / παλιοί 40*, 3 μήνες, χωρίς leaflets) και τις κοινές ρυθμίσεις
// της εφαρμογής (θέσεις εκτός, θέσεις άλλου προθέματος στον χώρο). Χωρίς εξαρτήσεις από browser / React.
import { CATEGORY_TXT, planRelocation, type ItemPlan, type RelPlan, type RelRow } from "./relocation.ts";
import { isLeaflet } from "./leaflet.ts";

export type ReportCfg = {
  prefix: string;
  from: string;
  room: string;
  keepMonths: number;
  skipPos: string[];
  posRoom: Record<string, string>;
  /** κωδικοί που είναι ήδη στο κοινό Pick list */
  picked: Set<string>;
  appUrl: string;
  now?: Date;
};

const nf0 = new Intl.NumberFormat("el-GR", { maximumFractionDigits: 0 });
const n0 = (x: number | null | undefined) => (x == null || !isFinite(x) ? "—" : nf0.format(x));
const fd = (s: string | null | undefined) => (s ? s.slice(0, 10).split("-").reverse().join("/") : "—");
const esc = (s: string | null | undefined) => (s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const cover = (i: ItemPlan) => (i.cover == null ? (i.onsite > 0 ? "∞" : "—") : i.cover >= 24 ? `${(i.cover / 12).toFixed(1).replace(".", ",")} έτη` : `${n0(i.cover)} μήνες`);
const coverNum = (i: ItemPlan) => (i.cover == null ? (i.onsite > 0 ? Number.MAX_VALUE : -1) : i.cover);

export function planForReport(rows: RelRow[], cfg: ReportCfg): RelPlan {
  const p = planRelocation(
    rows.filter((r) => !isLeaflet(r.description)),
    {
      prefix: cfg.prefix,
      from: cfg.from,
      keepMonths: cfg.keepMonths,
      includeNew: false,
      partial: true,
      areaClass: {},
      excluded: [],
      room: cfg.room,
      skipPos: cfg.skipPos,
      posRoom: cfg.posRoom,
      today: cfg.now,
    }
  );
  const withLeaflets = new Set(rows.filter((r) => isLeaflet(r.description)).map((r) => r.pos));
  p.freedPositions = p.freedPositions.filter((x) => !withLeaflets.has(x));
  for (const l of p.lines) if (withLeaflets.has(l.pos)) l.freesPosition = false;
  return p;
}

export function buildRelocationReport(rows: RelRow[], cfg: ReportCfg) {
  const now = cfg.now ?? new Date();
  const p = planForReport(rows, cfg);
  const items = [...p.moving].sort((a, b) => coverNum(b) - coverNum(a) || b.moveQty - a.moveQty || a.item.localeCompare(b.item));
  const date = now.toLocaleDateString("el-GR", { timeZone: "Europe/Athens", day: "2-digit", month: "2-digit", year: "numeric" });
  const pal = p.totals.pallets + (p.totals.palletsMissing ? ` (+${p.totals.palletsMissing} γραμμές χωρίς ποσ./παλέτα)` : "");
  const subject = `Μεταφορά σε εξωτερική αποθήκη — ${items.length} κωδικοί ${cfg.prefix}* (χώρος ${cfg.room}) — ${date}`;

  const th = (h: string, right = false) => `<th style="text-align:${right ? "right" : "left"};padding:6px 8px;border-bottom:2px solid #1f3a5f;background:#eef3f8;font-size:12px;white-space:nowrap">${h}</th>`;
  const td = (v: string, right = false, extra = "") => `<td style="padding:6px 8px;border-bottom:1px solid #e3e7ec;vertical-align:top;font-size:12px;${right ? "text-align:right;white-space:nowrap;" : ""}${extra}">${v}</td>`;
  const body = items
    .map((i) => {
      const lr = i.lastReceipt;
      const last = lr ? `${fd(lr.at)}${lr.qty != null ? ` · ${n0(lr.qty)} τεμ.` : ""}${lr.from ? `<br><span style="color:#777">από ${esc(lr.from)}</span>` : ""}` : "—";
      const why = [i.why.note, ...i.why.long].filter(Boolean).map((w) => `• ${esc(w)}`).join("<br>");
      const lots = new Set(i.lines.map((l) => `${l.lot}|${l.expiry ?? ""}`)).size;
      const pos = [...new Set(i.lines.map((l) => l.pos))].join(", ");
      return `<tr>${td(`<b>${esc(i.item)}</b>${i.legacyCodes ? `<br><span style="color:#777">πρώην ${esc(i.legacyCodes)}</span>` : ""}${cfg.picked.has(i.item) ? `<br><span style="color:#2f8f5b">✓ στο Pick list</span>` : ""}`, false, "white-space:nowrap;")}${td(esc(i.description))}${td(CATEGORY_TXT[i.category])}${td(n0(i.onsite), true)}${td(i.perMonth ? n0(i.perMonth) : "0", true)}${td(cover(i), true)}${td(last, true)}${td(`<b>${n0(i.moveQty)}</b>`, true)}${td(i.movePallets == null ? "—" : String(i.movePallets), true)}${td(`${lots} παρτ. · ${esc(pos)}`)}${td(why, false, "min-width:320px;color:#333")}</tr>`;
    })
    .join("");

  const html = `<!DOCTYPE html><html><body style="font-family:Segoe UI,Arial,sans-serif;color:#1d2733">
<p>Καλημέρα,</p>
<p>Η εβδομαδιαία ανάλυση για τη μεταφορά αποθέματος <b>${esc(cfg.prefix)}*</b> από τον <b>χώρο ${esc(cfg.room)}</b> στην εξωτερική αποθήκη
(ανάλωση από ${fd(cfg.from)}, κρατάμε κάλυψη ${cfg.keepMonths} μηνών στην κεντρική, μαζί με την κατανάλωση των παλιών κωδικών 40*, χωρίς leaflets):</p>
<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:8px 0 14px">
<tr>${td("Κωδικοί να φύγουν")}${td(`<b>${items.length}</b>`, true)}</tr>
<tr>${td("Τεμάχια")}${td(`<b>${n0(p.totals.moveQty)}</b>`, true)}</tr>
<tr>${td("Παλέτες (περίπου)")}${td(`<b>${pal}</b>`, true)}</tr>
<tr>${td("Θέσεις που αδειάζουν")}${td(`<b>${p.freedPositions.length}</b>`, true)}</tr>
${cfg.picked.size ? `<tr>${td("Ήδη στο Pick list")}${td(`<b>${cfg.picked.size}</b>`, true)}</tr>` : ""}
</table>
<p style="font-size:12px;color:#555">Ταξινόμηση: μεγαλύτερη κάλυψη πρώτα (∞ = απόθεμα χωρίς ανάλωση). Στη στήλη «Γιατί» η αιτιολογία για κάθε κωδικό.</p>
<table cellspacing="0" cellpadding="0" style="border-collapse:collapse">
<tr>${th("Κωδικός")}${th("Περιγραφή")}${th("Κατηγορία")}${th("Κεντρική", true)}${th("/ μήνα", true)}${th("Κάλυψη", true)}${th("Τελ. εισαγωγή", true)}${th("Να φύγει", true)}${th("Παλέτες", true)}${th("Από")}${th("Γιατί")}</tr>
${body || `<tr>${td("Τίποτα να μεταφερθεί αυτή την εβδομάδα.", false, "color:#777")}</tr>`}
</table>
<p style="font-size:12px;color:#555;margin-top:16px">Επιλογή κωδικών/ποσοτήτων και Pick list (PDF/Excel): <a href="${esc(cfg.appUrl)}">Fagron WHS → Ανάλυση → Μεταφορά αποθέματος</a>.<br>
Αυτόματη αναφορά της εφαρμογής Fagron WHS — κάθε Πέμπτη 12:00.</p>
</body></html>`;

  const text = [
    `Μεταφορά σε εξωτερική — ${items.length} κωδικοί, ${n0(p.totals.moveQty)} τεμ., ~${p.totals.pallets} παλέτες`,
    ...items.map((i) => `${i.item} ${i.description ?? ""} — να φύγει ${n0(i.moveQty)} — ${i.why.short}`),
  ].join("\n");
  return { subject, html, text, count: items.length };
}
