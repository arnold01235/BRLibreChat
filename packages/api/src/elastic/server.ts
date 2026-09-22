import express from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { ErrorRequestHandler, Response } from 'express';
import type { ConversationStore } from './store';
import type { AdapterSettings } from './config';
import type { ElasticClient } from './client';
import {
  AdapterError,
  completionSchema,
  digest,
  historyDigest,
  normalizeMessages,
  replayInput,
} from './protocol';

function sendError(res: Response, status: number, message: string): void {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  const error = { error: { message, type: 'adapter_error', code: String(status) } };
  if (res.headersSent) {
    res.end(`data: ${JSON.stringify(error)}\n\n`);
    return;
  }
  res.status(status).json(error);
}

export function createAdapterApp(
  config: AdapterSettings,
  client: ElasticClient,
  store: ConversationStore,
): express.Express {
  const app = express();
  app.disable('x-powered-by');
  const active = new Set<string>();
  const namespace = digest(
    JSON.stringify([
      config.kibanaUrl,
      config.spaceId,
      config.agentId,
      digest(config.apiKey),
      ...(config.connectorId ? [config.connectorId] : []),
    ]),
  );
  const expectedKey = Buffer.from(digest(`Bearer ${config.adapterKey}`));
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.use('/v1', (req, res, next) => {
    const actualKey = Buffer.from(digest(req.get('authorization') ?? ''));
    if (!timingSafeEqual(actualKey, expectedKey)) {
      sendError(res, 401, 'Invalid adapter API key.');
      return;
    }
    next();
  });
  app.use(express.json({ limit: config.maxRequestBytes }));
  app.get('/v1/models', (_req, res) => {
    res.json({
      object: 'list',
      data: [{ id: config.model, object: 'model', created: 0, owned_by: 'elastic' }],
    });
  });
  app.post('/v1/chat/completions', async (req, res) => {
    const parsed = completionSchema.safeParse(req.body);
    if (
      !parsed.success ||
      (parsed.data.model !== config.model && parsed.data.model !== config.titleModel)
    ) {
      sendError(
        res,
        400,
        'Use the configured model with text messages only; client-side tools and multiple completions are unsupported.',
      );
      return;
    }
    const user = req.get('x-librechat-user-id');
    const conversation = req.get('x-librechat-conversation-id');
    if (!user || !conversation || conversation === 'new' || /[{}]/.test(user + conversation)) {
      sendError(res, 400, 'Configure resolved LibreChat user and conversation ID headers.');
      return;
    }
    const key = digest(
      JSON.stringify([namespace, req.get('x-librechat-tenant-id') ?? '', user, conversation]),
    );
    if (parsed.data.model === config.titleModel) {
      try {
        if (parsed.data.stream) {
          sendError(
            res,
            400,
            'Title lookup requires a non-streaming completion. Set titleMethod to completion and titleTiming to final.',
          );
          return;
        }
        const state = await store.read(key);
        if (!state?.title) {
          sendError(res, 404, 'Elastic has not supplied a saved title for this conversation.');
          return;
        }
        res.json({
          id: `chatcmpl-${randomUUID()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: config.titleModel,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: state.title },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      } catch {
        sendError(res, 500, 'Unable to read the saved Elastic title.');
      }
      return;
    }
    if (active.has(key)) {
      sendError(res, 409, 'A request is already running for this conversation.');
      return;
    }
    if (active.size >= config.maxConcurrent) {
      sendError(res, 503, 'The adapter is busy. Retry after an active request completes.');
      return;
    }
    active.add(key);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);
    const onClose = (): void => {
      if (!res.writableEnded) {
        controller.abort();
      }
    };
    res.on('close', onClose);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      const messages = normalizeMessages(parsed.data.messages);
      const previous = await store.read(key);
      const continues = previous?.history === historyDigest(messages.slice(0, -1));
      const input = continues ? messages[messages.length - 1].content : replayInput(messages);
      // Invalidate before dispatch: a timeout/disconnect may still advance Elastic's history.
      await store.clear(key);
      controller.signal.throwIfAborted();
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const chunk = (
        delta: { role?: string; content?: string; reasoning_content?: string },
        finish: 'stop' | null = null,
      ): string =>
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: config.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      if (parsed.data.stream) {
        res.set({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
        res.write(chunk({ role: 'assistant' }));
        heartbeat = setInterval(() => {
          res.write(': keep-alive\n\n');
        }, 10000);
      }
      let activity = '';
      const reply = await client.converse(
        input,
        continues ? previous?.conversationId : undefined,
        controller.signal,
        config.showActivity
          ? (text) => {
              controller.signal.throwIfAborted();
              if (parsed.data.stream) {
                res.write(chunk({ reasoning_content: text }));
              } else {
                activity += text;
              }
            }
          : undefined,
      );
      controller.signal.throwIfAborted();
      await store.write(key, {
        conversationId: reply.conversation_id,
        ...(config.titleModel && (reply.title || (continues && previous?.title))
          ? { title: reply.title || previous?.title }
          : {}),
        history: historyDigest([
          ...messages,
          { role: 'assistant', content: reply.response.message },
        ]),
      });
      if (parsed.data.stream) {
        res.end(
          chunk({ content: reply.response.message }) + chunk({}, 'stop') + 'data: [DONE]\n\n',
        );
      } else {
        res.json({
          id,
          object: 'chat.completion',
          created,
          model: config.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: reply.response.message,
                ...(activity ? { reasoning_content: activity } : {}),
              },
              finish_reason: 'stop',
            },
          ],
        });
      }
    } catch (error) {
      if (timedOut) {
        sendError(
          res,
          504,
          'Elastic timed out. Its work may still be running; retrying starts a fresh conversation with visible chat context.',
        );
      } else if (!controller.signal.aborted) {
        sendError(
          res,
          error instanceof AdapterError ? error.status : 502,
          error instanceof AdapterError
            ? error.message
            : 'Adapter request failed. Check connectivity, TLS trust and writable state storage.',
        );
      }
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      res.off('close', onClose);
      active.delete(key);
    }
  });
  app.use((_req, res) => {
    sendError(res, 404, 'Unknown adapter endpoint.');
  });
  const errorHandler: ErrorRequestHandler = (
    error: Error & { status?: number },
    _req,
    res,
    _next,
  ) => {
    sendError(
      res,
      error.status === 413 ? 413 : 400,
      'Invalid JSON or request body exceeds maxRequestBytes.',
    );
  };
  app.use(errorHandler);
  return app;
}
