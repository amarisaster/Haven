import { useState, useRef } from 'react';
import type { Message } from '../lib/types';
import { speak, stop } from '../lib/tts';

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
  | { kind: 'file'; filename: string; pages?: string; body: string };

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
  const segments: Array<string | { filename: string; pages?: string; body: string }> = [];
  const fileBlockRegex = /<file\s+name="([^"]+)"(?:\s+pages="([^"]+)")?>([\s\S]*?)<\/file>/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = fileBlockRegex.exec(content)) !== null) {
    if (m.index > lastIdx) segments.push(content.slice(lastIdx, m.index));
    segments.push({ filename: m[1], pages: m[2], body: m[3] });
    lastIdx = fileBlockRegex.lastIndex;
  }
  if (lastIdx < content.length) segments.push(content.slice(lastIdx));

  for (const seg of segments) {
    if (typeof seg !== 'string') {
      parts.push({ kind: 'file', filename: seg.filename, pages: seg.pages, body: seg.body });
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
          node: <em key={`i-${i}-${key++}`} style={{ fontStyle: 'italic', opacity: 0.85 }}>{italicMatch[1]}</em>,
        };
        if (!firstMatch || candidate.index < firstMatch.index) firstMatch = candidate;
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

function formatTimestamp(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderContentParts(parts: ContentPart[], keyPrefix: string): React.ReactNode[] {
  return parts.map((part, i) => {
    const k = `${keyPrefix}-${i}`;
    switch (part.kind) {
      case 'text':
        return <div key={k}>{renderFormatted(part.text)}</div>;
      case 'image':
      case 'gif':
        return (
          <img
            key={k}
            src={part.url}
            alt=""
            style={{ maxWidth: '280px', borderRadius: '10px', marginTop: '8px', display: 'block' }}
            loading="lazy"
          />
        );
      case 'video':
        return (
          <video
            key={k}
            src={part.url}
            controls
            preload="metadata"
            style={{ maxWidth: '320px', borderRadius: '10px', marginTop: '8px', display: 'block' }}
          />
        );
      case 'audio':
        return (
          <audio
            key={k}
            src={part.url}
            controls
            preload="metadata"
            style={{ maxWidth: '100%', marginTop: '8px', display: 'block' }}
          />
        );
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
    }
  });
}

export default function MessageBubble({ message, isStreaming, fontSize = 15, fontFamily, textColor, companionAvatar, onEdit, onReact, onDelete, onRegenerate }: MessageBubbleProps) {
  const [showActions, setShowActions] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(message.content);
  const [speaking, setSpeaking] = useState(false);

  const isUser = message.role === 'user';
  const isCompanion = message.role === 'companion';

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

  const handleReact = (emoji: string) => {
    trackReaction(emoji);
    onReact?.(message.id, emoji);
    setShowActions(false);
    setShowEmojiInput(false);
  };

  const parsedParts = parseContent(message.content);
  // If the whole message is a single media URL, render the bubble in "media
  // mode" (tight padding, no bubble chrome) for the classic clean look.
  const mediaOnly = parsedParts.length === 1 && parsedParts[0].kind !== 'text' && parsedParts[0].kind !== 'file';

  return (
    <div
      style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', marginBottom: '8px', padding: '0 16px', gap: '8px' }}
      onClick={() => setShowActions(!showActions)}
    >
      {/* Companion avatar */}
      {isCompanion && companionAvatar && (
        <img src={companionAvatar} alt="" style={{ width: '28px', height: '28px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0, alignSelf: 'flex-end' }} />
      )}
      <div style={{ maxWidth: '80%', minWidth: '60px' }}>
        {/* Bubble */}
        <div
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
              {renderContentParts(parsedParts, `m-${message.id}`)}
              {message.image && (
                <img src={message.image} alt="Attached" style={{ maxWidth: '280px', borderRadius: '10px', marginTop: '8px', display: 'block' }} />
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
              >{r}</span>
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
              <span
                key={i}
                title={tc.server ? `${tc.server} · ${tc.name}` : tc.name}
                style={{
                  fontSize: '10px',
                  padding: '2px 8px',
                  borderRadius: '10px',
                  background: tc.ok === false ? 'transparent' : 'var(--haven-card)',
                  border: `1px solid ${tc.ok === false ? '#f8717155' : 'var(--haven-border)'}`,
                  color: tc.ok === false ? '#f87171' : 'var(--haven-accent)',
                  opacity: tc.ok === false ? 0.7 : 1,
                  textDecoration: tc.ok === false ? 'line-through' : 'none',
                }}
              >
                🔧 {tc.name}
              </span>
            ))}
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
              onClick={() => { setShowEmojiInput(true); setTimeout(() => emojiInputRef.current?.focus(), 50); }}
              style={{
                fontSize: '14px', background: 'var(--haven-surface)', border: '1px solid var(--haven-border)',
                borderRadius: '8px', padding: '2px 8px', cursor: 'pointer', color: 'var(--haven-text-muted)',
              }}
            >+</button>
            {showEmojiInput && (
              <input
                ref={emojiInputRef}
                type="text"
                placeholder="emoji"
                style={{
                  width: '50px', fontSize: '16px', background: 'var(--haven-surface)',
                  border: '1px solid var(--haven-border)', borderRadius: '8px',
                  padding: '2px 6px', color: 'var(--haven-text)', textAlign: 'center',
                  outline: 'none',
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
