import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DesktopPorts {
  bridgePort: number;
  consolePort: number;
}

export const HELM_HOME = process.env.HELM_HOME || join(homedir(), '.helm');

/**
 * The desktop app is a shell around the same daemon and the same config file.
 * It reads the ports rather than inventing its own, so a packaged Helm and a
 * `pnpm helm` run behave identically — and collide loudly instead of quietly
 * running two fleets against one database.
 */
export function readPorts(): DesktopPorts {
  const fallback: DesktopPorts = { bridgePort: 8787, consolePort: 3777 };
  const file = join(HELM_HOME, 'config.json');
  if (!existsSync(file)) return fallback;
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as {
      governor?: { bridgePort?: number; consolePort?: number };
    };
    return {
      bridgePort: Number(cfg.governor?.bridgePort) || fallback.bridgePort,
      consolePort: Number(cfg.governor?.consolePort) || fallback.consolePort,
    };
  } catch {
    return fallback;
  }
}
