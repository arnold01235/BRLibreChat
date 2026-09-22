import { z } from 'zod';
import type { AdapterSettings } from './config';
import type { ElasticReply } from './client';
import { AdapterError } from './protocol';

const eventSchema = z.object({
  conversation_id: z.string().optional(),
  reasoning: z.string().optional(),
  message: z.string().optional(),
  tool_id: z.string().optional(),
  tool_call_id: z.string().optional(),
  round: z.object({ response: z.object({ message: z.string() }).optional() }).optional(),
});
const envelopeSchema = z.object({ data: eventSchema });

/** Reads SSE incrementally; only public activity text and tool names leave this boundary. */
export async function readElasticStream(
  response: Response,
  config: AdapterSettings,
  conversationId?: string,
  onActivity?: (text: string) => void,
): Promise<ElasticReply> {
  const reader = response.body?.getReader();
  if (!reader || !response.headers.get('content-type')?.includes('text/event-stream')) {
    await reader?.cancel();
    throw new AdapterError(502, 'Elastic did not return an activity stream.');
  }
  const decoder = new TextDecoder();
  const tools = new Map<string, string>();
  let buffer = '';
  let scanFrom = 0;
  let event = '';
  let data: string[] = [];
  let size = 0;
  let answer: string | undefined;
  const emit = (text: string): void => {
    for (const secret of [config.apiKey, config.adapterKey]) {
      text = text.split(secret).join('[REDACTED]');
    }
    if (text.trim()) {
      onActivity?.(`${text.trim()}\n\n`);
    }
  };
  const dispatch = (): void => {
    if (!data.length) {
      event = '';
      return;
    }
    const kind = event;
    const payload = data.join('\n');
    event = '';
    data = [];
    if (kind === 'error') {
      throw new AdapterError(
        502,
        'Elastic reported a streaming error. Check the agent and model provider.',
      );
    }
    if (
      ![
        'conversation_id_set',
        'conversation_created',
        'conversation_updated',
        'reasoning',
        'tool_call',
        'tool_progress',
        'tool_result',
        'round_complete',
      ].includes(kind)
    ) {
      return;
    }
    let parsed: z.infer<typeof eventSchema>;
    try {
      const json = JSON.parse(payload);
      const envelope = envelopeSchema.safeParse(json);
      parsed = envelope.success ? envelope.data.data : eventSchema.parse(json);
    } catch {
      throw new AdapterError(502, 'Elastic returned an invalid activity event.');
    }
    if (parsed.conversation_id) {
      conversationId = parsed.conversation_id;
    }
    if (kind === 'reasoning' && parsed.reasoning) {
      emit(parsed.reasoning);
    } else if (kind === 'tool_call' && parsed.tool_id && parsed.tool_call_id) {
      tools.set(parsed.tool_call_id, parsed.tool_id);
      emit(`▶ ${parsed.tool_id}`);
    } else if (kind === 'tool_progress' && parsed.message) {
      emit(parsed.message);
    } else if (kind === 'tool_result' && parsed.tool_call_id) {
      const name = tools.get(parsed.tool_call_id) ?? parsed.tool_id;
      if (name) {
        emit(`■ ${name}`);
      }
      tools.delete(parsed.tool_call_id);
    } else if (kind === 'round_complete') {
      answer = parsed.round?.response?.message;
    }
  };
  const line = (value: string): void => {
    if (!value) {
      dispatch();
    } else if (value.startsWith('event:')) {
      event = value.slice(6).trim();
    } else if (value === 'data' || value.startsWith('data:')) {
      data.push(value.slice(5).replace(/^ /, ''));
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer.endsWith('\r')) {
          line(buffer.slice(0, -1));
        }
        break;
      }
      size += value.byteLength;
      if (size > config.maxResponseBytes) {
        throw new AdapterError(502, 'Elastic response exceeded maxResponseBytes.');
      }
      buffer += decoder.decode(value, { stream: true });
      let offset = 0;
      let i = scanFrom;
      for (; i < buffer.length; i++) {
        const character = buffer[i];
        if (character !== '\n' && character !== '\r') {
          continue;
        }
        if (character === '\r' && i === buffer.length - 1) {
          break;
        }
        line(buffer.slice(offset, i));
        if (character === '\r' && buffer[i + 1] === '\n') {
          i++;
        }
        offset = i + 1;
      }
      buffer = buffer.slice(offset);
      scanFrom = i - offset;
    }
    if (!conversationId || !answer?.trim()) {
      throw new AdapterError(
        502,
        'Elastic stream ended without a completed round. Interactive approvals are unsupported; retry explicitly.',
      );
    }
    return { conversation_id: conversationId, response: { message: answer } };
  } finally {
    await reader.cancel();
  }
}
