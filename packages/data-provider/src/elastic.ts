import { z } from 'zod';

export const elasticAdapterSchema = z
  .object({
    kibanaUrl: z.string().min(1),
    spaceId: z.string().default('default'),
    agentId: z.string().min(1),
    connectorId: z.string().optional(),
    apiKeyEnv: z.string().min(1).default('ELASTIC_API_KEY'),
    adapterKeyEnv: z.string().min(1).default('ELASTIC_ADAPTER_KEY'),
    model: z.string().min(1).default('elastic-agent'),
    host: z.string().min(1).default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(3091),
    timeoutMs: z.number().int().min(1000).max(3_600_000).default(120000),
    maxRequestBytes: z.number().int().positive().default(1_048_576),
    maxResponseBytes: z.number().int().positive().default(4_194_304),
    maxConcurrent: z.number().int().positive().default(8),
    stateDir: z.string().min(1).default('./data/elastic-adapter'),
  })
  .strict();

export type ElasticAdapterConfig = z.infer<typeof elasticAdapterSchema>;
