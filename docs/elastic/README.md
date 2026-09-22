# Elastic Agent Builder adapter

Run your existing Elastic agent from LibreChat's model selector. The adapter exposes an OpenAI-compatible `/v1/chat/completions` endpoint and calls Kibana's `/api/agent_builder/converse`. Elastic retains its agent instructions, tools and configured model connector (including LiteLLM). No new model provider credentials are needed in LibreChat.

## Local setup (RHEL)

Use Node 24 and your existing LibreChat/MongoDB setup. From the repository root, install and build:

```bash
npm ci
npm run frontend
```

If you do not have `librechat.yaml`, copy the example:

```bash
test -f librechat.yaml || cp docs/elastic/librechat.example.yaml librechat.yaml
```

If you already have that file, merge the example's `elasticAdapter` section and the `Elastic` entry into your existing `endpoints.custom` list. Do not replace your other settings. Both processes use `CONFIG_PATH` if set, otherwise `librechat.yaml` in the working directory.

Add these values to your root `.env` (keep it out of git):

```dotenv
ELASTIC_KIBANA_URL=https://your-kibana.example.com:9243
ELASTIC_SPACE_ID=your-team-space-id
ELASTIC_AGENT_ID=your-agent-id
ELASTIC_CONNECTOR_ID=
ELASTIC_API_KEY=your-encoded-elasticsearch-api-key
ELASTIC_ADAPTER_KEY=your-separate-random-adapter-secret
```

Generate a separate adapter secret with `openssl rand -hex 32`. Put its output in `ELASTIC_ADAPTER_KEY`. Use the encoded API key value for `ELASTIC_API_KEY`, without an `ApiKey ` prefix. The adapter requires a separate secret of at least 32 characters.

Use the **space ID from the URL** (`/s/team-id/`), not the team's display name. The adapter adds `/s/<spaceId>` automatically and preserves any reverse-proxy base path in `kibanaUrl`. Do not include the `/s/...` portion or `/api/...` endpoint in `ELASTIC_KIBANA_URL`. Set the space to `default` or an empty string for the default space.

Start the adapter in one terminal:

```bash
npm run elastic-adapter
```

Restart/start LibreChat in another terminal:

```bash
npm run backend
```

Open http://localhost:3080, select **Elastic → elastic-agent**, and send a message. `curl http://127.0.0.1:3091/healthz` checks that the adapter is listening (it does not test Elastic credentials).

## Choose a model connector

Set `ELASTIC_CONNECTOR_ID` in `.env` to the **Kibana connector ID**, not its display name or model name, then restart the adapter. Leave it empty or unset to use Elastic's default connector. Existing YAML files need no changes. The selected connector determines the model routing; LibreChat still shows `Elastic → elastic-agent`.

An optional `elasticAdapter.connectorId` in YAML overrides the environment setting and accepts a literal or `${ENV_VAR}`. An explicitly empty YAML value (`connectorId: ''`) uses Elastic's default even when the environment variable is set.

After installing this update, build once with `npm run build:data-provider && npm run build:api`. Subsequent connector changes only require restarting `npm run elastic-adapter`.

Switching connector IDs starts a fresh Elastic conversation with the visible LibreChat transcript. Start a new LibreChat chat if you do not want to pass prior context to the new connector.

## Change teams or agents

Edit `ELASTIC_SPACE_ID`, `ELASTIC_AGENT_ID` or `ELASTIC_KIBANA_URL` in `.env`, then restart **the adapter**. No rebuild is needed. You can also put literal values directly in the `elasticAdapter` YAML section instead of `${...}` placeholders. Changes to the endpoint URL, model name or adapter secret also require restarting LibreChat.

Conversation mappings are scoped to Kibana URL, space, agent, API-key identity, LibreChat tenant, user and chat. Changing the target starts a new Elastic conversation with the visible LibreChat history; it never sends the old space's Elastic conversation ID to the new space. Start a new LibreChat chat if you do not want to send prior chat context to the new target.

## Behaviour and limits

- Text chat and follow-ups are supported. The configured Elastic agent handles tool execution. Do not attach LibreChat tools to this endpoint; image/file attachments, tool-role messages and interactive Elastic approvals are rejected rather than silently executed or discarded.
- Answers use Elastic's synchronous Converse API. LibreChat receives a waiting stream with keep-alives, then the complete text answer; this is not token-by-token Elastic streaming. Tool traces, Kibana dashboards and interactive approval controls are not rendered in LibreChat.
- Successful linear follow-ups send only the latest user message and the stored Elastic conversation ID. Mappings survive adapter restarts and contain only conversation IDs and history hashes, not message text.
- Editing, regenerating, branching, changing the supplied history or losing the mapping starts a fresh Elastic conversation with the visible text transcript. Past tool calls are not individually replayed. LibreChat system/developer messages are included as user-provided context, not as overrides of the Elastic agent's instructions. Model sampling controls are not applied to the agent.
- Requests are never automatically retried by the adapter; the example disables LibreChat's provider retries. Cancelling in LibreChat aborts the HTTP request, but **does not guarantee that Elastic stops its work**. Timeout/disconnect invalidates the mapping before reuse to avoid appending to uncertain upstream state. An explicit retry may execute tools again; use read-only troubleshooting tools for this workflow.
- One adapter process should own a state directory. Concurrent requests for the same chat receive 409; total concurrent requests are bounded by `maxConcurrent`. Run one replica for this file-backed implementation. Retain `stateDir` on a persistent volume when containerizing. Deleting a LibreChat chat does not delete its Elastic history; manage Elastic retention separately. Stop the adapter before clearing obsolete local mapping files.
- The shared Elastic API key defines **every caller's Elastic privileges**. LibreChat conversation separation is not per-user Elastic authorization. Limit endpoint access and grant the key only the intended team's Agent Builder and data permissions. Secrets stay on the server; keep the adapter private to the LibreChat backend. Do not expose its key to browsers.

## Configuration

All settings are validated under `elasticAdapter` in `librechat.yaml`:

| Setting                | Default / purpose                                                      |
| ---------------------- | ---------------------------------------------------------------------- |
| `kibanaUrl`, `agentId` | Required; literals or `${ENV_VAR}`                                     |
| `spaceId`              | `default`; literal or `${ENV_VAR}`                                     |
| `connectorId`          | Optional; falls back to `ELASTIC_CONNECTOR_ID`, then Elastic's default |
| `apiKeyEnv`            | `ELASTIC_API_KEY`                                                      |
| `adapterKeyEnv`        | `ELASTIC_ADAPTER_KEY`                                                  |
| `host`, `port`         | `127.0.0.1`, `3091`                                                    |
| `model`                | `elastic-agent`; must match the custom endpoint's model                |
| `timeoutMs`            | `120000`                                                               |
| `maxRequestBytes`      | `1048576`                                                              |
| `maxResponseBytes`     | `4194304`                                                              |
| `maxConcurrent`        | `8`                                                                    |
| `stateDir`             | `./data/elastic-adapter` relative to working directory                 |

For an internal certificate authority, start Node with `NODE_EXTRA_CA_CERTS=/path/to/company-ca.pem`. Certificate verification stays enabled. Redirects from Kibana are rejected so API credentials cannot be forwarded to another host.

401 from the adapter means its shared secret does not match LibreChat's `apiKey`. An Elastic 401/403 error means check the Elastic key and space/agent/data privileges. Elastic 404 means check the base URL, space ID and agent ID. 504 means the configured timeout elapsed. Logs and error responses do not include Elastic response bodies, prompts or API keys.

## Verification and API references

The automated adapter tests use a local HTTP server in place of Elastic; they do not require access to your team's deployment. Live verification against your configured agent is still required.

- [Elastic Converse API](https://www.elastic.co/docs/api/doc/kibana/operation/operation-post-agent-builder-converse)
- [Elastic API overview and Spaces](https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/kibana-api)
- [Agent Builder API keys](https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/api-keys)
