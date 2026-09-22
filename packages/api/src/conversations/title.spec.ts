import { publishConversationTitle } from './title';

test.each([true, false])(
  'final title is cached only when the conditional save succeeds: %s',
  async (accepted) => {
    const events: string[] = [];
    await publishConversationTitle(
      {
        userId: 'alice',
        conversationId: 'chat',
        title: 'Elastic title',
        immediate: false,
        onTitleGenerated: () => {
          events.push('emit');
        },
      },
      {
        cache: {
          get: async () => undefined,
          set: async () => {
            events.push('cache');
          },
          delete: async () => {},
        },
        saveConvo: async (context, data, options) => {
          expect(context.userId).toBe('alice');
          expect(data).toEqual({ conversationId: 'chat', title: 'Elastic title' });
          expect(options).toMatchObject({
            expectedTitle: 'New Chat',
            noUpsert: true,
            appendMessageIds: [],
          });
          events.push('save');
          return accepted ? { title: data.title } : null;
        },
        onEmitError: () => {},
      },
    );
    expect(events).toEqual(accepted ? ['save', 'cache', 'emit'] : ['save']);
  },
);

test('discarded final titles never write or publish', async () => {
  const controller = new AbortController();
  controller.abort();
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected call');
  };
  await expect(
    publishConversationTitle(
      {
        userId: 'alice',
        conversationId: 'chat',
        title: 'Elastic title',
        immediate: false,
        discardSignal: controller.signal,
      },
      {
        cache: { get: unexpected, set: unexpected, delete: unexpected },
        saveConvo: unexpected,
        onEmitError: () => {},
      },
    ),
  ).resolves.toBeUndefined();
});
