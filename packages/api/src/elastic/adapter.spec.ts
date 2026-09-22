import os from 'node:os';
import OpenAI from 'openai';
import path from 'node:path';
import express from 'express';
import { load } from 'js-yaml';
import { once } from 'node:events';
import { initializeModel, Providers } from '@librechat/agents';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { elasticAdapterSchema, configSchema } from 'librechat-data-provider';
import type { AIMessageChunk } from '@librechat/agents';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { AdapterSettings } from './config';
import { loadAdapterSettings } from './config';
import { createElasticClient } from './client';
import { createAdapterApp } from './server';
import { createFileStore } from './store';

interface RecordedRequest {
  path: string;
  authorization?: string;
  csrf?: string;
  body: { input: string; agent_id: string; conversation_id?: string; connector_id?: string };
}

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${'a'.repeat(40)}`,
  'X-LibreChat-User-Id': 'alice',
  'X-LibreChat-Conversation-Id': 'chat-1',
};
const first = { model: 'elastic-agent', messages: [{ role: 'user', content: 'Check service A' }] };
const followup = {
  model: 'elastic-agent',
  messages: [
    ...first.messages,
    { role: 'assistant', content: 'Healthy' },
    { role: 'user', content: 'Why?' },
  ],
};

let directory: string;
let elastic: Server;
let adapter: Server;
let origin: string;
let config: AdapterSettings;
let calls: RecordedRequest[];
let upstreamStatus: number;
let upstreamDelay: number;
let malformed: boolean;
let upstreamClosed: boolean;
let releaseStream: (() => void) | undefined;
let streamFailure: boolean;

async function listen(app: express.Express): Promise<Server> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}
function serverUrl(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server): Promise<void> {
  const done = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await done;
}
async function startAdapter(): Promise<void> {
  adapter = await listen(
    createAdapterApp(config, createElasticClient(config), createFileStore(directory)),
  );
  origin = serverUrl(adapter);
}
function send(body: object = first, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...headers, ...extraHeaders },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'elastic-adapter-test-'));
  calls = [];
  upstreamStatus = 200;
  upstreamDelay = 0;
  malformed = false;
  upstreamClosed = false;
  releaseStream = undefined;
  streamFailure = false;
  const app = express();
  app.use(express.json());
  app.post('/base/s/:space/api/agent_builder/converse/async', async (req, res) => {
    calls.push({ path: req.originalUrl, body: req.body });
    res.set('Content-Type', 'text/event-stream');
    res.on('close', () => {
      upstreamClosed = true;
    });
    const event = (name: string, data: object): void => {
      res.write(`event: ${name}\ndata: ${JSON.stringify({ data })}\n\n`);
    };
    event('conversation_id_set', {
      conversation_id: req.body.conversation_id ?? `elastic-${calls.length}`,
    });
    event('reasoning', { reasoning: 'Checking APM data' });
    event('tool_call', {
      tool_call_id: 'call-1',
      tool_id: 'platform.core.search',
      params: { secret: 'private-parameters' },
    });
    event('tool_progress', { tool_call_id: 'call-1', message: 'Searching traces' });
    if (upstreamDelay) {
      await new Promise<void>((resolve) => {
        releaseStream = resolve;
        res.on('close', resolve);
      });
    }
    if (res.destroyed) {
      return;
    }
    if (streamFailure) {
      event('error', { message: 'private-upstream-error' });
      res.end();
      return;
    }
    event('tool_result', { tool_call_id: 'call-1', results: [{ data: 'private-results' }] });
    event('message_chunk', { text_chunk: 'Healthy' });
    event('round_complete', { round: { response: { message: 'Healthy' } } });
    res.end();
  });
  app.post('/base/s/:space/api/agent_builder/converse', async (req, res) => {
    calls.push({
      path: req.originalUrl,
      authorization: req.get('authorization'),
      csrf: req.get('kbn-xsrf'),
      body: req.body,
    });
    res.on('close', () => {
      upstreamClosed = true;
    });
    if (upstreamDelay) {
      await new Promise((resolve) => setTimeout(resolve, upstreamDelay));
    }
    res.status(upstreamStatus).json(
      malformed
        ? { secret: 'never forward this body' }
        : {
            conversation_id: req.body.conversation_id ?? `elastic-${calls.length}`,
            response: { message: 'Healthy' },
          },
    );
  });
  elastic = await listen(app);
  config = {
    ...elasticAdapterSchema.parse({
      kibanaUrl: `${serverUrl(elastic)}/base`,
      spaceId: 'team ops',
      agentId: 'troubleshooter',
    }),
    apiKey: 'elastic-secret',
    adapterKey: 'a'.repeat(40),
    stateDir: directory,
  };
  await startAdapter();
});

afterEach(async () => {
  await close(adapter);
  await close(elastic);
  await rm(directory, { recursive: true, force: true });
});

test('scopes the request to the team space and returns an OpenAI answer', async () => {
  const response = await send();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    object: 'chat.completion',
    choices: [{ message: { role: 'assistant', content: 'Healthy' }, finish_reason: 'stop' }],
  });
  expect(calls).toEqual([
    {
      path: '/base/s/team%20ops/api/agent_builder/converse',
      authorization: 'ApiKey elastic-secret',
      csrf: 'true',
      body: { agent_id: 'troubleshooter', input: 'Check service A' },
    },
  ]);
});

test('LibreChat model receives live thinking before the final answer and retains follow-up history', async () => {
  await close(adapter);
  config = { ...config, showActivity: true, connectorId: 'connector-a' };
  await startAdapter();
  upstreamDelay = 1;
  const model = initializeModel({
    provider: Providers.OPENAI,
    clientOptions: {
      model: config.model,
      apiKey: config.adapterKey,
      streaming: true,
      streamUsage: false,
      maxRetries: 0,
      configuration: { baseURL: `${origin}/v1`, defaultHeaders: headers },
    },
  });
  let reasoning = '';
  let answer = '';
  let sawLiveActivity = false;
  const stream = await model.stream('Check service A');
  for await (const value of stream) {
    const part = value as AIMessageChunk;
    const activity = part.additional_kwargs.reasoning_content;
    if (typeof activity === 'string') {
      reasoning += activity;
      if (!sawLiveActivity && reasoning.includes('Searching traces')) {
        expect(answer).toBe('');
        expect(upstreamClosed).toBe(false);
        sawLiveActivity = true;
        releaseStream?.();
      }
    }
    if (typeof part.content === 'string') {
      answer += part.content;
    }
  }
  expect(reasoning).toContain('Checking APM data');
  expect(reasoning).toContain('▶ platform.core.search');
  expect(reasoning).toContain('■ platform.core.search');
  expect(reasoning).not.toContain('private-');
  expect(answer).toBe('Healthy');
  expect(sawLiveActivity).toBe(true);
  expect(calls[0].body.connector_id).toBe('connector-a');
  upstreamDelay = 0;
  await close(adapter);
  await startAdapter();
  const response = await send(followup);
  expect(response.status).toBe(200);
  expect(calls[1].body.conversation_id).toBe('elastic-1');
  expect(calls[1].body.input).toBe('Why?');
  expect(await response.json()).toMatchObject({
    choices: [
      {
        message: {
          content: 'Healthy',
          reasoning_content: expect.stringContaining('Checking APM data'),
        },
      },
    ],
  });
});

test('streaming errors are sanitized and invalidate history even after activity was displayed', async () => {
  await close(adapter);
  config = { ...config, showActivity: true };
  await startAdapter();
  await send();
  streamFailure = true;
  const response = await send({ ...followup, stream: true });
  const body = await response.text();
  expect(body).toContain('Checking APM data');
  expect(body).toContain('Elastic reported a streaming error');
  expect(body).not.toContain('private-upstream-error');
  expect(body).not.toContain('[DONE]');
  streamFailure = false;
  await send(followup);
  expect(calls[2].body.conversation_id).toBeUndefined();
});

test('cancelling a live activity stream closes the Elastic connection', async () => {
  await close(adapter);
  config = { ...config, showActivity: true };
  await startAdapter();
  upstreamDelay = 1;
  const controller = new AbortController();
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers,
    signal: controller.signal,
    body: JSON.stringify({ ...first, stream: true }),
  });
  const reader = response.body!.getReader();
  let text = '';
  while (!text.includes('Searching traces')) {
    const part = await reader.read();
    if (part.done) {
      throw new Error('No activity received');
    }
    text += new TextDecoder().decode(part.value);
  }
  controller.abort();
  for (let i = 0; i < 100 && !upstreamClosed; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(upstreamClosed).toBe(true);
});

test('preserves linear history after an adapter restart and forwards only the new input', async () => {
  await send();
  await close(adapter);
  await startAdapter();
  expect((await send(followup)).status).toBe(200);
  expect(calls[1].body).toEqual({
    input: 'Why?',
    conversation_id: 'elastic-1',
    agent_id: 'troubleshooter',
  });
});

test('forwards the selected connector on initial requests and follow-ups', async () => {
  await close(adapter);
  config = { ...config, connectorId: 'connector-a' };
  await startAdapter();
  expect((await send()).status).toBe(200);
  expect((await send(followup)).status).toBe(200);
  expect(calls.map((call) => call.body.connector_id)).toEqual(['connector-a', 'connector-a']);
  expect(calls[1].body.conversation_id).toBe('elastic-1');
});

test('switching connectors starts fresh upstream history', async () => {
  await send();
  for (const connectorId of ['connector-a', 'connector-b']) {
    await close(adapter);
    config = { ...config, connectorId };
    await startAdapter();
    expect((await send(followup)).status).toBe(200);
    const body = calls[calls.length - 1].body;
    expect(body.connector_id).toBe(connectorId);
    expect(body.conversation_id).toBeUndefined();
    expect(body.input).toContain('Check service A');
  }
});

test('isolates users, tenants and separate LibreChat chats', async () => {
  await send();
  await send(followup, { 'X-LibreChat-User-Id': 'bob' });
  await send(followup, { 'X-LibreChat-Conversation-Id': 'chat-2' });
  await send(followup, { 'X-LibreChat-Tenant-Id': 'other-tenant' });
  expect(calls.slice(1).every((call) => call.body.conversation_id === undefined)).toBe(true);
});

test('changing the target never reuses a conversation ID from the old team', async () => {
  await send();
  await close(adapter);
  config = { ...config, spaceId: 'another-team', agentId: 'another-agent' };
  await startAdapter();
  await send(followup);
  expect(calls[1].path).toBe('/base/s/another-team/api/agent_builder/converse');
  expect(calls[1].body.conversation_id).toBeUndefined();
  expect(calls[1].body.input).toContain('Check service A');
});

test('edits and regeneration start fresh history instead of appending to stale Elastic rounds', async () => {
  await send();
  await send(first);
  await send({ ...followup, messages: [{ role: 'user', content: 'Edited question' }] });
  expect(calls.every((call) => !call.body.conversation_id)).toBe(true);
});

test('the OpenAI SDK can consume streaming and non-streaming answers', async () => {
  const sdk = new OpenAI({
    baseURL: `${origin}/v1`,
    apiKey: config.adapterKey,
    defaultHeaders: headers,
    maxRetries: 0,
  });
  const stream = await sdk.chat.completions.create({
    model: config.model,
    messages: [{ role: 'user', content: 'Hi' }],
    stream: true,
  });
  let answer = '';
  let finish: string | null = null;
  for await (const chunk of stream) {
    answer += chunk.choices[0]?.delta.content ?? '';
    finish = chunk.choices[0]?.finish_reason ?? finish;
  }
  expect(answer).toBe('Healthy');
  expect(finish).toBe('stop');
  const reply = await sdk.chat.completions.create({
    model: config.model,
    messages: [{ role: 'user', content: 'Hi again' }],
  });
  expect(reply.choices[0].message.content).toBe('Healthy');
});

test('requires backend authentication and resolved user/chat headers', async () => {
  expect((await send(first, { Authorization: 'Bearer wrong' })).status).toBe(401);
  expect((await send(first, { 'X-LibreChat-User-Id': '' })).status).toBe(400);
  expect(
    (await send(first, { 'X-LibreChat-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}' }))
      .status,
  ).toBe(400);
  expect((await fetch(`${origin}/v1/models`)).status).toBe(401);
  const models = await fetch(`${origin}/v1/models`, { headers });
  expect(await models.json()).toMatchObject({ data: [{ id: 'elastic-agent' }] });
  expect(calls).toHaveLength(0);
});

test.each([
  { ...first, model: 'unconfigured' },
  {
    ...first,
    messages: [
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'http://example.com/x.png' } }],
      },
    ],
  },
  { ...first, messages: [{ role: 'tool', content: 'result' }] },
  { ...first, tools: [{ type: 'function', function: { name: 'unwanted' } }] },
  { ...first, messages: [{ role: 'user', content: ' ' }] },
])('rejects unsupported input without contacting Elastic: %j', async (body) => {
  expect((await send(body)).status).toBe(400);
  expect(calls).toHaveLength(0);
});

test('upstream failures are sanitized and invalidate uncertain conversation state', async () => {
  await send();
  upstreamStatus = 403;
  malformed = true;
  const response = await send(followup);
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain('never forward');
  upstreamStatus = 200;
  malformed = false;
  await send(followup);
  expect(calls[2].body.conversation_id).toBeUndefined();
});

test('invalid Elastic response is reported as an error, not an empty successful answer', async () => {
  malformed = true;
  expect((await send()).status).toBe(502);
});

test('rejects simultaneous turns on one chat and accepts a retry after completion', async () => {
  upstreamDelay = 100;
  const pending = send();
  while (calls.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect((await send()).status).toBe(409);
  expect((await pending).status).toBe(200);
  expect((await send(followup)).status).toBe(200);
});

test.each([false, true])(
  'times out without retrying Elastic (activity: %s)',
  async (showActivity) => {
    await close(adapter);
    config = { ...config, timeoutMs: 40, showActivity };
    await startAdapter();
    upstreamDelay = 100;
    expect((await send()).status).toBe(504);
    expect(calls).toHaveLength(1);
  },
);

test('client cancellation closes the upstream request', async () => {
  upstreamDelay = 100;
  const controller = new AbortController();
  const pending = fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(first),
    signal: controller.signal,
  });
  while (calls.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  controller.abort();
  await expect(pending).rejects.toThrow();
  for (let i = 0; i < 30 && !upstreamClosed; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(upstreamClosed).toBe(true);
});

test('enforces request and upstream response size limits', async () => {
  await close(adapter);
  config = { ...config, maxRequestBytes: 200, maxResponseBytes: 10 };
  await startAdapter();
  expect(
    (await send({ ...first, messages: [{ role: 'user', content: 'x'.repeat(500) }] })).status,
  ).toBe(413);
  expect(calls).toHaveLength(0);
  expect((await send()).status).toBe(502);
});

test('loads the documented YAML through the shared config schema and expands target settings', async () => {
  const yaml = await readFile(
    path.resolve(__dirname, '../../../..', 'docs/elastic/librechat.example.yaml'),
    'utf8',
  );
  expect(configSchema.safeParse(load(yaml)).success).toBe(true);
  const filename = path.join(directory, 'librechat.yaml');
  await writeFile(filename, yaml);
  const env = {
    ELASTIC_KIBANA_URL: 'https://kibana.example.com/base/',
    ELASTIC_SPACE_ID: 'team-a',
    ELASTIC_AGENT_ID: 'agent-a',
    ELASTIC_API_KEY: 'key',
    ELASTIC_ADAPTER_KEY: 'a'.repeat(40),
  };
  const settings = await loadAdapterSettings(filename, env);
  expect(settings).toMatchObject({
    kibanaUrl: 'https://kibana.example.com/base',
    spaceId: 'team-a',
    agentId: 'agent-a',
    timeoutMs: 120000,
  });
  expect(configSchema.safeParse({ version: '1.3.5', elasticAdapter: settings }).success).toBe(
    false,
  );
  const { apiKey: _apiKey, adapterKey: _adapterKey, ...shared } = settings;
  expect(configSchema.safeParse({ version: '1.3.5', elasticAdapter: shared }).success).toBe(true);
  await expect(loadAdapterSettings(filename, { ...env, ELASTIC_ADAPTER_KEY: '' })).rejects.toThrow(
    'separate',
  );
  await expect(
    loadAdapterSettings(filename, {
      ...env,
      ELASTIC_KIBANA_URL: 'https://kibana.example.com/s/team-a',
    }),
  ).rejects.toThrow('base URL');
});

test('loads optional connector environment settings and YAML overrides', async () => {
  const filename = path.join(directory, 'connector.yaml');
  const env = { ELASTIC_API_KEY: 'key', ELASTIC_ADAPTER_KEY: 'a'.repeat(40) };
  const yaml = 'elasticAdapter:\n  kibanaUrl: https://kibana.example.com\n  agentId: agent-a\n';
  await writeFile(filename, yaml);
  expect((await loadAdapterSettings(filename, env)).connectorId).toBeUndefined();
  expect(
    (await loadAdapterSettings(filename, { ...env, ELASTIC_CONNECTOR_ID: '  ' })).connectorId,
  ).toBeUndefined();
  const selectedEnv = { ...env, ELASTIC_CONNECTOR_ID: ' connector-env ' };
  expect((await loadAdapterSettings(filename, selectedEnv)).connectorId).toBe('connector-env');
  await writeFile(filename, yaml + '  connectorId: connector-yaml\n');
  expect((await loadAdapterSettings(filename, selectedEnv)).connectorId).toBe('connector-yaml');
  await writeFile(filename, yaml + '  connectorId: "${CUSTOM_CONNECTOR}"\n');
  expect(
    (await loadAdapterSettings(filename, { ...selectedEnv, CUSTOM_CONNECTOR: 'custom' }))
      .connectorId,
  ).toBe('custom');
  await writeFile(filename, yaml + '  connectorId: ""\n');
  expect((await loadAdapterSettings(filename, selectedEnv)).connectorId).toBeUndefined();
});

test('streaming upstream errors reject through the OpenAI SDK', async () => {
  upstreamStatus = 403;
  const sdk = new OpenAI({
    baseURL: `${origin}/v1`,
    apiKey: config.adapterKey,
    defaultHeaders: headers,
    maxRetries: 0,
  });
  const consume = async (): Promise<void> => {
    const stream = await sdk.chat.completions.create({
      model: config.model,
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    for await (const _chunk of stream) {
      /* Drain until the upstream error. */
    }
  };
  await expect(consume()).rejects.toThrow('Elastic returned HTTP 403');
  expect(calls).toHaveLength(1);
});

test('bounds concurrent work across chats', async () => {
  await close(adapter);
  config = { ...config, maxConcurrent: 1 };
  await startAdapter();
  upstreamDelay = 100;
  const pending = send();
  while (calls.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect((await send(first, { 'X-LibreChat-Conversation-Id': 'other-chat' })).status).toBe(503);
  await pending;
});

test('default space omits the space prefix and redirects never leak credentials', async () => {
  const app = express();
  app.use(express.json());
  let called = false;
  app.post('/api/agent_builder/converse', (_req, res) => {
    called = true;
    res.redirect(307, `${serverUrl(elastic)}/base/s/forbidden/api/agent_builder/converse`);
  });
  const redirector = await listen(app);
  try {
    const client = createElasticClient({
      ...config,
      kibanaUrl: serverUrl(redirector),
      spaceId: 'default',
    });
    await expect(client.converse('Hi', undefined, new AbortController().signal)).rejects.toThrow();
    expect(called).toBe(true);
    expect(calls).toHaveLength(0);
  } finally {
    await close(redirector);
  }
});
