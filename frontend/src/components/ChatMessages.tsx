import { useEffect, useRef } from 'react';
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
}: ChatMessagesProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages or streaming
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

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
    </div>
  );
}
