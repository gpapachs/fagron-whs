"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Πλάνο Αποθήκης" },
  { href: "/repack", label: "Ανασυσκευασία" },
];

export default function NavTabs() {
  const pathname = usePathname();
  return (
    <nav className="navtabs" aria-label="Ενότητες">
      {LINKS.map((l) => {
        const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
        return (
          <Link key={l.href} href={l.href} className={active ? "on" : ""} aria-current={active ? "page" : undefined}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
