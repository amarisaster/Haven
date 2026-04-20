import { useEffect, useRef, useState } from 'react';
import type { Message } from '../lib/types';
import MessageBubble from './MessageBubble';

interface ChatMessagesProps {
  messages: Message[];
  streamingContent: string | null;
  fontSize: number;
  fontFamily?: string;
  textColor?: string;
  wallpaper: string;
  companionAvatar?: string;
  onEditMessage: (messageId: string, newContent: string) => void;
  onReactMessage: (messageId: string, emoji: string) => void;
  onDeleteMessage?: (messageId: string) => void;
  onRegenerateMessage?: (messageId: string) => void;
}

function getWallpaperStyle(wallpaper: string): React.CSSProperties {
  if (!wallpaper) return {};

  // Starfield preset
  if (wallpaper === 'preset:starfield') {
    return {
      background: 'radial-gradient(ellipse at center, #0a0a1a 0%, #000 100%)',
      backgroundSize: 'cover',
    };
  }

  // Data URL or external URL
  if (wallpaper.startsWith('url(')) {
    return {
      backgroundImage: wallpaper,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
    };
  }

  // Gradient
  if (wallpaper.startsWith('linear-gradient') || wallpaper.startsWith('radial-gradient')) {
    return { background: wallpaper };
  }

  // Solid color (hex or named)
  if (wallpaper.startsWith('#') || wallpaper.startsWith('rgb')) {
    return { background: wallpaper };
  }

  return {};
}

export default function ChatMessages({
  messages,
  streamingContent,
  fontSize,
  fontFamily,
  textColor,
  wallpaper,
  companionAvatar,
  onEditMessage,
  onReactMessage,
  onDeleteMessage,
  onRegenerateMessage,
}: ChatMessagesProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [showJumpButton, setShowJumpButton] = useState(false);

  // Auto-scroll on new messages or streaming — BUT only if the user is
  // already near the bottom. If they've scrolled up to read older context,
  // respect that and show the jump-to-bottom button instead of yanking the
  // view away from them.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamingContent]);

  // Track scroll position so the jump button only appears when useful.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowJumpButton(distanceFromBottom > 300);
    };
    el.addEventListener('scroll', onScroll);
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const wallpaperStyles = getWallpaperStyle(wallpaper);

  return (
    <div
      ref={containerRef}
      className="hide-scrollbar"
      style={{
        flex: 1,
        overflowY: 'auto',
        paddingTop: '16px',
        paddingBottom: '8px',
        ...wallpaperStyles,
        position: 'relative',
      }}
    >
      {/* Starfield particles overlay */}
      {wallpaper === 'preset:starfield' && (
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden',
        }}>
          {Array.from({ length: 50 }).map((_, i) => (
            <div
              key={i}
              style={{
                position: 'absolute',
                width: `${Math.random() * 2 + 1}px`,
                height: `${Math.random() * 2 + 1}px`,
                background: 'white',
                borderRadius: '50%',
                top: `${Math.random() * 100}%`,
                left: `${Math.random() * 100}%`,
                opacity: Math.random() * 0.6 + 0.2,
                animation: `twinkle ${Math.random() * 3 + 2}s ease-in-out infinite`,
                animationDelay: `${Math.random() * 3}s`,
              }}
            />
          ))}
          <style>{`
            @keyframes twinkle {
              0%, 100% { opacity: 0.2; }
              50% { opacity: 0.8; }
            }
          `}</style>
        </div>
      )}

      {/* Empty state */}
      {messages.length === 0 && !streamingContent && (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100%', color: 'var(--haven-text-muted)', textAlign: 'center', padding: '40px',
        }}>
          <div style={{ fontSize: '40px', marginBottom: '12px' }}>💬</div>
          <p style={{ fontSize: '14px' }}>Start a conversation</p>
        </div>
      )}

      {/* Messages */}
      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          fontSize={fontSize}
          fontFamily={fontFamily}
          textColor={textColor}
          companionAvatar={companionAvatar}
          onEdit={onEditMessage}
          onReact={onReactMessage}
          onDelete={onDeleteMessage}
          onRegenerate={onRegenerateMessage}
        />
      ))}

      {/* Streaming message */}
      {streamingContent !== null && (
        <MessageBubble
          message={{
            id: '__streaming__',
            thread_id: '',
            role: 'companion',
            content: streamingContent,
            created_at: new Date().toISOString(),
          }}
          isStreaming
          fontSize={fontSize}
          fontFamily={fontFamily}
          textColor={textColor}
          companionAvatar={companionAvatar}
        />
      )}

      <div ref={bottomRef} />

      {/* Jump-to-bottom button — only appears when the user has scrolled up
          more than ~300px from the latest message. Stays out of the way
          when you're following the live conversation. */}
      {showJumpButton && (
        <button
          onClick={scrollToBottom}
          aria-label="Jump to latest"
          title="Jump to latest"
          style={{
            position: 'sticky', bottom: '16px', marginLeft: 'auto',
            right: '16px', float: 'right',
            width: '40px', height: '40px', borderRadius: '50%',
            background: 'var(--haven-accent)', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'white', boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            zIndex: 20, marginRight: '16px',
          }}
        >
          <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5L12 21m0 0l-7.5-7.5M12 21V3" />
          </svg>
        </button>
      )}
    </div>
  );
}
