# n8n-nodes-sempera

[Documentation](https://docs.sempera.org) | [Getting started](https://docs.sempera.org/getting-started) | [OpenAPI document](https://api.sempera.org/openapi.json) | [MIT licence](LICENSE)

[n8n](https://n8n.io) community nodes for [Sempera](https://sempera.org) AI phone agents. Place a call, send a text, read calls, list agents, and start a workflow when Sempera delivers a signed webhook.

They call the public API at `https://api.sempera.org` (contract: [`/openapi.json`](https://api.sempera.org/openapi.json)) with your workspace API key.

## Install

In n8n: Settings, Community nodes, Install, and enter `n8n-nodes-sempera`. Self-hosted n8n can also install it from npm or from a clone of this repository:

```bash
cd ~/.n8n/custom        # create it if it does not exist
npm install n8n-nodes-sempera
# or, from a clone: npm install /path/to/n8n-nodes-sempera
```

Then restart n8n.

## Credentials

**Sempera API** holds a workspace API key. Create one in the Sempera App under Settings, API keys, with only the scopes the workflow needs (`calls:read` to read calls, `agents:read` to list agents, `calls:write` and an owner key to place calls and texts). The credential's Test button calls `GET /v1/me`.

**Sempera Webhook Signing Secret** holds the secret of one webhook endpoint, for the trigger.

## The Sempera node

| Resource | Operation | API |
|---|---|---|
| Call | Send | `POST /v1/calls` |
| Call | Get | `GET /v1/calls/{call_id}` |
| Call | List | `GET /v1/calls` |
| Text Message | Send | `POST /v1/sms/send` |
| Agent | List | `GET /v1/agents` |

List operations have Return All (follows every page) or a Limit.

### Sending is explicit

Calls and texts reach real people, so nothing about who is contacted is ever filled in for you. Every Send needs the Agent ID, the recipient number (E.164, such as `+14165550123`) and a Consent Basis: one sentence recording why this person agreed to be contacted. A text also needs the From number, which must be one the workspace lists as able to send texts. If any of them is empty the item fails before any request is made.

The API still applies calling and sending hours, the do-not-contact list, opt-outs, caps and billing. A refusal is raised as an error (or an output item if Continue On Fail is on); it is never retried with different values.

Each Send carries an `Idempotency-Key`. By default it is built from the workflow, the execution, the node and the item, so a retry of the very same item cannot act twice. Set Additional Fields, Idempotency Key to choose your own. A different request with a key already used is refused. If a send times out, the outcome is unknown: read the call or the App before running it again.

## The Sempera Trigger

Starts a workflow when Sempera delivers an event: `call.completed`, `call.outcomes`, `agent.published`, `test.completed`, `metric_alert.triggered`, `batch.updated` or `webhook.test`.

1. Add the trigger, pick the events, and create a Sempera Webhook Signing Secret credential with a secret of 16 to 256 characters.
2. Register the trigger's production URL with Sempera, using the same secret:

   ```bash
   curl -sS -X POST https://api.sempera.org/v1/webhooks \
     -H "Authorization: Bearer $SEMPERA_API_KEY" \
     -H "Idempotency-Key: $(uuidgen)" \
     -H "Content-Type: application/json" \
     -d '{"url": "<the trigger URL>", "events": ["call.completed"], "secret": "<the same secret>"}'
   ```

3. `POST /v1/webhooks/{id}/test` sends one signed `webhook.test` to check the wiring.

Every delivery is checked before the workflow sees it. Sempera signs `X-Sempera-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>`, the HMAC keyed with your secret over `"<t>." + raw_body`. The trigger verifies the exact bytes received with a constant-time comparison and rejects a delivery that is unsigned, malformed, altered, signed with another secret, or more than the Clock Tolerance (300 seconds by default) from this server's clock. A rejected delivery answers `401` and starts nothing. Delivery is at least once, so the trigger drops an event id it has already passed on (it remembers the last 1000). Events you did not select are acknowledged and ignored.

## Development

```bash
npm test
```

The nodes are plain CommonJS with no build step and no runtime dependencies; `n8n-workflow` is a peer dependency provided by n8n. The tests mock the HTTP layer and the n8n context: they prove request shapes, the explicit-send guards and the signature checks, not live API behaviour.

## Licence

MIT. Copyright Sempera Labs, Inc.
