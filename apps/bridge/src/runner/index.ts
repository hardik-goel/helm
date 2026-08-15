import type { AgentRunner } from './types.js';
import { SdkAgentRunner } from './sdk-runner.js';
import { CliAgentRunner } from './cli-runner.js';

export * from './types.js';
export { SdkAgentRunner } from './sdk-runner.js';
export { CliAgentRunner } from './cli-runner.js';

/**
 * The one-line swap. HELM_RUNNER=cli forces the fallback; otherwise the SDK
 * path is used, dropping to the CLI only if the SDK cannot even be loaded.
 */
export function createRunner(): AgentRunner {
  if (process.env.HELM_RUNNER === 'cli') return new CliAgentRunner();
  try {
    return new SdkAgentRunner();
  } catch {
    return new CliAgentRunner();
  }
}
