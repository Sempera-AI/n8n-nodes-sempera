"use strict";

const { InputError, defaultIdempotencyKey, runOperation } = require("./operations");

const show = (resource, operation) => ({ show: { resource: [resource], ...(operation ? { operation: Array.isArray(operation) ? operation : [operation] } : {}) } });

// n8n-workflow is always present inside n8n; it is loaded lazily so this file can be tested without it.
function n8nErrors() {
  try {
    return require("n8n-workflow");
  } catch {
    return {};
  }
}

class Sempera {
  constructor() {
    this.description = {
      displayName: "Sempera",
      name: "sempera",
      icon: "file:sempera.svg",
      group: ["transform"],
      version: 1,
      subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
      description: "Place calls, send texts and read calls and agents with Sempera AI phone agents",
      defaults: { name: "Sempera" },
      inputs: ["main"],
      outputs: ["main"],
      usableAsTool: true,
      credentials: [{ name: "semperaApi", required: true }],
      properties: [
        {
          displayName: "Resource",
          name: "resource",
          type: "options",
          noDataExpression: true,
          options: [
            { name: "Agent", value: "agent" },
            { name: "Call", value: "call" },
            { name: "Text Message", value: "sms" },
          ],
          default: "call",
        },

        // ------------------------------------------------------------ Agent
        {
          displayName: "Operation",
          name: "operation",
          type: "options",
          noDataExpression: true,
          displayOptions: show("agent"),
          options: [{ name: "List", value: "getMany", action: "List agents", description: "List the agents of the workspace" }],
          default: "getMany",
        },
        {
          displayName: "Status",
          name: "status",
          type: "options",
          displayOptions: show("agent", "getMany"),
          options: [
            { name: "Active", value: "active" },
            { name: "Archived", value: "archived" },
            { name: "All", value: "all" },
          ],
          default: "active",
        },

        // ------------------------------------------------------------ Call
        {
          displayName: "Operation",
          name: "operation",
          type: "options",
          noDataExpression: true,
          displayOptions: show("call"),
          options: [
            { name: "Get", value: "get", action: "Get a call", description: "Read one call, with its transcript when there is one" },
            { name: "List", value: "getMany", action: "List calls", description: "List one agent's calls, newest first" },
            { name: "Send", value: "send", action: "Send a call", description: "Place one real outbound phone call" },
          ],
          default: "send",
        },
        {
          displayName: "Call ID",
          name: "callId",
          type: "string",
          required: true,
          default: "",
          displayOptions: show("call", "get"),
        },
        {
          displayName: "Agent ID",
          name: "agentId",
          type: "string",
          required: true,
          default: "",
          description: "The agent. For Send, the agent whose line places the call. Never filled in for you.",
          displayOptions: show("call", ["send", "getMany"]),
        },
        {
          displayName: "Agent ID",
          name: "agentId",
          type: "string",
          default: "",
          description: "Optional. Narrows the lookup to one agent",
          displayOptions: show("call", "get"),
        },
        {
          displayName: "To",
          name: "to",
          type: "string",
          required: true,
          default: "",
          placeholder: "+14165550123",
          description: "The person to call, in E.164 form. Never filled in for you.",
          displayOptions: show("call", "send"),
        },
        {
          displayName: "Consent Basis",
          name: "consentBasis",
          type: "string",
          required: true,
          default: "",
          placeholder: "This person asked Northwind Barbers to call them about Friday.",
          description: "One sentence recording why this person agreed to be called. Sempera records it and never invents it.",
          displayOptions: show("call", "send"),
        },
        {
          displayName: "Opening Message",
          name: "message",
          type: "string",
          default: "",
          description: "Optional opening line, spoken after the automated-call disclosure",
          displayOptions: show("call", "send"),
        },
        {
          displayName: "Additional Fields",
          name: "additionalFields",
          type: "collection",
          placeholder: "Add Field",
          default: {},
          displayOptions: show("call", "send"),
          options: [
            { displayName: "Agent Version", name: "agentVersion", type: "string", default: "", description: "A published version id or number. Not with Mode Prompt" },
            { displayName: "From", name: "from", type: "string", default: "", description: "An owned caller ID in E.164 form" },
            { displayName: "Idempotency Key", name: "idempotencyKey", type: "string", default: "", description: "Names this one intended call. Leave empty to use one built from the workflow, execution and item. A different request with the same key is refused." },
            { displayName: "Language", name: "language", type: "string", default: "" },
            {
              displayName: "Metadata",
              name: "metadata",
              type: "fixedCollection",
              typeOptions: { multipleValues: true },
              default: {},
              description: "Values for the agent's opening template, such as name",
              options: [{ displayName: "Values", name: "values", values: [
                { displayName: "Key", name: "key", type: "string", default: "" },
                { displayName: "Value", name: "value", type: "string", default: "" },
              ] }],
            },
            { displayName: "Mode", name: "mode", type: "options", default: "agent", options: [{ name: "Agent", value: "agent" }, { name: "Prompt", value: "prompt" }], description: "Agent: the published agent talks. Prompt: Task is the whole conversation." },
            { displayName: "Production", name: "production", type: "boolean", default: false, description: "Whether to use the production pin explicitly. Not with Mode Prompt" },
            { displayName: "Task", name: "task", type: "string", default: "", description: "What the call should accomplish. Required with Mode Prompt" },
            { displayName: "Timezone", name: "timezone", type: "string", default: "", placeholder: "America/Toronto", description: "The recipient's IANA time zone (the API's default is America/Toronto)" },
            { displayName: "Voice", name: "voice", type: "string", default: "", description: "A Sempera voice ID" },
            { displayName: "Window", name: "window", type: "string", default: "", placeholder: "09:00-18:00", description: "The recipient's hours, HH:MM-HH:MM. Outside them nothing is sent." },
          ],
        },

        // ------------------------------------------------------------ Text message
        {
          displayName: "Operation",
          name: "operation",
          type: "options",
          noDataExpression: true,
          displayOptions: show("sms"),
          options: [{ name: "Send", value: "send", action: "Send a text message", description: "Send one real text message" }],
          default: "send",
        },
        {
          displayName: "Agent ID",
          name: "agentId",
          type: "string",
          required: true,
          default: "",
          description: "The agent whose texting number sends the text. Never filled in for you.",
          displayOptions: show("sms", "send"),
        },
        {
          displayName: "From",
          name: "from",
          type: "string",
          required: true,
          default: "",
          placeholder: "+14165550199",
          description: "The agent's texting number, in E.164 form. It must be one the workspace lists as able to send texts.",
          displayOptions: show("sms", "send"),
        },
        {
          displayName: "To",
          name: "to",
          type: "string",
          required: true,
          default: "",
          placeholder: "+14165550123",
          description: "The recipient, in E.164 form. Never filled in for you.",
          displayOptions: show("sms", "send"),
        },
        {
          displayName: "Message",
          name: "message",
          type: "string",
          required: true,
          default: "",
          typeOptions: { rows: 3 },
          displayOptions: show("sms", "send"),
        },
        {
          displayName: "Consent Basis",
          name: "consentBasis",
          type: "string",
          required: true,
          default: "",
          placeholder: "This person asked for a text reminder.",
          description: "One sentence recording why this person agreed to be texted",
          displayOptions: show("sms", "send"),
        },
        {
          displayName: "Additional Fields",
          name: "additionalFields",
          type: "collection",
          placeholder: "Add Field",
          default: {},
          displayOptions: show("sms", "send"),
          options: [
            { displayName: "Idempotency Key", name: "idempotencyKey", type: "string", default: "", description: "Names this one intended text. Leave empty to use one built from the workflow, execution and item." },
            { displayName: "Timezone", name: "timezone", type: "string", default: "", placeholder: "America/Toronto" },
            { displayName: "Window", name: "window", type: "string", default: "", placeholder: "09:00-18:00", description: "The recipient's hours, HH:MM-HH:MM. Outside them nothing is sent." },
          ],
        },

        // ------------------------------------------------------------ Lists
        {
          displayName: "Return All",
          name: "returnAll",
          type: "boolean",
          default: false,
          description: "Whether to return all results or only up to a given limit",
          displayOptions: show(["agent", "call"], "getMany"),
        },
        {
          displayName: "Limit",
          name: "limit",
          type: "number",
          typeOptions: { minValue: 1, maxValue: 200 },
          default: 50,
          description: "Max number of results to return",
          displayOptions: { show: { resource: ["agent", "call"], operation: ["getMany"], returnAll: [false] } },
        },
      ],
    };
  }

  async execute() {
    const items = this.getInputData();
    const out = [];
    const credentials = await this.getCredentials("semperaApi");
    const baseUrl = String(credentials.baseUrl || "https://api.sempera.org").replace(/\/+$/, "");
    const { NodeApiError, NodeOperationError } = n8nErrors();

    for (let i = 0; i < items.length; i++) {
      try {
        const resource = this.getNodeParameter("resource", i);
        const operation = this.getNodeParameter("operation", i);
        const p = { resource, operation };
        for (const name of ["agentId", "callId", "to", "from", "message", "consentBasis", "status", "returnAll", "limit", "additionalFields"]) {
          const value = this.getNodeParameter(name, i, undefined);
          if (value !== undefined) p[name] = value;
        }
        p.idempotencyKey = p.additionalFields?.idempotencyKey;

        const request = async (method, path, { qs, body, idempotencyKey } = {}) => {
          const options = { method, url: baseUrl + path, json: true, headers: { Accept: "application/json" } };
          if (qs) options.qs = Object.fromEntries(Object.entries(qs).filter(([, v]) => v !== undefined && v !== null && v !== ""));
          if (body !== undefined) options.body = body;
          if (idempotencyKey) options.headers["Idempotency-Key"] = idempotencyKey;
          return this.helpers.httpRequestWithAuthentication.call(this, "semperaApi", options);
        };

        const key = defaultIdempotencyKey({
          workflowId: this.getWorkflow()?.id,
          executionId: this.getExecutionId?.(),
          nodeName: this.getNode().name,
          itemIndex: i,
        });
        const results = await runOperation(resource, operation, p, request, key);
        for (const r of results) out.push({ json: r ?? {}, pairedItem: { item: i } });
      } catch (error) {
        if (this.continueOnFail()) {
          out.push({ json: { error: error.message }, pairedItem: { item: i } });
          continue;
        }
        if (error instanceof InputError && NodeOperationError) throw new NodeOperationError(this.getNode(), error.message, { itemIndex: i });
        if (NodeApiError && !(error instanceof InputError) && !error?.context?.itemIndex) throw new NodeApiError(this.getNode(), error, { itemIndex: i });
        throw error;
      }
    }
    return [out];
  }
}

module.exports = { Sempera };
