"use strict";

// The signing secret of one Sempera webhook endpoint. The Sempera Trigger uses it to check
// `X-Sempera-Signature` on every delivery, and refuses a delivery that does not match.
class SemperaWebhookApi {
  constructor() {
    this.name = "semperaWebhookApi";
    this.displayName = "Sempera Webhook Signing Secret";
    this.documentationUrl = "https://api.sempera.org/openapi.json";
    this.properties = [
      {
        displayName: "Signing Secret",
        name: "signingSecret",
        type: "string",
        typeOptions: { password: true },
        default: "",
        required: true,
        description: "The secret you set (16 to 256 characters) when you registered the endpoint with POST /v1/webhooks",
      },
    ];
  }
}

module.exports = { SemperaWebhookApi };
