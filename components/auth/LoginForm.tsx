"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toLoginEmail } from "@/lib/users";

export default function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // ήδη συνδεδεμένος -> κατευθείαν στην εφαρμογή
  useEffect(() => {
    createClient()
      .auth.getUser()
      .then(({ data: { user } }) => {
        if (user) router.replace("/");
      });
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: toLoginEmail(email), password });
    setLoading(false);
    if (signInError) {
      setError("Λάθος όνομα χρήστη / email ή κωδικός.");
      return;
    }
    router.replace("/");
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <label className="field">
        Όνομα χρήστη ή email
        <input
          type="text"
          required
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="π.χ. alex ή name@fagron.gr"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <label className="field">
        Κωδικός
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error && <p className="login-error">{error}</p>}
      <button className="btn primary" type="submit" disabled={loading}>
        {loading ? "Σύνδεση…" : "Σύνδεση"}
      </button>
    </form>
  );
}
