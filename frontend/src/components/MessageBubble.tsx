import { useState } from 'react';
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

const REACTIONS = ['❤️', '😂', '😮', '🥺', '🔥', '👏'];

function isMediaUrl(text: string): boolean {
  const trimmed = text.trim();
  return /^https?:\/\/\S+\.(gif|png|jpg|jpeg|webp)(\?\S*)?$/i.test(trimmed) ||
    /^https?:\/\/media\d*\.giphy\.com\//i.test(trimmed) ||
    /^https?:\/\/i\.giphy\.com\//i.test(trimmed);
}

function isMediaLine(line: string): boolean {
  return isMediaUrl(line.trim());
}

function extractMedia(content: string): { text: string; mediaUrls: string[] } {
  const lines = content.split('\n');
  const textLines: string[] = [];
  const mediaUrls: string[] = [];
  for (const line of lines) {
    if (isMediaLine(line)) {
      mediaUrls.push(line.trim());
    } else {
      const urlMatch = line.match(/(https?:\/\/[^\s]+\.(gif|gifv|png|jpg|jpeg|webp)(\?[^\s]*)?)/i);
      if (urlMatch && isMediaLine(urlMatch[1])) {
        textLines.push(line.replace(urlMatch[0], '').trim());
        mediaUrls.push(urlMatch[1]);
      } else {
        textLines.push(line);
      }
    }
  }
  return { text: textLines.join('\n').trim(), mediaUrls };
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
          node: <em key={`i-${i}-${key++}`} style={{ color: 'var(--haven-accent-soft)', fontStyle: 'italic' }}>{italicMatch[1]}</em>,
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

  const handleReact = (emoji: string) => {
    onReact?.(message.id, emoji);
    setShowActions(false);
  };

  const media = isMediaUrl(message.content);

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
            padding: media ? '4px' : '10px 14px',
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
          ) : media ? (
            <img
              src={message.content.trim()}
              alt="media"
              style={{ maxWidth: '100%', maxHeight: '300px', borderRadius: '14px', display: 'block' }}
              loading="lazy"
            />
          ) : (
            <>
              {(() => {
                const { text, mediaUrls } = extractMedia(message.content);
                return (
                  <>
                    {renderFormatted(text)}
                    {mediaUrls.map((url, i) => (
                      <img key={i} src={url} alt="" style={{ maxWidth: '200px', borderRadius: '10px', marginTop: '8px', display: 'block' }} loading="lazy" />
                    ))}
                  </>
                );
              })()}
              {isStreaming && (
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

        {/* Action bar */}
        {showActions && !editing && (
          <div
            style={{
              display: 'flex', gap: '4px', marginTop: '4px', flexWrap: 'wrap',
              justifyContent: isUser ? 'flex-end' : 'flex-start',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {REACTIONS.map((emoji) => (
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
