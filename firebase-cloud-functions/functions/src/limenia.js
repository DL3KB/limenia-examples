// Minimal client for the Limenia ingest API (/v1) with plain fetch.
//
// Retries network errors, timeouts, 429 and 5xx with exponential backoff (1, 2, 4, 8 s)
// and waits at least Retry-After. Every attempt sends the same body and the same
// Idempotency-Key, so Limenia recognises the repetition and creates nothing twice.

export class LimeniaUnavailableError extends Error {
  constructor(cause) {
    super("Limenia could not be reached", { cause });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry-After in seconds (delta seconds or HTTP date), or null. */
export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1000));
}

export class LimeniaClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl e.g. https://app.limenia.eu (without /v1)
   * @param {string} options.apiKey
   * @param {typeof fetch} [options.fetch]
   * @param {(ms: number) => Promise<void>} [options.sleep]
   * @param {number} [options.maxAttempts] attempts including the first one
   * @param {number} [options.timeoutMs] per attempt; the first request after a pause can be slow (cold start)
   * @param {number} [options.maxWaitSeconds] longest Retry-After we wait for while the app is waiting for us
   */
  constructor({ baseUrl, apiKey, fetch: fetchImpl = globalThis.fetch, sleep: sleepImpl = sleep, maxAttempts = 5, timeoutMs = 30_000, maxWaitSeconds = 30 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
    this.maxAttempts = maxAttempts;
    this.timeoutMs = timeoutMs;
    this.maxWaitSeconds = maxWaitSeconds;
  }

  /**
   * @returns {Promise<{status: number, body: any, retryAfter: string|null}>}
   *   Limenia's answer (also 4xx and 5xx). Throws LimeniaUnavailableError if no answer came.
   */
  async request(method, path, { body, idempotencyKey, retry = true } = {}) {
    const headers = { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const attempts = retry ? this.maxAttempts : 1;

    for (let attempt = 1; ; attempt++) {
      const backoffMs = 1000 * 2 ** (attempt - 1);
      let res;
      try {
        res = await this.fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
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
