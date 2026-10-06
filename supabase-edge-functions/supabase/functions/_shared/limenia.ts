// Minimal client for the Limenia ingest API (/v1) with plain fetch.
//
// Retries network errors, timeouts, 429 and 5xx with exponential backoff (1, 2, 4, 8 s)
// and waits at least Retry-After. Every attempt sends the same body and the same
// Idempotency-Key, so Limenia recognises the repetition and creates nothing twice.

export class LimeniaUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("Limenia could not be reached", { cause });
  }
}

export interface LimeniaResult {
  status: number;
  // deno-lint-ignore no-explicit-any
  body: any;
  retryAfter: string | null;
}

export interface RequestOptions {
  body?: unknown;
  idempotencyKey?: string;
  retry?: boolean;
}

export interface LimeniaApi {
  request(method: string, path: string, options?: RequestOptions): Promise<LimeniaResult>;
}

/** Retry-After in seconds (delta seconds or HTTP date), or null. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1000));
}

export class LimeniaClient implements LimeniaApi {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly maxWaitSeconds: number;

  constructor(options: {
    baseUrl: string;
    apiKey: string;
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    maxAttempts?: number;
    timeoutMs?: number;
    maxWaitSeconds?: number;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxAttempts = options.maxAttempts ?? 5;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxWaitSeconds = options.maxWaitSeconds ?? 30;
  }

  async request(method: string, path: string, { body, idempotencyKey, retry = true }: RequestOptions = {}): Promise<LimeniaResult> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const attempts = retry ? this.maxAttempts : 1;

    for (let attempt = 1;; attempt++) {
      const backoffMs = 1000 * 2 ** (attempt - 1);
      let res: Response;
      try {
        res = await this.fetch(`${this.baseUrl}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        if (attempt >= attempts) throw new LimeniaUnavailableError(err);
        await this.sleep(backoffMs);
        continue;
      }

      const retryAfter = res.headers.get("retry-after");
      if (attempt < attempts && (res.status === 429 || res.status >= 500)) {
        const waitSeconds = parseRetryAfter(retryAfter) ?? 0;
        if (waitSeconds <= this.maxWaitSeconds) {
          await res.body?.cancel();
          await this.sleep(Math.max(backoffMs, waitSeconds * 1000));
          continue;
        }
        // Longer than the app should wait: hand 429 and Retry-After to the app.
      }

      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null; // e.g. an HTML error page of a proxy
      }
      return { status: res.status, body: parsed, retryAfter };
    }
  }
}
