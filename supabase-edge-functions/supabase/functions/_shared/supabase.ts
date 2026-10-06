// Supabase clients and the signed-in user.
//
// The login is Supabase Auth: the app calls the functions with the user's access
// token (supabase.functions.invoke does that), and the Supabase user ID is the
// externalUserId at Limenia. If your app uses another login, replace userFromRequest.
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set automatically in hosted Edge
// Functions. The service role key bypasses Row Level Security: it stays in the
// functions and never goes to the app.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

let admin: SupabaseClient | undefined;

export function adminClient(): SupabaseClient {
  admin ??= createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return admin;
}

export type UserResolver = (req: Request) => Promise<string | null>;

/** The ID of the user whose access token came with the request, or null. */
export const userFromRequest: UserResolver = async (req) => {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await adminClient().auth.getUser(token); // the anon key alone is no user
  return error || !data.user ? null : data.user.id;
};

/** Processed webhook event IDs in the table limenia_webhook_events (see supabase/migrations). */
export function tableEventStore(client: () => SupabaseClient) {
  return {
    async isProcessed(eventId: string): Promise<boolean> {
      const { data, error } = await client().from("limenia_webhook_events").select("id").eq("id", eventId).maybeSingle();
      if (error) throw error;
      return data !== null;
    },
    async markProcessed(eventId: string): Promise<void> {
      const { error } = await client().from("limenia_webhook_events").upsert({ id: eventId });
      if (error) throw error;
    },
  };
}
