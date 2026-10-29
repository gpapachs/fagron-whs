import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Server Component / Route Handler client -- reads the session from cookies.
// Never holds the service-role key: this app never needs to bypass RLS, so
// every read/write (here and in the browser) goes through the same
// authenticated-only policies defined in supabase/migrations/0001_init.sql.
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component render with no way to write
            // cookies -- fine, middleware.ts refreshes the session on every
            // request so the session still stays alive.
          }
        },
      },
    }
  );
}
