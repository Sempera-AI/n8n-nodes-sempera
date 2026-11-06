"use strict";

// Tests for the Sempera n8n nodes. The HTTP layer is a fake `httpRequestWithAuthentication` that records every
// request and answers from a script, and the n8n context is a small stand-in, so nothing here reaches a network.

const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { existsSync, readFileSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { describe, test } = require("node:test");

const ROOT = join(__dirname, "..");
const { Sempera } = require("../nodes/sempera/Sempera.node.js");
const { SemperaTrigger, handleDelivery } = require("../nodes/sempera/SemperaTrigger.node.js");
const { SemperaApi } = require("../credentials/SemperaApi.credentials.js");
const { SemperaWebhookApi } = require("../credentials/SemperaWebhookApi.credentials.js");
const { verifySignature } = require("../nodes/sempera/signature.js");
const { buildSendCallBody, buildSendSmsBody, defaultIdempotencyKey } = require("../nodes/sempera/operations.js");

// The known answer published in the webhooks guide.
const VECTOR = {
  secret: "whsec_vector_0123456789",
  t: 1790000000,
  body: '{"created_at":"2026-09-28T12:00:00+00:00","data":{"actor":"vector","endpoint_id":"22222222-2222-4222-8222-222222222222"},"id":"evt_00000000000000000000000000000001","object":"event","type":"webhook.test","workspace_id":"11111111-1111-4111-8111-111111111111"}',
  header: "t=1790000000,v1=1f4226699ca9fa61b71fbb57dbd2f57efa6788488437ee2e411ea4e3002be3c1",
};

function sign(secret, t, body) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.`).update(body).digest("hex")}`;
}

/** A stand-in for the context n8n gives `execute()`. `routes` maps "METHOD /path" to a function or a value. */
function context({ items = [{ json: {} }], params, routes = {}, continueOnFail = false }) {
  const requests = [];
  const ctx = {
    requests,
    getInputData: () => items,
    getCredentials: async () => ({ apiKey: "sempera_sk_test_0000", baseUrl: "https://api.sempera.org" }),
    getNodeParameter: (name, i, fallback) => {
      const p = Array.isArray(params) ? params[i] : params;
      return name in p ? p[name] : fallback;
    },
    getWorkflow: () => ({ id: "wf1" }),
    getExecutionId: () => "ex9",
    getNode: () => ({ name: "Sempera" }),
    continueOnFail: () => continueOnFail,
    helpers: {
      httpRequestWithAuthentication: async function (credentialName, options) {
        const u = new URL(options.url);
        requests.push({ credentialName, method: options.method, path: u.pathname, qs: options.qs ?? {}, body: options.body, headers: options.headers });
        const route = routes[`${options.method} ${u.pathname}`];
        if (route === undefined) throw Object.assign(new Error(`no route ${options.method} ${u.pathname}`), { httpCode: "404" });
        return typeof route === "function" ? route(options) : route;
      },
    },
  };
  return ctx;
}

const run = (ctx) => new Sempera().execute.call(ctx);

describe("Send call", () => {
  const params = {
    resource: "call", operation: "send", agentId: "northwind-barbers", to: "+14165550123",
    consentBasis: "This person asked Northwind Barbers to call them about Friday.", message: "Hello", additionalFields: {},
  };

  test("posts exactly what the user supplied, with an idempotency key and the stored credential", async () => {
    const ctx = context({ params, routes: { "POST /v1/calls": { id: "call-1", status: "answered" } } });
    const [out] = await run(ctx);
    assert.deepEqual(out.map((o) => o.json), [{ id: "call-1", status: "answered" }]);
    const [req] = ctx.requests;
    assert.equal(req.credentialName, "semperaApi");
    assert.deepEqual(req.body, { agent_id: "northwind-barbers", to: "+14165550123", consent_basis: params.consentBasis, message: "Hello" });
    assert.equal(req.headers["Idempotency-Key"], "n8n-wf1-ex9-Sempera-0");
  });

  test("never defaults who is contacted: each of agent, number and consent is required", () => {
    for (const missing of ["agentId", "to", "consentBasis"]) {
      assert.throws(() => buildSendCallBody({ ...params, [missing]: "" }), /is required/, missing);
      assert.throws(() => buildSendCallBody({ ...params, [missing]: "   " }), /is required/, missing);
    }
    assert.throws(() => buildSendCallBody({ ...params, to: "416-555-0123" }), /E\.164/);
  });

  test("nothing is sent when the input is invalid", async () => {
    const ctx = context({ params: { ...params, consentBasis: "" }, routes: { "POST /v1/calls": { id: "x" } } });
    await assert.rejects(run(ctx), /Consent Basis is required/);
    assert.equal(ctx.requests.length, 0);
  });

  test("prompt mode needs a task and refuses version pins; extras are passed through", () => {
    assert.throws(() => buildSendCallBody({ ...params, additionalFields: { mode: "prompt" } }), /Task is required/);
    assert.throws(() => buildSendCallBody({ ...params, additionalFields: { mode: "prompt", task: "t", production: true } }), /cannot be used with Mode Prompt/);
    assert.throws(() => buildSendCallBody({ ...params, additionalFields: { window: "9-6" } }), /Window/);
    const body = buildSendCallBody({ ...params, additionalFields: { from: "+14165550199", timezone: "America/Toronto", window: "09:00-17:00", metadata: { values: [{ key: "name", value: "Ada" }] } } });
    assert.equal(body.from, "+14165550199");
    assert.deepEqual(body.metadata, { name: "Ada" });
    assert.equal(body.window, "09:00-17:00");
  });

  test("an explicit idempotency key wins; the default is stable per item and execution", async () => {
    const ctx = context({ params: { ...params, additionalFields: { idempotencyKey: "my-key-1" } }, routes: { "POST /v1/calls": { id: "c" } } });
    await run(ctx);
    assert.equal(ctx.requests[0].headers["Idempotency-Key"], "my-key-1");
    assert.equal(defaultIdempotencyKey({ workflowId: "w", executionId: "e", nodeName: "Sempera 2", itemIndex: 3 }), "n8n-w-e-Sempera-2-3");
    assert.ok(defaultIdempotencyKey({ workflowId: "w", executionId: "e", nodeName: "x".repeat(400), itemIndex: 0 }).length <= 255);
  });

  test("an API refusal is thrown, not swallowed, and continue-on-fail turns it into an item", async () => {
    const refusal = Object.assign(new Error("outside calling hours"), { httpCode: "409" });
    const routes = { "POST /v1/calls": () => { throw refusal; } };
    // Inside n8n the error is wrapped in a NodeApiError, whose message is n8n's own; either way it is thrown.
    await assert.rejects(run(context({ params, routes })), (e) => e instanceof Error && e.message.length > 0);
    const [out] = await run(context({ params, routes, continueOnFail: true }));
    assert.equal(out.length, 1);
    assert.equal(typeof out[0].json.error, "string");
    assert.ok(out[0].json.error.length > 0);
  });

  test("each item is its own call with its own key", async () => {
    const items = [{ json: {} }, { json: {} }];
    const second = { ...params, to: "+14165550124" };
    const ctx = context({ items, params: [params, second], routes: { "POST /v1/calls": { id: "c" } } });
    await run(ctx);
    assert.deepEqual(ctx.requests.map((r) => r.body.to), ["+14165550123", "+14165550124"]);
    assert.notEqual(ctx.requests[0].headers["Idempotency-Key"], ctx.requests[1].headers["Idempotency-Key"]);
  });
});

describe("Send text message", () => {
  const params = {
    resource: "sms", operation: "send", agentId: "northwind-barbers", from: "+14165550199", to: "+14165550123",
    message: "See you Friday at 3.", consentBasis: "This person asked for a text reminder.", additionalFields: {},
  };

  test("posts the SMS body the API expects", async () => {
    const ctx = context({ params, routes: { "POST /v1/sms/send": { status: "sent" } } });
    await run(ctx);
    assert.deepEqual(ctx.requests[0].body, {
      agent_id: "northwind-barbers", agent_number: "+14165550199", user_number: "+14165550123",
      agent_message: "See you Friday at 3.", consent_basis: "This person asked for a text reminder.",
    });
    assert.ok(ctx.requests[0].headers["Idempotency-Key"]);
  });

  test("agent, both numbers, message and consent are required", () => {
    for (const missing of ["agentId", "from", "to", "message", "consentBasis"]) {
      assert.throws(() => buildSendSmsBody({ ...params, [missing]: "" }), /is required/, missing);
    }
  });
});

describe("Get and list", () => {
  test("Get call reads one call and narrows by agent only when asked", async () => {
    const routes = { "GET /v1/calls/call-1": { id: "call-1" } };
    const ctx = context({ params: { resource: "call", operation: "get", callId: "call-1", agentId: "" }, routes });
    const [out] = await run(ctx);
    assert.equal(out[0].json.id, "call-1");
    assert.deepEqual(ctx.requests[0].qs, {});
    const ctx2 = context({ params: { resource: "call", operation: "get", callId: "call-1", agentId: "a1" }, routes });
    await run(ctx2);
    assert.deepEqual(ctx2.requests[0].qs, { agent_id: "a1" });
  });

  test("List calls follows next_cursor when Return All is on", async () => {
    const pages = [
      { data: [{ id: "c1" }, { id: "c2" }], has_more: true, next_cursor: "cur-2" },
      { data: [{ id: "c3" }], has_more: false, next_cursor: null },
    ];
    let n = 0;
    const ctx = context({ params: { resource: "call", operation: "getMany", agentId: "a1", returnAll: true, limit: 50 }, routes: { "GET /v1/calls": () => pages[n++] } });
    const [out] = await run(ctx);
    assert.deepEqual(out.map((o) => o.json.id), ["c1", "c2", "c3"]);
    assert.deepEqual(ctx.requests.map((r) => r.qs.cursor), [undefined, "cur-2"]);
    assert.ok(ctx.requests.every((r) => r.qs.agent_id === "a1" && r.qs.limit === 200));
  });

  test("List calls needs an agent, and honours Limit", async () => {
    await assert.rejects(run(context({ params: { resource: "call", operation: "getMany", agentId: "", returnAll: false, limit: 5 }, routes: {} })), /Agent ID is required/);
    const ctx = context({ params: { resource: "call", operation: "getMany", agentId: "a1", returnAll: false, limit: 2 }, routes: { "GET /v1/calls": { data: [{ id: 1 }, { id: 2 }, { id: 3 }], has_more: true, next_cursor: "x" } } });
    const [out] = await run(ctx);
    assert.equal(out.length, 2);
    assert.equal(ctx.requests.length, 1);
  });

  test("List agents passes the status filter", async () => {
    const ctx = context({ params: { resource: "agent", operation: "getMany", status: "all", returnAll: false, limit: 50 }, routes: { "GET /v1/agents": { data: [{ id: "a1" }], has_more: false } } });
    const [out] = await run(ctx);
    assert.deepEqual(out.map((o) => o.json.id), ["a1"]);
    assert.equal(ctx.requests[0].qs.status, "all");
  });
});

describe("Sempera Trigger", () => {
  const body = Buffer.from(VECTOR.body);
  const base = { secret: VECTOR.secret, rawBody: body, signature: VECTOR.header, events: [], toleranceSeconds: 300, now: VECTOR.t + 5 };

  test("the published vector verifies", () => {
    assert.deepEqual(verifySignature(VECTOR.secret, VECTOR.body, VECTOR.header, { now: VECTOR.t }), { valid: true, timestamp: VECTOR.t });
  });

  test("matches what the server's signer produces: HMAC-SHA256 over '<t>.' + raw body, lowercase hex", () => {
    const raw = Buffer.from('{"id":"evt_1","object":"event","type":"call.completed"}');
    assert.equal(sign("s".repeat(20), 1790000100, raw).length, "t=1790000100,v1=".length + 64);
    assert.equal(verifySignature("s".repeat(20), raw, sign("s".repeat(20), 1790000100, raw), { now: 1790000100 }).valid, true);
  });

  test("a good delivery reaches the workflow; a bad one never does", () => {
    const ok = handleDelivery({ ...base, staticData: {} });
    assert.equal(ok.status, 200);
    assert.equal(ok.items[0].type, "webhook.test");
    const cases = {
      "wrong secret": { secret: "another-secret-value-123" },
      "changed body": { rawBody: Buffer.from(VECTOR.body.replace("vector", "vect0r")) },
      "no header": { signature: undefined },
      "malformed header": { signature: "v1=abc" },
      "no secret": { secret: "" },
      "no raw body": { rawBody: undefined },
      "stale timestamp": { now: VECTOR.t + 301 },
      "future timestamp": { now: VECTOR.t - 301 },
    };
    for (const [what, patch] of Object.entries(cases)) {
      const r = handleDelivery({ ...base, ...patch, staticData: {} });
      assert.equal(r.status, 401, what);
      assert.equal(r.items, undefined, what);
    }
  });

  test("the signature is checked before anything is parsed or filtered", () => {
    const r = handleDelivery({ ...base, rawBody: Buffer.from("not json"), staticData: {} });
    assert.equal(r.status, 401);
    const signed = Buffer.from("not json");
    const good = handleDelivery({ ...base, rawBody: signed, signature: sign(VECTOR.secret, VECTOR.t, signed), staticData: {} });
    assert.equal(good.status, 400);
  });

  test("an event outside the chosen list is acknowledged and dropped", () => {
    const r = handleDelivery({ ...base, events: ["call.completed"], staticData: {} });
    assert.deepEqual(r, { status: 200, ignored: true });
  });

  test("a repeated event id is dropped, and the memory is bounded", () => {
    const staticData = {};
    assert.ok(handleDelivery({ ...base, staticData }).items);
    assert.deepEqual(handleDelivery({ ...base, staticData }), { status: 200, duplicate: true });
    for (let i = 0; i < 1200; i++) {
      const b = Buffer.from(JSON.stringify({ id: `evt_${i}`, type: "call.completed" }));
      handleDelivery({ ...base, rawBody: b, signature: sign(VECTOR.secret, VECTOR.t, b), staticData });
    }
    assert.ok(staticData.eventIds.length <= 1000);
  });

  test("webhook() answers 401 on a bad signature and hands a good event to the workflow", async () => {
    const make = (headers, rawBody) => {
      const sent = {};
      const res = { status(c) { sent.status = c; return this; }, json(b) { sent.body = b; return this; } };
      return {
        sent,
        getCredentials: async () => ({ signingSecret: VECTOR.secret }),
        getRequestObject: () => ({ headers, rawBody }),
        getResponseObject: () => res,
        getNodeParameter: (name, fallback) => (name === "events" ? [] : fallback),
        getWorkflowStaticData: () => ({}),
        helpers: { returnJsonArray: (items) => items.map((json) => ({ json })) },
      };
    };
    const bad = make({ "x-sempera-signature": "t=1,v1=00" }, body);
    const r1 = await new SemperaTrigger().webhook.call(bad);
    assert.equal(bad.sent.status, 401);
    assert.deepEqual(r1, { noWebhookResponse: true });
    // The timestamp of the vector is old, so a fresh delivery is signed now.
    const t = Math.floor(Date.now() / 1000);
    const good = make({ "x-sempera-signature": sign(VECTOR.secret, t, body), "x-sempera-event-id": "evt_1" }, body);
    const r2 = await new SemperaTrigger().webhook.call(good);
    assert.equal(r2.workflowData[0][0].json.type, "webhook.test");
    assert.equal(good.sent.status, undefined);
  });
});

describe("package", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  test("follows the n8n community node conventions", () => {
    assert.equal(pkg.name, "n8n-nodes-sempera");
    assert.ok(pkg.keywords.includes("n8n-community-node-package"));
    assert.equal(pkg.license, "MIT");
    assert.equal(pkg.n8n.n8nNodesApiVersion, 1);
    assert.deepEqual(pkg.peerDependencies, { "n8n-workflow": "*" });
    assert.equal(pkg.dependencies, undefined, "community nodes ship no runtime dependencies");
    for (const f of [...pkg.n8n.nodes, ...pkg.n8n.credentials]) {
      assert.ok(existsSync(join(ROOT, f)), `${f} exists`);
      assert.ok(pkg.files.some((p) => f === p || f.startsWith(p + "/")), `${f} is published`);
    }
  });

  test("every node and credential is a class named after its file, with the fields n8n needs", () => {
    for (const f of pkg.n8n.nodes) {
      const cls = f.split("/").pop().replace(/\.node\.js$/, "");
      const mod = require(join(ROOT, f));
      assert.equal(typeof mod[cls], "function", f);
      const d = new mod[cls]().description;
      assert.equal(d.name, cls[0].toLowerCase() + cls.slice(1));
      assert.ok(existsSync(join(ROOT, "nodes/sempera", d.icon.replace("file:", ""))), "icon file");
      for (const c of d.credentials) assert.ok(pkg.n8n.credentials.some((p) => p.endsWith(`/${c.name[0].toUpperCase() + c.name.slice(1)}.credentials.js`)), c.name);
    }
    for (const f of pkg.n8n.credentials) {
      const cls = f.split("/").pop().replace(/\.credentials\.js$/, "");
      const c = new (require(join(ROOT, f))[cls])();
      assert.equal(c.name, cls[0].toLowerCase() + cls.slice(1));
      assert.ok(c.properties.some((p) => p.typeOptions?.password), "a secret field is masked");
    }
  });

  test("the API credential sends a Bearer key and tests itself with GET /v1/me", () => {
    const c = new SemperaApi();
    assert.equal(c.authenticate.properties.headers.Authorization, "=Bearer {{$credentials.apiKey}}");
    assert.equal(c.test.request.url, "/v1/me");
    assert.equal(c.properties.find((p) => p.name === "baseUrl").default, "https://api.sempera.org");
    assert.ok(new SemperaWebhookApi().properties[0].typeOptions.password);
  });

  test("the node offers exactly Send call, Get call, List calls, Send SMS and List agents", () => {
    const props = new Sempera().description.properties;
    const ops = (resource) => props.filter((p) => p.name === "operation" && p.displayOptions?.show?.resource?.includes(resource)).flatMap((p) => p.options.map((o) => o.value)).sort();
    assert.deepEqual(ops("call"), ["get", "getMany", "send"]);
    assert.deepEqual(ops("sms"), ["send"]);
    assert.deepEqual(ops("agent"), ["getMany"]);
    for (const name of ["agentId", "to", "consentBasis"]) {
      for (const p of props.filter((q) => q.name === name && q.displayOptions?.show?.operation?.includes("send"))) {
        assert.equal(p.default, "", `${name} has no default`);
        assert.equal(p.required, true, `${name} is required`);
      }
    }
  });

  test("no file holds a key, an em dash or a private host", () => {
    const em = String.fromCharCode(0x2014);
    const priv = new RegExp([["local", "host"].join(""), ["127", "0", "0", "1"].join("\\."), ["", "Users", ""].join("/")].join("|"));
    const walk = (dir) => readdirSync(dir).flatMap((n) => {
      if (n === "node_modules") return [];
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
    for (const f of walk(ROOT)) {
      const text = readFileSync(f, "utf8");
      assert.ok(!text.includes(em), `${f} has an em dash`);
      assert.ok(!/sempera_sk_[A-Za-z0-9]{8,}/.test(text), `${f} has a key`);
      assert.ok(!priv.test(text), `${f} has a private host`);
    }
  });
});
