import { z } from 'zod';

/**
 * Law 8 lives here. `bounds` has no defaults and no optional members on
 * purpose: a YAML missing any of the three fails validation at registration
 * rather than being silently filled in with something generous.
 */
export const LoopBounds = z.object({
  max_iterations_per_day: z.number().int().positive({
    message: 'Law 8: max_iterations_per_day is required and must be > 0',
  }),
  budget_per_run_usd: z.number().positive({
    message: 'Law 8: budget_per_run_usd is required and must be > 0',
  }),
  budget_per_day_usd: z.number().positive({
    message: 'Law 8: budget_per_day_usd is required and must be > 0',
  }),
});
export type LoopBounds = z.infer<typeof LoopBounds>;

export const DURATION_RE = /^(\d+)(s|m|h|d)$/;

export const LoopTrigger = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('cron'),
    every: z.string().regex(DURATION_RE, 'use a duration like 15m, 1h, 24h').optional(),
    at: z.string().regex(/^\d{2}:\d{2}$/, 'use HH:MM 24h local time').optional(),
    days: z.array(z.number().int().min(0).max(6)).optional(),
  }),
  z.object({ type: z.literal('event'), on: z.string().min(1) }),
  z.object({ type: z.literal('gate'), on: z.enum(['approved', 'denied', 'pending']) }),
  z.object({ type: z.literal('manual') }),
]);
export type LoopTrigger = z.infer<typeof LoopTrigger>;

export const LoopStep = z.object({
  /** Agent name or id. Resolved at registration; unknown agent = refuse. */
  agent: z.string().min(1),
  do: z.string().min(1),
  /** Guard expression evaluated against the run scope, e.g. "findings.novel > 0". */
  when: z.string().optional(),
  /** Names the step's structured output so later `when:` clauses can read it. */
  output: z.string().optional(),
  /** Parks the run at the gate until a human decides. */
  gated: z.boolean().default(false),
  maxTurns: z.number().int().positive().default(20),
  emits: z.array(z.string()).default([]),
});
export type LoopStep = z.infer<typeof LoopStep>;

export const LoopExitCondition = z.string().min(1);

export const LoopDefinition = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'loop names are lowercase-kebab'),
    description: z.string().default(''),
    trigger: LoopTrigger,
    bounds: LoopBounds,
    memory: z.boolean().default(true),
    /**
     * Law 7 stays the default. An overnight fleet may opt a single loop onto
     * metered billing; the key still comes from the OS keychain, never a file.
     */
    billing: z.enum(['subscription', 'api']).default('subscription'),
    steps: z.array(LoopStep).min(1),
    /** Law 8: a loop with no way to stop is not a loop, it is a leak. */
    exit: z.array(LoopExitCondition).min(1, {
      message: 'Law 8: at least one exit condition is required',
    }),
    enabled: z.boolean().default(false),
  })
  .superRefine((def, ctx) => {
    if (def.bounds.budget_per_run_usd > def.bounds.budget_per_day_usd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bounds', 'budget_per_run_usd'],
        message: 'budget_per_run_usd cannot exceed budget_per_day_usd',
      });
    }
    const known = new Set<string>();
    for (const [i, step] of def.steps.entries()) {
      if (step.when) {
        const root = step.when.trim().split(/[^A-Za-z0-9_]/)[0] ?? '';
        const reserved = ['gate', 'memory', 'run', 'true', 'false'];
        if (root && !known.has(root) && !reserved.includes(root) && !/^\d/.test(root)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['steps', i, 'when'],
            message: `"${root}" is not produced by any earlier step's output:`,
          });
        }
      }
      if (step.output) known.add(step.output);
    }
  });
export type LoopDefinition = z.infer<typeof LoopDefinition>;

export const LoopStatus = z.enum(['enabled', 'parked', 'disabled']);
export type LoopStatus = z.infer<typeof LoopStatus>;

export const LoopRunOutcome = z.enum([
  'clean',
  'ticket-filed',
  'fix-verified',
  'budget-exhausted',
  'iterations-capped',
  'waiting-gate',
  'error',
  'short-circuited',
  'parked',
]);
export type LoopRunOutcome = z.infer<typeof LoopRunOutcome>;

export function parseDurationMs(input: string): number {
  const m = DURATION_RE.exec(input.trim());
  if (!m) throw new Error(`bad duration: ${input}`);
  const n = Number(m[1]);
  const unit = m[2] as 's' | 'm' | 'h' | 'd';
  const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return n * mult;
}

/**
 * Validate a parsed YAML object. Returns a flat error list rather than throwing
 * so the console can render every problem in the editor at once.
 */
export function validateLoop(raw: unknown):
  | { ok: true; loop: LoopDefinition }
  | { ok: false; errors: Array<{ path: string; message: string }> } {
  const res = LoopDefinition.safeParse(raw);
  if (res.success) return { ok: true, loop: res.data };
  return {
    ok: false,
    errors: res.error.issues.map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.message,
    })),
  };
}
