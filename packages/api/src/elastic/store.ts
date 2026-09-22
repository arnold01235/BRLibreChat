import { z } from 'zod';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { AdapterError } from './protocol';

const stateSchema = z.object({
  conversationId: z.string().min(1),
  history: z.string().length(64),
  title: z.string().min(1).max(200).optional(),
});
export type ConversationState = z.infer<typeof stateSchema>;

export interface ConversationStore {
  read(key: string): Promise<ConversationState | undefined>;
  clear(key: string): Promise<void>;
  write(key: string, state: ConversationState): Promise<void>;
}

export function createFileStore(directory: string): ConversationStore {
  const file = (key: string): string => {
    if (!/^[a-f0-9]{64}$/.test(key)) {
      throw new Error('Invalid conversation storage key.');
    }
    return path.join(directory, `${key}.json`);
  };
  return {
    async read(key) {
      try {
        return stateSchema.parse(JSON.parse(await readFile(file(key), 'utf8')));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw new AdapterError(500, 'Unable to read adapter conversation state.');
      }
    },
    async clear(key) {
      await rm(file(key), { force: true });
    },
    async write(key, state) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = file(key);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}
