import { z } from 'zod';
import type { AdapterSettings } from './config';
import { AdapterError } from './protocol';

export interface ElasticReply {
  conversation_id: string;
  response: { message: string };
}
export interface ElasticClient {
  converse(
    input: string,
    conversationId: string | undefined,
    signal: AbortSignal,
  ): Promise<ElasticReply>;
}

const replySchema = z.object({
  conversation_id: z.string().min(1),
  response: z.object({ message: z.string().min(1) }),
});

export function createElasticClient(config: AdapterSettings, request = fetch): ElasticClient {
  const space =
    config.spaceId && config.spaceId !== 'default'
      ? `/s/${encodeURIComponent(config.spaceId)}`
      : '';
  const url = `${config.kibanaUrl}${space}/api/agent_builder/converse`;
  return {
    async converse(input, conversationId, signal) {
      const response = await request(url, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `ApiKey ${config.apiKey}`,
          'kbn-xsrf': 'true',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agent_id: config.agentId,
          input,
          conversation_id: conversationId,
          ...(config.connectorId ? { connector_id: config.connectorId } : {}),
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        let hint = 'Check Elastic availability and retry explicitly.';
        if (response.status === 401 || response.status === 403) {
          hint = 'Check the Elastic API key and its agent, space and data permissions.';
        } else if (response.status === 404) {
          hint = 'Check the Kibana URL, space ID and agent ID.';
        }
        throw new AdapterError(
          response.status === 429 ? 429 : 502,
          `Elastic returned HTTP ${response.status}. ${hint}`,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) {
        throw new AdapterError(502, 'Elastic returned an empty response.');
      }
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          size += value.byteLength;
          if (size > config.maxResponseBytes) {
            throw new AdapterError(502, 'Elastic response exceeded maxResponseBytes.');
          }
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      try {
        return replySchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        throw new AdapterError(
          502,
          'Elastic did not return a completed text answer. Interactive approvals and attachments are not supported by this adapter.',
        );
      }
    },
  };
}
