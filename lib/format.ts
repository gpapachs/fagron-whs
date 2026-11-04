// Κοινές μορφές εμφάνισης.

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** «σήμερα 08:02», «χθες 14:10», «πριν 3 ημ.», αλλιώς «04/11/26» */
export function relDate(iso: string | null | undefined, withTime = true): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.round((dayStart(new Date()) - dayStart(d)) / 86400000);
  if (days === 0) return withTime ? `σήμερα ${hm(d)}` : "σήμερα";
  if (days === 1) return withTime ? `χθες ${hm(d)}` : "χθες";
  if (days > 1 && days < 7) return `πριν ${days} ημ.`;
  if (days === -1) return withTime ? `αύριο ${hm(d)}` : "αύριο";
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)}`;
}

/** πλήρης ημερομηνία για το title (tooltip) */
export function fullDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString("el-GR", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
