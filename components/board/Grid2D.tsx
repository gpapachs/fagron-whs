"use client";

import {
  CORRIDOR_SPEC,
  CORRIDORS,
  SPECIAL_ID,
  codeFor,
  layoutFor,
  pad,
  zoneFor,
} from "@/lib/corridors";
import type { Position, PositionStatus } from "@/lib/types";

function emptyLike(code: string, corridorId: string, zone: string): Position {
  return {
    code,
    corridor_id: corridorId,
    zone,
    status: "free",
    product: "",
    qty: 0,
    notes: "",
    slot_date: null,
    updated_at: "",
    updated_by: null,
  };
}

function matchesQuery(p: Position, query: string) {
  if (!query) return true;
  return p.product.toLowerCase().includes(query);
}

export default function Grid2D({
  positionsByCode,
  filter,
  query,
  currentCode,
  onCellClick,
}: {
  positionsByCode: Record<string, Position>;
  filter: PositionStatus | "all";
  query: string;
  currentCode: string | null;
  onCellClick: (cid: number | string, idx: number, code: string) => void;
}) {
  return (
    <>
      <div className="board">
        {Array.from({ length: CORRIDORS }, (_, i) => i + 1).map((c) => {
          const spec = CORRIDOR_SPEC[c];
          const lay = layoutFor(c);
          let occN = 0;
          let resN = 0;
          lay.forEach((_l, idx) => {
            const code = codeFor(c, idx);
            const p = positionsByCode[code];
            if (p?.status === "occupied") occN++;
            else if (p?.status === "reserved") resN++;
          });
          const corTotal = lay.length;
          const pct = corTotal ? Math.round(((occN + resN) / corTotal) * 100) : 0;
          let idxCounter = 0;

          return (
            <div className="corridor" id={`corridor-${c}`} key={c}>
              <div className="chead">
                <div className="name">E{pad(c)}</div>
                <span className="zone-tag">{zoneFor(c)}</span>
                <div className="meter">
                  {occN > 0 && (
                    <i style={{ width: `${(occN / corTotal) * 100}%`, background: "var(--occupied)" }} />
                  )}
                  {resN > 0 && (
                    <i style={{ width: `${(resN / corTotal) * 100}%`, background: "var(--reserved)" }} />
                  )}
                </div>
                <div className="pct">{pct}% πλήρης</div>
              </div>
              <div className="cols">
                {spec.map((rowCounts, ci) => (
                  <div className="colgroup" key={ci}>
                    <div className="collabel">Στ.{ci + 1}</div>
                    <div className="rows">
                      {rowCounts.map((count, ri) => (
                        <div className="rowline" key={ri}>
                          {Array.from({ length: count }, (_, pOffset) => {
                            const pp = pOffset + 1;
                            const idx = idxCounter++;
                            const code = codeFor(c, idx);
                            const slot = positionsByCode[code] ?? emptyLike(code, String(c), zoneFor(c));
                            const dim =
                              (filter !== "all" && slot.status !== filter) ||
                              (query !== "" && !matchesQuery(slot, query));
                            const match = query !== "" && matchesQuery(slot, query) && slot.product;
                            const selected = currentCode === code;
                            const cls = [
                              "cell",
                              slot.status,
                              dim ? "dim" : "",
                              match ? "match" : "",
                              selected ? "selected" : "",
                            ]
                              .filter(Boolean)
                              .join(" ");
                            return (
                              <div
                                key={code}
                                className={cls}
                                title={code + (slot.product ? " · " + slot.product : "")}
                                onClick={() => onCellClick(c, idx, code)}
                              >
                                {pp}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <SpecialSection
        positionsByCode={positionsByCode}
        filter={filter}
        query={query}
        currentCode={currentCode}
        onCellClick={onCellClick}
      />
    </>
  );
}

function SpecialSection({
  positionsByCode,
  filter,
  query,
  currentCode,
  onCellClick,
}: {
  positionsByCode: Record<string, Position>;
  filter: PositionStatus | "all";
  query: string;
  currentCode: string | null;
  onCellClick: (cid: number | string, idx: number, code: string) => void;
}) {
  const lay = layoutFor(SPECIAL_ID);
  if (!lay.length) return null;
  return (
    <div className="special-section">
      <div className="chead">
        <div className="name" style={{ minWidth: "auto" }}>
          Ειδικές θέσεις
        </div>
        <span className="zone-tag">{zoneFor(SPECIAL_ID)}</span>
      </div>
      <div className="special-pills">
        {lay.map((l, idx) => {
          if (!l.special) return null;
          const code = l.code;
          const slot = positionsByCode[code] ?? emptyLike(code, "special", zoneFor(SPECIAL_ID));
          const dim =
            (filter !== "all" && slot.status !== filter) || (query !== "" && !matchesQuery(slot, query));
          const selected = currentCode === code;
          const cls = ["special-pill", slot.status, dim ? "dim" : "", selected ? "selected" : ""]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={code}
              className={cls}
              onClick={() => onCellClick(SPECIAL_ID, idx, code)}
              type="button"
            >
              {code}
              {slot.product ? ` · ${slot.product}` : ""}
            </button>
          );
        })}
      </div>
    </div>
  );
}
