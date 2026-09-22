require('dotenv/config');
const { startElasticAdapter } = require('../../packages/api/dist/elastic.cjs');

startElasticAdapter(process.env.CONFIG_PATH || 'librechat.yaml', process.env).catch(() => {
  console.error(
    'Elastic adapter startup failed. Check librechat.yaml, the Elastic API key and adapter key.',
  );
  process.exitCode = 1;
});
