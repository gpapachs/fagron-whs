"use client";

import Link from "next/link";
import NavTabs from "@/components/NavTabs";
import LogoutButton from "@/components/auth/LogoutButton";

export default function AppBar({ email, role }: { email: string | null; role: "admin" | "staff" }) {
  const initial = (email ?? "?").trim().charAt(0).toUpperCase();
  return (
    <header className="appbar">
      <div className="appbar-inner">
        <Link href="/" className="brand" aria-label="Fagron WHS — αρχική">
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden>
            <rect x="3" y="5" width="26" height="22" rx="3" fill="none" stroke="currentColor" strokeWidth="2.4" />
            <path d="M3 14h26M3 21h26M12 5v22M21 5v22" stroke="currentColor" strokeWidth="1.6" />
            <rect x="13.5" y="15.5" width="6" height="4" rx="0.8" fill="var(--rack)" />
          </svg>
          <span className="brand-name">
            Fagron <b>WHS</b>
          </span>
        </Link>
        <NavTabs />
        <div className="appbar-user">
          <span className="avatar" aria-hidden>
            {initial}
          </span>
          <span className="who">
            <span className="email">{email}</span>
            <span className="role">{role === "admin" ? "Διαχειριστής" : "Προσωπικό"}</span>
          </span>
          <LogoutButton />
        </div>
      </div>
    </header>
  );
}
