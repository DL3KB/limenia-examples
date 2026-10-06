import { LimeniaClient } from "./limenia.ts";

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing secret ${name}`);
  return value;
}

export const limeniaFromEnv = () =>
  new LimeniaClient({ baseUrl: Deno.env.get("LIMENIA_BASE_URL") || "https://app.limenia.eu", apiKey: required("LIMENIA_API_KEY") });

// The current secret and, during a rotation, the previous one.
export const webhookSecretsFromEnv = () =>
  [required("LIMENIA_WEBHOOK_SECRET"), Deno.env.get("LIMENIA_WEBHOOK_SECRET_PREVIOUS")].filter((s): s is string => !!s);

export const deviceSecretFromEnv = () => required("DEVICE_CHECK_SECRET");
