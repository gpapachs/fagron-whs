"use client";

import Link from "next/link";
import NavTabs from "@/components/NavTabs";
import LogoutButton from "@/components/auth/LogoutButton";
import ThemeMenu from "@/components/ThemeMenu";
import { displayUser } from "@/lib/users";
import { versionLabel, versionTitle } from "@/lib/version";

export default function AppBar({ email, role }: { email: string | null; role: "admin" | "staff" }) {
  const name = displayUser(email);
  const initial = (name || "?").trim().charAt(0).toUpperCase();
  return (
    <header className="appbar">
      <div className="appbar-inner">
        <Link href="/" className="brand" aria-label="Fagron WHS — αρχική">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-logo" src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/fagron-logo.svg`} alt="Fagron" width={84} height={22} />
          <span className="brand-name">
            <b>WHS</b>
          </span>
        </Link>
        <span className="version" title={versionTitle}>
          {versionLabel}
        </span>
        <NavTabs />
        <div className="appbar-user">
          <ThemeMenu />
          <span className="avatar" aria-hidden>
            {initial}
          </span>
          <span className="who">
            <span className="email">{name}</span>
            <span className="role">{role === "admin" ? "Διαχειριστής" : "Προσωπικό"}</span>
          </span>
          <LogoutButton />
        </div>
      </div>
    </header>
  );
}
