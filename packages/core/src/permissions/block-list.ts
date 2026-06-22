/**
 * L6a Phase D1 — Non-destructive block-list registry (permissions.md:24-40).
 *
 * This is the DECLARED LIST only. The PreToolUse enforcement hooks (Claude/Codex variants) that
 * actually block these at runtime are L7 (permissions.md:90-98) — NOT built here. This module
 * holds the canonical declared registry that the L7 hooks enforce and the drift check verifies.
 *
 * Philosophy: block ONLY the workarounds that bypass the gated/sanctioned path or destroy
 * state. Everything not on this list is permitted (Principle 6 — tools-do-the-work).
 */

/** The three non-destructive-boundary groupings (permissions.md:29-39). */
export type BlockCategory = 'destroys-repo-or-system' | 'bypasses-gate' | 'breaks-single-surface';

/** A single declared hard-block rule. */
export interface BlockRule {
  /** Stable unique id — also the key the drift check uses. */
  readonly id: string;
  readonly category: BlockCategory;
  readonly description: string;
  /** Pure predicate over the raw command string. Must not produce false positives. */
  readonly matches: (command: string) => boolean;
}

/** Runtime context the L7 enforcement hook may inject before evaluating a raw command string. */
export interface MatchBlockOptions {
  /** Shell variables already known from the surrounding command context. */
  readonly variables?: ReadonlyMap<string, string>;
  /** Git aliases resolved from the current repo/user/global config before matching. */
  readonly gitAliases?: ReadonlyMap<string, string | undefined>;
  /** GitHub CLI aliases resolved from the current config before matching. */
  readonly ghAliases?: ReadonlyMap<string, string>;
}

interface MatchBlockState {
  readonly variables: ReadonlyMap<string, string>;
  readonly gitAliases: ReadonlyMap<string, string | undefined>;
  readonly ghAliases: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Tokenize a shell command string into argv tokens without command normalization. */
function decodeAnsiEscape(command: string, start: number): { value: string; end: number } {
  const ch = command[start];
  if (ch == null) return { value: '\\', end: start - 1 };
  const simple = new Map<string, string>([
    ['a', '\u0007'],
    ['b', '\b'],
    ['e', '\u001b'],
    ['E', '\u001b'],
    ['f', '\f'],
    ['n', '\n'],
    ['r', '\r'],
    ['t', '\t'],
    ['v', '\v'],
    ['\\', '\\'],
    ["'", "'"],
    ['"', '"'],
  ]);
  const mapped = simple.get(ch);
  if (mapped != null) return { value: mapped, end: start };
  if (/[0-7]/u.test(ch)) {
    let end = start;
    while (end + 1 < command.length && end - start < 2 && /[0-7]/u.test(command[end + 1]!)) {
      end++;
    }
    return { value: String.fromCodePoint(Number.parseInt(command.slice(start, end + 1), 8)), end };
  }
  if (ch === 'x') {
    const hex = command.slice(start + 1, start + 3).match(/^[0-9a-fA-F]{1,2}/u)?.[0];
    if (hex != null) {
      return { value: String.fromCodePoint(Number.parseInt(hex, 16)), end: start + hex.length };
    }
  }
  if (ch === 'u' || ch === 'U') {
    const width = ch === 'u' ? 4 : 8;
    const hex = command
      .slice(start + 1, start + 1 + width)
      .match(new RegExp(`^[0-9a-fA-F]{1,${width}}`, 'u'))?.[0];
    if (hex != null) {
      return { value: String.fromCodePoint(Number.parseInt(hex, 16)), end: start + hex.length };
    }
  }
  return { value: ch, end: start };
}

interface ShellWord {
  readonly value: string;
  readonly quoted: boolean;
}

function rawTokenRecords(command: string): ShellWord[] {
  const tokens: ShellWord[] = [];
  let current = '';
  let currentQuoted = false;
  let quote: '"' | "'" | 'ansi' | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote != null) {
      if ((quote === 'ansi' && ch === "'") || ch === quote) {
        quote = undefined;
      } else if (quote === 'ansi' && ch === '\\') {
        const decoded = decodeAnsiEscape(command, i + 1);
        current += decoded.value;
        i = decoded.end;
      } else if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        current += command[++i]!;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '$' && command[i + 1] === "'") {
      quote = 'ansi';
      currentQuoted = true;
      i++;
      continue;
    }
    if (ch === '$' && command[i + 1] === '"') {
      quote = '"';
      currentQuoted = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      currentQuoted = true;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      current += command[++i]!;
      continue;
    }
    if (/\s/u.test(ch)) {
      if (current.length > 0) {
        tokens.push({ value: current, quoted: currentQuoted });
        current = '';
        currentQuoted = false;
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push({ value: current, quoted: currentQuoted });
  return tokens;
}

function rawTokens(command: string): string[] {
  return rawTokenRecords(command).map((token) => token.value);
}

const ENV_ASSIGN = /^[A-Z_][A-Z0-9_]*=/i;

interface EnvShortOptionCluster {
  readonly recognized: boolean;
  readonly clearsEnv: boolean;
  readonly consumesNext: boolean;
  readonly splitString?: string;
  readonly splitConsumesNext: boolean;
}

function parseEnvShortOptionCluster(token: string): EnvShortOptionCluster | undefined {
  if (!token.startsWith('-') || token.startsWith('--') || token === '-') return undefined;
  const body = token.slice(1);
  let clearsEnv = false;
  for (let i = 0; i < body.length; i++) {
    const option = body[i]!;
    if (option === 'S') {
      const attached = body.slice(i + 1);
      return {
        recognized: true,
        clearsEnv,
        consumesNext: false,
        splitString: attached.length > 0 ? attached : undefined,
        splitConsumesNext: attached.length === 0,
      };
    }
    if (option === 'u' || option === 'C' || option === 'a') {
      return {
        recognized: true,
        clearsEnv,
        consumesNext: body.slice(i + 1).length === 0,
        splitConsumesNext: false,
      };
    }
    if (option === 'i') {
      clearsEnv = true;
      continue;
    }
    if (option === '0' || option === 'v') continue;
    return undefined;
  }
  return { recognized: true, clearsEnv, consumesNext: false, splitConsumesNext: false };
}

function redirectionIndex(token: string): number {
  for (let i = 0; i < token.length; i++) {
    const ch = token[i]!;
    if (ch === '<' || ch === '>') return i;
  }
  return -1;
}

function redirectionHasAttachedTarget(token: string, index: number): boolean {
  let i = index + 1;
  if ((token[index] === '>' && (token[i] === '>' || token[i] === '|')) || token[index] === '<') {
    if (token[index] === '<' && token[i] === '<') i++;
    else if (token[index] === '>') i++;
  }
  return i < token.length;
}

function stripShellRedirections(tokens: readonly string[]): string[] {
  const out: string[] = [];
  let skipNext = false;
  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const index = redirectionIndex(token);
    if (index === -1) {
      out.push(token);
      continue;
    }
    const prefix = token.slice(0, index);
    if (prefix.length > 0 && !/^\d+$|^&$/u.test(prefix)) {
      out.push(prefix);
    }
    if (!redirectionHasAttachedTarget(token, index)) skipNext = true;
  }
  return out;
}

function stripShellRedirectionRecords(tokens: readonly ShellWord[]): ShellWord[] {
  const out: ShellWord[] = [];
  let skipNext = false;
  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const index = redirectionIndex(token.value);
    if (index === -1) {
      out.push(token);
      continue;
    }
    const prefix = token.value.slice(0, index);
    if (prefix.length > 0 && !/^\d+$|^&$/u.test(prefix)) {
      out.push({ value: prefix, quoted: token.quoted });
    }
    if (!redirectionHasAttachedTarget(token.value, index)) skipNext = true;
  }
  return out;
}

function stripLeadingEnvAssignments(tokens: readonly string[]): string[] {
  const envAssign = /^[A-Z_][A-Z0-9_]*=/i;
  let i = 0;
  while (i < tokens.length && envAssign.test(tokens[i]!)) i++;
  return tokens.slice(i);
}

function stripLeadingEnvAssignmentRecords(tokens: readonly ShellWord[]): ShellWord[] {
  let i = 0;
  while (i < tokens.length && ENV_ASSIGN.test(tokens[i]!.value)) i++;
  return tokens.slice(i);
}

function commandEnvAssignments(command: string): ReadonlyMap<string, string> {
  const env = new Map<string, string>();
  const tokens = rawTokens(command);
  let i = 0;
  while (i < tokens.length && ENV_ASSIGN.test(tokens[i]!)) {
    const token = tokens[i]!;
    const eq = token.indexOf('=');
    env.set(token.slice(0, eq), token.slice(eq + 1));
    i++;
  }
  const stripped = stripShellRedirections(tokens.slice(i));
  if (commandName(stripped[0]) !== 'env') return env;
  const mergeEnv = (other: ReadonlyMap<string, string>): void => {
    for (const [key, value] of other) env.set(key, value);
  };
  const valueOptions = new Set(['-u', '--unset', '-C', '--chdir', '-a', '--argv0']);
  for (let j = 1; j < stripped.length; j++) {
    const token = stripped[j]!;
    if (ENV_ASSIGN.test(token)) {
      const eq = token.indexOf('=');
      env.set(token.slice(0, eq), token.slice(eq + 1));
      continue;
    }
    if (token === '-S' || token === '--split-string') {
      const split = stripped[j + 1];
      if (split != null) mergeEnv(commandEnvAssignments(split));
      break;
    }
    if (token.startsWith('-S') && token !== '-S' && !token.startsWith('--')) {
      mergeEnv(commandEnvAssignments(token.slice(2)));
      break;
    }
    if (token.startsWith('--split-string=')) {
      mergeEnv(commandEnvAssignments(token.slice('--split-string='.length)));
      break;
    }
    const shortOptions = parseEnvShortOptionCluster(token);
    if (shortOptions?.splitString != null) {
      if (shortOptions.clearsEnv) env.clear();
      mergeEnv(commandEnvAssignments(shortOptions.splitString));
      break;
    }
    if (shortOptions?.splitConsumesNext === true) {
      if (shortOptions.clearsEnv) env.clear();
      const split = stripped[j + 1];
      if (split != null) mergeEnv(commandEnvAssignments(split));
      break;
    }
    if (shortOptions?.recognized === true) {
      if (shortOptions.clearsEnv) env.clear();
      if (shortOptions.consumesNext) j++;
      continue;
    }
    if (token === '-i' || token === '-' || token === '--ignore-environment') {
      env.clear();
      continue;
    }
    const eq = token.indexOf('=');
    const optionName = eq === -1 ? token : token.slice(0, eq);
    if (valueOptions.has(optionName)) {
      if (eq === -1) j++;
      continue;
    }
    if (token === '--') continue;
    if (token.startsWith('-')) continue;
    break;
  }
  return env;
}

/**
 * Tokenize a shell command string into argv tokens, stripping leading
 * `KEY=VALUE` environment assignments so `FOO=bar git push` tokenizes as
 * `['git', 'push']`.
 */
function tokenize(command: string): string[] {
  return normalizeCommand(stripLeadingEnvAssignments(stripShellRedirections(rawTokens(command))));
}

function tokenizeWithQuoteMetadata(command: string): ShellWord[] {
  const stripped = stripLeadingEnvAssignmentRecords(
    stripShellRedirectionRecords(rawTokenRecords(command)),
  );
  const values = stripped.map((token) => token.value);
  const normalized = normalizeCommand(values);
  if (normalized.length === values.length && normalized.every((value, i) => value === values[i])) {
    return stripped;
  }
  return normalized.map((value) => ({ value, quoted: false }));
}

function normalizeShellLineContinuations(command: string): string {
  return command.replace(/\\\r?\n/gu, '');
}

function stripShellComments(command: string): string {
  let output = '';
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote != null) {
      output += ch;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        output += command[++i]!;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      output += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      output += ch + command[++i]!;
      continue;
    }
    if (ch === '$' && command[i + 1] === '(') {
      const balanced = readBalanced(command, i + 2, '(', ')');
      if (balanced != null) {
        output += command.slice(i, balanced.end + 1);
        i = balanced.end;
        continue;
      }
    }
    if (ch === '`') {
      const backtick = readBacktick(command, i);
      if (backtick != null) {
        output += backtick.text;
        i = backtick.end;
        continue;
      }
    }
    if (ch === '#' && startsShellComment(output)) {
      while (i + 1 < command.length && command[i + 1] !== '\n' && command[i + 1] !== '\r') i++;
      continue;
    }
    output += ch;
  }
  return output;
}

function startsShellComment(output: string): boolean {
  if (output.length === 0) return true;
  const prev = output.at(-1)!;
  return /\s/u.test(prev) || prev === ';' || prev === '&' || prev === '|' || prev === '(';
}

function readBacktick(command: string, start: number): { text: string; end: number } | undefined {
  let text = '`';
  for (let i = start + 1; i < command.length; i++) {
    const ch = command[i]!;
    text += ch;
    if (ch === '\\' && i + 1 < command.length) {
      text += command[++i]!;
      continue;
    }
    if (ch === '`') return { text, end: i };
  }
  return undefined;
}

function splitShellCommands(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote !== "'" && ch === '$' && command[i + 1] === '(') {
      const balanced = readBalanced(command, i + 2, '(', ')');
      if (balanced != null) {
        current += command.slice(i, balanced.end + 1);
        i = balanced.end;
        continue;
      }
    }
    if (quote !== "'" && ch === '`') {
      const backtick = readBacktick(command, i);
      if (backtick != null) {
        current += backtick.text;
        i = backtick.end;
        continue;
      }
    }
    if (quote != null) {
      current += ch;
      if (ch === quote) quote = undefined;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) current += command[++i]!;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      current += ch + command[++i]!;
      continue;
    }
    const next = command[i + 1];
    const isControlOperator =
      ch === ';' ||
      ch === '\n' ||
      ch === '|' ||
      ch === '&' ||
      (ch === '&' && next === '&') ||
      (ch === '|' && next === '|');
    if (isControlOperator) {
      if (current.trim().length > 0) parts.push(current.trim());
      current = '';
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) i++;
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts.length > 0 ? parts : [command.trim()];
}

interface HeredocDelimiter {
  readonly delimiter: string;
  readonly stripTabs: boolean;
}

function heredocDelimiters(line: string): HeredocDelimiter[] {
  const delimiters: HeredocDelimiter[] = [];
  const pattern = /(<<-?)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))/giu;
  for (const match of line.matchAll(pattern)) {
    const delimiter = match[2] ?? match[3] ?? match[4];
    if (delimiter != null) delimiters.push({ delimiter, stripTabs: match[1] === '<<-' });
  }
  return delimiters;
}

function heredocLineMatches(line: string, heredoc: HeredocDelimiter): boolean {
  const candidate = heredoc.stripTabs ? line.replace(/^\t+/u, '') : line;
  return candidate === heredoc.delimiter;
}

interface ForLoopPayload {
  readonly variable: string;
  readonly values: readonly string[];
  readonly payload: string;
}

function shellForLoopPayloads(command: string): ForLoopPayload[] {
  const loops: ForLoopPayload[] = [];
  const pattern = /\bfor\s+([A-Z_][A-Z0-9_]*)\s+in\s+([^;]+);\s*do\s+([\s\S]*?)\s*;?\s*done\b/giu;
  for (const match of command.matchAll(pattern)) {
    const variable = match[1];
    const valueList = match[2];
    const payload = match[3];
    if (variable == null || valueList == null || payload == null) continue;
    const values = rawTokens(valueList).filter((value) => value.length > 0);
    if (values.length > 0) loops.push({ variable, values, payload });
  }
  return loops;
}

function lineExecutesHeredocBody(line: string): boolean {
  const last = splitPipeline(line).at(-1);
  return last != null ? isStdinExecutingCommand(tokenize(last)) : false;
}

function stripNonShellHeredocBodies(command: string): string {
  const lines = command.split(/\r?\n/u);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);
    const delimiters = heredocDelimiters(line);
    if (delimiters.length === 0 || lineExecutesHeredocBody(line)) continue;
    for (const delimiter of delimiters) {
      while (i + 1 < lines.length) {
        i++;
        if (heredocLineMatches(lines[i]!, delimiter)) break;
      }
    }
  }
  return out.join('\n');
}

function readBalanced(
  command: string,
  bodyStart: number,
  open: string,
  close: string,
): { body: string; end: number } | undefined {
  let depth = 1;
  let quote: '"' | "'" | '`' | undefined;
  for (let i = bodyStart; i < command.length; i++) {
    const ch = command[i]!;
    if (quote != null) {
      if (ch === '\\' && i + 1 < command.length) {
        i++;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      i++;
      continue;
    }
    if (ch === open) {
      depth++;
      continue;
    }
    if (ch === close) {
      depth--;
      if (depth === 0) {
        return { body: command.slice(bodyStart, i), end: i };
      }
    }
  }
  return undefined;
}

function nestedShellPayloads(command: string): string[] {
  const payloads: string[] = [];
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < command.length) {
        i++;
        continue;
      }
      if (ch === '"') {
        quote = undefined;
        continue;
      }
    } else {
      if (ch === "'") {
        quote = "'";
        continue;
      }
      if (ch === '"') {
        quote = '"';
        continue;
      }
      if (ch === '\\' && i + 1 < command.length) {
        i++;
        continue;
      }
      if (ch === '(' && command[i - 1] !== '$') {
        const balanced = readBalanced(command, i + 1, '(', ')');
        if (balanced != null) {
          payloads.push(balanced.body);
          i = balanced.end;
          continue;
        }
      }
    }
    if (ch === '$' && command[i + 1] === '(') {
      const balanced = readBalanced(command, i + 2, '(', ')');
      if (balanced != null) {
        payloads.push(balanced.body);
        i = balanced.end;
        continue;
      }
    }
    if (ch === '`') {
      let body = '';
      for (let j = i + 1; j < command.length; j++) {
        const inner = command[j]!;
        if (inner === '\\' && j + 1 < command.length) {
          body += command[++j]!;
          continue;
        }
        if (inner === '`') {
          payloads.push(body);
          i = j;
          break;
        }
        body += inner;
      }
    }
  }
  return payloads;
}

function literalCommandOutput(command: string): string | undefined {
  const argv = rawTokens(command.trim());
  const name = commandName(argv[0]);
  if (name === 'printf') {
    const format = argv[1];
    if (format == null) return '';
    return printfFormatOutput(format, argv.slice(2));
  }
  if (name === 'echo') return argv.slice(1).join(' ');
  return undefined;
}

function printfFormatOutput(format: string, args: readonly string[]): string | undefined {
  let out = '';
  let literalStart = 0;
  let argIndex = 0;

  const flushLiteral = (end: number): void => {
    if (end > literalStart) out += decodePrintfEscapes(format.slice(literalStart, end));
  };

  for (let i = 0; i < format.length; i++) {
    if (format[i] !== '%') continue;
    flushLiteral(i);
    const conversion = format[i + 1];
    if (conversion == null) return undefined;
    i++;
    literalStart = i + 1;
    if (conversion === '%') {
      out += '%';
      continue;
    }
    const arg = args[argIndex++] ?? '';
    if (conversion === 's') {
      out += arg;
      continue;
    }
    if (conversion === 'b') {
      out += decodePrintfEscapes(arg);
      continue;
    }
    return undefined;
  }
  flushLiteral(format.length);
  return out;
}

function decodePrintfEscapes(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch !== '\\' || i + 1 >= input.length) {
      out += ch;
      continue;
    }
    const decoded = decodeAnsiEscape(input, i + 1);
    out += decoded.value;
    i = decoded.end;
  }
  return out;
}

function synthesizeLiteralCommandSubstitutions(command: string): string | undefined {
  let output = '';
  let changed = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      output += ch;
      if (ch === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < command.length) {
        output += ch + command[++i]!;
        continue;
      }
      if (ch === '$' && command[i + 1] === '(') {
        const balanced = readBalanced(command, i + 2, '(', ')');
        if (balanced == null) {
          output += ch;
          continue;
        }
        const literal = literalCommandOutput(balanced.body);
        if (literal == null) return undefined;
        output += literal;
        changed = true;
        i = balanced.end;
        continue;
      }
      if (ch === '`') {
        const backtick = readBacktick(command, i);
        if (backtick == null) {
          output += ch;
          continue;
        }
        const literal = literalCommandOutput(backtick.text.slice(1, -1));
        if (literal == null) return undefined;
        output += literal;
        changed = true;
        i = backtick.end;
        continue;
      }
      output += ch;
      if (ch === '"') quote = undefined;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      output += ch;
      continue;
    }
    if (ch === '"') {
      quote = '"';
      output += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      output += ch + command[++i]!;
      continue;
    }
    if (ch === '$' && command[i + 1] === '(') {
      const balanced = readBalanced(command, i + 2, '(', ')');
      if (balanced == null) {
        output += ch;
        continue;
      }
      const literal = literalCommandOutput(balanced.body);
      if (literal == null) return undefined;
      output += literal;
      changed = true;
      i = balanced.end;
      continue;
    }
    if (ch === '`') {
      const backtick = readBacktick(command, i);
      if (backtick == null) {
        output += ch;
        continue;
      }
      const literal = literalCommandOutput(backtick.text.slice(1, -1));
      if (literal == null) return undefined;
      output += literal;
      changed = true;
      i = backtick.end;
      continue;
    }
    output += ch;
  }
  return changed ? output : undefined;
}

function shellStdinPayloads(command: string): string[] {
  const payloads: string[] = [];
  const heredocPayload = shellHeredocPayload(command);
  if (heredocPayload != null) payloads.push(heredocPayload);
  const processSubstitutionPayload = shellProcessSubstitutionPayload(command);
  if (processSubstitutionPayload != null) payloads.push(processSubstitutionPayload);

  let stream: string | undefined;
  for (const part of splitPipeline(command)) {
    if (stream == null) {
      stream = literalStreamOutput(part.trim());
      continue;
    }
    const argv = tokenize(part);
    if (isTransparentPipeCommand(argv)) continue;
    if (isShellStdinCommand(argv)) {
      payloads.push(stream);
      continue;
    }
    const xargsPayload = xargsPayloadFor(argv, stream);
    if (xargsPayload != null) payloads.push(xargsPayload);
  }
  const hereString = hereStringParts(command);
  const hereStringCommand = hereString?.command;
  const hereStringPayload = hereString?.payload;
  if (
    hereStringCommand != null &&
    hereStringPayload != null &&
    isShellStdinCommand(tokenize(hereStringCommand))
  ) {
    const tokens = rawTokens(hereStringPayload);
    if (tokens.length === 1 && tokens[0] != null && tokens[0].length > 0) {
      payloads.push(tokens[0]);
    }
  }
  return payloads;
}

function literalStreamOutput(command: string): string | undefined {
  const hereString = hereStringParts(command);
  if (hereString != null && isTransparentPipeCommand(tokenize(hereString.command))) {
    const tokens = rawTokens(hereString.payload);
    if (tokens.length === 1 && tokens[0] != null && tokens[0].length > 0) return tokens[0];
  }
  const heredoc = transparentHeredocOutput(command);
  if (heredoc != null) return heredoc;
  return literalCommandOutput(command);
}

function transparentHeredocOutput(command: string): string | undefined {
  const lines = command.split(/\r?\n/u);
  const first = lines[0];
  if (first == null) return undefined;
  const delimiter = heredocDelimiters(first)[0];
  if (delimiter == null) return undefined;
  if (!isTransparentPipeCommand(stripShellRedirections(rawTokens(first)))) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(1)) {
    if (heredocLineMatches(line, delimiter)) return body.join('\n');
    body.push(line);
  }
  return undefined;
}

function hereStringParts(command: string): { command: string; payload: string } | undefined {
  const match = /^\s*([\s\S]+?)\s*<<<\s*([\s\S]+?)\s*$/u.exec(command);
  const hereStringCommand = match?.[1];
  const hereStringPayload = match?.[2];
  if (hereStringCommand == null || hereStringPayload == null) return undefined;
  return { command: hereStringCommand, payload: hereStringPayload };
}

function shellProcessSubstitutionPayload(command: string): string | undefined {
  const stdinMatch = /^\s*([\s\S]+?)\s*<\s*<\(([\s\S]+)\)\s*$/u.exec(command);
  if (stdinMatch?.[1] != null && stdinMatch[2] != null) {
    const shellCommand = stdinMatch[1];
    const producer = stdinMatch[2];
    if (!isShellStdinCommand(tokenize(shellCommand))) return undefined;
    return literalStreamOutput(producer.trim());
  }
  const scriptArgMatch = /^\s*([\s\S]+?)\s+<\(([\s\S]+)\)(?:\s+[\s\S]*)?$/u.exec(command);
  const shellCommand = scriptArgMatch?.[1];
  const producer = scriptArgMatch?.[2];
  if (shellCommand == null || producer == null) return undefined;
  const argv = tokenize(shellCommand);
  if (!isShellScriptFileCommand(argv) && !isSourceScriptFileCommand(argv)) return undefined;
  return literalStreamOutput(producer.trim());
}

function splitPipeline(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote !== "'" && ch === '$' && command[i + 1] === '(') {
      const balanced = readBalanced(command, i + 2, '(', ')');
      if (balanced != null) {
        current += command.slice(i, balanced.end + 1);
        i = balanced.end;
        continue;
      }
    }
    if (quote !== "'" && ch === '`') {
      const backtick = readBacktick(command, i);
      if (backtick != null) {
        current += backtick.text;
        i = backtick.end;
        continue;
      }
    }
    if (quote != null) {
      current += ch;
      if (ch === quote) quote = undefined;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) current += command[++i]!;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      current += ch + command[++i]!;
      continue;
    }
    if (ch === '|' && command[i + 1] !== '|') {
      if (current.trim().length > 0) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts.length > 0 ? parts : [command.trim()];
}

function isShellStdinCommand(argv: readonly string[]): boolean {
  const normalized = normalizeCommand([...argv]);
  const name = commandName(normalized[0]);
  if (!isShellCommandName(name)) return false;
  return shellPayload([...normalized]) == null;
}

function isStdinExecutingCommand(argv: readonly string[]): boolean {
  return isShellStdinCommand(argv) || isSourceStdinCommand(argv);
}

function isShellScriptFileCommand(argv: readonly string[]): boolean {
  const normalized = normalizeCommand([...argv]);
  const name = commandName(normalized[0]);
  if (!isShellCommandName(name)) return false;
  const longOptionsWithValue = new Set(['--init-file', '--rcfile']);
  for (let i = 1; i < normalized.length; i++) {
    const token = normalized[i]!;
    if (token === '--') return true;
    if (token === '+o' || token === '+O') {
      i++;
      continue;
    }
    if (!token.startsWith('-') || token === '-') return false;
    if (
      token === '-c' ||
      token === '-s' ||
      (/^-[^-]/u.test(token) && (token.includes('c') || token.includes('s')))
    ) {
      return false;
    }
    const eq = token.indexOf('=');
    const optionName = eq === -1 ? token : token.slice(0, eq);
    if (token.startsWith('--') && longOptionsWithValue.has(optionName) && eq === -1) {
      if (i + 1 >= normalized.length) return false;
      i++;
    }
    if (token === '-o' || token === '-O' || token === '+o' || token === '+O' || token === '-D') {
      if (i + 1 >= normalized.length) return false;
      i++;
    }
  }
  return true;
}

function isSourceScriptFileCommand(argv: readonly string[]): boolean {
  const normalized = normalizeCommand([...argv]);
  const name = commandName(normalized[0]);
  return (name === 'source' || name === '.') && normalized.length === 1;
}

function isSourceStdinCommand(argv: readonly string[]): boolean {
  const normalized = normalizeCommand([...argv]);
  const name = commandName(normalized[0]);
  return (name === 'source' || name === '.') && normalized[1] === '/dev/stdin';
}

function isTransparentPipeCommand(argv: readonly string[]): boolean {
  const normalized = normalizeCommand([...argv]);
  const name = commandName(normalized[0]);
  return name === 'cat' || name === 'tee';
}

function shellHeredocPayload(command: string): string | undefined {
  const lines = command.split(/\r?\n/u);
  const first = lines[0];
  if (first == null || !lineExecutesHeredocBody(first)) return undefined;
  const delimiter = heredocDelimiters(first)[0];
  if (delimiter == null) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(1)) {
    if (heredocLineMatches(line, delimiter)) return body.join('\n');
    body.push(line);
  }
  return undefined;
}

function xargsPayloadFor(argv: readonly string[], stdin: string): string | undefined {
  if (commandName(argv[0]) !== 'xargs') return undefined;
  let i = 1;
  let replacement: string | undefined;
  const valueOptions = new Set([
    '-E',
    '-L',
    '-n',
    '-P',
    '-s',
    '--eof',
    '--replace',
    '--max-lines',
    '--max-args',
    '--max-procs',
    '--max-chars',
  ]);
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === '--') {
      i++;
      break;
    }
    if (!token.startsWith('-') || token === '-') break;
    if (token === '-I' || token === '--replace') {
      replacement = argv[i + 1];
      i += 2;
      continue;
    }
    if (token === '-i') {
      replacement = '{}';
      i++;
      continue;
    }
    if (token.startsWith('-I') && token.length > 2) {
      replacement = token.slice(2);
      i++;
      continue;
    }
    if (token.startsWith('-i') && token.length > 2) {
      replacement = token.slice(2);
      i++;
      continue;
    }
    if (token.startsWith('--replace=')) {
      replacement = token.slice('--replace='.length);
      i++;
      continue;
    }
    const eq = token.indexOf('=');
    const optionName = eq === -1 ? token : token.slice(0, eq);
    if (valueOptions.has(optionName)) {
      i += eq === -1 ? 2 : 1;
      continue;
    }
    i++;
  }
  const command = argv.slice(i);
  if (command.length === 0) return undefined;
  const synthesized =
    replacement != null
      ? command.map((token) => token.split(replacement).join(stdin))
      : [...command, ...rawTokens(stdin)];
  return synthesized.map(quoteShellToken).join(' ');
}

function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

function commandName(token: string | undefined): string | undefined {
  if (token == null || token.length === 0) return undefined;
  const name = token.split('/').filter(Boolean).at(-1) ?? token;
  if (shellGlobCanMatch(name, 'git')) return 'git';
  if (shellGlobCanMatch(name, 'gh')) return 'gh';
  if (shellGlobCanMatch(name, 'co')) return 'co';
  if (shellGlobCanMatch(name, 'sudo')) return 'sudo';
  return name;
}

function shellGlobCanMatch(pattern: string, literal: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?') && !pattern.includes('[')) return false;
  let regex = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      regex += '.*';
      continue;
    }
    if (ch === '?') {
      regex += '.';
      continue;
    }
    if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end !== -1) {
        regex += pattern.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    regex += ch.replace(/[\\^$+?.()|{}]/gu, '\\$&');
  }
  regex += '$';
  try {
    return new RegExp(regex, 'u').test(literal);
  } catch {
    return false;
  }
}

function normalizeCommand(argv: string[]): string[] {
  let out = argv;
  for (;;) {
    const name = commandName(out[0]);
    if (name === 'git-push') return ['git', 'push', ...out.slice(1)];
    if (name === 'git-merge') return ['git', 'merge', ...out.slice(1)];
    if (name === 'env') {
      let i = 1;
      const valueOptions = new Set(['-u', '--unset', '-C', '--chdir', '-a', '--argv0']);
      const flagOptions = new Set([
        '-0',
        '--null',
        '-i',
        '-',
        '--ignore-environment',
        '-v',
        '--debug',
      ]);
      while (i < out.length) {
        const token = out[i]!;
        const eq = token.indexOf('=');
        const optionName = eq === -1 ? token : token.slice(0, eq);
        if (/^[A-Z_][A-Z0-9_]*=/i.test(token)) {
          i++;
        } else if (token === '-S' || token === '--split-string') {
          const split = out[i + 1];
          if (split == null) return out;
          out = [...tokenize(split), ...out.slice(i + 2)];
          i = 0;
          break;
        } else if (token.startsWith('-S') && token !== '-S' && !token.startsWith('--')) {
          out = [...tokenize(token.slice(2)), ...out.slice(i + 1)];
          i = 0;
          break;
        } else if (token.startsWith('--split-string=')) {
          out = [...tokenize(token.slice('--split-string='.length)), ...out.slice(i + 1)];
          i = 0;
          break;
        } else {
          const shortOptions = parseEnvShortOptionCluster(token);
          if (shortOptions?.splitString != null) {
            out = [...tokenize(shortOptions.splitString), ...out.slice(i + 1)];
            i = 0;
            break;
          }
          if (shortOptions?.splitConsumesNext === true) {
            const split = out[i + 1];
            if (split == null) return out;
            out = [...tokenize(split), ...out.slice(i + 2)];
            i = 0;
            break;
          }
          if (shortOptions?.recognized === true) {
            i += shortOptions.consumesNext ? 2 : 1;
            continue;
          }
        }
        if (token === '--') {
          i++;
          break;
        } else if (valueOptions.has(optionName)) {
          i += eq === -1 ? 2 : 1;
        } else if (flagOptions.has(token)) {
          i++;
        } else {
          break;
        }
      }
      out = normalizeCommand(stripLeadingEnvAssignments(out.slice(i)));
      continue;
    }
    if (name === 'command') {
      let i = 1;
      while (i < out.length) {
        const token = out[i]!;
        if (token === '--') {
          i++;
          break;
        }
        if (token === '-p') {
          i++;
          continue;
        }
        if (token.startsWith('-')) return out;
        break;
      }
      out = out.slice(i);
      continue;
    }
    if (name === 'builtin') {
      out = out.slice(1);
      continue;
    }
    if (name === 'exec') {
      let i = 1;
      while (i < out.length) {
        const token = out[i]!;
        if (token === '--') {
          i++;
          break;
        }
        if (token === '-a') {
          i += 2;
          continue;
        }
        if (token === '-c' || token === '-l' || /^-[cl]+$/u.test(token)) {
          i++;
          continue;
        }
        if (!token.startsWith('-') || token === '-') break;
        return out;
      }
      out = out.slice(i);
      continue;
    }
    if (name === 'nohup') {
      out = out[1] === '--' ? out.slice(2) : out.slice(1);
      continue;
    }
    if (name === 'timeout') {
      let i = 1;
      const valueOptions = new Set(['-k', '--kill-after', '--signal']);
      while (i < out.length) {
        const token = out[i]!;
        if (token === '--') {
          i++;
          break;
        }
        if (valueOptions.has(token) || /^-s[^A-Za-z0-9]?/u.test(token)) {
          i += 2;
          continue;
        }
        if (token.startsWith('--kill-after=') || token.startsWith('--signal=')) {
          i++;
          continue;
        }
        if (token.startsWith('-') && !/^\d/u.test(token.slice(1))) {
          i++;
          continue;
        }
        i++;
        break;
      }
      out = out.slice(i);
      continue;
    }
    if (name === 'nice') {
      let i = 1;
      while (i < out.length) {
        const token = out[i]!;
        if (token === '--') {
          i++;
          break;
        }
        if (token === '-n' || token === '--adjustment') {
          i += 2;
          continue;
        }
        if (/^[+-]?\d+$/u.test(token)) {
          i++;
          continue;
        }
        if (token.startsWith('-n') && token.length > 2) {
          i++;
          continue;
        }
        if (token.startsWith('--adjustment=')) {
          i++;
          continue;
        }
        break;
      }
      out = out.slice(i);
      continue;
    }
    if (name === 'setsid') {
      const i = skipLeadingOptions(out, 1, new Set());
      out = out.slice(i);
      continue;
    }
    if (name === 'stdbuf') {
      const i = skipLeadingOptions(
        out,
        1,
        new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
      );
      out = out.slice(i);
      continue;
    }
    if (name === 'node') {
      const valueOptions = new Set([
        '-C',
        '-r',
        '--conditions',
        '--env-file',
        '--experimental-loader',
        '--import',
        '--loader',
        '--require',
      ]);
      let scriptIdx = 1;
      while (scriptIdx < out.length) {
        const token = out[scriptIdx]!;
        if (token === '--') {
          scriptIdx++;
          break;
        }
        if (token === '-e' || token === '--eval' || token === '-p' || token === '--print') {
          scriptIdx = out.length;
          break;
        }
        const eq = token.indexOf('=');
        const optionName = eq === -1 ? token : token.slice(0, eq);
        if (valueOptions.has(optionName)) {
          scriptIdx += eq === -1 ? 2 : 1;
          continue;
        }
        if (token.startsWith('-')) {
          scriptIdx++;
          continue;
        }
        break;
      }
      const script = out[scriptIdx];
      if (
        script === 'packages/cli/dist/index.js' ||
        script?.endsWith('/packages/cli/dist/index.js')
      ) {
        out = ['co', ...out.slice(scriptIdx + 1)];
        continue;
      }
    }
    if (name === 'pnpm') {
      let i = 1;
      const valueOptions = new Set(['--filter', '-F', '--dir', '-C', '--workspace-root']);
      while (i < out.length) {
        const token = out[i]!;
        if (token === 'exec') {
          out = out[i + 1] === '--' ? out.slice(i + 2) : out.slice(i + 1);
          i = 0;
          break;
        }
        if (token === 'node') {
          out = ['node', ...out.slice(i + 1)];
          i = 0;
          break;
        }
        if (token === '-c' || token === '--shell-mode') {
          const payloadIndex = out[i + 1] === 'exec' ? i + 2 : i + 1;
          const payload = out[payloadIndex];
          if (payload == null) return out;
          out = ['sh', '-c', payload, ...out.slice(payloadIndex + 1)];
          i = 0;
          break;
        }
        if (token === '--') {
          i++;
          continue;
        }
        const eq = token.indexOf('=');
        const optionName = eq === -1 ? token : token.slice(0, eq);
        if (valueOptions.has(optionName)) {
          i += eq === -1 ? 2 : 1;
          continue;
        }
        if (token.startsWith('-')) {
          i++;
          continue;
        }
        break;
      }
      if (i === 0) continue;
    }
    if (name === 'npm') {
      let i = 1;
      const valueOptions = new Set([
        '--workspace',
        '-w',
        '--prefix',
        '-C',
        '--cache',
        '--userconfig',
      ]);
      while (i < out.length) {
        const token = out[i]!;
        if (token === 'exec' || token === 'x') {
          out = npmExecCommand(out, i + 1);
          i = 0;
          break;
        }
        if (token === '--') {
          i++;
          continue;
        }
        const eq = token.indexOf('=');
        const optionName = eq === -1 ? token : token.slice(0, eq);
        if (valueOptions.has(optionName)) {
          i += eq === -1 ? 2 : 1;
          continue;
        }
        if (token.startsWith('-')) {
          i++;
          continue;
        }
        break;
      }
      if (i === 0) continue;
    }
    if (name === 'npx') {
      out = npmExecCommand(out, 1);
      continue;
    }
    if (name === 'time') {
      const i = skipLeadingOptions(out, 1, new Set(['-f', '--format', '-o', '--output']));
      out = out.slice(i);
      continue;
    }
    return name == null ? out : [name, ...out.slice(1)];
  }
}

function npmExecCommand(argv: string[], start: number): string[] {
  let i = start;
  const valueOptions = new Set(['--package', '-p', '--cache', '--userconfig']);
  const flagOptions = new Set(['--yes', '-y', '--no-install', '--ignore-existing']);
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === '--') {
      i++;
      break;
    }
    if (token === '-c' || token === '--call') {
      return argv[i + 1] != null ? ['sh', '-c', argv[i + 1]!, ...argv.slice(i + 2)] : argv;
    }
    if (token.startsWith('--call=')) {
      return ['sh', '-c', token.slice('--call='.length), ...argv.slice(i + 1)];
    }
    const eq = token.indexOf('=');
    const optionName = eq === -1 ? token : token.slice(0, eq);
    if (valueOptions.has(optionName)) {
      i += eq === -1 ? 2 : 1;
      continue;
    }
    if (flagOptions.has(token)) {
      i++;
      continue;
    }
    if (token.startsWith('-')) {
      i++;
      continue;
    }
    break;
  }
  return argv.slice(i);
}

function shellPayload(argv: string[]): string | undefined {
  const name = commandName(argv[0]);
  if (!isShellCommandName(name)) return undefined;
  const longOptionsWithValue = new Set(['--init-file', '--rcfile']);
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') return undefined;
    if (token === '+o' || token === '+O') {
      i++;
      continue;
    }
    if (!token.startsWith('-') || token === '-') return undefined;
    if (token === '-c' || (/^-[^-]/u.test(token) && token.includes('c'))) {
      return expandShellPositionals(argv[i + 1], argv[i + 2], argv.slice(i + 3));
    }
    if (name === 'fish') {
      if (token === '--command' || token === '-C') {
        return expandShellPositionals(argv[i + 1], argv[i + 2], argv.slice(i + 3));
      }
      if (token.startsWith('--command=')) {
        return expandShellPositionals(
          token.slice('--command='.length),
          argv[i + 1],
          argv.slice(i + 2),
        );
      }
    }
    const eq = token.indexOf('=');
    const optionName = eq === -1 ? token : token.slice(0, eq);
    if (token.startsWith('--')) {
      if (longOptionsWithValue.has(optionName) && eq === -1) i++;
      continue;
    }
    if (token === '-o' || token === '-O' || token === '+o' || token === '+O') i++;
  }
  return undefined;
}

const SHELL_COMMAND_NAMES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'ksh',
  'mksh',
  'dash',
  'ash',
  'csh',
  'tcsh',
]);

function isShellCommandName(name: string | undefined): boolean {
  return name != null && SHELL_COMMAND_NAMES.has(name);
}

function quoteShellToken(token: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(token) ? token : `'${token.replace(/'/gu, "'\\''")}'`;
}

function expandShellPositionals(
  command: string | undefined,
  arg0: string | undefined,
  args: readonly string[],
): string | undefined {
  if (command == null) return undefined;
  const joined = args.map(quoteShellToken).join(' ');
  const expanded = command
    .replace(/(["'])\$(?:\{@\}|\{\*\}|@|\*)\1/gu, joined)
    .replace(/\$(?:\{([0-9@*])\}|([0-9@*]))/gu, (_match, braced, bare) => {
      const name = String(braced ?? bare);
      if (name === '@' || name === '*') return joined;
      const index = Number(name);
      if (index === 0) return arg0 != null ? quoteShellToken(arg0) : '';
      return args[index - 1] != null ? quoteShellToken(args[index - 1]!) : '';
    });
  return expanded.trim().length > 0 ? expanded : command;
}

function hasShellPositionals(command: string): boolean {
  return /\$(?:\{[0-9@*]\}|[0-9@*])/u.test(command);
}

function expandShellAliasInvocation(alias: string, args: readonly string[]): string {
  if (hasShellPositionals(alias)) return expandShellPositionals(alias, undefined, args) ?? alias;
  const suffix = args.join(' ');
  return suffix.length > 0 ? `${alias} ${suffix}` : alias;
}

function evalPayload(argv: string[]): string | undefined {
  if (commandName(argv[0]) !== 'eval') return undefined;
  const payload = argv.slice(1).join(' ').trim();
  return payload.length > 0 ? payload : undefined;
}

function shellAliasDefinitionPayload(argv: string[]): string | undefined {
  if (commandName(argv[0]) !== 'alias') return undefined;
  const payloads: string[] = [];
  for (const token of argv.slice(1)) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    const value = token.slice(eq + 1).trim();
    if (value.length > 0) payloads.push(value);
  }
  return payloads.length > 0 ? payloads.join('; ') : undefined;
}

function shellAliasDefinitions(argv: string[]): Array<{ name: string; value: string }> {
  if (commandName(argv[0]) !== 'alias') return [];
  const aliases: Array<{ name: string; value: string }> = [];
  for (const token of argv.slice(1)) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    const name = token.slice(0, eq);
    const value = token.slice(eq + 1).trim();
    if (/^[A-Z_][A-Z0-9_]*$/iu.test(name) && value.length > 0) aliases.push({ name, value });
  }
  return aliases;
}

function shellFunctionPayload(command: string): string | undefined {
  const match = /^\s*(?:function\s+)?[A-Z_][A-Z0-9_]*\s*(?:\(\)\s*)?\{\s*(.+)$/iu.exec(command);
  const payload = match?.[1]?.trim();
  return payload != null && payload.length > 0 ? payload : undefined;
}

function shellFunctionDefinition(command: string): { name: string; body: string } | undefined {
  const braceMatch =
    /^\s*(?:function\s+)?([A-Z_][A-Z0-9_]*)\s*(?:\(\)\s*)?\{\s*(.+?)\s*\}?\s*$/iu.exec(command);
  const parenMatch =
    braceMatch ??
    /^\s*(?:function\s+)?([A-Z_][A-Z0-9_]*)\s*(?:\(\)\s*)?\(\s*(.+?)\s*\)\s*$/iu.exec(command);
  const name = parenMatch?.[1];
  const body = parenMatch?.[2]?.trim();
  if (name == null || body == null || body.length === 0) return undefined;
  return { name, body };
}

function shellVariableDefinitions(command: string): Array<{ name: string; value: string }> {
  const tokens = stripShellRedirections(rawTokens(command));
  if (tokens.length === 0) return [];
  if (!tokens.every((token) => ENV_ASSIGN.test(token))) {
    const commandSubstitutionDefinition = shellVariableDefinitionWithCommandSubstitution(command);
    return commandSubstitutionDefinition != null ? [commandSubstitutionDefinition] : [];
  }
  const definitions: Array<{ name: string; value: string }> = [];
  for (const token of tokens) {
    const eq = token.indexOf('=');
    const name = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (/^[A-Z_][A-Z0-9_]*$/iu.test(name) && value.length > 0) {
      definitions.push({ name, value });
    }
  }
  return definitions;
}

function shellVariableDefinitionWithCommandSubstitution(
  command: string,
): { name: string; value: string } | undefined {
  const match = /^\s*([A-Z_][A-Z0-9_]*)=([\s\S]+?)\s*$/iu.exec(command);
  const name = match?.[1];
  const value = match?.[2];
  if (name == null || value == null || !hasCommandSubstitution(value)) return undefined;
  return { name, value };
}

function shellVariableDeclarations(command: string): Array<{ name: string; value: string }> {
  const tokens = stripShellRedirections(rawTokens(command));
  const name = commandName(tokens[0]);
  if (name !== 'export' && name !== 'declare' && name !== 'typeset' && name !== 'readonly') {
    return [];
  }
  const definitions: Array<{ name: string; value: string }> = [];
  for (const token of tokens.slice(1)) {
    if (token === '--') continue;
    if (token.startsWith('-')) continue;
    if (!ENV_ASSIGN.test(token)) continue;
    const eq = token.indexOf('=');
    const varName = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (/^[A-Z_][A-Z0-9_]*$/iu.test(varName) && value.length > 0) {
      definitions.push({ name: varName, value });
    }
  }
  return definitions;
}

function expandShellVariablesInToken(
  token: string,
  variables: ReadonlyMap<string, string>,
): string {
  const withSubstrings = token.replace(
    /\$\{([A-Z_][A-Z0-9_]*):(\d+)(?::(\d+))?\}/giu,
    (match, name, offsetRaw, lengthRaw) => {
      const value = variables.get(String(name));
      if (value == null) return match;
      const offset = Number(offsetRaw);
      const length = lengthRaw != null ? Number(lengthRaw) : undefined;
      if (!Number.isSafeInteger(offset) || offset < 0) return match;
      if (length != null && (!Number.isSafeInteger(length) || length < 0)) return match;
      return length == null ? value.slice(offset) : value.slice(offset, offset + length);
    },
  );
  const withIndirect = withSubstrings.replace(/\$\{!([A-Z_][A-Z0-9_]*)\}/giu, (match, name) => {
    const target = variables.get(String(name));
    if (target == null) return match;
    if (target === 'HOME') return variables.get('HOME') ?? '$HOME';
    return variables.get(target) ?? '';
  });
  const withPatterns = withIndirect
    .replace(/\$\{([A-Z_][A-Z0-9_]*)(#{1,2})([^}]*)\}/giu, (match, name, _op, pattern) => {
      const value = variables.get(String(name));
      if (value == null) return match;
      const prefix = String(pattern);
      return value.startsWith(prefix) ? value.slice(prefix.length) : value;
    })
    .replace(/\$\{([A-Z_][A-Z0-9_]*)(%{1,2})([^}]*)\}/giu, (match, name, _op, pattern) => {
      const value = variables.get(String(name));
      if (value == null) return match;
      const suffix = String(pattern);
      return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
    });
  const withDefaults = withPatterns.replace(
    /\$\{([A-Z_][A-Z0-9_]*)(:-|-|:=|=|:\+|\+|:\?|\?)([^}]*)\}/giu,
    (_match, name, operator, fallback) => {
      const value = variables.get(String(name));
      if ((operator === '-' || operator === '=') && value != null) return value;
      if ((operator === ':-' || operator === ':=') && value != null && value.length > 0) {
        return value;
      }
      if (operator === '+') return value != null ? String(fallback) : '';
      if (operator === ':+') return value != null && value.length > 0 ? String(fallback) : '';
      if (operator === '?') return value != null ? value : '';
      if (operator === ':?') return value != null && value.length > 0 ? value : '';
      return String(fallback);
    },
  );
  return withDefaults.replace(
    /\$(?:\{([A-Z_][A-Z0-9_]*)\}|([A-Z_][A-Z0-9_]*))/giu,
    (match, braced, bare) => {
      const value = variables.get(String(braced ?? bare));
      return value ?? match;
    },
  );
}

function expandBraceAlternatives(token: string): string[] {
  const match = /^(.*)\{([^{}]*,[^{}]*)\}(.*)$/u.exec(token);
  if (match == null) return [token];
  const [, prefix, body, suffix] = match;
  return body!.split(',').map((alternative) => `${prefix}${alternative}${suffix}`);
}

function synthesizeBraceExpansionCommand(command: string): string | undefined {
  let changed = false;
  const expanded: string[] = [];
  for (const token of rawTokens(command)) {
    const alternatives = expandBraceAlternatives(token);
    if (alternatives.length > 1) changed = true;
    expanded.push(...alternatives);
  }
  return changed ? expanded.map(quoteShellToken).join(' ') : undefined;
}

function shellFieldSplit(value: string, variables: ReadonlyMap<string, string>): string[] {
  const ifs = variables.get('IFS') ?? ' \t\n';
  if (ifs.length === 0) return [value];
  const escaped = ifs.replace(/[\\\]^$.*+?()[\]{}|-]/gu, '\\$&');
  return value.split(new RegExp(`[${escaped}]+`, 'u')).filter((part) => part.length > 0);
}

function expandShellVariableWords(
  argv: readonly ShellWord[],
  variables: ReadonlyMap<string, string>,
): string[] {
  const expanded: string[] = [];
  for (const token of argv) {
    const value = expandShellVariablesInToken(token.value, variables);
    const pieces =
      value === token.value || token.quoted || hasCommandSubstitution(value)
        ? [value]
        : shellFieldSplit(value, variables);
    for (const rawToken of pieces) {
      expanded.push(...expandBraceAlternatives(rawToken));
    }
  }
  return normalizeCommand(expanded);
}

const SHELL_STRUCTURAL_TOKENS = new Set([
  '{',
  '!',
  'coproc',
  'if',
  'then',
  'elif',
  'else',
  'while',
  'until',
  'do',
  'case',
]);

function shellStructuralPayload(argv: string[]): string | undefined {
  const first = argv[0];
  if (first == null || !SHELL_STRUCTURAL_TOKENS.has(first)) return undefined;
  if (first === 'case') {
    const arm = argv.findIndex((token) => token.endsWith(')'));
    if (arm !== -1) {
      const payload = argv
        .slice(arm + 1)
        .filter((token) => token !== 'esac')
        .join(' ')
        .trim();
      return payload.length > 0 ? payload : undefined;
    }
  }
  const payload = argv.slice(1).join(' ').trim();
  return payload.length > 0 ? payload : undefined;
}

/** True iff any token in argv exactly equals one of the given flags. */
function hasFlag(argv: string[], ...flags: string[]): boolean {
  return argv.some((t) => flags.includes(t));
}

function isGitForcePushFlag(token: string): boolean {
  return (
    token === '--force' ||
    token === '-f' ||
    token === '--force-with-lease' ||
    token.startsWith('--force-with-lease=') ||
    /^-[a-zA-Z]*f[a-zA-Z]*$/u.test(token)
  );
}

function hasGitForcePushFlag(argv: readonly string[]): boolean {
  return argv.some(isGitForcePushFlag);
}

function skipLeadingOptions(
  argv: string[],
  start: number,
  valueOptions: ReadonlySet<string>,
): number {
  let i = start;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === '--') return i + 1;
    if (!token.startsWith('-') || token === '-') return i;

    const eq = token.indexOf('=');
    const optionName = eq === -1 ? token : token.slice(0, eq);
    if (valueOptions.has(optionName) && eq === -1) {
      i += 2;
    } else {
      i += 1;
    }
  }
  return i;
}

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
]);

interface GitAliasParse {
  readonly aliases: ReadonlyMap<string, string | undefined>;
  readonly subcommandIndex: number;
  readonly externalAliasConfig: boolean;
}

function normalizeGitAliasName(name: string): string {
  return name.toLowerCase();
}

function normalizeGitAliasMap(
  aliases: ReadonlyMap<string, string | undefined>,
): Map<string, string | undefined> {
  const normalized = new Map<string, string | undefined>();
  for (const [name, value] of aliases) normalized.set(normalizeGitAliasName(name), value);
  return normalized;
}

function isGitIncludePathKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === 'include.path' ||
    (normalized.startsWith('includeif.') && normalized.endsWith('.path'))
  );
}

function envSelectsExternalGitConfig(env: ReadonlyMap<string, string>): boolean {
  return [
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_XDG',
    'HOME',
    'XDG_CONFIG_HOME',
  ].some((key) => {
    const value = env.get(key);
    return value != null && value.length > 0;
  });
}

const KNOWN_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'add',
  'am',
  'archive',
  'bisect',
  'blame',
  'branch',
  'bundle',
  'cat-file',
  'check-ignore',
  'checkout',
  'cherry-pick',
  'clean',
  'clone',
  'commit',
  'config',
  'describe',
  'diff',
  'fetch',
  'for-each-ref',
  'grep',
  'init',
  'log',
  'ls-files',
  'merge',
  'merge-base',
  'mv',
  'pull',
  'push',
  'rebase',
  'remote',
  'reset',
  'restore',
  'rev-list',
  'rev-parse',
  'rm',
  'show',
  'show-ref',
  'stash',
  'status',
  'submodule',
  'switch',
  'tag',
  'worktree',
]);

function isPotentialGitAliasSubcommand(subcommand: string | undefined): boolean {
  if (subcommand == null || subcommand.startsWith('-')) return false;
  return !KNOWN_GIT_SUBCOMMANDS.has(subcommand.toLowerCase());
}

function parseGitAliases(
  argv: string[],
  env: ReadonlyMap<string, string> = new Map(),
  inheritedAliases: ReadonlyMap<string, string | undefined> = new Map(),
): GitAliasParse {
  const aliases = normalizeGitAliasMap(inheritedAliases);
  let externalAliasConfig = envSelectsExternalGitConfig(env);
  const countRaw = env.get('GIT_CONFIG_COUNT');
  const count = countRaw != null && /^\d+$/u.test(countRaw) ? Number(countRaw) : 0;
  for (let n = 0; n < count; n++) {
    const key = env.get(`GIT_CONFIG_KEY_${n}`);
    if (key == null) continue;
    if (isGitIncludePathKey(key)) externalAliasConfig = true;
    const match = /^alias\.([^=]+)$/iu.exec(key);
    if (match != null)
      aliases.set(normalizeGitAliasName(match[1]!), env.get(`GIT_CONFIG_VALUE_${n}`));
  }
  const parameters = env.get('GIT_CONFIG_PARAMETERS');
  if (parameters != null) {
    for (const param of rawTokens(parameters)) {
      const eq = param.indexOf('=');
      if (eq === -1) continue;
      const key = param.slice(0, eq);
      if (isGitIncludePathKey(key)) externalAliasConfig = true;
      const match = /^alias\.([^=]+)$/iu.exec(key);
      if (match != null) aliases.set(normalizeGitAliasName(match[1]!), param.slice(eq + 1));
    }
  }
  let i = 1;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === '--') {
      i++;
      break;
    }
    if (!token.startsWith('-') || token === '-') break;

    const eq = token.indexOf('=');
    const optionName = eq === -1 ? token : token.slice(0, eq);
    let value: string | undefined;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(optionName)) {
      if (eq === -1) {
        value = argv[i + 1];
        i += 2;
      } else {
        value = token.slice(eq + 1);
        i += 1;
      }
      if (optionName === '-c' && value != null) {
        const key = value.slice(0, value.indexOf('=') === -1 ? value.length : value.indexOf('='));
        if (isGitIncludePathKey(key)) externalAliasConfig = true;
        const match = /^alias\.([^=]+)=(.*)$/iu.exec(value);
        if (match != null) aliases.set(normalizeGitAliasName(match[1]!), match[2]!);
      }
      if (optionName === '--config-env' && value != null) {
        const eq = value.indexOf('=');
        const key = eq === -1 ? value : value.slice(0, eq);
        if (isGitIncludePathKey(key)) externalAliasConfig = true;
        const match = /^alias\.([^=]+)=([A-Z_][A-Z0-9_]*)$/iu.exec(value);
        if (match != null) aliases.set(normalizeGitAliasName(match[1]!), env.get(match[2]!));
      }
    } else {
      i += 1;
    }
  }
  return { aliases, subcommandIndex: i, externalAliasConfig };
}

function gitArgs(
  argv: string[],
  inheritedAliases: ReadonlyMap<string, string | undefined> = new Map(),
): readonly string[] {
  if (argv[0] !== 'git') return [];
  const { aliases, subcommandIndex: i } = parseGitAliases(argv, new Map(), inheritedAliases);
  const subcommand = argv[i];
  if (subcommand == null) return [];
  const subcommandKey = normalizeGitAliasName(subcommand);
  if (!aliases.has(subcommandKey)) return argv.slice(i);
  const alias = aliases.get(subcommandKey);
  if (alias == null || alias.trim().length === 0) return ['push'];
  const expanded = tokenize(`${alias} ${argv.slice(i + 1).join(' ')}`);
  const blockedIndex = expanded.findIndex(
    (token) => token === 'push' || token === 'merge' || token === 'pull' || token === 'send-pack',
  );
  return blockedIndex === -1 ? expanded : expanded.slice(blockedIndex);
}

function gitAliasPayload(
  argv: string[],
  env: ReadonlyMap<string, string>,
  inheritedAliases: ReadonlyMap<string, string | undefined>,
): string | undefined {
  if (argv[0] !== 'git') return undefined;
  const {
    aliases,
    subcommandIndex: i,
    externalAliasConfig,
  } = parseGitAliases(argv, env, inheritedAliases);
  const subcommand = argv[i];
  if (subcommand == null) return undefined;
  const payload = resolveGitAliasPayload(aliases, subcommand, argv.slice(i + 1));
  if (payload != null) return payload;
  if (externalAliasConfig && isPotentialGitAliasSubcommand(subcommand)) {
    return 'git push';
  }
  return undefined;
}

function resolveGitAliasPayload(
  aliases: ReadonlyMap<string, string | undefined>,
  subcommand: string,
  rest: readonly string[],
  seen: ReadonlySet<string> = new Set(),
): string | undefined {
  const subcommandKey = normalizeGitAliasName(subcommand);
  if (!aliases.has(subcommandKey)) return undefined;
  if (seen.has(subcommandKey)) return 'git push';
  const alias = aliases.get(subcommandKey);
  if (alias == null || alias.trim().length === 0) return 'git push';
  const payload = alias.startsWith('!')
    ? (expandShellPositionals(alias.slice(1).trim(), undefined, rest) ?? '')
    : `git ${alias} ${rest.join(' ')}`;
  if (payload.trim().length === 0) return 'git push';

  const payloadArgv = tokenize(payload);
  if (payloadArgv[0] === 'git') {
    const { subcommandIndex } = parseGitAliases(payloadArgv);
    const nestedSubcommand = payloadArgv[subcommandIndex];
    const nestedSubcommandKey =
      nestedSubcommand != null ? normalizeGitAliasName(nestedSubcommand) : undefined;
    if (nestedSubcommandKey != null && aliases.has(nestedSubcommandKey)) {
      const nextSeen = new Set(seen);
      nextSeen.add(subcommandKey);
      return resolveGitAliasPayload(
        aliases,
        nestedSubcommandKey,
        payloadArgv.slice(subcommandIndex + 1),
        nextSeen,
      );
    }
  }
  return payload;
}

function gitConfigAlias(argv: string[]): { name: string; value: string } | undefined {
  const args = gitArgs(argv);
  if (args[0] !== 'config') return undefined;
  let i = 1;
  let readOnly = false;
  const readOnlyFlags = new Set([
    '--get',
    '--get-all',
    '--get-regexp',
    '--get-urlmatch',
    '--list',
    '-l',
    '--name-only',
    '--show-origin',
    '--show-scope',
  ]);
  while (i < args.length) {
    const token = args[i]!;
    if (token === '--') {
      i++;
      break;
    }
    if (!token.startsWith('-') || token === '-') break;
    if (readOnlyFlags.has(token)) {
      readOnly = true;
      i++;
      continue;
    }
    if (token === '--file' || token === '-f' || token === '--blob' || token === '--type') {
      i += 2;
      continue;
    }
    i++;
  }
  if (readOnly) return undefined;
  const key = args[i];
  const value = args[i + 1];
  const match = key != null ? /^alias\.([^=]+)$/iu.exec(key) : null;
  if (match == null || value == null) return undefined;
  return { name: match[1]!, value };
}

function gitConfigAliasPayload(argv: string[]): string | undefined {
  const alias = gitConfigAlias(argv);
  if (alias == null) return undefined;
  if (alias.value.trim().length === 0) return 'git push';
  return alias.value.startsWith('!') ? alias.value.slice(1).trim() : `git ${alias.value}`;
}

const GH_GLOBAL_OPTIONS_WITH_VALUE = new Set(['-R', '--repo', '--hostname', '--config']);

function ghArgs(argv: string[]): readonly string[] {
  if (argv[0] !== 'gh') return [];
  const i = skipLeadingOptions(argv, 1, GH_GLOBAL_OPTIONS_WITH_VALUE);
  return argv.slice(i);
}

function ghCommandArgs(argv: string[]): readonly string[] {
  const args = ghArgs(argv);
  if (args[0] !== 'pr') return args;
  const i = skipLeadingOptions([...args], 1, GH_GLOBAL_OPTIONS_WITH_VALUE);
  return ['pr', ...args.slice(i)];
}

// Every -X / --method value on the command line. gh allows the flag repeated and pflag takes the
// LAST value, so reading only the first is unsound (a decoy leading `-X GET` would mask a trailing
// `-X POST`). We collect them all and fail closed if ANY names a write verb.
function ghApiMethods(args: readonly string[]): string[] {
  const methods: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--method' || token === '-X') {
      const value = args[i + 1];
      if (value != null) methods.push(value.toUpperCase());
      continue;
    }
    if (token.startsWith('--method=')) methods.push(token.slice('--method='.length).toUpperCase());
    else if (/^-X[A-Za-z]+$/u.test(token)) methods.push(token.slice(2).toUpperCase());
  }
  return methods;
}

function ghApiEndpoint(args: readonly string[]): string | undefined {
  for (const token of args.slice(1)) {
    if (token === '--') continue;
    if (token.startsWith('-')) continue;
    return token.replace(/^\/+/u, '');
  }
  return undefined;
}

// gh field flags that supply a request body — their presence makes `gh api` implicitly POST.
const GH_API_FIELD_FLAGS = new Set(['-f', '--field', '-F', '--raw-field', '--input']);

// HTTP methods that mutate server state.
const GH_API_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// GraphQL mutations that publish a PR outside the recorded-PASS gate. Kept for documentation;
// the gate now blocks ANY inline `mutation` operation, not only these specific names.
const GH_GRAPHQL_PUBLISH_MUTATIONS = [
  'mergePullRequest',
  'createPullRequest',
  'enablePullRequestAutoMerge',
  'markPullRequestReadyForReview',
] as const;

function ghApiHasFieldFlag(args: readonly string[]): boolean {
  for (let i = 1; i < args.length; i++) {
    const token = args[i]!;
    if (GH_API_FIELD_FLAGS.has(token)) return true;
    if (/^--(field|raw-field|input)=/u.test(token)) return true; // equals form
    if (/^-[fF].+/u.test(token)) return true; // attached short form: -fkey=… / -Fkey=…
  }
  return false;
}

// True iff a request body is supplied INDIRECTLY — from a file (`key=@path`), stdin (`key=@-`),
// or `--input <file|->`. The body content is then OPAQUE to this gate (it never appears in argv),
// so a publishing mutation hidden there cannot be detected and the call must fail closed.
function ghApiHasOpaqueBody(args: readonly string[]): boolean {
  for (let i = 1; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--input' || token.startsWith('--input=')) return true; // file path or '-'
    if (token === '-f' || token === '-F' || token === '--field' || token === '--raw-field') {
      if ((args[i + 1] ?? '').includes('=@')) return true; // separate-token: key=@file / key=@-
      continue;
    }
    if (/^--(field|raw-field)=.*=@/u.test(token)) return true; // equals form: --field=key=@x
    if (/^-[fF].*=@/u.test(token)) return true; // attached short form: -Fkey=@x
  }
  return false;
}

// gh sends GET unless an explicit write method is given or a request-body field flag is present
// (which makes it an implicit POST). An explicit GET/HEAD keeps `-f/-F` as read query params.
function ghApiIsWriteRequest(args: readonly string[]): boolean {
  const methods = ghApiMethods(args);
  if (methods.length > 0) {
    // Explicit method(s): a write iff ANY names a write verb. Fail closed against repeated/mixed
    // method flags — gh/pflag takes the LAST, so a decoy leading `-X GET` must not mask `-X POST`.
    return methods.some((method) => GH_API_WRITE_METHODS.has(method));
  }
  return ghApiHasFieldFlag(args);
}

function ghApiGraphqlIsBypass(args: readonly string[]): boolean {
  // An opaque mutation body (file/stdin) cannot be inspected → fail closed.
  if (ghApiHasOpaqueBody(args)) return true;
  // Any inline GraphQL *mutation* operation publishes. The `mutation` keyword is required for
  // mutations (read queries are anonymous `{…}` or `query{…}`), so a read query stays permitted.
  const haystack = args.join('\n');
  if (/\bmutation\b/u.test(haystack)) return true;
  return GH_GRAPHQL_PUBLISH_MUTATIONS.some((mutation) => haystack.includes(mutation));
}

function ghApiBypassesPrGate(args: readonly string[]): boolean {
  if (args[0] !== 'api') return false;
  const endpoint = ghApiEndpoint(args);
  if (endpoint == null) return false;
  // `gh api graphql` resolves its endpoint to `graphql`; inspect the operation directly.
  if (endpoint === 'graphql') return ghApiGraphqlIsBypass(args);
  // Mirror the Claude `Bash(gh api*)` posture on the Codex surface: fail closed on ANY write
  // through `gh api`. Enumerating publishing endpoints (pulls, pulls/N/merge, pulls/N/update-branch,
  // merges, git/refs, …) is whack-a-mole — a *write* is the thing that can publish, merge, or move
  // refs outside the recorded-PASS gate. Read-only GETs (no write method, no request body) stay
  // permitted, so non-publishing inspection still works on both providers.
  return ghApiIsWriteRequest(args);
}

function ghAliasSet(argv: string[]): { name: string; value: string; shell: boolean } | undefined {
  const args = ghArgs(argv);
  if (args[0] !== 'alias' || args[1] !== 'set') return undefined;
  let shell = false;
  const positional: string[] = [];
  for (let i = 2; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--shell' || token === '-s' || token === '--shell=true') {
      shell = true;
      continue;
    }
    if (token === '--shell=false') continue;
    if (token === '--clobber') {
      continue;
    }
    if (token === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (token.startsWith('-')) {
      continue;
    }
    positional.push(token);
  }
  const name = positional[0];
  const value = positional[1];
  if (name == null || value == null) return undefined;
  if (value === '-') return { name, value: 'git push', shell: true };
  return { name, value, shell };
}

function isGhAliasImportStdinCommand(argv: readonly string[]): boolean {
  const args = ghArgs([...argv]);
  if (args[0] !== 'alias' || args[1] !== 'import') return false;
  for (let i = 2; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--') return args[i + 1] === '-';
    if (token === '-') return true;
    if (token === '--clobber') continue;
    if (token.startsWith('-')) continue;
    return false;
  }
  return false;
}

interface GhAliasImport {
  readonly name: string;
  readonly value: string;
}

function ghAliasImportHeredocPayload(command: string): string | undefined {
  const lines = command.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const delimiter = heredocDelimiters(line)[0];
    if (delimiter == null) continue;
    const body: string[] = [];
    let end = i + 1;
    for (; end < lines.length; end++) {
      const candidate = lines[end]!;
      if (heredocLineMatches(candidate, delimiter)) break;
      body.push(candidate);
    }
    if (isGhAliasImportStdinCommand(stripShellRedirections(rawTokens(line)))) {
      return body.join('\n');
    }
    i = end;
  }
  return undefined;
}

function ghAliasImportPayloads(command: string): string[] {
  const payloads: string[] = [];
  const heredocPayload = ghAliasImportHeredocPayload(command);
  if (heredocPayload != null) payloads.push(heredocPayload);

  const pipedHeredocPayload = ghAliasImportPipedHeredocPayload(command);
  if (pipedHeredocPayload != null) payloads.push(pipedHeredocPayload);

  const shellCommands = splitShellCommands(command);
  for (const segment of shellCommands) {
    const processSubstitutionPayload = ghAliasImportProcessSubstitutionPayload(segment);
    if (processSubstitutionPayload != null) payloads.push(processSubstitutionPayload);
  }

  let stream: string | undefined;
  for (const part of splitPipeline(command)) {
    if (stream == null) {
      stream = literalStreamOutput(part.trim());
      continue;
    }
    const consumer = splitShellCommands(part)[0] ?? part;
    const argv = stripShellRedirections(rawTokens(consumer));
    if (isTransparentPipeCommand(argv)) continue;
    if (isGhAliasImportStdinCommand(argv)) payloads.push(stream);
    stream = undefined;
  }

  for (const segment of shellCommands) {
    const hereString = hereStringParts(segment);
    if (
      hereString != null &&
      isGhAliasImportStdinCommand(stripShellRedirections(rawTokens(hereString.command)))
    ) {
      const tokens = rawTokens(hereString.payload);
      if (tokens.length === 1 && tokens[0] != null && tokens[0].length > 0) {
        payloads.push(tokens[0]);
      }
    }
  }
  return payloads;
}

function ghAliasImportPipedHeredocPayload(command: string): string | undefined {
  const lines = command.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const delimiter = heredocDelimiters(line)[0];
    if (delimiter == null) continue;
    const pipeline = splitPipeline(line);
    if (pipeline.length < 2) continue;
    const producer = pipeline[0]!;
    const consumer = pipeline.at(-1)!;
    if (!isTransparentPipeCommand(stripShellRedirections(rawTokens(producer)))) continue;
    if (!isGhAliasImportStdinCommand(stripShellRedirections(rawTokens(consumer)))) continue;
    const body: string[] = [];
    for (const candidate of lines.slice(i + 1)) {
      if (heredocLineMatches(candidate, delimiter)) return body.join('\n');
      body.push(candidate);
    }
  }
  return undefined;
}

function ghAliasImportProcessSubstitutionPayload(command: string): string | undefined {
  const match = /^\s*([\s\S]+?)\s*<\s*<\(([\s\S]+)\)\s*$/u.exec(command);
  const consumer = match?.[1];
  const producer = match?.[2];
  if (consumer == null || producer == null) return undefined;
  if (!isGhAliasImportStdinCommand(stripShellRedirections(rawTokens(consumer)))) return undefined;
  return literalStreamOutput(producer.trim());
}

function parseGhAliasImportPayload(payload: string): GhAliasImport[] {
  const imports: GhAliasImport[] = [];
  const lines = payload.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const body = trimmed.slice(1, -1);
      for (const entry of body.split(',')) {
        const colon = entry.indexOf(':');
        if (colon <= 0) continue;
        const name = stripQuotes(entry.slice(0, colon).trim());
        const value = stripYamlScalarTag(stripQuotes(entry.slice(colon + 1).trim()));
        if (name.length > 0 && value.length > 0) imports.push({ name, value });
      }
      continue;
    }
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const name = stripQuotes(trimmed.slice(0, colon).trim());
    let value = stripYamlScalarTag(stripQuotes(trimmed.slice(colon + 1).trim()));
    if (/^[|>][-+]?$/u.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/u.test(lines[i + 1]!)) {
        i++;
        block.push(lines[i]!.replace(/^\s+/u, ''));
      }
      value = block.join('\n').trim();
    }
    if (name.length > 0 && value.length > 0) imports.push({ name, value });
  }
  return imports;
}

function stripYamlScalarTag(value: string): string {
  return value.replace(/^![!\w./-]+\s+/u, '').trim();
}

function ghAliasPayload(argv: string[], aliases: ReadonlyMap<string, string>): string | undefined {
  const args = ghArgs(argv);
  const match = [...aliases.entries()]
    .map(([name, value]) => ({ name, value, tokens: name.trim().split(/\s+/u).filter(Boolean) }))
    .filter((entry) => entry.tokens.length > 0)
    .sort((a, b) => b.tokens.length - a.tokens.length)
    .find((entry) => entry.tokens.every((token, i) => args[i] === token));
  if (match == null) return undefined;
  const alias = match.value;
  const rest = args.slice(match.tokens.length);
  if (alias.startsWith('!')) {
    const payload = expandShellPositionals(alias.slice(1).trim(), undefined, rest) ?? '';
    return payload.length > 0 ? payload : 'git push';
  }
  return `gh ${alias} ${rest.join(' ')}`;
}

function envSelectsExternalGhConfig(env: ReadonlyMap<string, string>): boolean {
  return ['GH_CONFIG_DIR', 'HOME', 'XDG_CONFIG_HOME'].some((key) => {
    const value = env.get(key);
    return value != null && value.length > 0;
  });
}

const KNOWN_GH_TOP_LEVEL_COMMANDS: ReadonlySet<string> = new Set([
  'alias',
  'api',
  'auth',
  'browse',
  'codespace',
  'completion',
  'config',
  'extension',
  'gist',
  'gpg-key',
  'issue',
  'label',
  'org',
  'pr',
  'project',
  'release',
  'repo',
  'ruleset',
  'run',
  'search',
  'secret',
  'ssh-key',
  'status',
  'variable',
  'workflow',
]);

function isPotentialGhAliasCommand(command: string | undefined): boolean {
  if (command == null || command.startsWith('-')) return false;
  return !KNOWN_GH_TOP_LEVEL_COMMANDS.has(command.toLowerCase());
}

function externalGhAliasPayload(
  argv: string[],
  env: ReadonlyMap<string, string>,
): string | undefined {
  if (argv[0] !== 'gh' || !envSelectsExternalGhConfig(env)) return undefined;
  const args = ghArgs(argv);
  if (!isPotentialGhAliasCommand(args[0])) return undefined;
  return `gh pr merge ${args.slice(1).join(' ')}`.trim();
}

const CO_GLOBAL_OPTIONS_WITH_VALUE = new Set(['--config', '-C', '--project', '--cwd']);

function coSubcommand(argv: string[]): string | undefined {
  if (argv[0] !== 'co') return undefined;
  const i = skipLeadingOptions(argv, 1, CO_GLOBAL_OPTIONS_WITH_VALUE);
  return argv[i];
}

function isDangerousRmTarget(target: string): boolean {
  const normalized = stripQuotes(target).replace(/["']/gu, '');
  const withoutTrailingSlash = normalized.length > 1 ? normalized.replace(/\/+$/u, '') : normalized;
  const symbolicHome = normalized.replace(/^\$\{HOME(?:(?::?\?|-|:-|=|:=)[^}]*)?\}/u, '${HOME}');
  return (
    withoutTrailingSlash === '/' ||
    withoutTrailingSlash === '~' ||
    withoutTrailingSlash === '$HOME' ||
    withoutTrailingSlash === '${HOME}' ||
    normalized.startsWith('/*') ||
    normalized.startsWith('/.*') ||
    normalized.startsWith('~/*') ||
    normalized.startsWith('~/.') ||
    normalized.startsWith('$HOME/*') ||
    normalized.startsWith('$HOME/.') ||
    normalized.startsWith('${HOME}/*') ||
    normalized.startsWith('${HOME}/.') ||
    normalized.startsWith('${HOME?') ||
    normalized.startsWith('${HOME:?') ||
    symbolicHome === '${HOME}' ||
    symbolicHome.startsWith('${HOME}/*') ||
    symbolicHome.startsWith('${HOME}/.')
  );
}

function hasHelpFlag(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === '--') return false;
    if (arg === '--help' || arg === '-h') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The declared hard blocks — EXACTLY these eight, no more, no less.
// ---------------------------------------------------------------------------

export const BLOCK_LIST: readonly BlockRule[] = [
  // ── destroys-repo-or-system ───────────────────────────────────────────────

  {
    // Rewrites shared history. Force-push variants: --force, -f, --force-with-lease.
    id: 'git-force-push',
    category: 'destroys-repo-or-system',
    description: '`git push` with --force / -f / --force-with-lease rewrites shared history.',
    matches(command) {
      const argv = tokenize(command);
      if (hasHelpFlag(argv)) return false;
      const args = gitArgs(argv);
      if (args[0] !== 'push') return false;
      return hasGitForcePushFlag(args);
    },
  },

  {
    // `rm -rf /` or `rm -rf ~`/`$HOME` — mass deletion of root or home.
    id: 'rm-rf-root-or-home',
    category: 'destroys-repo-or-system',
    description: '`rm` recursive+force targeting / or ~ / $HOME destroys the filesystem.',
    matches(command) {
      const argv = tokenize(command);
      if (argv[0] !== 'rm') return false;
      // Must have a recursive flag AND a force flag.
      const allFlags = argv.filter((t) => t.startsWith('-') && !t.startsWith('--')).join('');
      const hasRecursive = hasFlag(argv, '--recursive') || /r/i.test(allFlags);
      const hasForce = hasFlag(argv, '--force') || allFlags.includes('f');
      if (!hasRecursive || !hasForce) return false;
      // At least one target must be / ~ $HOME or exactly those path strings.
      const targets = argv.filter((t) => !t.startsWith('-'));
      targets.shift(); // remove 'rm'
      return targets.some(isDangerousRmTarget);
    },
  },

  {
    // Any command invoking sudo elevates privilege destructively.
    id: 'sudo',
    category: 'destroys-repo-or-system',
    description: 'Commands invoking `sudo` escalate privilege in ways agents must not do.',
    matches(command) {
      const argv = tokenize(command);
      return argv[0] === 'sudo';
    },
  },

  {
    // Invoking the router daemon directly (`co run …`); forces the MCP surface.
    id: 'daemon-direct',
    category: 'destroys-repo-or-system',
    description:
      '`co run` invokes the foreground router daemon directly — use the MCP surface instead.',
    matches(command) {
      const argv = tokenize(command);
      return coSubcommand(argv) === 'run';
    },
  },

  // ── bypasses-gate ─────────────────────────────────────────────────────────

  {
    // Raw `git merge` lets unreviewed code land. Forces `co_merge`.
    id: 'raw-git-merge',
    category: 'bypasses-gate',
    description: 'Raw `git merge` bypasses the review gate — use `co_merge` instead.',
    matches(command) {
      const argv = tokenize(command);
      if (hasHelpFlag(argv)) return false;
      const args = gitArgs(argv);
      if (args[0] === 'pull') return true;
      if (args[0] !== 'merge') return false;
      return !args.some((arg) => arg === '--abort' || arg === '--quit');
    },
  },

  {
    // Raw `git push` (non-force) bypasses `co_push` which requires a PASS verdict.
    id: 'raw-git-push',
    category: 'bypasses-gate',
    description: 'Raw `git push` bypasses the review gate — use `co_push` instead.',
    matches(command) {
      const argv = tokenize(command);
      if (hasHelpFlag(argv)) return false;
      const args = gitArgs(argv);
      if (args[0] === 'send-pack') return true;
      if (args[0] !== 'push') return false;
      // A force-push is already caught by git-force-push; return true only for non-force pushes
      // so the more-specific rule takes priority when both would match.
      return !hasGitForcePushFlag(args);
    },
  },

  {
    // `gh pr merge/create` bypasses the recorded PR gate. PR creation goes through co_pr_merge;
    // direct GitHub PR merging is outside the sanctioned v1 agent surface.
    id: 'raw-gh-pr-merge',
    category: 'bypasses-gate',
    description:
      '`gh pr create` bypasses the review gate; use `co_pr_merge` to open PRs. `gh pr merge` ' +
      'is outside the sanctioned v1 agent surface.',
    matches(command) {
      const argv = tokenize(command);
      if (hasHelpFlag(argv)) return false;
      const args = ghCommandArgs(argv);
      if (ghApiBypassesPrGate(args)) return true;
      return args[0] === 'pr' && (args[1] === 'merge' || args[1] === 'create');
    },
  },

  // ── breaks-single-surface ─────────────────────────────────────────────────

  {
    // An agent invoking the `co` CLI violates the single-surface decision (MCP only).
    id: 'co-in-shell',
    category: 'breaks-single-surface',
    description: 'Agents must use the MCP surface (`co_*` tools), not the `co` CLI in the shell.',
    matches(command) {
      const argv = tokenize(command);
      // `co run` is already caught by daemon-direct; any other `co <subcommand>` is still blocked.
      if (argv[0] !== 'co') return false;
      const subcommand = coSubcommand(argv);
      return subcommand !== 'run';
    },
  },
];

// ---------------------------------------------------------------------------
// Public matcher
// ---------------------------------------------------------------------------

/**
 * Returns the first {@link BlockRule} that matches `command`, or `null` when nothing matches
 * (meaning the command is not hard-blocked and is freely permitted).
 *
 * Matching priority: `git-force-push` is tested before `raw-git-push` so that a force-push
 * resolves to the more-specific rule. The list order encodes this priority.
 */
function mergedVariables(
  shellVariables: ReadonlyMap<string, string>,
  env: ReadonlyMap<string, string>,
): Map<string, string> {
  const merged = new Map(shellVariables);
  for (const [name, value] of env) merged.set(name, value);
  return merged;
}

function isReadonlyMap(value: unknown): value is ReadonlyMap<string, string> {
  return (
    typeof value === 'object' &&
    value != null &&
    typeof (value as { get?: unknown }).get === 'function' &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
  );
}

function normalizeMatchBlockState(
  input: ReadonlyMap<string, string> | MatchBlockOptions,
): MatchBlockState {
  if (isReadonlyMap(input)) {
    return {
      variables: input,
      gitAliases: new Map(),
      ghAliases: new Map(),
    };
  }
  return {
    variables: input.variables ?? new Map(),
    gitAliases: input.gitAliases ?? new Map(),
    ghAliases: input.ghAliases ?? new Map(),
  };
}

function blockRuleById(id: string): BlockRule | undefined {
  return BLOCK_LIST.find((rule) => rule.id === id);
}

function hasCommandSubstitution(token: string | undefined): boolean {
  return token != null && (token.includes('$(') || token.includes('`'));
}

function executableLookupName(source: string | undefined): string | undefined {
  if (source == null) return undefined;
  const trimmed = source.trim();
  let lookupSource = trimmed;
  if (trimmed.startsWith('$(')) {
    const balanced = readBalanced(trimmed, 2, '(', ')');
    if (balanced != null && balanced.end === trimmed.length - 1) lookupSource = balanced.body;
  } else if (trimmed.startsWith('`')) {
    const backtick = readBacktick(trimmed, 0);
    if (backtick != null && backtick.end === trimmed.length - 1) {
      lookupSource = backtick.text.slice(1, -1);
    }
  }
  const argv = rawTokens(lookupSource);
  const name = commandName(argv[0]);
  if (name === 'which') {
    const target = argv.find((token, index) => index > 0 && !token.startsWith('-'));
    return commandName(target);
  }
  if (name === 'command') {
    let sawLookupFlag = false;
    for (const token of argv.slice(1)) {
      if (token === '--') continue;
      if (token === '-v' || token === '-V') {
        sawLookupFlag = true;
        continue;
      }
      if (!sawLookupFlag || token.startsWith('-')) continue;
      return commandName(token);
    }
  }
  return undefined;
}

function isProtectedExecutableLookup(source: string | undefined): boolean {
  const name = executableLookupName(source);
  return (
    name === 'git' ||
    name === 'git-push' ||
    name === 'git-merge' ||
    name === 'gh' ||
    name === 'co' ||
    name === 'sudo'
  );
}

function isNonProtectedExecutableLookup(source: string | undefined): boolean {
  const name = executableLookupName(source);
  return name != null && !isProtectedExecutableLookup(source);
}

function failClosedOpaqueGitSubstitutionTail(
  source: string | undefined,
  tail: readonly string[],
): BlockRule | undefined {
  const nonProtectedLookup = isNonProtectedExecutableLookup(source);
  if (nonProtectedLookup) return undefined;
  const protectedLookup = isProtectedExecutableLookup(source);
  if (tail[0] === 'push') return blockRuleById('raw-git-push');
  if (tail[0] === 'merge' && !protectedLookup) return blockRuleById('raw-git-merge');
  if (tail[0] != null && isGitForcePushFlag(tail[0]) && !protectedLookup) {
    return blockRuleById('git-force-push');
  }
  if (tail[0] === 'pr' && (tail[1] === 'merge' || tail[1] === 'create')) {
    return blockRuleById('raw-gh-pr-merge');
  }
  return undefined;
}

function failClosedUnknownCommandSubstitutionTail(tail: readonly string[]): BlockRule | undefined {
  return failClosedOpaqueGitSubstitutionTail(undefined, tail);
}

function failClosedCommandSubstitutionArgv(argv: readonly string[]): BlockRule | undefined {
  const name = commandName(argv[0]);
  if (name === 'git') {
    const { subcommandIndex } = parseGitAliases([...argv]);
    if (hasCommandSubstitution(argv[subcommandIndex])) return blockRuleById('raw-git-push');
  }
  if (name === 'gh') {
    const args = ghArgs([...argv]);
    if (hasCommandSubstitution(args[0])) {
      const tail = args.slice(commandSubstitutionTokenSpanEnd(args, 0) + 1);
      if (tail[0] === 'merge' || tail[0] === 'create') return blockRuleById('raw-gh-pr-merge');
      if (tail[0] != null && (/^\d+$/u.test(tail[0]) || tail[0].startsWith('-'))) {
        return blockRuleById('raw-gh-pr-merge');
      }
    }
    if (
      (hasCommandSubstitution(args[0]) && (args[1] === 'merge' || args[1] === 'create')) ||
      (args[0] === 'pr' && hasCommandSubstitution(args[1]))
    ) {
      return blockRuleById('raw-gh-pr-merge');
    }
  }
  if (hasCommandSubstitution(argv[0])) {
    return failClosedUnknownCommandSubstitutionTail(argv.slice(1));
  }
  return undefined;
}

function failClosedCommandSubstitutionVariableTail(
  value: string,
  tail: readonly string[],
): BlockRule | undefined {
  if (tail[0] === 'origin' && !executableLookupName(value)) {
    return blockRuleById('raw-git-push');
  }
  return failClosedOpaqueGitSubstitutionTail(value, tail);
}

function commandSubstitutionVariableValue(
  token: string | undefined,
  variables: ReadonlyMap<string, string>,
): string | undefined {
  if (token == null) return undefined;
  const match = /^\$(?:\{([A-Z_][A-Z0-9_]*)\}|([A-Z_][A-Z0-9_]*))$/iu.exec(token);
  const name = match?.[1] ?? match?.[2];
  const value = name != null ? variables.get(name) : undefined;
  return value != null && hasCommandSubstitution(value) ? value : undefined;
}

function failClosedVariableCommandSubstitutionRule(
  argv: readonly string[],
  variables: ReadonlyMap<string, string>,
): BlockRule | undefined {
  const name = commandName(argv[0]);
  if (name === 'git') {
    const { subcommandIndex } = parseGitAliases([...argv]);
    if (commandSubstitutionVariableValue(argv[subcommandIndex], variables) != null) {
      return blockRuleById('raw-git-push');
    }
  }
  if (name === 'gh') {
    const args = ghArgs([...argv]);
    if (commandSubstitutionVariableValue(args[0], variables) != null) {
      const tail = args.slice(1);
      if (tail[0] === 'merge' || tail[0] === 'create') return blockRuleById('raw-gh-pr-merge');
    }
    if (args[0] === 'pr' && commandSubstitutionVariableValue(args[1], variables) != null) {
      return blockRuleById('raw-gh-pr-merge');
    }
  }
  if (commandSubstitutionVariableValue(argv[0], variables) != null) {
    return failClosedCommandSubstitutionVariableTail(
      commandSubstitutionVariableValue(argv[0], variables)!,
      argv.slice(1),
    );
  }
  return undefined;
}

function firstArgIsNonProtectedLookupVariable(
  argv: readonly string[],
  variables: ReadonlyMap<string, string>,
): boolean {
  return isNonProtectedExecutableLookup(commandSubstitutionVariableValue(argv[0], variables));
}

function commandSubstitutionTokenSpanEnd(tokens: readonly string[], start: number): number {
  const first = tokens[start];
  if (first == null) return start;
  if (first.includes('$(')) {
    for (let i = start; i < tokens.length; i++) {
      if (tokens[i]!.includes(')')) return i;
    }
  }
  if (first.includes('`')) {
    for (let i = start; i < tokens.length; i++) {
      if (tokens[i]!.endsWith('`') || (i > start && tokens[i]!.includes('`'))) return i;
    }
  }
  return start;
}

interface LeadingCommandSubstitution {
  readonly body: string;
  readonly tail: readonly string[];
}

function leadingCommandSubstitution(command: string): LeadingCommandSubstitution | undefined {
  const trimmed = command.trimStart();
  if (trimmed.startsWith('$(')) {
    const balanced = readBalanced(trimmed, 2, '(', ')');
    if (balanced != null) {
      return { body: balanced.body, tail: tokenize(trimmed.slice(balanced.end + 1)) };
    }
  }
  if (trimmed.startsWith('`')) {
    const backtick = readBacktick(trimmed, 0);
    if (backtick != null) {
      return {
        body: backtick.text.slice(1, -1),
        tail: tokenize(trimmed.slice(backtick.end + 1)),
      };
    }
  }
  return undefined;
}

function leadingSubstitutionHintsGhPr(leading: LeadingCommandSubstitution): BlockRule | undefined {
  const hint = leading.body.toLowerCase();
  const first = leading.tail[0];
  const tailLooksLikePrOperand = first != null && (/^\d+$/u.test(first) || first.startsWith('-'));
  if (
    tailLooksLikePrOperand &&
    (hint.includes('gh-pr-merge') ||
      hint.includes('gh-pr-create') ||
      hint.includes('gh_pr_merge') ||
      hint.includes('gh_pr_create'))
  ) {
    return blockRuleById('raw-gh-pr-merge');
  }
  return undefined;
}

function failClosedCommandSubstitutionRule(command: string): BlockRule | undefined {
  if (!command.includes('$(') && !command.includes('`')) return undefined;

  const argv = normalizeCommand(
    stripLeadingEnvAssignments(stripShellRedirections(rawTokens(command))),
  );
  const byArgv = failClosedCommandSubstitutionArgv(argv);
  if (byArgv != null) return byArgv;

  const leading = leadingCommandSubstitution(command);
  const tail = leading?.tail;
  if (tail?.[0] === 'push' && !isNonProtectedExecutableLookup(leading?.body)) {
    return blockRuleById('raw-git-push');
  }
  if (tail?.[0] === 'origin' && !executableLookupName(leading?.body)) {
    return blockRuleById('raw-git-push');
  }
  const opaqueGit = failClosedOpaqueGitSubstitutionTail(leading?.body, tail ?? []);
  if (opaqueGit != null) return opaqueGit;
  if (tail?.[0] === 'pr' && (tail[1] === 'merge' || tail[1] === 'create')) {
    return blockRuleById('raw-gh-pr-merge');
  }
  if (leading != null) {
    const hinted = leadingSubstitutionHintsGhPr(leading);
    if (hinted != null) return hinted;
    if (isNonProtectedExecutableLookup(leading.body)) return undefined;
  }
  if (tail != null && tail.length > 0) return failClosedUnknownCommandSubstitutionTail(tail);
  return undefined;
}

export function matchBlock(
  command: string,
  options: ReadonlyMap<string, string> | MatchBlockOptions = new Map(),
): BlockRule | null {
  const state = normalizeMatchBlockState(options);
  const inheritedGitAliases = new Map(state.gitAliases);
  const ghAliases = new Map<string, string>(state.ghAliases);
  const shellAliases = new Map<string, string>();
  const shellFunctions = new Map<string, string>();
  const shellVariables = new Map(state.variables);
  if (!shellVariables.has('IFS')) shellVariables.set('IFS', ' ');
  const childOptions = (variables: ReadonlyMap<string, string>): MatchBlockOptions => ({
    variables,
    gitAliases: inheritedGitAliases,
    ghAliases,
  });
  const commandWithoutComments = stripShellComments(normalizeShellLineContinuations(command));
  for (const payload of ghAliasImportPayloads(commandWithoutComments)) {
    for (const imported of parseGhAliasImportPayload(payload)) {
      const importedPayload = imported.value.startsWith('!')
        ? imported.value.slice(1).trim()
        : `gh ${imported.value}`;
      const nested = matchBlock(importedPayload, childOptions(shellVariables));
      if (nested != null) return nested;
      ghAliases.set(imported.name, imported.value);
    }
  }
  const normalizedCommand = stripNonShellHeredocBodies(commandWithoutComments);
  for (const loop of shellForLoopPayloads(normalizedCommand)) {
    for (const value of loop.values) {
      const loopVariables = new Map(shellVariables);
      loopVariables.set(loop.variable, value);
      const nested = matchBlock(loop.payload, childOptions(loopVariables));
      if (nested != null) return nested;
    }
  }
  for (const payload of shellStdinPayloads(normalizedCommand)) {
    const nested = matchBlock(payload, childOptions(shellVariables));
    if (nested != null) return nested;
  }
  for (const segment of splitShellCommands(normalizedCommand)) {
    const env = commandEnvAssignments(segment);
    const nestedVariables = mergedVariables(shellVariables, env);
    let effectiveSegment = segment;
    for (const payload of nestedShellPayloads(segment)) {
      const nested = matchBlock(payload, childOptions(nestedVariables));
      if (nested != null) return nested;
    }
    const synthesized = synthesizeLiteralCommandSubstitutions(segment);
    if (synthesized != null) {
      const nested = matchBlock(synthesized, childOptions(nestedVariables));
      if (nested != null) return nested;
      effectiveSegment = synthesized;
    }
    const failClosedSubstitutionRule = failClosedCommandSubstitutionRule(effectiveSegment);
    if (failClosedSubstitutionRule != null) return failClosedSubstitutionRule;
    const braceExpanded = synthesizeBraceExpansionCommand(effectiveSegment);
    if (braceExpanded != null) {
      const nested = matchBlock(braceExpanded, childOptions(nestedVariables));
      if (nested != null) return nested;
    }
    const functionDefinition = shellFunctionDefinition(effectiveSegment);
    const functionPayload = functionDefinition?.body ?? shellFunctionPayload(effectiveSegment);
    if (functionPayload != null) {
      const nested = matchBlock(functionPayload, childOptions(nestedVariables));
      if (nested != null) return nested;
      if (functionDefinition != null) {
        shellFunctions.set(functionDefinition.name, functionDefinition.body);
        continue;
      }
    }
    const variableDefinitions = shellVariableDefinitions(effectiveSegment);
    if (variableDefinitions.length > 0) {
      for (const definition of variableDefinitions) {
        shellVariables.set(definition.name, definition.value);
      }
      continue;
    }
    const variableDeclarations = shellVariableDeclarations(effectiveSegment);
    if (variableDeclarations.length > 0) {
      for (const declaration of variableDeclarations) {
        shellVariables.set(declaration.name, declaration.value);
      }
      continue;
    }
    const originalCommandForRules = tokenize(effectiveSegment).map(quoteShellToken).join(' ');
    const rmRule = blockRuleById('rm-rf-root-or-home');
    if (rmRule?.matches(originalCommandForRules)) return rmRule;
    const rawArgvWords = tokenizeWithQuoteMetadata(effectiveSegment);
    const rawArgv = rawArgvWords.map((token) => token.value);
    const failClosedVariableSubstitutionRule = failClosedVariableCommandSubstitutionRule(
      rawArgv,
      shellVariables,
    );
    if (failClosedVariableSubstitutionRule != null) return failClosedVariableSubstitutionRule;
    const argv = expandShellVariableWords(rawArgvWords, shellVariables);
    const failClosedExpandedSubstitutionRule = firstArgIsNonProtectedLookupVariable(
      rawArgv,
      shellVariables,
    )
      ? undefined
      : failClosedCommandSubstitutionArgv(argv);
    if (failClosedExpandedSubstitutionRule != null) return failClosedExpandedSubstitutionRule;
    const shellAlias = argv[0] != null ? shellAliases.get(argv[0]) : undefined;
    if (shellAlias != null) {
      const expanded = expandShellAliasInvocation(shellAlias, argv.slice(1));
      const nested = matchBlock(expanded, childOptions(nestedVariables));
      if (nested != null) return nested;
    }
    const shellFunction = argv[0] != null ? shellFunctions.get(argv[0]) : undefined;
    if (shellFunction != null) {
      const expanded = expandShellPositionals(shellFunction, undefined, argv.slice(1));
      if (expanded != null) {
        const nested = matchBlock(expanded, childOptions(nestedVariables));
        if (nested != null) return nested;
      }
    }
    const structuralPayload = shellStructuralPayload(argv);
    if (structuralPayload != null) {
      const nested = matchBlock(structuralPayload, childOptions(nestedVariables));
      if (nested != null) return nested;
    }
    const payload = shellPayload(argv);
    if (payload != null) {
      const nested = matchBlock(payload, childOptions(nestedVariables));
      if (nested != null) return nested;
    }
    const evaled = evalPayload(argv);
    if (evaled != null) {
      const nested = matchBlock(evaled, childOptions(nestedVariables));
      if (nested != null) return nested;
    }
    const shellAliasPayload = shellAliasDefinitionPayload(argv);
    if (shellAliasPayload != null) {
      const nested = matchBlock(shellAliasPayload, childOptions(nestedVariables));
      if (nested != null) return nested;
    }
    for (const alias of shellAliasDefinitions(argv)) {
      shellAliases.set(alias.name, alias.value);
    }
    const aliasPayload = gitAliasPayload(argv, env, inheritedGitAliases);
    if (aliasPayload != null) {
      const nested = matchBlock(aliasPayload, childOptions(nestedVariables));
      if (nested != null) return nested;
    }
    const gitConfigPayload = gitConfigAliasPayload(argv);
    if (gitConfigPayload != null) {
      const nested = matchBlock(gitConfigPayload, childOptions(nestedVariables));
      if (nested != null) return nested;
      const alias = gitConfigAlias(argv);
      if (alias != null) inheritedGitAliases.set(normalizeGitAliasName(alias.name), alias.value);
    }
    const ghAlias = ghAliasSet(argv);
    if (ghAlias != null) {
      const payload =
        ghAlias.shell || ghAlias.value.startsWith('!')
          ? ghAlias.value.replace(/^!/u, '').trim()
          : `gh ${ghAlias.value}`;
      const nested = matchBlock(payload, childOptions(nestedVariables));
      if (nested != null) return nested;
      ghAliases.set(ghAlias.name, ghAlias.shell ? `!${ghAlias.value}` : ghAlias.value);
    }
    const externalGhPayload = externalGhAliasPayload(argv, env);
    if (externalGhPayload != null) {
      const nested = matchBlock(externalGhPayload, childOptions(nestedVariables));
      if (nested != null) return nested;
    }
    const ghPayload = ghAliasPayload(argv, ghAliases);
    if (ghPayload != null) {
      const nested = matchBlock(ghPayload, childOptions(nestedVariables));
      if (nested != null) return nested;
    }
    const commandForRules =
      argv.length > 0 ? argv.map(quoteShellToken).join(' ') : effectiveSegment;
    for (const rule of BLOCK_LIST) {
      if (rule.matches(commandForRules)) return rule;
    }
  }
  return null;
}
