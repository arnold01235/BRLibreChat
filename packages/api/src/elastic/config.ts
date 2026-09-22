import { z } from 'zod';
import { load } from 'js-yaml';
import { readFile } from 'node:fs/promises';
import { elasticAdapterSchema } from 'librechat-data-provider';
import type { ElasticAdapterConfig } from 'librechat-data-provider';

export type AdapterSettings = ElasticAdapterConfig & { apiKey: string; adapterKey: string };

export async function loadAdapterSettings(
  configPath: string,
  env: NodeJS.ProcessEnv,
): Promise<AdapterSettings> {
  const parsed = z
    .object({ elasticAdapter: elasticAdapterSchema })
    .safeParse(load(await readFile(configPath, 'utf8')));
  if (!parsed.success) {
    throw new Error('Invalid or missing elasticAdapter configuration in librechat.yaml.');
  }
  const config = parsed.data.elasticAdapter;
  const expand = (value: string): string =>
    value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => {
      if (env[name] == null) {
        throw new Error(`Missing environment variable ${name}.`);
      }
      return env[name] ?? '';
    });
  const apiKey = env[config.apiKeyEnv]?.trim();
  const adapterKey = env[config.adapterKeyEnv]?.trim();
  if (!apiKey || !adapterKey || adapterKey.length < 32 || apiKey === adapterKey) {
    throw new Error(
      'Set separate Elastic and adapter keys; the adapter key must be at least 32 characters.',
    );
  }
  const settings = {
    ...config,
    kibanaUrl: expand(config.kibanaUrl).replace(/\/+$/, ''),
    spaceId: expand(config.spaceId),
    agentId: expand(config.agentId),
    connectorId:
      (config.connectorId === undefined
        ? env.ELASTIC_CONNECTOR_ID
        : expand(config.connectorId)
      )?.trim() || undefined,
    apiKey,
    adapterKey,
  };
  const url = new URL(settings.kibanaUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /\/s\/[^/]+\/?$/.test(url.pathname) ||
    !settings.agentId.trim() ||
    /[\r\n]/.test(apiKey)
  ) {
    throw new Error(
      'Use a Kibana base URL without credentials, query, fragment or /s/space; set spaceId separately.',
    );
  }
  return settings;
}
