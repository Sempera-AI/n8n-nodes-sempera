"use strict";

// The credential of the Sempera node: a workspace API key, sent as `Authorization: Bearer <key>`.
class SemperaApi {
  constructor() {
    this.name = "semperaApi";
    this.displayName = "Sempera API";
    this.documentationUrl = "https://api.sempera.org/openapi.json";
    this.properties = [
      {
        displayName: "API Key",
        name: "apiKey",
        type: "string",
        typeOptions: { password: true },
        default: "",
        required: true,
        description: "A workspace API key from the Sempera App, Settings, API keys. Give it only the scopes this workflow needs.",
      },
      {
        displayName: "Base URL",
        name: "baseUrl",
        type: "string",
        default: "https://api.sempera.org",
        description: "Leave as is unless Sempera gave you another API address",
      },
    ];
    this.authenticate = {
      type: "generic",
      properties: { headers: { Authorization: "=Bearer {{$credentials.apiKey}}" } },
    };
    // "Test" in the credential dialog: GET /v1/me names the key's workspace, role and scopes.
    this.test = {
      request: { baseURL: "={{$credentials.baseUrl}}", url: "/v1/me", method: "GET" },
    };
  }
}

module.exports = { SemperaApi };
