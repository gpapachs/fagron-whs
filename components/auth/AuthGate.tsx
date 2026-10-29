"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export type SessionInfo = {
  userId: string;
  email: string | null;
  role: "admin" | "staff";
};

// Φρουρός σύνδεσης στον browser (η εφαρμογή είναι στατική, στο GitHub Pages,
// οπότε δεν υπάρχει server/middleware). Χωρίς σύνδεση -> /login.
// Η πραγματική προστασία των δεδομένων είναι στη βάση (RLS): χωρίς έγκυρη
// σύνδεση το Supabase δεν επιστρέφει καμία γραμμή, ό,τι κι αν κάνει ο browser.
export default function AuthGate({ children }: { children: (session: SessionInfo) => ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<SessionInfo | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (cancelled) return;
      if (!user) {
        router.replace("/login");
        return;
      }
      const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
      if (cancelled) return;
      setSession({
        userId: user.id,
        email: user.email ?? null,
        role: (profile?.role as "admin" | "staff" | undefined) ?? "staff",
      });
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") router.replace("/login");
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [router]);

  if (!session) return <PageLoading />;
  return <>{children(session)}</>;
}

export function PageLoading({ text = "Φόρτωση…" }: { text?: string }) {
  return (
    <div className="page-loading" role="status">
      <span className="spinner" aria-hidden />
      {text}
    </div>
  );
}
