"use strict";

// Verify the `X-Sempera-Signature` header of a webhook delivery.
// The header is `t=<unix seconds>,v1=<lowercase hex HMAC-SHA256>`, the HMAC keyed with the endpoint secret over
// `"<t>." + raw_body`: the same scheme Sempera signs with. Verify the exact bytes received, before parsing JSON.

const { createHmac, timingSafeEqual } = require("node:crypto");

const SIGNATURE_HEADER = "x-sempera-signature";
const DEFAULT_TOLERANCE_SECONDS = 300;

/** @returns {{valid: true, timestamp: number} | {valid: false, reason: string}} */
function verifySignature(secret, body, header, { toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, now } = {}) {
  if (!secret) return { valid: false, reason: "no signing secret configured" };
  if (!header) return { valid: false, reason: "missing X-Sempera-Signature header" };
  if (body === undefined || body === null) return { valid: false, reason: "no raw body to check" };
  const parts = {};
  for (const piece of String(header).split(",")) {
    const i = piece.indexOf("=");
    if (i > 0) {
      const key = piece.slice(0, i).trim();
      if (!(key in parts)) parts[key] = piece.slice(i + 1).trim();
    }
  }
  const stamp = Number(parts.t);
  if (!parts.t || !Number.isInteger(stamp) || !parts.v1) return { valid: false, reason: "malformed X-Sempera-Signature header" };
  const clock = now ?? Date.now() / 1000;
  if (Math.abs(clock - stamp) > toleranceSeconds) {
    return { valid: false, reason: `timestamp is ${Math.round(Math.abs(clock - stamp))}s from this clock (tolerance ${toleranceSeconds}s)` };
  }
  const raw = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  const expected = Buffer.from(createHmac("sha256", secret).update(`${stamp}.`).update(raw).digest("hex"));
  const given = Buffer.from(parts.v1);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { valid: false, reason: "signature does not match the body and secret" };
  }
  return { valid: true, timestamp: stamp };
}

module.exports = { SIGNATURE_HEADER, DEFAULT_TOLERANCE_SECONDS, verifySignature };
