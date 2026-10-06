// POST /functions/v1/limenia-devices/request-hash, then POST /functions/v1/limenia-devices/check.
import { deviceSecretFromEnv, limeniaFromEnv } from "../_shared/config.ts";
import { createDevicesHandler } from "../_shared/handlers.ts";
import { userFromRequest } from "../_shared/supabase.ts";

Deno.serve(createDevicesHandler({ limenia: limeniaFromEnv(), userFromRequest, deviceSecret: deviceSecretFromEnv() }));
