"use strict";

// What each Sempera node operation sends. Pure functions over a `request(method, path, {qs, body, idempotencyKey})`
// function, so the node file only wires n8n to them and the tests can run them against a fake HTTP layer.
//
// Sending a call or a text reaches a real person. Nothing that decides who is contacted is ever defaulted:
// the agent, the recipient and the consent sentence are required on every item.

const E164 = /^\+[1-9][0-9]{6,14}$/;

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

function text(name, value) {
  const s = typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value).trim();
  if (!s) throw new InputError(`${name} is required`);
  return s;
}

function phone(name, value) {
  const s = text(name, value);
  if (!E164.test(s)) throw new InputError(`${name} must be an E.164 number such as +14165550123`);
  return s;
}

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== "") out[k] = v;
  return out;
}

function metadataObject(fixedCollection) {
  const out = {};
  for (const row of fixedCollection?.values ?? []) {
    const key = text("metadata key", row.key);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) throw new InputError(`metadata key ${key} may use letters, digits and _, starting with a letter`);
    out[key] = String(row.value ?? "");
  }
  return out;
}

/** The key that names one intended send. Reused only when n8n re-runs the very same item of the same execution. */
function defaultIdempotencyKey({ workflowId, executionId, nodeName, itemIndex }) {
  const parts = ["n8n", workflowId, executionId, nodeName, itemIndex].map((p) => String(p ?? "x").replace(/[^A-Za-z0-9._-]+/g, "-"));
  return parts.join("-").slice(0, 255);
}

function buildSendCallBody(p) {
  const extra = p.additionalFields ?? {};
  const mode = extra.mode || undefined;
  if (mode === "prompt" && !extra.task) throw new InputError("Task is required when Mode is Prompt");
  if (mode === "prompt" && (extra.agentVersion || extra.production)) throw new InputError("Agent Version and Production cannot be used with Mode Prompt");
  if (extra.window && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(extra.window)) throw new InputError("Window must look like 09:00-18:00");
  const body = compact({
    agent_id: text("Agent ID", p.agentId),
    to: phone("To", p.to),
    consent_basis: text("Consent Basis", p.consentBasis),
    mode,
    message: p.message,
    task: extra.task,
    from: extra.from ? phone("From", extra.from) : undefined,
    voice: extra.voice,
    language: extra.language,
    agent_version: extra.agentVersion,
    production: extra.production ? true : undefined,
    timezone: extra.timezone,
    window: extra.window,
  });
  const metadata = metadataObject(extra.metadata);
  if (Object.keys(metadata).length) body.metadata = metadata;
  return body;
}

function buildSendSmsBody(p) {
  const extra = p.additionalFields ?? {};
  if (extra.window && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(extra.window)) throw new InputError("Window must look like 09:00-18:00");
  return compact({
    agent_id: text("Agent ID", p.agentId),
    agent_number: phone("From", p.from),
    user_number: phone("To", p.to),
    agent_message: text("Message", p.message),
    consent_basis: text("Consent Basis", p.consentBasis),
    timezone: extra.timezone,
    window: extra.window,
  });
}

/** Read one list, following `next_cursor` when `returnAll`; otherwise one page of at most `limit`. */
async function readList(request, path, query, { returnAll, limit }) {
  const items = [];
  let cursor;
  for (let pages = 0; pages < 1000; pages++) {
    const page = await request("GET", path, { qs: { ...query, limit: returnAll ? 200 : Math.min(Math.max(Number(limit) || 50, 1), 200), cursor } });
    items.push(...(page?.data ?? []));
    if (!returnAll && items.length >= (Number(limit) || 50)) return items.slice(0, Number(limit) || 50);
    if (!page?.has_more || !page?.next_cursor) return items;
    cursor = page.next_cursor;
  }
  throw new InputError("stopped after 1000 pages; narrow the query");
}

/**
 * @param {string} resource  call | sms | agent
 * @param {string} operation send | get | getMany
 * @param {object} p         the node's parameters
 * @param {function} request (method, path, {qs, body, idempotencyKey}) => parsed JSON
 * @param {string} idempotencyKey the key for a send
 * @returns {Promise<object[]>} the items to output
 */
async function runOperation(resource, operation, p, request, idempotencyKey) {
  if (resource === "call" && operation === "send") {
    return [await request("POST", "/v1/calls", { body: buildSendCallBody(p), idempotencyKey: text("Idempotency Key", p.idempotencyKey || idempotencyKey) })];
  }
  if (resource === "call" && operation === "get") {
    return [await request("GET", `/v1/calls/${encodeURIComponent(text("Call ID", p.callId))}`, { qs: { agent_id: p.agentId || undefined } })];
  }
  if (resource === "call" && operation === "getMany") {
    return readList(request, "/v1/calls", { agent_id: text("Agent ID", p.agentId) }, p);
  }
  if (resource === "sms" && operation === "send") {
    return [await request("POST", "/v1/sms/send", { body: buildSendSmsBody(p), idempotencyKey: text("Idempotency Key", p.idempotencyKey || idempotencyKey) })];
  }
  if (resource === "agent" && operation === "getMany") {
    return readList(request, "/v1/agents", { status: p.status || undefined }, p);
  }
  throw new InputError(`unsupported operation ${resource}/${operation}`);
}

module.exports = { InputError, buildSendCallBody, buildSendSmsBody, defaultIdempotencyKey, readList, runOperation };
