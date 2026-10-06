import { type LimeniaResult, LimeniaUnavailableError } from "./limenia.ts";

// CORS, needed when a web app calls the functions (supabase.functions.invoke).
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, idempotency-key",
  "Access-Control-Expose-Headers": "retry-after, idempotency-key",
};

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json", ...headers } });
}

export function problem(status: number, code: string, title: string, headers: Record<string, string> = {}): Response {
  return json(status, { type: "about:blank", title, status, code }, { ...headers, "content-type": "application/problem+json" });
}

/** Passes Limenia's status, problem body and Retry-After on to the app. */
export async function forward(call: () => Promise<LimeniaResult>, extraHeaders: Record<string, string> = {}): Promise<Response> {
  let result: LimeniaResult;
  try {
    result = await call();
  } catch (err) {
    if (err instanceof LimeniaUnavailableError) return problem(502, "limenia_unreachable", "Limenia could not be reached", extraHeaders);
    throw err;
  }
  const headers = { ...extraHeaders, ...(result.retryAfter ? { "retry-after": result.retryAfter } : {}) };
  // Note: a 401 from Limenia means the backend's API key is wrong, not that the app user
  // is signed out. Do not sign the user out in the app because of it.
  if (result.status >= 400) {
    const body = result.body ?? { type: "about:blank", title: "Upstream error", status: result.status, code: "upstream_error" };
    return json(result.status, body, { ...headers, "content-type": "application/problem+json" });
  }
  return json(result.status, result.body, headers);
}

/**
 * The app should create one key per report and send it again on every retry.
 * Without one, a key is made here; it then only covers our own retries.
 */
export function idempotencyKey(req: Request, kind: string): string {
  const fromApp = req.headers.get("idempotency-key");
  return fromApp && fromApp.length <= 200 ? fromApp : `${kind}-${crypto.randomUUID()}`;
}
