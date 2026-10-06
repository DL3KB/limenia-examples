import assert from "node:assert/strict";
import { test } from "node:test";
import { deviceRequestHash, issueDeviceTicket, redeemDeviceTicket } from "../src/device-ticket.js";

test("request hash follows the documented formula", () => {
  // base64url(SHA-256("limenia:u_112:n1")) without padding, computed independently
  assert.equal(deviceRequestHash("u_112", "n1"), "CvuBqutH7GhuMXcNutV-bLyiJT3vYP7VCiBMg5Z5Zzg");
});

test("a ticket gives back the request hash only for the same user, before expiry", () => {
  const { ticket, requestHash } = issueDeviceTicket("u_1", "s3cret", 1000);
  assert.equal(redeemDeviceTicket(ticket, "u_1", "s3cret", 1000), requestHash);
  assert.equal(redeemDeviceTicket(ticket, "u_2", "s3cret", 1000), null);
  assert.equal(redeemDeviceTicket(ticket, "u_1", "other", 1000), null);
  assert.equal(redeemDeviceTicket(ticket, "u_1", "s3cret", 1000 + 601), null);
  assert.equal(redeemDeviceTicket("garbage", "u_1", "s3cret", 1000), null);
  assert.equal(redeemDeviceTicket(undefined, "u_1", "s3cret", 1000), null);
});
