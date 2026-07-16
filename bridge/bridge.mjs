import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const ALLOWED_SANDBOXES = new Set(['read-only', 'workspace-write']);
const MAX_STDERR_CHARS = 64 * 1024;

function emptyResult() {
  return {
    ok: false,
    messages: [],
    fileChanges: [],
    commands: [],
    errors: [],
    rawEventCount: 0,
  };
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function errorText(value) {
  if (typeof value === 'string') return nonEmptyString(value);
  if (!value || typeof value !== 'object') return undefined;
  return nonEmptyString(value.message)
    ?? nonEmptyString(value.error)
    ?? nonEmptyString(value.detail);
}

function changeType(change) {
  return nonEmptyString(change?.kind)
    ?? nonEmptyString(change?.change_type)
    ?? nonEmptyString(change?.changeType)
    ?? nonEmptyString(change?.type)
    ?? 'unknown';
}

function addFileChange(result, change, summary) {
  if (!change || typeof change !== 'object') return;
  const path = nonEmptyString(change.path)
    ?? nonEmptyString(change.file_path)
    ?? nonEmptyString(change.filePath);
  if (!path) return;

  const normalized = { path, changeType: changeType(change) };
  const resolvedSummary = nonEmptyString(change.summary) ?? nonEmptyString(summary);
  if (resolvedSummary) normalized.summary = resolvedSummary;
  result.fileChanges.push(normalized);
}

function addCommand(result, item) {
  const command = Array.isArray(item?.command)
    ? item.command.map(String).join(' ')
    : nonEmptyString(item?.command);
  if (!command) return;

  const normalized = { command };
  const cwd = nonEmptyString(item.cwd) ?? nonEmptyString(item.working_directory);
  const reason = nonEmptyString(item.reason)
    ?? nonEmptyString(item.justification)
    ?? nonEmptyString(item.description);
  if (cwd) normalized.cwd = cwd;
  if (reason) normalized.reason = reason;
  result.commands.push(normalized);
}

function normalizeItem(result, item) {
  if (!item || typeof item !== 'object') return;

  switch (item.type) {
    case 'agent_message': {
      const text = nonEmptyString(item.text) ?? nonEmptyString(item.message);
      if (text) result.messages.push(text);
      break;
    }
    case 'command_execution':
      addCommand(result, item);
      break;
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes : [item];
      for (const change of changes) addFileChange(result, change, item.summary);
      break;
    }
    case 'error': {
      const message = errorText(item);
      if (message) result.errors.push(message);
      break;
    }
  }
}

function normalizeEvent(result, event) {
  if (!event || typeof event !== 'object') return;

  switch (event.type) {
    case 'item.completed':
      normalizeItem(result, event.item);
      break;
    case 'turn.failed': {
      const message = errorText(event.error) ?? errorText(event);
      result.errors.push(message ?? 'Codex turn failed.');
      break;
    }
    case 'error': {
      const message = errorText(event);
      result.errors.push(message ?? 'Codex emitted an unspecified error event.');
      break;
    }
  }
}

/**
 * Normalize one Codex JSON event into zero or more relay events.
 *
 * This deliberately builds on the same aggregate normalizer used by
 * runCodex(), so field fallbacks stay identical between batch and streaming
 * consumers. A single Codex file_change item may produce multiple relay
 * events when it contains multiple changed paths.
 *
 * @param {unknown} event
 * @returns {{kind: 'message'|'file_change'|'command_approval'|'done'|'error', data: object}[]}
 */
export function normalizeCodexEvent(event) {
  const partial = emptyResult();
  normalizeEvent(partial, event);

  const normalized = [];
  for (const message of partial.messages) {
    normalized.push({ kind: 'message', data: { text: message } });
  }
  for (const change of partial.fileChanges) {
    normalized.push({ kind: 'file_change', data: change });
  }
  for (const command of partial.commands) {
    normalized.push({ kind: 'command_approval', data: command });
  }
  for (const message of partial.errors) {
    normalized.push({ kind: 'error', data: { message } });
  }

  if (event?.type === 'turn.completed') {
    const data = {};
    if (event.usage && typeof event.usage === 'object') data.usage = event.usage;
    normalized.push({ kind: 'done', data });
  }

  return normalized;
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

  // npm installs Codex as a .cmd/.ps1 shim on Windows. Node cannot execute
  // those shims directly without a shell, so resolve the shim with where.exe
  // and use PowerShell's -File mode. Unlike -Command/shell:true, this does not
  // reinterpret the user prompt as shell source.
  const located = spawnSync('where.exe', ['codex'], {
    encoding: 'utf8',
    windowsHide: true,
  });
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

function terminateProcessTree(child) {
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
 * Run Codex headlessly and normalize its JSONL event stream.
 *
 * @param {{prompt: string, cwd: string, sandbox?: 'read-only'|'workspace-write', timeoutMs?: number}} options
 */
export async function runCodex({
  prompt,
  cwd,
  sandbox = 'read-only',
  timeoutMs = 180000,
} = {}) {
  const result = emptyResult();

  if (!nonEmptyString(prompt)) {
    result.errors.push('prompt must be a non-empty string.');
    return result;
  }
  if (!nonEmptyString(cwd)) {
    result.errors.push('cwd must be a non-empty string.');
    return result;
  }
  if (!ALLOWED_SANDBOXES.has(sandbox)) {
    result.errors.push('sandbox must be "read-only" or "workspace-write".');
    return result;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    result.errors.push('timeoutMs must be a positive finite number.');
    return result;
  }

  const codexArgs = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-C', cwd,
    '-s', sandbox,
    prompt,
  ];
  const target = invocation(codexArgs);

  return await new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    let stderr = '';

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (timedOut) {
        result.errors.push(`Codex timed out after ${timeoutMs}ms.`);
      } else if (exitCode !== 0) {
        const detail = nonEmptyString(stderr);
        result.errors.push(detail
          ? `Codex exited with code ${exitCode}${signal ? ` (${signal})` : ''}: ${detail}`
          : `Codex exited with code ${exitCode}${signal ? ` (${signal})` : ''}.`);
      }

      result.ok = exitCode === 0 && !timedOut && result.errors.length === 0;
      resolve(result);
    };

    try {
      child = spawn(target.command, target.args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      result.errors.push(`Failed to spawn Codex: ${error.message}`);
      resolve(result);
      return;
    }

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        result.rawEventCount += 1;
        normalizeEvent(result, event);
      } catch (error) {
        result.errors.push(`Invalid JSONL from Codex: ${error.message}`);
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
      clearTimeout(timeout);
      result.errors.push(`Failed to spawn Codex: ${error.message}`);
      resolve(result);
    });
    child.once('close', finish);

    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      terminateProcessTree(child);
      // A platform-level process teardown should emit close. This fallback
      // preserves the API's hard deadline even if it does not.
      setTimeout(() => finish(null, 'SIGKILL'), 1000).unref();
    }, timeoutMs);
  });
}

function usage() {
  return 'Usage: node bridge.mjs --prompt "..." --cwd "<dir>" [--sandbox read-only|workspace-write] [--timeout-ms <ms>]';
}

function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--prompt', '--cwd', '--sandbox', '--timeout-ms'].includes(flag)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    if (index + 1 >= argv.length) throw new Error(`Missing value for ${flag}`);
    const value = argv[index += 1];
    if (flag === '--prompt') options.prompt = value;
    if (flag === '--cwd') options.cwd = value;
    if (flag === '--sandbox') options.sandbox = value;
    if (flag === '--timeout-ms') options.timeoutMs = Number(value);
  }
  return options;
}

const modulePath = decodeURIComponent(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/u, '$1')
  .replaceAll('/', '\\')
  .toLowerCase();
const invokedPath = (process.argv[1] ?? '').replaceAll('/', '\\').toLowerCase();

if (invokedPath === modulePath) {
  let output;
  try {
    const options = parseCli(process.argv.slice(2));
    if (!options.prompt || !options.cwd) throw new Error('--prompt and --cwd are required.');
    output = await runCodex(options);
  } catch (error) {
    output = emptyResult();
    output.errors.push(`${error.message}\n${usage()}`);
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.ok) process.exitCode = 1;
}
