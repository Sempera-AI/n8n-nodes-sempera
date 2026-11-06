"use strict";

const { verifySignature, DEFAULT_TOLERANCE_SECONDS } = require("./signature");

const EVENTS = ["call.completed", "call.outcomes", "agent.published", "test.completed", "metric_alert.triggered", "batch.updated", "webhook.test"];
const SEEN_LIMIT = 1000;

/** Remember an event id; true if it was seen before. Bounded, oldest dropped first. */
function seenBefore(staticData, id) {
  if (!id) return false;
  const list = Array.isArray(staticData.eventIds) ? staticData.eventIds : [];
  if (list.includes(id)) return true;
  list.push(id);
  staticData.eventIds = list.slice(-SEEN_LIMIT);
  return false;
}

/**
 * The whole decision for one delivery, apart from n8n: returns {status, items?, reason?}.
 * `items` is what the workflow receives; a delivery that is not accepted never reaches it.
 */
function handleDelivery({ secret, rawBody, signature, eventId, events, toleranceSeconds, staticData, now }) {
  const check = verifySignature(secret, rawBody, signature, { toleranceSeconds, now });
  if (!check.valid) return { status: 401, reason: check.reason };
  let event;
  try {
    event = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    return { status: 400, reason: "the body is not JSON" };
  }
  if (events.length && !events.includes(event.type)) return { status: 200, ignored: true };
  if (seenBefore(staticData, event.id ?? eventId)) return { status: 200, duplicate: true };
  return { status: 200, items: [event] };
}

class SemperaTrigger {
  constructor() {
    this.description = {
      displayName: "Sempera Trigger",
      name: "semperaTrigger",
      icon: "file:sempera.svg",
      group: ["trigger"],
      version: 1,
      subtitle: '={{$parameter["events"].join(", ")}}',
      description: "Starts a workflow when Sempera delivers a signed webhook event",
      defaults: { name: "Sempera Trigger" },
      inputs: [],
      outputs: ["main"],
      credentials: [{ name: "semperaWebhookApi", required: true }],
      webhooks: [{ name: "default", httpMethod: "POST", responseMode: "onReceived", path: "sempera" }],
      properties: [
        {
          displayName: "Events",
          name: "events",
          type: "multiOptions",
          default: ["call.completed"],
          description: "Only these events start the workflow; others are acknowledged and dropped. Leave empty to accept every event the endpoint receives.",
          options: EVENTS.map((e) => ({ name: e, value: e })),
        },
        {
          displayName: "Clock Tolerance (Seconds)",
          name: "toleranceSeconds",
          type: "number",
          default: DEFAULT_TOLERANCE_SECONDS,
          typeOptions: { minValue: 0, maxValue: 86400 },
          description: "How far the delivery's timestamp may differ from this server's clock",
        },
      ],
    };
  }

  async webhook() {
    const credentials = await this.getCredentials("semperaWebhookApi");
    const req = this.getRequestObject();
    const res = this.getResponseObject();
    const outcome = handleDelivery({
      secret: credentials.signingSecret,
      rawBody: req.rawBody,
      signature: req.headers["x-sempera-signature"],
      eventId: req.headers["x-sempera-event-id"],
      events: this.getNodeParameter("events", []),
      toleranceSeconds: this.getNodeParameter("toleranceSeconds", DEFAULT_TOLERANCE_SECONDS),
      staticData: this.getWorkflowStaticData("node"),
    });
    if (outcome.status !== 200) {
      res.status(outcome.status).json({ error: outcome.reason });
      return { noWebhookResponse: true };
    }
    if (!outcome.items) {
      res.status(200).json({ received: true });
      return { noWebhookResponse: true };
    }
    return { workflowData: [this.helpers.returnJsonArray(outcome.items)] };
  }
}

module.exports = { SemperaTrigger, handleDelivery, seenBefore, EVENTS };
