import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every test process gets its own ~/.helm. The suite must never be able to
// touch the operator's real fleet, database, or transcripts.
process.env.HELM_HOME = mkdtempSync(join(tmpdir(), 'helm-test-'));
process.env.HELM_TEST = '1';
