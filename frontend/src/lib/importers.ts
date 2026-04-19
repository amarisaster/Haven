/**
 * Haven — Chat Import Parsers
 * Converts exports from ChatGPT, Claude, and SillyTavern into Haven format
 */

export interface ImportedThread {
  title: string;
  messages: Array<{
    role: 'user' | 'companion';
    content: string;
    timestamp?: string;
    model?: string;
  }>;
}

export interface ImportedIdentity {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  firstMessage?: string;
  appearance?: string;
  systemPrompt?: string;
}

export interface ImportResult {
  source: 'chatgpt' | 'claude' | 'sillytavern' | 'haven' | 'nexus-md' | 'unknown';
  threads: ImportedThread[];
  identity?: ImportedIdentity;
  errors: string[];
}

// ============================================================
// ChatGPT — conversations.json
// ============================================================

export function parseChatGPT(data: any): ImportResult {
  const errors: string[] = [];
  const threads: ImportedThread[] = [];

  // Can be array of conversations or single conversation
  const conversations = Array.isArray(data) ? data : [data];

  for (const conv of conversations) {
    try {
      if (!conv.mapping) {
        errors.push(`Skipped conversation "${conv.title || 'untitled'}": no mapping found`);
        continue;
      }

      const messages: ImportedThread['messages'] = [];

      // Linearize the tree: find root, follow children
      const nodes = conv.mapping;
      let currentId = Object.keys(nodes).find(id => !nodes[id].parent);

      // Walk the tree depth-first, following first child
      const visited = new Set<string>();
      const queue = currentId ? [currentId] : [];

      while (queue.length > 0) {
        const nodeId = queue.shift()!;
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);

        const node = nodes[nodeId];
        if (node?.message?.content?.parts) {
          const role = node.message.author?.role;
          const content = node.message.content.parts
            .filter((p: any) => typeof p === 'string')
            .join('\n');

          if (content.trim() && (role === 'user' || role === 'assistant')) {
            const timestamp = node.message.create_time
              ? new Date(node.message.create_time * 1000).toISOString()
              : undefined;

            messages.push({
              role: role === 'assistant' ? 'companion' : 'user',
              content: content.trim(),
              timestamp,
              model: node.message.metadata?.model_slug,
            });
          }
        }

        // Add children to queue
        if (node?.children) {
          queue.push(...node.children);
        }
      }

      if (messages.length > 0) {
        threads.push({
          title: conv.title || 'Imported conversation',
          messages,
        });
      }
    } catch (e) {
      errors.push(`Failed to parse conversation: ${(e as Error).message}`);
    }
  }

  return { source: 'chatgpt', threads, errors };
}

// ============================================================
// Claude — claude-export format
// ============================================================

export function parseClaude(data: any): ImportResult {
  const errors: string[] = [];
  const threads: ImportedThread[] = [];

  try {
    const title = data.meta?.title || data.title || 'Imported from Claude';
    const chats = data.chats || data.messages || [];
    const messages: ImportedThread['messages'] = [];

    for (const chat of chats) {
      const role = chat.type === 'prompt' || chat.role === 'user' ? 'user' : 'companion';

      let content = '';
      if (Array.isArray(chat.message)) {
        // claude-export format: message is array of content blocks
        content = chat.message
          .map((block: any) => {
            if (block.type === 'pre' || block.type === 'code') {
              return '```' + (block.language || '') + '\n' + block.data + '\n```';
            }
            return block.data || block.text || '';
          })
          .join('\n\n');
      } else if (typeof chat.message === 'string') {
        content = chat.message;
      } else if (typeof chat.content === 'string') {
        content = chat.content;
      }

      if (content.trim()) {
        messages.push({
          role,
          content: content.trim(),
          timestamp: chat.timestamp || chat.created_at,
        });
      }
    }

    if (messages.length > 0) {
      threads.push({ title, messages });
    }
  } catch (e) {
    errors.push(`Failed to parse Claude export: ${(e as Error).message}`);
  }

  return { source: 'claude', threads, errors };
}

// ============================================================
// SillyTavern — Character Card V2/V3
// ============================================================

export function parseSillyTavern(data: any): ImportResult {
  const errors: string[] = [];
  const threads: ImportedThread[] = [];

  // Handle V2/V3 wrapper
  const card = data.data || data;

  const identity: ImportedIdentity = {
    name: card.name,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    firstMessage: card.first_mes,
    appearance: card.description, // SillyTavern puts appearance in description
    systemPrompt: card.system_prompt,
  };

  // Create a thread from the first message if it exists
  if (card.first_mes) {
    threads.push({
      title: `First meeting with ${card.name || 'companion'}`,
      messages: [{
        role: 'companion',
        content: card.first_mes,
      }],
    });
  }

  // Parse example messages if they exist
  if (card.mes_example) {
    const exampleMessages: ImportedThread['messages'] = [];
    const lines = card.mes_example.split('\n');
    for (const line of lines) {
      const userMatch = line.match(/^<START>\s*$/i);
      if (userMatch) continue;

      const charMatch = line.match(/^{{char}}:\s*(.+)/i);
      const humanMatch = line.match(/^{{user}}:\s*(.+)/i);

      if (charMatch) {
        exampleMessages.push({ role: 'companion', content: charMatch[1].trim() });
      } else if (humanMatch) {
        exampleMessages.push({ role: 'user', content: humanMatch[1].trim() });
      }
    }

    if (exampleMessages.length > 0) {
      threads.push({
        title: 'Example conversation',
        messages: exampleMessages,
      });
    }
  }

  return { source: 'sillytavern', threads, identity, errors };
}

// ============================================================
// Haven — re-import from Haven export
// ============================================================

export function parseHaven(data: any): ImportResult {
  const errors: string[] = [];
  const threads: ImportedThread[] = [];

  if (!data.haven_version) {
    errors.push('Not a Haven export file');
    return { source: 'unknown', threads, errors };
  }

  for (const thread of (data.threads || [])) {
    threads.push({
      title: thread.title || 'Imported thread',
      messages: (thread.messages || []).map((m: any) => ({
        role: m.role === 'user' ? 'user' as const : 'companion' as const,
        content: m.content,
        timestamp: m.created_at || m.timestamp,
        model: m.model,
      })),
    });
  }

  const identity: ImportedIdentity | undefined = data.identity?.length > 0
    ? { description: data.identity.map((i: any) => i.content).join('\n\n') }
    : undefined;

  return { source: 'haven', threads, identity, errors };
}

// ============================================================
// Nexus AI Chat Importer — Obsidian plugin markdown export
// ============================================================
//
// Pattern (each message block):
//   >[!nexus_user] **User** - MM/DD/YYYY at H:MM AM/PM
//   > line 1
//   > line 2
//   <!-- UID: ... -->
//
// Alternating user / assistant blocks, sometimes separated by --- fences. We
// split the body on the callout markers and walk the blocks in order.

const NEXUS_BLOCK_RE = /^>\s*\[!nexus_(user|agent)\][^\n]*$/gim;

export function isNexusChatMarkdown(text: string): boolean {
  // Two signals: the plugin tag in frontmatter OR a nexus_user / nexus_agent
  // callout. Either alone is enough — sometimes frontmatter got stripped.
  return /nexus-ai-chat-importer/i.test(text) ||
         /^>\s*\[!nexus_(user|agent)\]/m.test(text);
}

export function parseNexusChatMarkdown(text: string, fallbackTitle?: string): ImportResult {
  const errors: string[] = [];
  const messages: ImportedThread['messages'] = [];

  // Title — prefer the "# Title:" line, then frontmatter aliases, then the
  // filename the caller passed in.
  let title = fallbackTitle || 'Imported conversation';
  const titleLine = text.match(/^#\s+Title:\s*(.+)$/m);
  if (titleLine) title = titleLine[1].trim();
  else {
    const alias = text.match(/^aliases:\s*"?([^"\n]+)"?$/m);
    if (alias) title = alias[1].trim();
  }

  // Walk each callout block. A block starts at the match index and ends at
  // the next match (or EOF). Content lines are the `> ` prefixed ones; we
  // stop at the UID marker, the --- fence, or the next callout.
  const markers: Array<{ index: number; role: 'user' | 'companion'; timestamp?: string }> = [];
  const timestampRe = /\*\*(?:User|Assistant)\*\*\s*-\s*([\d\/]+\s+at\s+[\d:]+\s*[AP]M)/;
  // Manual iteration because we need both the role capture AND the trailing
  // timestamp from the same line.
  let m: RegExpExecArray | null;
  NEXUS_BLOCK_RE.lastIndex = 0;
  while ((m = NEXUS_BLOCK_RE.exec(text)) !== null) {
    const line = m[0];
    const role: 'user' | 'companion' = m[1] === 'agent' ? 'companion' : 'user';
    const tsMatch = line.match(timestampRe);
    let iso: string | undefined;
    if (tsMatch) {
      // ChatGPT timestamp format: "04/27/2025 at 2:20 PM" — parse best-effort.
      const d = new Date(tsMatch[1].replace(' at ', ' '));
      if (!isNaN(d.getTime())) iso = d.toISOString();
    }
    markers.push({ index: m.index, role, timestamp: iso });
  }

  if (markers.length === 0) {
    errors.push('No nexus_user / nexus_agent blocks found in file.');
    return { source: 'nexus-md', threads: [], errors };
  }

  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].index;
    const end = i + 1 < markers.length ? markers[i + 1].index : text.length;
    const block = text.slice(start, end);

    // Body lines: every `> ` line AFTER the first (the callout header itself).
    // Stop at the UID marker or --- fence.
    const bodyLines: string[] = [];
    const lines = block.split('\n');
    let seenHeader = false;
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!seenHeader) {
        if (/^>\s*\[!nexus_(user|agent)\]/i.test(line)) {
          seenHeader = true;
          continue;
        }
      } else {
        if (/^<!--\s*UID:/i.test(line)) break;
        if (/^---\s*$/.test(line)) break;
        if (/^>\s*\[!nexus_(user|agent)\]/i.test(line)) break;
        // Strip the leading `> ` (or `>` alone for blank quote lines).
        if (line.startsWith('> ')) bodyLines.push(line.slice(2));
        else if (line === '>') bodyLines.push('');
        else if (line.length > 0) bodyLines.push(line);
      }
    }

    const content = bodyLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (content) {
      messages.push({
        role: markers[i].role,
        content,
        timestamp: markers[i].timestamp,
      });
    }
  }

  const threads = messages.length > 0 ? [{ title, messages }] : [];
  return { source: 'nexus-md', threads, errors };
}

// ============================================================
// Auto-detect format and parse
// ============================================================

export function autoDetectAndParse(data: any): ImportResult {
  // Haven export
  if (data.haven_version) {
    return parseHaven(data);
  }

  // ChatGPT — has mapping tree
  if (Array.isArray(data) && data[0]?.mapping) {
    return parseChatGPT(data);
  }
  if (data.mapping) {
    return parseChatGPT(data);
  }

  // Claude — has meta + chats
  if (data.meta && data.chats) {
    return parseClaude(data);
  }
  // Claude alternate format
  if (data.messages && data.title && !data.haven_version) {
    return parseClaude(data);
  }

  // SillyTavern — has character card fields
  if (data.spec === 'chara_card_v2' || data.spec === 'chara_card_v3' || data.data?.name) {
    return parseSillyTavern(data);
  }
  if (data.name && (data.personality || data.description || data.first_mes)) {
    return parseSillyTavern(data);
  }

  return {
    source: 'unknown',
    threads: [],
    errors: ['Could not detect the file format. Supported: ChatGPT, Claude, SillyTavern, Haven exports.'],
  };
}
