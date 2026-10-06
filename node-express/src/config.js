// Configuration from environment variables. The server refuses to start without them.

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

export function loadConfig() {
  return {
    baseUrl: (process.env.LIMENIA_BASE_URL || "https://app.limenia.eu").replace(/\/+$/, ""),
    apiKey: required("LIMENIA_API_KEY"),
    // The current secret and, during a rotation, the previous one.
    webhookSecrets: [required("LIMENIA_WEBHOOK_SECRET"), process.env.LIMENIA_WEBHOOK_SECRET_PREVIOUS].filter(Boolean),
    port: Number(process.env.PORT || 3000),
  };
}
