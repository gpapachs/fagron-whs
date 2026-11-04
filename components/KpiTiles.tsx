"use client";

export type Kpi = { key: string; label: string; value: number | string; tone?: "green" | "yellow" | "red" | "blue" | "orange" | "neutral"; hint?: string };

/** Μεγάλα κουτάκια σύνοψης· με κλικ φιλτράρουν (αν δοθεί onPick). */
export default function KpiTiles({ items, active, onPick }: { items: Kpi[]; active?: string | null; onPick?: (key: string) => void }) {
  return (
    <div className="kt-row" data-n={items.length}>
      {items.map((k) => {
        const Tag = onPick ? "button" : "div";
        return (
          <Tag
            key={k.key}
            type={onPick ? "button" : undefined}
            className={`kt ${k.tone ?? "neutral"} ${active === k.key ? "on" : ""}`}
            onClick={onPick ? () => onPick(k.key) : undefined}
            title={k.hint}
          >
            <span className="kt-n">{typeof k.value === "number" ? k.value.toLocaleString("el-GR") : k.value}</span>
            <span className="kt-l">{k.label}</span>
          </Tag>
        );
      })}
    </div>
  );
}
