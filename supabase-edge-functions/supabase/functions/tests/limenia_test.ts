import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { LimeniaClient, LimeniaUnavailableError } from "../_shared/limenia.ts";

function client(responses: (Response | Error)[], sleeps: number[], calls: RequestInit[] = []) {
  const fetch = (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init!);
    const next = responses.shift()!;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return new LimeniaClient({ baseUrl: "https://limenia.test", apiKey: "k", fetch, sleep: (ms) => (sleeps.push(ms), Promise.resolve()) });
}

Deno.test("retries 503 and network errors with the same key and body", async () => {
  const sleeps: number[] = [];
  const calls: RequestInit[] = [];
  const result = await client(
    [new TypeError("x"), new Response(null, { status: 503 }), Response.json({ reportId: "r" }, { status: 201 })],
    sleeps,
    calls,
  )
    .request("POST", "/v1/reports", { body: { a: 1 }, idempotencyKey: "k1" });
  assertEquals(result.status, 201);
  assertEquals(sleeps, [1000, 2000]);
  for (const c of calls) {
    assertEquals((c.headers as Record<string, string>)["Idempotency-Key"], "k1");
    assertEquals(c.body, '{"a":1}');
  }
});

Deno.test("waits at least Retry-After, hands a longer one back", async () => {
  const sleeps: number[] = [];
  await client([new Response(null, { status: 429, headers: { "Retry-After": "30" } }), Response.json({})], sleeps).request(
    "GET",
    "/v1/ping",
  );
  assertEquals(sleeps, [30000]);
  const long = await client([new Response(null, { status: 429, headers: { "Retry-After": "31" } })], []).request("GET", "/v1/ping");
  assertEquals([long.status, long.retryAfter], [429, "31"]);
});

Deno.test("gives up after five attempts", async () => {
  const sleeps: number[] = [];
  await assertRejects(
    () => client(Array.from({ length: 5 }, () => new TypeError("x")), sleeps).request("GET", "/v1/ping"),
    LimeniaUnavailableError,
  );
  assertEquals(sleeps, [1000, 2000, 4000, 8000]);
});
