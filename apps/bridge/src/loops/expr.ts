/**
 * A deliberately tiny expression language for loop `when:` guards.
 *
 * Guards decide whether an agent runs, so they must not be evaluated with
 * `eval` or `new Function`: a loop YAML is a file on disk, and a file on disk
 * is not a trusted source of JavaScript. This parser supports exactly what a
 * guard needs — paths, literals, comparisons, and boolean joins — and nothing
 * that could reach the host.
 *
 * Grammar:
 *   or   := and ( '||' and )*
 *   and  := not ( '&&' not )*
 *   not  := '!' not | cmp
 *   cmp  := term ( ('=='|'!='|'>='|'<='|'>'|'<') term )?
 *   term := number | string | true | false | null | path | '(' or ')'
 */

export type Scope = Record<string, unknown>;

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ident'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lparen' }
  | { t: 'rparen' };

const OPS = ['&&', '||', '==', '!=', '>=', '<=', '>', '<', '!'];

export class GuardError extends Error {}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(') {
      out.push({ t: 'lparen' });
      i++;
      continue;
    }
    if (c === ')') {
      out.push({ t: 'rparen' });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end === -1) throw new GuardError(`unterminated string in guard: ${src}`);
      out.push({ t: 'str', v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i))!;
      out.push({ t: 'ident', v: m[0] });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new GuardError(`unexpected character "${c}" in guard: ${src}`);
    out.push({ t: 'op', v: op });
    i += op.length;
  }
  return out;
}

class Parser {
  private pos = 0;
  constructor(
    private readonly toks: Token[],
    private readonly scope: Scope,
    private readonly src: string,
  ) {}

  parse(): unknown {
    const v = this.or();
    if (this.pos !== this.toks.length) throw new GuardError(`trailing input in guard: ${this.src}`);
    return v;
  }

  private peekOp(...ops: string[]): boolean {
    const t = this.toks[this.pos];
    return !!t && t.t === 'op' && ops.includes(t.v);
  }

  private or(): unknown {
    let left = this.and();
    while (this.peekOp('||')) {
      this.pos++;
      const right = this.and();
      left = truthy(left) || truthy(right);
    }
    return left;
  }

  private and(): unknown {
    let left = this.not();
    while (this.peekOp('&&')) {
      this.pos++;
      const right = this.not();
      left = truthy(left) && truthy(right);
    }
    return left;
  }

  private not(): unknown {
    if (this.peekOp('!')) {
      this.pos++;
      return !truthy(this.not());
    }
    return this.cmp();
  }

  private cmp(): unknown {
    const left = this.term();
    if (this.peekOp('==', '!=', '>=', '<=', '>', '<')) {
      const op = (this.toks[this.pos] as { v: string }).v;
      this.pos++;
      const right = this.term();
      return compare(op, left, right);
    }
    return left;
  }

  private term(): unknown {
    const t = this.toks[this.pos];
    if (!t) throw new GuardError(`unexpected end of guard: ${this.src}`);
    if (t.t === 'lparen') {
      this.pos++;
      const v = this.or();
      const close = this.toks[this.pos];
      if (!close || close.t !== 'rparen') throw new GuardError(`missing ) in guard: ${this.src}`);
      this.pos++;
      return v;
    }
    this.pos++;
    if (t.t === 'num') return t.v;
    if (t.t === 'str') return t.v;
    if (t.t === 'ident') {
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'null') return null;
      return lookup(this.scope, t.v);
    }
    throw new GuardError(`unexpected token in guard: ${this.src}`);
  }
}

function lookup(scope: Scope, path: string): unknown {
  let cur: unknown = scope;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function compare(op: string, a: unknown, b: unknown): boolean {
  switch (op) {
    case '==':
      return a === b;
    case '!=':
      return a !== b;
    case '>':
      return num(a) > num(b);
    case '<':
      return num(a) < num(b);
    case '>=':
      return num(a) >= num(b);
    case '<=':
      return num(a) <= num(b);
    default:
      throw new GuardError(`unknown operator ${op}`);
  }
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

/**
 * Evaluate a guard. An unparseable or erroring guard resolves to FALSE: when a
 * loop cannot say for certain that a step should run, the step does not run.
 */
export function evaluateGuard(
  expr: string | undefined,
  scope: Scope,
): { value: boolean; error?: string } {
  if (!expr || !expr.trim()) return { value: true };
  try {
    return { value: truthy(new Parser(tokenize(expr), scope, expr).parse()) };
  } catch (err) {
    return { value: false, error: (err as Error).message };
  }
}
