import { useState, useRef, useEffect } from 'react';
import type { Message } from '../lib/types';
import { speak, stop } from '../lib/tts';
import { apiBase, authedFetch } from '../lib/api';
import AuthMedia from './AuthMedia';

let _emojiCache: Map<string, string> | null = null;
let _emojiFetching = false;
// Subscribers re-render once the cache arrives — without this, reactions that
// painted before the fetch finished stayed as raw :shortcode: text forever.
const _emojiListeners: Array<() => void> = [];
function loadCustomEmoji() {
  if (_emojiCache || _emojiFetching) return;
  _emojiFetching = true;
  const base = apiBase();
  if (!base) { _emojiFetching = false; return; }
  authedFetch(`${base}/api/custom-media?type=emoji`)
    .then(r => r.json())
    .then(d => {
      if (!Array.isArray(d)) return;
      _emojiCache = new Map();
      for (const e of d) _emojiCache.set(e.name, `${base}${e.url}`);
      _emojiListeners.forEach(fn => fn());
    })
    .catch(() => {})
    .finally(() => { _emojiFetching = false; });
}
export function refreshEmojiCache() { _emojiCache = null; loadCustomEmoji(); }

// Live view of the custom emoji set for pickers; updates when the cache loads.
function useCustomEmojiList(): Array<[string, string]> {
  const [list, setList] = useState<Array<[string, string]>>(() => _emojiCache ? [..._emojiCache.entries()] : []);
  useEffect(() => {
    const notify = () => setList(_emojiCache ? [..._emojiCache.entries()] : []);
    _emojiListeners.push(notify);
    if (_emojiCache) notify();
    return () => {
      const i = _emojiListeners.indexOf(notify);
      if (i >= 0) _emojiListeners.splice(i, 1);
    };
  }, []);
  return list;
}

// Render a reaction value that may be a custom-emoji shortcode (:name:). Mirrors
// the message-body emoji rendering (line ~174) so a companion reacting with a
// custom emoji shows the image, not the literal :name: text. Unicode reactions
// pass through unchanged.
function renderReaction(r: string): React.ReactNode {
  const m = /^:([a-zA-Z0-9_-]+):$/.exec(r);
  if (m && _emojiCache) {
    const url = _emojiCache.get(m[1]);
    if (url) return <AuthMedia url={url} type="img" alt={m[1]} style={{ display: 'inline-block', width: '18px', height: '18px', verticalAlign: 'middle', objectFit: 'contain' }} />;
  }
  return r;
}

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
  fontSize?: number;
  fontFamily?: string;
  textColor?: string;
  companionAvatar?: string;
  onEdit?: (messageId: string, newContent: string) => void;
  onReact?: (messageId: string, emoji: string) => void;
  onDelete?: (messageId: string) => void;
  onRegenerate?: (messageId: string) => void;
  onRevertFile?: (file: string) => void;
}

const DEFAULT_REACTIONS = ['❤️', '🖤', '😂', '😮', '🥺', '🔥'];
const LS_FREQ = 'haven-freq-reactions';
const MAX_QUICK = 8;

function getFrequentReactions(): string[] {
  try {
    const data: Record<string, number> = JSON.parse(localStorage.getItem(LS_FREQ) || '{}');
    const sorted = Object.entries(data).sort((a, b) => b[1] - a[1]).map(([e]) => e);
    if (sorted.length === 0) return DEFAULT_REACTIONS;
    const merged = [...sorted];
    for (const d of DEFAULT_REACTIONS) {
      if (!merged.includes(d)) merged.push(d);
    }
    return merged.slice(0, MAX_QUICK);
  } catch { return DEFAULT_REACTIONS; }
}

function trackReaction(emoji: string) {
  try {
    const data: Record<string, number> = JSON.parse(localStorage.getItem(LS_FREQ) || '{}');
    data[emoji] = (data[emoji] || 0) + 1;
    localStorage.setItem(LS_FREQ, JSON.stringify(data));
  } catch {}
}

type ContentPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; url: string }
  | { kind: 'gif'; url: string }
  | { kind: 'video'; url: string }
  | { kind: 'audio'; url: string }
  | { kind: 'file'; filename: string; pages?: string; body: string }
  | { kind: 'diff'; file: string; changeType: string; summary?: string }
  | { kind: 'command'; text: string };

function classifyUrl(raw: string): ContentPart['kind'] | null {
  const u = raw.trim();
  if (u.startsWith('data:')) {
    if (/^data:image\/gif/i.test(u)) return 'gif';
    if (/^data:image\//i.test(u)) return 'image';
    if (/^data:video\//i.test(u)) return 'video';
    if (/^data:audio\//i.test(u)) return 'audio';
    return null;
  }
  if (!/^https?:\/\//i.test(u)) return null;
  if (/\.(gif|gifv)(\?|$)/i.test(u)) return 'gif';
  if (/^https?:\/\/(media\d*|i)\.giphy\.com\//i.test(u)) return 'gif';
  if (/^https?:\/\/giphy\.com\/gifs\//i.test(u)) return 'gif';
  if (/tenor\.com\//i.test(u)) return 'gif';
  if (/\.(mp4|webm|mov)(\?|$)/i.test(u)) return 'video';
  if (/\.(mp3|wav|ogg|m4a|flac)(\?|$)/i.test(u)) return 'audio';
  if (/\.(png|jpg|jpeg|webp|svg)(\?|$)/i.test(u)) return 'image';
  return null;
}

function parseContent(content: string): ContentPart[] {
  const parts: ContentPart[] = [];
  type Block =
    | { kind: 'file'; filename: string; pages?: string; body: string }
    | { kind: 'diff'; file: string; changeType: string; summary?: string }
    | { kind: 'command'; text: string };
  const decode = (value: string) => value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  const segments: Array<string | Block> = [];
  const blockRegex = /<file\s+name="([^"]+)"(?:\s+pages="([^"]+)")?>([\s\S]*?)<\/file>|<codex-diff\s+file="([^"]+)"\s+change="([^"]+)">([\s\S]*?)<\/codex-diff>|<codex-cmd>([\s\S]*?)<\/codex-cmd>/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = blockRegex.exec(content)) !== null) {
    if (m.index > lastIdx) segments.push(content.slice(lastIdx, m.index));
    if (m[1] !== undefined) {
      segments.push({ kind: 'file', filename: decode(m[1]), pages: m[2], body: m[3] });
    } else if (m[4] !== undefined) {
      const summary = decode(m[6].trim());
      segments.push({ kind: 'diff', file: decode(m[4]), changeType: decode(m[5]), summary: summary || undefined });
    } else {
      segments.push({ kind: 'command', text: decode(m[7].trim()) });
    }
    lastIdx = blockRegex.lastIndex;
  }
  if (lastIdx < content.length) {
    let tail = content.slice(lastIdx);
    const incompleteCommand = tail.lastIndexOf('<codex-cmd>');
    if (incompleteCommand >= 0) tail = tail.slice(0, incompleteCommand);
    const lastTagStart = tail.lastIndexOf('<');
    if (lastTagStart >= 0) {
      const possibleTag = tail.slice(lastTagStart).toLowerCase();
      if ('<codex-cmd>'.startsWith(possibleTag) || possibleTag.startsWith('<codex-cmd')) {
        tail = tail.slice(0, lastTagStart);
      }
    }
    if (tail) segments.push(tail);
  }

  for (const seg of segments) {
    if (typeof seg !== 'string') {
      parts.push(seg);
      continue;
    }
    const buffered: string[] = [];
    const flush = () => {
      const t = buffered.join('\n').trim();
      if (t) parts.push({ kind: 'text', text: t });
      buffered.length = 0;
    };
    for (const line of seg.split('\n')) {
      const trimmed = line.trim();
      const wholeLineKind = trimmed ? classifyUrl(trimmed) : null;
      if (wholeLineKind) {
        flush();
        parts.push({ kind: wholeLineKind, url: trimmed } as ContentPart);
        continue;
      }
      const urlMatch = trimmed.match(/(https?:\/\/[^\s)]+)/);
      if (urlMatch) {
        const k = classifyUrl(urlMatch[1]);
        if (k) {
          const before = trimmed.replace(urlMatch[1], '').trim();
          if (before) buffered.push(before);
          flush();
          parts.push({ kind: k, url: urlMatch[1] } as ContentPart);
          continue;
        }
      }
      buffered.push(line);
    }
    flush();
  }
  return parts;
}

function renderFormatted(text: string): React.ReactNode[] {
  return text.split('\n').map((line, i) => {
    const parts: React.ReactNode[] = [];
    let remaining = line;
    let key = 0;

    while (remaining.length > 0) {
      // Bold: **text**
      const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
      // Italic action: *text*
      const italicMatch = remaining.match(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/);

      let firstMatch: { index: number; length: number; node: React.ReactNode } | null = null as { index: number; length: number; node: React.ReactNode } | null;

      if (boldMatch && boldMatch.index !== undefined) {
        const candidate = {
          index: boldMatch.index,
          length: boldMatch[0].length,
          node: <strong key={`b-${i}-${key++}`}>{boldMatch[1]}</strong>,
        };
        if (!firstMatch || candidate.index < firstMatch.index) firstMatch = candidate;
      }

      if (italicMatch && italicMatch.index !== undefined) {
        const candidate = {
          index: italicMatch.index,
          length: italicMatch[0].length,
          node: <em key={`i-${i}-${key++}`} className="haven-italic-action" style={{ fontStyle: 'italic' }}>{italicMatch[1]}</em>,
        };
        if (!firstMatch || candidate.index < firstMatch.index) firstMatch = candidate;
      }

      // Custom emoji: :name:
      if (_emojiCache) {
        const emojiMatch = remaining.match(/:([a-zA-Z0-9_-]+):/);
        if (emojiMatch && emojiMatch.index !== undefined) {
          const url = _emojiCache.get(emojiMatch[1]);
          if (url) {
            const candidate = {
              index: emojiMatch.index,
              length: emojiMatch[0].length,
              node: <AuthMedia key={`ce-${i}-${key++}`} url={url} type="img" alt={emojiMatch[1]} style={{ display: 'inline-block', width: '24px', height: '24px', verticalAlign: 'middle', objectFit: 'contain' }} />,
            };
            if (!firstMatch || candidate.index < firstMatch.index) firstMatch = candidate;
          }
        }
      }

      if (firstMatch) {
        if (firstMatch.index > 0) {
          parts.push(<span key={`t-${i}-${key++}`}>{remaining.slice(0, firstMatch.index)}</span>);
        }
        parts.push(firstMatch.node);
        remaining = remaining.slice(firstMatch.index + firstMatch.length);
      } else {
        parts.push(<span key={`t-${i}-${key++}`}>{remaining}</span>);
        remaining = '';
      }
    }

    return (
      <span key={`line-${i}`}>
        {parts}
        {i < text.split('\n').length - 1 && <br />}
      </span>
    );
  });
}

function parseThinking(content: string): { thinking: string | null; isThinking: boolean; response: string } {
  const openMatch = content.match(/<think(?:ing)?>/i);
  if (!openMatch || openMatch.index === undefined) return { thinking: null, isThinking: false, response: content };

  const before = content.slice(0, openMatch.index).trim();
  const afterOpen = content.slice(openMatch.index + openMatch[0].length);

  const closeMatch = afterOpen.match(/<\/think(?:ing)?>/i);
  if (!closeMatch || closeMatch.index === undefined) {
    return { thinking: afterOpen, isThinking: true, response: before };
  }

  const thinking = afterOpen.slice(0, closeMatch.index).trim();
  const after = afterOpen.slice(closeMatch.index + closeMatch[0].length).trim();
  const response = [before, after].filter(Boolean).join('\n');

  return { thinking: thinking || null, isThinking: false, response };
}

function formatTimestamp(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function CommandGroup({ commands }: { commands: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const label = `${commands.length} ${commands.length === 1 ? 'command' : 'commands'}`;

  return (
    <div style={{ marginTop: '6px' }}>
      <button
        onClick={(event) => { event.stopPropagation(); setExpanded((current) => !current); }}
        title={label}
        style={{
          fontSize: '10px', padding: '2px 8px', borderRadius: '10px', cursor: 'pointer',
          background: 'var(--haven-card)',
          border: `1px solid ${expanded ? 'var(--haven-accent)' : 'var(--haven-border)'}`,
          color: 'var(--haven-accent)',
        }}
      >
        ⚙ {label}
      </button>
      {expanded && (
        <div style={{
          marginTop: '6px', padding: '10px', borderRadius: '8px',
          background: 'var(--haven-card)', border: '1px solid var(--haven-border)',
          fontSize: '11px', fontFamily: 'monospace', whiteSpace: 'pre-wrap',
          wordBreak: 'break-word', maxHeight: '256px', overflowY: 'auto', textAlign: 'left',
        }}>
          {commands.map((command, index) => <div key={index}>{command}</div>)}
        </div>
      )}
    </div>
  );
}

function renderContentParts(parts: ContentPart[], keyPrefix: string, onRevertFile?: (file: string) => void): React.ReactNode[] {
  return parts.map((part, i) => {
    const k = `${keyPrefix}-${i}`;
    switch (part.kind) {
      case 'text':
        return <div key={k}>{renderFormatted(part.text)}</div>;
      case 'image':
      case 'gif': {
        const isEmoji = part.url.includes('/api/files/emoji/');
        return <AuthMedia key={k} url={part.url} type="img" style={{
          maxWidth: isEmoji ? '48px' : '280px', maxHeight: isEmoji ? '48px' : undefined,
          borderRadius: isEmoji ? '4px' : '10px', marginTop: '8px',
          display: isEmoji ? 'inline-block' : 'block', verticalAlign: isEmoji ? 'middle' : undefined,
        }} />;
      }
      case 'video':
        return <AuthMedia key={k} url={part.url} type="video" style={{ maxWidth: '320px', borderRadius: '10px', marginTop: '8px', display: 'block' }} />;
      case 'audio':
        return <AuthMedia key={k} url={part.url} type="audio" style={{ maxWidth: '100%', marginTop: '8px', display: 'block' }} />;
      case 'command': {
        if (parts[i - 1]?.kind === 'command') return null;
        const commands: string[] = [];
        for (let commandIndex = i; parts[commandIndex]?.kind === 'command'; commandIndex += 1) {
          commands.push((parts[commandIndex] as Extract<ContentPart, { kind: 'command' }>).text);
        }
        return <CommandGroup key={k} commands={commands} />;
      }
      case 'file': {
        const sizeHint = part.pages
          ? `${part.pages} pages · ${Math.round(part.body.length / 1000)}k chars`
          : `${Math.round(part.body.length / 1000)}k chars`;
        return (
          <div
            key={k}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              background: 'var(--haven-surface)',
              border: '1px solid var(--haven-border)',
              borderRadius: '10px',
              padding: '8px 12px',
              marginTop: '8px',
            }}
          >
            <span style={{ fontSize: '16px' }}>📄</span>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: '12px',
                  fontWeight: 500,
                  color: 'var(--haven-text)',
                  maxWidth: '220px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {part.filename}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--haven-text-muted)' }}>{sizeHint}</div>
            </div>
          </div>
        );
      }
      case 'diff':
        return (
          <div key={k} style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            background: 'var(--haven-surface)', border: '1px solid var(--haven-border)',
            borderRadius: '10px', padding: '8px 10px', marginTop: '8px',
          }}>
            <span style={{ fontSize: '14px' }}>🛠️</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{
                fontSize: '11px', fontFamily: 'monospace', color: 'var(--haven-text)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{part.file}</div>
              <div style={{ fontSize: '10px', color: 'var(--haven-text-muted)' }}>
                {part.changeType}{part.summary ? ` · ${part.summary}` : ''}
              </div>
            </div>
            {part.changeType !== 'reverted' && onRevertFile && (
              <button
                onClick={(event) => { event.stopPropagation(); onRevertFile(part.file); }}
                style={{
                  fontSize: '10px', padding: '3px 8px', borderRadius: '8px', cursor: 'pointer',
                  background: 'transparent', border: '1px solid var(--haven-accent)', color: 'var(--haven-accent)',
                }}
              >Revert</button>
            )}
          </div>
        );
    }
  });
}

export default function MessageBubble({ message, isStreaming, fontSize = 15, fontFamily, textColor, companionAvatar, onEdit, onReact, onDelete, onRegenerate, onRevertFile }: MessageBubbleProps) {
  const [showActions, setShowActions] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(message.content);
  const [speaking, setSpeaking] = useState(false);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [expandedToolCall, setExpandedToolCall] = useState<number | null>(null);

  useEffect(() => { loadCustomEmoji(); }, []);

  const isUser = message.role === 'user';
  const isCompanion = message.role === 'companion';
  const { thinking, isThinking, response } = isCompanion ? parseThinking(message.content) : { thinking: null, isThinking: false, response: message.content };

  const handleTTS = () => {
    if (speaking) {
      stop();
      setSpeaking(false);
      return;
    }
    setSpeaking(true);
    speak(message.content, () => setSpeaking(false));
  };

  const handleSaveEdit = () => {
    if (editText.trim() && editText !== message.content) {
      onEdit?.(message.id, editText.trim());
    }
    setEditing(false);
  };

  const [showEmojiInput, setShowEmojiInput] = useState(false);
  const emojiInputRef = useRef<HTMLInputElement>(null);
  const customEmojiList = useCustomEmojiList();

  const handleReact = (emoji: string) => {
    trackReaction(emoji);
    onReact?.(message.id, emoji);
    setShowActions(false);
    setShowEmojiInput(false);
  };

  const parsedParts = parseContent(response);
  // If the whole message is a single media URL, render the bubble in "media
  // mode" (tight padding, no bubble chrome) for the classic clean look.
  const mediaOnly = parsedParts.length === 1 && parsedParts[0].kind !== 'text' && parsedParts[0].kind !== 'file' && parsedParts[0].kind !== 'diff' && parsedParts[0].kind !== 'command';

  return (
    <div
      style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', marginBottom: '8px', padding: '0 16px', gap: '8px' }}
      onClick={() => setShowActions(!showActions)}
    >
      {/* Companion avatar */}
      {isCompanion && companionAvatar && (
        <AuthMedia url={companionAvatar} type="img" alt="" style={{ width: '28px', height: '28px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0, alignSelf: 'flex-end' }} />
      )}
      <div style={{ maxWidth: '85%', minWidth: '60px' }}>
        {/* Bubble */}
        <div
          className={isUser ? 'haven-user-bubble' : 'haven-companion-bubble'}
          style={{
            background: isUser ? 'var(--haven-accent-soft)' : 'var(--haven-card)',
            color: textColor && !isUser ? textColor : isUser ? '#1c1917' : 'var(--haven-text)',
            borderRadius: isUser ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
            borderLeft: isCompanion ? '3px solid var(--haven-accent)' : undefined,
            padding: mediaOnly ? '4px' : '10px 14px',
            fontSize: `${fontSize}px`,
            fontFamily: fontFamily && fontFamily !== 'System' ? fontFamily : undefined,
            lineHeight: '1.5',
            wordBreak: 'break-word',
            position: 'relative',
          }}
        >
          {editing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                style={{
                  background: 'var(--haven-surface)',
                  color: 'var(--haven-text)',
                  border: '1px solid var(--haven-border)',
                  borderRadius: '8px',
                  padding: '8px',
                  fontSize: `${fontSize}px`,
                  width: '100%',
                  minHeight: '60px',
                  outline: 'none',
                  fontFamily: 'inherit',
                }}
                autoFocus
              />
              <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                <button
                  onClick={(e) => { e.stopPropagation(); setEditing(false); setEditText(message.content); }}
                  style={{
                    padding: '4px 12px', borderRadius: '6px', border: '1px solid var(--haven-border)',
                    background: 'transparent', color: 'var(--haven-text-secondary)', fontSize: '12px', cursor: 'pointer',
                  }}
                >Cancel</button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleSaveEdit(); }}
                  style={{
                    padding: '4px 12px', borderRadius: '6px', border: 'none',
                    background: 'var(--haven-accent)', color: 'white', fontSize: '12px', cursor: 'pointer',
                  }}
                >Save</button>
              </div>
            </div>
          ) : (
            <>
              {/* Thinking block — collapsible, Claude.ai style */}
              {isThinking && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  padding: '6px 0', color: 'var(--haven-text-muted)', fontSize: `${Math.max(fontSize - 3, 11)}px`,
                  cursor: 'pointer',
                }} onClick={(e) => { e.stopPropagation(); setThinkingExpanded(!thinkingExpanded); }}>
                  <span style={{
                    display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%',
                    background: 'var(--haven-accent)', animation: 'haven-thinking-pulse 1.5s ease-in-out infinite',
                  }} />
                  <span>Thinking...</span>
                  <style>{`@keyframes haven-thinking-pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }`}</style>
                </div>
              )}
              {thinking && !isThinking && (
                <div
                  style={{ padding: '4px 0', marginBottom: '6px', borderBottom: '1px solid var(--haven-border)' }}
                  onClick={(e) => { e.stopPropagation(); setThinkingExpanded(!thinkingExpanded); }}
                >
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: '6px',
                    color: 'var(--haven-text-muted)', fontSize: `${Math.max(fontSize - 3, 11)}px`, cursor: 'pointer',
                    userSelect: 'none',
                  }}>
                    <span style={{ fontSize: '8px', transition: 'transform 0.15s', transform: thinkingExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
                    <span>Thought process</span>
                  </div>
                  {thinkingExpanded && (
                    <div style={{
                      marginTop: '6px', padding: '8px', borderRadius: '6px',
                      background: 'var(--haven-surface)', fontSize: `${Math.max(fontSize - 2, 11)}px`,
                      color: 'var(--haven-text-muted)', lineHeight: '1.5',
                      maxHeight: '300px', overflowY: 'auto',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    }}>{thinking}</div>
                  )}
                </div>
              )}
              {(isThinking && thinkingExpanded && thinking) && (
                <div style={{
                  marginBottom: '6px', padding: '8px', borderRadius: '6px',
                  background: 'var(--haven-surface)', fontSize: `${Math.max(fontSize - 2, 11)}px`,
                  color: 'var(--haven-text-muted)', lineHeight: '1.5',
                  maxHeight: '300px', overflowY: 'auto',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>{thinking}</div>
              )}
              {renderContentParts(parsedParts, `m-${message.id}`, onRevertFile)}
              {message.image && (
                <AuthMedia url={message.image} type="img" alt="Attached" style={{ maxWidth: '280px', borderRadius: '10px', marginTop: '8px', display: 'block' }} />
              )}
              {isStreaming && !message.content && (
                // Typing indicator — shown while waiting for the first token
                // to arrive. Three dots pulsing in sequence.
                <span style={{ display: 'inline-flex', gap: '4px', alignItems: 'center', padding: '4px 0' }}>
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--haven-text-muted)', animation: 'haven-typing 1.2s infinite ease-in-out both' }} />
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--haven-text-muted)', animation: 'haven-typing 1.2s infinite ease-in-out both', animationDelay: '0.15s' }} />
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--haven-text-muted)', animation: 'haven-typing 1.2s infinite ease-in-out both', animationDelay: '0.3s' }} />
                  <style>{`@keyframes haven-typing { 0%, 60%, 100% { opacity: 0.3; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }`}</style>
                </span>
              )}
              {isStreaming && message.content && (
                <span
                  style={{
                    display: 'inline-block', width: '2px', height: '1em',
                    background: 'var(--haven-accent)', marginLeft: '2px',
                    animation: 'blink 1s step-end infinite', verticalAlign: 'text-bottom',
                  }}
                />
              )}
            </>
          )}
        </div>

        {/* Reactions display */}
        {message.reactions && message.reactions.length > 0 && (
          <div style={{ display: 'flex', gap: '4px', marginTop: '4px', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
            {message.reactions.map((r, i) => (
              <span
                key={i}
                style={{
                  fontSize: '14px', background: 'var(--haven-surface)', borderRadius: '10px',
                  padding: '1px 6px', border: '1px solid var(--haven-border)',
                }}
              >{renderReaction(r)}</span>
            ))}
          </div>
        )}

        {/* Timestamp + model */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px', marginTop: '3px',
          justifyContent: isUser ? 'flex-end' : 'flex-start',
        }}>
          <span style={{ fontSize: '10px', color: 'var(--haven-text-muted)' }}>
            {formatTimestamp(message.created_at)}
          </span>
          {isCompanion && message.model && (
            <span style={{ fontSize: '10px', color: 'var(--haven-text-muted)', opacity: 0.7 }}>
              {message.model}
            </span>
          )}
        </div>

        {/* Fallback notice — worker emits this when the tool-call path
            failed (unsupported model, privacy filter, timeout) and we
            degraded to plain streaming. Small amber banner so the user
            knows why tool chips are missing on this reply. */}
        {isCompanion && message.notice && (
          <div
            style={{
              marginTop: '4px',
              padding: '6px 10px',
              borderRadius: '8px',
              background: '#7c521020',
              border: '1px solid #d97706',
              color: '#fbbf24',
              fontSize: '11px',
              lineHeight: '1.4',
            }}
          >
            ⚠ {message.notice}
          </div>
        )}

        {/* Tool call chips — small pills showing which MCP tools fired during
            this response. Failed calls get a muted / strikethrough look so
            "tried and errored" is visible without the whole row feeling busy. */}
        {isCompanion && message.tool_calls && message.tool_calls.length > 0 && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: '4px',
            marginTop: '4px',
            justifyContent: isUser ? 'flex-end' : 'flex-start',
          }}>
            {message.tool_calls.map((tc, i) => (
              <button
                key={i}
                onClick={(e) => {
                  e.stopPropagation();
                  setExpandedToolCall(expandedToolCall === i ? null : i);
                }}
                title={tc.server ? `${tc.server} · ${tc.name}` : tc.name}
                style={{
                  fontSize: '10px',
                  padding: '2px 8px',
                  borderRadius: '10px',
                  cursor: 'pointer',
                  background: tc.ok === false ? 'transparent' : 'var(--haven-card)',
                  border: `1px solid ${tc.ok === false ? '#f8717155' : expandedToolCall === i ? 'var(--haven-accent)' : 'var(--haven-border)'}`,
                  color: tc.ok === false ? '#f87171' : 'var(--haven-accent)',
                  opacity: tc.ok === false ? 0.7 : 1,
                  textDecoration: tc.ok === false ? 'line-through' : 'none',
                }}
              >
                🔧 {tc.name} {expandedToolCall === i ? '▾' : '▸'}
              </button>
            ))}
            {expandedToolCall !== null && message.tool_calls[expandedToolCall] && (
              <div style={{
                width: '100%',
                marginTop: '6px',
                padding: '10px',
                borderRadius: '8px',
                background: 'var(--haven-card)',
                border: '1px solid var(--haven-border)',
                fontSize: '11px',
                fontFamily: 'monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: '256px',
                overflowY: 'auto',
                textAlign: 'left',
              }}>
                {message.tool_calls[expandedToolCall].arguments !== undefined && (
                  <>
                    <div style={{ color: 'var(--haven-muted)', marginBottom: '4px' }}>args:</div>
                    <div style={{ marginBottom: '8px' }}>{JSON.stringify(message.tool_calls[expandedToolCall].arguments, null, 2)}</div>
                  </>
                )}
                {message.tool_calls[expandedToolCall].result !== undefined && (
                  <>
                    <div style={{ color: 'var(--haven-muted)', marginBottom: '4px' }}>result:</div>
                    <div>{typeof message.tool_calls[expandedToolCall].result === 'string' ? message.tool_calls[expandedToolCall].result : JSON.stringify(message.tool_calls[expandedToolCall].result, null, 2)}</div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Action bar */}
        {showActions && !editing && (
          <div
            style={{
              display: 'flex', gap: '4px', marginTop: '4px', flexWrap: 'wrap',
              justifyContent: isUser ? 'flex-end' : 'flex-start',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {getFrequentReactions().map((emoji) => (
              <button
                key={emoji}
                onClick={() => handleReact(emoji)}
                style={{
                  fontSize: '16px', background: 'var(--haven-surface)', border: '1px solid var(--haven-border)',
                  borderRadius: '8px', padding: '2px 6px', cursor: 'pointer',
                  transition: 'transform 0.1s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.2)')}
                onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
              >{emoji}</button>
            ))}
            <button
              onClick={() => setShowEmojiInput(v => !v)}
              style={{
                fontSize: '14px', background: 'var(--haven-surface)', border: '1px solid var(--haven-border)',
                borderRadius: '8px', padding: '2px 8px', cursor: 'pointer', color: 'var(--haven-text-muted)',
              }}
            >{showEmojiInput ? '−' : '+'}</button>
            {showEmojiInput && (
              <div style={{
                width: '100%', marginTop: '4px', padding: '6px', borderRadius: '10px',
                background: 'var(--haven-surface)', border: '1px solid var(--haven-border)',
              }}>
                {/* Standard set */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {['💕', '💖', '💜', '🖤', '🤍', '😍', '🤭', '😏', '😳', '😤', '😢', '😴', '🤔', '😇', '🤗', '🫶', '💋', '👀', '🙈', '💅', '🫡', '🌸', '🌙', '⭐', '🎵', '🦋', '🌈', '🍓'].map((emoji) => (
                    <button
                      key={emoji}
                      onClick={() => handleReact(emoji)}
                      style={{ fontSize: '16px', background: 'none', border: 'none', cursor: 'pointer', padding: '2px', transition: 'transform 0.1s' }}
                      onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.25)')}
                      onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                    >{emoji}</button>
                  ))}
                </div>
                {/* Custom emojis — picked visually, no shortcode memorizing */}
                {customEmojiList.length > 0 && (
                  <div style={{
                    display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px',
                    paddingTop: '6px', borderTop: '1px solid var(--haven-border)',
                  }}>
                    {customEmojiList.map(([name, url]) => (
                      <button
                        key={name}
                        onClick={() => handleReact(`:${name}:`)}
                        title={`:${name}:`}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', transition: 'transform 0.1s' }}
                        onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.25)')}
                        onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                      >
                        <AuthMedia url={url} type="img" alt={name} style={{ width: '20px', height: '20px', objectFit: 'contain', display: 'block' }} />
                      </button>
                    ))}
                  </div>
                )}
                {/* Free-type fallback for any unicode emoji */}
                <input
                  ref={emojiInputRef}
                  type="text"
                  placeholder="type any emoji…"
                  style={{
                    width: '110px', fontSize: '14px', background: 'var(--haven-bg, transparent)',
                    border: '1px solid var(--haven-border)', borderRadius: '8px', marginTop: '6px',
                    padding: '2px 6px', color: 'var(--haven-text)', outline: 'none',
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const val = (e.target as HTMLInputElement).value.trim();
                      if (val) handleReact(val);
                    }
                  }}
                  onInput={(e) => {
                    const val = (e.target as HTMLInputElement).value.trim();
                    if (val && /\p{Emoji}/u.test(val)) handleReact(val);
                  }}
                />
              </div>
            )}
            {isUser && onEdit && (
              <button
                onClick={() => setEditing(true)}
                style={{
                  fontSize: '12px', background: 'var(--haven-surface)', border: '1px solid var(--haven-border)',
                  borderRadius: '8px', padding: '2px 8px', cursor: 'pointer', color: 'var(--haven-text-secondary)',
                }}
              >Edit</button>
            )}
            {isCompanion && (
              <button
                onClick={handleTTS}
                style={{
                  fontSize: '14px', background: speaking ? 'var(--haven-accent)' : 'var(--haven-surface)',
                  border: '1px solid var(--haven-border)', borderRadius: '8px', padding: '2px 8px', cursor: 'pointer',
                  color: speaking ? 'white' : 'var(--haven-text-secondary)',
                }}
              >{speaking ? '🔊' : '🔈'}</button>
            )}
            {isCompanion && onRegenerate && (
              <button
                onClick={() => onRegenerate(message.id)}
                style={{ fontSize: '12px', background: 'var(--haven-surface)', border: '1px solid var(--haven-border)', borderRadius: '8px', padding: '2px 8px', cursor: 'pointer', color: 'var(--haven-text-secondary)' }}
              >🔄</button>
            )}
            {isCompanion && (
              <button
                onClick={() => navigator.clipboard.writeText(message.content)}
                style={{ fontSize: '12px', background: 'var(--haven-surface)', border: '1px solid var(--haven-border)', borderRadius: '8px', padding: '2px 8px', cursor: 'pointer', color: 'var(--haven-text-secondary)' }}
              >📋</button>
            )}
            {onDelete && (
              <button
                onClick={() => onDelete(message.id)}
                style={{ fontSize: '12px', background: 'var(--haven-surface)', border: '1px solid var(--haven-border)', borderRadius: '8px', padding: '2px 8px', cursor: 'pointer', color: '#f87171' }}
              >🗑</button>
            )}
          </div>
        )}
      </div>

      {/* Blink animation */}
      {isStreaming && (
        <style>{`
          @keyframes blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0; }
          }
        `}</style>
      )}
    </div>
  );
}
