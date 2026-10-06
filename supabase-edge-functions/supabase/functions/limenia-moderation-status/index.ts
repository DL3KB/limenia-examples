// GET /functions/v1/limenia-moderation-status: moderation status of the signed-in user.
import { limeniaFromEnv } from "../_shared/config.ts";
import { createStatusHandler } from "../_shared/handlers.ts";
import { userFromRequest } from "../_shared/supabase.ts";

Deno.serve(createStatusHandler({ limenia: limeniaFromEnv(), userFromRequest }));
