import type { AppConfig } from '@librechat/data-schemas';
import { SAFE_CONVERSATION_TITLE } from '../protection/title';

interface TitlePublication {
  userId: string;
  conversationId: string;
  title: string;
  immediate: boolean;
  isTemporary?: boolean;
  expiredAt?: Date;
  interfaceConfig?: AppConfig['interfaceConfig'];
  convoReady?: Promise<void>;
  signal?: AbortSignal;
  discardSignal?: AbortSignal;
  onTitleGenerated?: (value: { conversationId: string; title: string }) => Promise<void> | void;
}

interface TitleDependencies {
  cache: {
    get(key: string): Promise<string | undefined>;
    set(key: string, title: string, ttl: number): Promise<unknown>;
    delete(key: string): Promise<unknown>;
  };
  saveConvo(
    context: Pick<TitlePublication, 'userId' | 'isTemporary' | 'expiredAt' | 'interfaceConfig'>,
    data: { conversationId: string; title: string },
    options: { context: string; noUpsert: true; appendMessageIds: []; expectedTitle?: string },
  ): Promise<{ title: string } | { message: string } | null>;
  onEmitError(error: unknown): void;
}

/** Final titles are published only after an atomic save accepts the still-untitled chat. */
export async function publishConversationTitle(
  options: TitlePublication,
  { cache, saveConvo, onEmitError }: TitleDependencies,
): Promise<void> {
  const { userId, conversationId, title, immediate, signal, discardSignal } = options;
  const key = `${userId}-${conversationId}`;
  const publish = async (): Promise<void> => {
    await cache.set(key, title, 120000);
    if (!signal?.aborted && options.onTitleGenerated) {
      try {
        await options.onTitleGenerated({ conversationId, title });
      } catch (error) {
        onEmitError(error);
      }
    }
  };
  if (immediate) {
    await publish();
  }
  await options.convoReady;
  if (discardSignal?.aborted) {
    if (immediate && (await cache.get(key)) === title) {
      await cache.delete(key);
    }
    return;
  }
  const saved = await saveConvo(
    {
      userId,
      isTemporary: options.isTemporary,
      expiredAt: options.expiredAt,
      interfaceConfig: options.interfaceConfig,
    },
    { conversationId, title },
    {
      context: 'api/server/services/Endpoints/agents/title.js',
      noUpsert: true,
      appendMessageIds: [],
      ...(!immediate ? { expectedTitle: SAFE_CONVERSATION_TITLE } : {}),
    },
  );
  if (!immediate && saved && 'title' in saved && saved.title === title) {
    await publish();
  }
}
