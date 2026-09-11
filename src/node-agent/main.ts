import process from 'node:process';
import { loadNodeAgentConfig, nodeAgentUsage } from './config.js';
import { startNodeAgentServer } from './server.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`Chat On Steroids Node Agent\n\nUsage: ${nodeAgentUsage()}`);
    return;
  }
  const configPath = argument('--config');
  if (!configPath) { console.error(`Missing --config. Usage: ${nodeAgentUsage()}`); process.exitCode = 2; return; }
  try {
    const config = await loadNodeAgentConfig(configPath);
    const server = await startNodeAgentServer(config, configPath);
    console.log(`Node Agent listening on ${server.address().host}:${server.address().port}`);
    const stop = () => { void server.close().then(() => process.exit(0)); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main();
