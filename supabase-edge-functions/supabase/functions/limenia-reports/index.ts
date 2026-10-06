// POST /functions/v1/limenia-reports: report content or a user.
import { limeniaFromEnv } from "../_shared/config.ts";
import { createReportsHandler } from "../_shared/handlers.ts";
import { userFromRequest } from "../_shared/supabase.ts";

Deno.serve(createReportsHandler({ limenia: limeniaFromEnv(), userFromRequest }));
