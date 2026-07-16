import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { normalizeCodexEvent } from './bridge.mjs';

const ALLOWED_SANDBOXES = new Set(['read-only', 'workspace-write']);
const MAX_STDERR_CHARS = 64 * 1024;

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function invocation(args) {
  const configured = process.env.CODEX_BIN;
  if (configured) {
    if (process.platform === 'win32' && /\.cmd$/iu.test(configured)) {
      return {
        command: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', configured.replace(/\.cmd$/iu, '.ps1'), ...args],
      };
    }
    if (process.platform === 'win32' && /\.ps1$/iu.test(configured)) {
      return {
        command: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', configured, ...args],
      };
    }
    return { command: configured, args };
  }

  if (process.platform !== 'win32') return { command: 'codex', args };

  const located = spawnSync('where.exe', ['codex'], { encoding: 'utf8', windowsHide: true });
  const paths = located.status === 0
    ? located.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
    : [];
  const executable = paths.find((path) => /\.exe$/iu.test(path));
  if (executable) return { command: executable, args };
  const cmdShim = paths.find((path) => /\.cmd$/iu.test(path));
  if (cmdShim) {
    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', cmdShim.replace(/\.cmd$/iu, '.ps1'), ...args],
    };
  }
  return { command: 'codex', args };
}

export function terminate(child) {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => child.kill('SIGKILL'));
    return;
  }
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * Spawn `codex exec --json` and emit normalized relay events as JSONL arrives.
 * The callback receives `{kind, data}` objects suitable for
 * `session.pushEvent(requestId, kind, data)`.
 */
export async function streamCodex({
  prompt,
  cwd,
  sandbox = 'read-only',
  onEvent,
  timeoutMs = 180000,
  signal,
  resumeThreadId,
  onThreadId,
  configOverrides = [],
  env,
  model,
  images = [],
} = {}) {
  if (!text(prompt)) throw new TypeError('prompt must be a non-empty string.');
  if (!text(cwd)) throw new TypeError('cwd must be a non-empty string.');
  if (!ALLOWED_SANDBOXES.has(sandbox)) {
    throw new TypeError('sandbox must be "read-only" or "workspace-write".');
  }
  if (typeof onEvent !== 'function') throw new TypeError('onEvent must be a function.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive finite number.');
  }

  // The prompt goes through stdin, NOT argv: companion system prompts can be
  // tens of KB and Windows caps a command line at ~32K (live ENAMETOOLONG,
  // 2026-07-15). `codex exec -` reads the prompt from stdin.
  // With resumeThreadId, `codex exec resume <id>` continues the existing
  // session — the identity/context load happens once per session, not per run.
  // -i and -m must follow `resume <id>` when resuming (they belong to the
  // resume subcommand there); on a fresh run they're plain exec options.
  const runFlags = [
    ...(model ? ['-m', model] : []),
    ...images.flatMap((image) => ['-i', image]),
  ];
  const codexArgs = [
    'exec', '--json', '--skip-git-repo-check',
    '-C', cwd,
    '-s', sandbox,
    ...configOverrides.flatMap((override) => ['-c', override]),
    ...(resumeThreadId ? ['resume', resumeThreadId, ...runFlags, '-'] : [...runFlags, '-']),
  ];
  const target = invocation(codexArgs);

  return await new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    let stderr = '';
    let rawEventCount = 0;
    let sawTerminal = false;
    const errors = [];
    let callbacks = Promise.resolve();
    let abortHandler;

    const emit = (event) => {
      if (event.kind === 'done' || event.kind === 'error') sawTerminal = true;
      callbacks = callbacks.then(() => onEvent(event)).catch((error) => {
        errors.push(`onEvent failed: ${error.message}`);
      });
    };

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortHandler) signal?.removeEventListener('abort', abortHandler);

      if (timedOut) {
        const message = `Codex timed out after ${timeoutMs}ms.`;
        errors.push(message);
        if (!sawTerminal) emit({ kind: 'error', data: { message } });
      } else if (exitCode !== 0) {
        const detail = text(stderr);
        const message = detail
          ? `Codex exited with code ${exitCode}${signal ? ` (${signal})` : ''}: ${detail}`
          : `Codex exited with code ${exitCode}${signal ? ` (${signal})` : ''}.`;
        errors.push(message);
        if (!sawTerminal) emit({ kind: 'error', data: { message } });
      } else if (!sawTerminal) {
        emit({ kind: 'done', data: { exitCode: 0 } });
      }

      callbacks.then(() => resolve({
        ok: exitCode === 0 && !timedOut && errors.length === 0,
        exitCode,
        signal,
        rawEventCount,
        errors,
      }));
    };

    try {
      child = spawn(target.command, target.args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolve({ ok: false, exitCode: null, signal: null, rawEventCount, errors: [`Failed to spawn Codex: ${error.message}`] });
      return;
    }

    child.stdin.on('error', () => { /* child may exit before the prompt lands */ });
    child.stdin.end(prompt);

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const raw = JSON.parse(line);
        rawEventCount += 1;
        if (raw?.type === 'thread.started' && raw.thread_id && typeof onThreadId === 'function') {
          onThreadId(String(raw.thread_id));
        }
        for (const event of normalizeCodexEvent(raw)) emit(event);
      } catch (error) {
        const message = `Invalid JSONL from Codex: ${error.message}`;
        errors.push(message);
        emit({ kind: 'error', data: { message } });
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_STDERR_CHARS) {
        stderr += chunk.slice(0, MAX_STDERR_CHARS - stderr.length);
      }
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const message = `Failed to spawn Codex: ${error.message}`;
      errors.push(message);
      emit({ kind: 'error', data: { message } });
      callbacks.then(() => resolve({ ok: false, exitCode: null, signal: null, rawEventCount, errors }));
    });
    child.once('close', finish);

    abortHandler = () => {
      if (settled) return;
      terminate(child);
    };
    if (signal?.aborted) abortHandler();
    else signal?.addEventListener('abort', abortHandler, { once: true });

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      terminate(child);
      setTimeout(() => finish(null, 'SIGKILL'), 1000).unref();
    }, timeoutMs);
  });
}

export default streamCodex;
