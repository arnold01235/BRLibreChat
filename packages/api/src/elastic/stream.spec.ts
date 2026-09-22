import { elasticAdapterSchema } from 'librechat-data-provider';
import { readElasticStream } from './stream';

const config = {
  ...elasticAdapterSchema.parse({ kibanaUrl: 'https://kibana.example', agentId: 'agent' }),
  apiKey: 'secret-key',
  adapterKey: 'adapter-secret',
};
function response(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) {
          controller.enqueue(Uint8Array.of(byte));
        }
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
const round = 'event: round_complete\ndata: {"round":{"response":{"message":"Healthy"}}}\n\n';

test('handles fragmented UTF-8, CRLF, comments, multiline data and wrapped events', async () => {
  const activity: string[] = [];
  const stream = response(
    ': heartbeat\r\nevent: conversation_id_set\r\ndata: {"data":{"conversation_id":"chat"}}\r\n\r\n' +
      'event: reasoning\r\ndata: {"data":\r\ndata: {"reasoning":"Søker secret-key adapter-secret"}}\r\n\r\n' +
      'event: future_event\ndata: ignored\n\n' +
      round,
  );
  expect(await readElasticStream(stream, config, undefined, (text) => activity.push(text))).toEqual(
    {
      conversation_id: 'chat',
      response: { message: 'Healthy' },
    },
  );
  expect(activity.join('')).toBe('Søker [REDACTED] [REDACTED]\n\n');
});

test('accepts a completed answer without any activity events', async () => {
  expect(await readElasticStream(response(round), config, 'existing')).toMatchObject({
    conversation_id: 'existing',
    response: { message: 'Healthy' },
  });
});

test('accepts CR-only line endings including the final delimiter', async () => {
  expect(
    await readElasticStream(response(round.replace(/\n/g, '\r')), config, 'existing'),
  ).toMatchObject({ response: { message: 'Healthy' } });
});

test.each([
  '',
  'event: message_complete\ndata: {"message_content":"Partial"}\n\n',
  'event: round_complete\ndata: {"round":{}}\n\n',
  'event: round_complete\ndata: {"round":{"response":{"message":""}}}\n\n',
])('rejects incomplete rounds and approval-only responses: %s', async (text) => {
  await expect(readElasticStream(response(text), config, 'existing')).rejects.toThrow(
    'completed round',
  );
});

test('rejects missing conversation identity', async () => {
  await expect(readElasticStream(response(round), config)).rejects.toThrow('completed round');
});

test('rejects malformed events without exposing the body', async () => {
  await expect(
    readElasticStream(response('event: reasoning\ndata: secret-key\n\n'), config),
  ).rejects.toThrow('invalid activity event');
});

test('bounds stream bytes including ignored tool payloads', async () => {
  await expect(
    readElasticStream(response('event: tool_result\ndata: ' + 'x'.repeat(100)), {
      ...config,
      maxResponseBytes: 50,
    }),
  ).rejects.toThrow('maxResponseBytes');
});

test('rejects non-SSE responses', async () => {
  await expect(readElasticStream(new Response('{}'), config)).rejects.toThrow('activity stream');
});
