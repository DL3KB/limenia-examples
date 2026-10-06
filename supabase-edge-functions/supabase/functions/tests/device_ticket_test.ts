import { assertEquals } from "jsr:@std/assert@1";
import { deviceRequestHash, issueDeviceTicket, redeemDeviceTicket } from "../_shared/device-ticket.ts";

Deno.test("request hash follows the documented formula", async () => {
  // base64url(SHA-256("limenia:u_112:n1")) without padding, computed independently
  assertEquals(await deviceRequestHash("u_112", "n1"), "CvuBqutH7GhuMXcNutV-bLyiJT3vYP7VCiBMg5Z5Zzg");
});

Deno.test("a ticket gives back the request hash only for the same user, before expiry", async () => {
  const { ticket, requestHash } = await issueDeviceTicket("u_1", "s3cret", 1000);
  assertEquals(await redeemDeviceTicket(ticket, "u_1", "s3cret", 1000), requestHash);
  assertEquals(await redeemDeviceTicket(ticket, "u_2", "s3cret", 1000), null);
  assertEquals(await redeemDeviceTicket(ticket, "u_1", "other", 1000), null);
  assertEquals(await redeemDeviceTicket(ticket, "u_1", "s3cret", 1601), null);
  assertEquals(await redeemDeviceTicket("garbage", "u_1", "s3cret", 1000), null);
});
