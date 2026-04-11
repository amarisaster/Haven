import { useState, useEffect, useCallback } from 'react';
import type { Message } from '../lib/types';
import { getMessages, sendChat, getCompanionStatus } from '../lib/api';
import { notifyCompanionMessage } from '../lib/notifications';
import ChatMessages from './ChatMessages';
import ChatInput from './ChatInput';
import ModelSelector from './ModelSelector';
import WallpaperPicker from './WallpaperPicker';

interface ChatContainerProps {
  threadId: string | null;
  onThreadCreated: (id: string) => void;
  companionName: string;
  companionAvatar?: string;
  onBack?: () => void;
}

const LS_FONT = 'haven-font-size';
const LS_WALLPAPER = 'haven-wallpaper';
const LS_MODEL = 'haven-model';
const LS_PROVIDER = 'haven-provider';

export default function ChatContainer({ threadId, onThreadCreated, companionName, companionAvatar, onBack }: ChatContainerProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem(LS_MODEL) || 'openai/gpt-4o-mini');
  const [selectedProvider, setSelectedProvider] = useState(() => localStorage.getItem(LS_PROVIDER) || 'openrouter');
  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem(LS_FONT);
    return saved ? parseInt(saved, 10) : 15;
  });
  const [wallpaper, setWallpaper] = useState(() => localStorage.getItem(LS_WALLPAPER) || '');
  const fontFamily = localStorage.getItem('haven-font-family') || undefined;
  const textColor = localStorage.getItem('haven-text-color') || undefined;
  const [showMenu, setShowMenu] = useState(false);
  const [showWallpaper, setShowWallpaper] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [companionStatus, setCompanionStatus] = useState<{ custom_status: string | null; presence: string }>({ custom_status: null, presence: 'online' });

  // Poll companion status
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const s = await getCompanionStatus();
        if (active) setCompanionStatus(s);
      } catch { /* silent */ }
    };
    poll();
    const interval = setInterval(poll, 30000);
    return () => { active = false; clearInterval(interval); };
  }, []);

  // Load messages when thread changes
  useEffect(() => {
    if (!threadId) {
      setMessages([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    getMessages(threadId)
      .then(setMessages)
      .catch((err) => setError(err.message))
      .finally(() => setIsLoading(false));
  }, [threadId]);

  // Persist settings
  useEffect(() => { localStorage.setItem(LS_FONT, String(fontSize)); }, [fontSize]);
  useEffect(() => { localStorage.setItem(LS_WALLPAPER, wallpaper); }, [wallpaper]);
  useEffect(() => { localStorage.setItem(LS_MODEL, selectedModel); }, [selectedModel]);
  useEffect(() => { localStorage.setItem(LS_PROVIDER, selectedProvider); }, [selectedProvider]);

  const handleModelChange = (model: string, provider: string) => {
    setSelectedModel(model);
    setSelectedProvider(provider);
  };

  const handleSend = useCallback(async (content: string) => {
    setError(null);
    setShowMenu(false);

    // Optimistic user message
    const userMsg: Message = {
      id: `temp-${Date.now()}`,
      thread_id: threadId || '',
      role: 'user',
      content,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setStreamingContent('');

    let currentThreadId = threadId;
    let fullContent = '';
    let responseModel = '';

    try {
      for await (const event of sendChat(content, threadId, selectedModel, selectedProvider)) {
        switch (event.type) {
          case 'thread':
            if (event.threadId && !currentThreadId) {
              currentThreadId = event.threadId;
              onThreadCreated(event.threadId);
            }
            break;
          case 'chunk':
            if (event.content) {
              fullContent += event.content;
              setStreamingContent(fullContent);
            }
            break;
          case 'reaction': {
            const emoji = (event as any).emoji || '❤️';
            setMessages(prev => {
              for (let i = prev.length - 1; i >= 0; i--) {
                if (prev[i].role === 'user') {
                  const updated = [...prev];
                  updated[i] = { ...updated[i], reactions: [...(updated[i].reactions || []), emoji] };
                  return updated;
                }
              }
              return prev;
            });
            break;
          }
          case 'complete':
            responseModel = event.model || selectedModel;
            break;
          case 'error':
            setError(event.message || 'Stream error');
            break;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    }

    // Finalize: add companion message
    setStreamingContent(null);
    if (fullContent) {
      const companionMsg: Message = {
        id: `comp-${Date.now()}`,
        thread_id: currentThreadId || '',
        role: 'companion',
        content: fullContent,
        model: responseModel || selectedModel,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, companionMsg]);
      notifyCompanionMessage(companionName, fullContent);
    }
  }, [threadId, selectedModel, selectedProvider, onThreadCreated]);

  const handleEditMessage = useCallback(async (messageId: string, newContent: string) => {
    // Find the index of the edited message
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;

    // Truncate messages after the edited one
    const truncated = messages.slice(0, idx);

    // Update the edited message content
    const editedMsg: Message = { ...messages[idx], content: newContent };
    setMessages([...truncated, editedMsg]);

    // Resend from the edited message
    setError(null);
    setStreamingContent('');

    let fullContent = '';
    let responseModel = '';

    try {
      for await (const event of sendChat(newContent, threadId, selectedModel, selectedProvider)) {
        switch (event.type) {
          case 'chunk':
            if (event.content) {
              fullContent += event.content;
              setStreamingContent(fullContent);
            }
            break;
          case 'complete':
            responseModel = event.model || selectedModel;
            break;
          case 'error':
            setError(event.message || 'Stream error');
            break;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resend');
    }

    setStreamingContent(null);
    if (fullContent) {
      const companionMsg: Message = {
        id: `comp-${Date.now()}`,
        thread_id: threadId || '',
        role: 'companion',
        content: fullContent,
        model: responseModel || selectedModel,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, companionMsg]);
      notifyCompanionMessage(companionName, fullContent);
    }
  }, [messages, threadId, selectedModel, selectedProvider]);

  const handleReactMessage = useCallback((messageId: string, emoji: string) => {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== messageId) return m;
        const reactions = m.reactions ? [...m.reactions] : [];
        const idx = reactions.indexOf(emoji);
        if (idx >= 0) {
          reactions.splice(idx, 1);
        } else {
          reactions.push(emoji);
        }
        return { ...m, reactions };
      })
    );
  }, []);

  const adjustFont = (delta: number) => {
    setFontSize((prev) => Math.max(12, Math.min(24, prev + delta)));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', padding: '8px 12px',
        borderBottom: '1px solid var(--haven-border)', background: 'var(--haven-surface)',
        gap: '8px', flexShrink: 0,
      }}>
        {/* Back button */}
        {onBack && (
          <button
            onClick={onBack}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--haven-text-muted)', padding: '4px', display: 'flex',
              alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}
          >
            <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
          </button>
        )}
        {/* Avatar + name */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          {companionAvatar ? (
            <img src={companionAvatar} alt="" style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
          ) : (
            <div style={{
              width: '32px', height: '32px', borderRadius: '50%', flexShrink: 0,
              background: 'var(--haven-accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'white', fontSize: '14px', fontWeight: 600,
            }}>
              {companionName.charAt(0)}
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--haven-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{companionName}</div>
            {(() => {
              const p = companionStatus.presence || 'online';
              const colors: Record<string, string> = { online: '#4ade80', idle: '#facc15', dnd: '#f87171', offline: '#6b7280' };
              const color = colors[p] || colors.online;
              const text = companionStatus.custom_status || p;
              return (
                <div style={{ fontSize: '10px', color: 'var(--haven-text-secondary)', display: 'flex', alignItems: 'center', gap: '3px', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }} />
                  {text}
                </div>
              );
            })()}
          </div>
        </div>

        <ModelSelector
          selectedModel={selectedModel}
          selectedProvider={selectedProvider}
          onModelChange={handleModelChange}
        />

        {/* Menu button */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowMenu(!showMenu)}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--haven-text-secondary)', fontSize: '18px', padding: '4px 8px',
            }}
          >&#8942;</button>

          {showMenu && (
            <div style={{
              position: 'absolute', top: '100%', right: 0, marginTop: '4px',
              background: 'var(--haven-surface)', border: '1px solid var(--haven-border)',
              borderRadius: '10px', padding: '6px', minWidth: '160px', zIndex: 50,
              boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            }}>
              {/* Font size */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '6px 8px',
              }}>
                <span style={{ fontSize: '12px', color: 'var(--haven-text-secondary)' }}>Font Size</span>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    onClick={() => adjustFont(-1)}
                    style={{
                      width: '28px', height: '28px', borderRadius: '6px',
                      border: '1px solid var(--haven-border)', background: 'var(--haven-card)',
                      color: 'var(--haven-text)', cursor: 'pointer', fontSize: '12px', fontWeight: 600,
                    }}
                  >A-</button>
                  <button
                    onClick={() => adjustFont(1)}
                    style={{
                      width: '28px', height: '28px', borderRadius: '6px',
                      border: '1px solid var(--haven-border)', background: 'var(--haven-card)',
                      color: 'var(--haven-text)', cursor: 'pointer', fontSize: '14px', fontWeight: 600,
                    }}
                  >A+</button>
                </div>
              </div>

              {/* Wallpaper */}
              <button
                onClick={() => { setShowWallpaper(true); setShowMenu(false); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
                  padding: '6px 8px', background: 'transparent', border: 'none',
                  color: 'var(--haven-text-secondary)', fontSize: '12px', cursor: 'pointer',
                  borderRadius: '6px', textAlign: 'left',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--haven-card)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                🎨 Wallpaper
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{
          padding: '8px 16px', background: '#7f1d1d', color: '#fca5a5',
          fontSize: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            style={{ background: 'transparent', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: '14px' }}
          >x</button>
        </div>
      )}

      {/* Loading indicator */}
      {isLoading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '12px' }}>
          <div style={{
            width: '20px', height: '20px', border: '2px solid var(--haven-accent)',
            borderTopColor: 'transparent', borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* Messages */}
      <ChatMessages
        messages={messages}
        streamingContent={streamingContent}
        fontSize={fontSize}
        fontFamily={fontFamily}
        textColor={textColor}
        wallpaper={wallpaper}
        companionAvatar={companionAvatar}
        onEditMessage={handleEditMessage}
        onReactMessage={handleReactMessage}
      />

      {/* Input */}
      <ChatInput
        onSend={handleSend}
        disabled={streamingContent !== null}
        placeholder={threadId ? `Message ${companionName}...` : `Start a new conversation with ${companionName}...`}
      />

      {/* Wallpaper picker */}
      {showWallpaper && (
        <WallpaperPicker
          current={wallpaper}
          onSelect={setWallpaper}
          onClose={() => setShowWallpaper(false)}
        />
      )}

      {/* Click outside to close menu */}
      {showMenu && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 40 }}
          onClick={() => setShowMenu(false)}
        />
      )}
    </div>
  );
}
