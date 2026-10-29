import { createClient } from "@/lib/supabase/server";
import Board from "@/components/board/Board";
import type { Position, Profile } from "@/lib/types";

export default async function HomePage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [{ data: positions }, { data: profile }] = await Promise.all([
    supabase.from("positions").select("*"),
    user
      ? supabase.from("profiles").select("*").eq("id", user.id).single()
      : Promise.resolve({ data: null }),
  ]);

  return (
    <Board
      initialPositions={(positions as Position[] | null) ?? []}
      userId={user?.id ?? null}
      userEmail={user?.email ?? null}
      role={(profile as Profile | null)?.role ?? "staff"}
    />
  );
}
