import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import chokidar, { type FSWatcher } from 'chokidar';
import { HelmConfig, type HelmConfig as HelmConfigT } from '@helm/core';
import { ensureHelmDirs, paths } from './paths.js';

/**
 * ~/.helm/config.json is the operator-editable source of truth for projects,
 * agents, and governor settings. The console writes it through the bridge API;
 * the bridge also watches the file so hand-edits take effect without a restart.
 */
export class ConfigStore extends EventEmitter {
  private current: HelmConfigT;
  private watcher: FSWatcher | null = null;
  private writingUntil = 0;

  constructor(private readonly file = paths.config) {
    super();
    ensureHelmDirs();
    this.current = this.load();
  }

  get(): HelmConfigT {
    return this.current;
  }

  private load(): HelmConfigT {
    if (!existsSync(this.file)) {
      const fresh = HelmConfig.parse({});
      this.writeFile(fresh);
      return fresh;
    }
    try {
      const parsed = HelmConfig.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      if (parsed.success) return parsed.data;
      this.emit('invalid', parsed.error.issues);
      return this.current ?? HelmConfig.parse({});
    } catch (err) {
      this.emit('invalid', [{ path: [], message: String(err) }]);
      return this.current ?? HelmConfig.parse({});
    }
  }

  /** Mutate and persist atomically. Returns the new config. */
  update(fn: (draft: HelmConfigT) => HelmConfigT | void): HelmConfigT {
    const draft = structuredClone(this.current);
    const next = HelmConfig.parse(fn(draft) ?? draft);
    this.current = next;
    this.writeFile(next);
    this.emit('change', next);
    return next;
  }

  private writeFile(cfg: HelmConfigT): void {
    // Suppress our own watcher echo.
    this.writingUntil = Date.now() + 500;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.file);
  }

  watch(): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.file, { ignoreInitial: true });
    this.watcher.on('all', () => {
      if (Date.now() < this.writingUntil) return;
      const next = this.load();
      this.current = next;
      this.emit('change', next);
    });
  }

  async close(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
  }
}
