import { loadAdapterSettings } from './elastic/config';
import { createElasticClient } from './elastic/client';
import { createAdapterApp } from './elastic/server';
import { createFileStore } from './elastic/store';

export async function startElasticAdapter(
  configPath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const settings = await loadAdapterSettings(configPath, env);
  const app = createAdapterApp(
    settings,
    createElasticClient(settings),
    createFileStore(settings.stateDir),
  );
  const server = app.listen(settings.port, settings.host, () => {
    console.log(`Elastic adapter listening on ${settings.host}:${settings.port}`);
  });
  server.on('error', () => {
    console.error('Cannot start Elastic adapter listener. Check host, port and permissions.');
    process.exitCode = 1;
  });
}
