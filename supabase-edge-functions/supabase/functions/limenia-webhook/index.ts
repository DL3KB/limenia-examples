// POST /functions/v1/limenia-webhook: webhook receiver, called by Limenia.
// Deploy with --no-verify-jwt: Limenia sends no Supabase JWT, the signature is the authentication.
import { createActions } from "../_shared/actions.ts";
import { webhookSecretsFromEnv } from "../_shared/config.ts";
import { createWebhookHandler } from "../_shared/handlers.ts";
import { adminClient, tableEventStore } from "../_shared/supabase.ts";

Deno.serve(
  createWebhookHandler({
    secrets: webhookSecretsFromEnv(),
    store: tableEventStore(adminClient),
    actions: createActions(adminClient),
  }),
);
