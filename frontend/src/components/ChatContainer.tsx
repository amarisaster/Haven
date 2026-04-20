import { useState, useEffect, useCallback } from 'react';
import type { Message, ToolCallRecord } from '../lib/types';
import { getMessages, sendChat, getCompanionStatus, getUserStatus, deleteMessage } from '../lib/api';
import { notifyCompanionMessage } from '../lib/notifications';
import { getWallpaper as loadWallpaper, setWallpaper as saveWallpaper } from '../lib/wallpaper-store';
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
  const [wallpaper, setWallpaper] = useState('');
  const fontFamily = localStorage.getItem('haven-font-family') || undefined;
  const textColor = localStorage.getItem('haven-text-color') || undefined;
  const [showMenu, setShowMenu] = useState(false);
  const [showWallpaper, setShowWallpaper] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [companionStatus, setCompanionStatus] = useState<{ custom_status: string | null; presence: string }>({ custom_status: null, presence: 'online' });
  const [userStatus, setUserStatus] = useState<{ custom_status: string | null; presence: string }>({ custom_status: null, presence: 'online' });

  // Poll companion + user status from D1 (both live server-side so they stay
  // consistent across devices / sessions).
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const [cs, us] = await Promise.all([getCompanionStatus(), getUserStatus()]);
        if (active) {
          setCompanionStatus(cs);
          setUserStatus(us);
        }
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
  // Load wallpaper from IndexedDB per thread
  const wpKey = threadId ? `wp-${threadId}` : 'wp-default';
  useEffect(() => { loadWallpaper(wpKey).then(setWallpaper); }, [wpKey]);
  useEffect(() => { localStorage.setItem(LS_MODEL, selectedModel); }, [selectedModel]);
  useEffect(() => { localStorage.setItem(LS_PROVIDER, selectedProvider); }, [selectedProvider]);

  const handleModelChange = (model: string, provider: string) => {
    setSelectedModel(model);
    setSelectedProvider(provider);
  };

  const handleSend = useCallback(async (content: string, image?: string, fileContext?: string) => {
    setError(null);
    setShowMenu(false);

    // Fold the <file>...</file> block into the persisted content so reloads
    // keep the file attached to the conversation and MessageBubble can
    // render it as a file card. The backend still sees the full block.
    const persistedContent = fileContext ? `${content}\n\n${fileContext}` : content;

    // Optimistic user message
    const userMsg: Message = {
      id: `temp-${Date.now()}`,
      thread_id: threadId || '',
      role: 'user',
      content: persistedContent,
      ...(image && { image }),
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setStreamingContent('');

    let currentThreadId = threadId;
    let fullContent = '';
    let responseModel = '';
    let toolCalls: ToolCallRecord[] = [];
    let notice: string | undefined;
    let realUserId: string | undefined;
    let realCompanionId: string | undefined;

    try {
      for await (const event of sendChat(persistedContent, threadId, selectedModel, selectedProvider, image)) {
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
          case 'tools': {
            // Worker emits one event with all tool results at the end of a
            // tool-calling inference round. We map each to a compact record
            // (name + ok) for rendering as chips under the assistant bubble.
            const results = (event.results as any[]) || [];
            toolCalls = results.map(r => ({
              name: r?.name || r?.tool_name || 'tool',
              server: r?.server_name || r?.server,
              ok: r?.ok !== false && !r?.error,
            }));
            break;
          }
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
          case 'notice':
            // Worker emits this when tool inference falls back to plain
            // streaming — e.g., model doesn't support function calling,
            // privacy filter blocks tool providers, provider timeout.
            if (typeof (event as any).message === 'string') {
              notice = (event as any).message;
            }
            break;
          case 'complete':
            responseModel = event.model || selectedModel;
            // Worker strips [react: emoji] / <think> blocks and sends the
            // CLEAN text here. Prefer it over the chunk-accumulated content
            // so the prefix doesn't stay visible in the bubble after
            // streaming ends.
            if (typeof event.content === 'string' && event.content.length > 0) {
              fullContent = event.content;
              setStreamingContent(fullContent);
            }
            // Capture real D1 UUIDs so delete/react/edit work in this
            // session without waiting for a thread reload. Optimistic IDs
            // (temp-*, comp-*) don't exist server-side.
            if ((event as any).user_message_id) realUserId = (event as any).user_message_id;
            if ((event as any).companion_message_id) realCompanionId = (event as any).companion_message_id;
            break;
          case 'error':
            setError(event.message || 'Stream error');
            break;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    }

    // Swap the optimistic user temp-id for the D1 UUID so delete/react/edit
    // hit the right row. Done in a single setMessages to avoid two renders.
    if (realUserId) {
      setMessages((prev) => prev.map((m) =>
        m.id === userMsg.id ? { ...m, id: realUserId! } : m
      ));
    }

    // Finalize: add companion message if ANY of — text content, tool calls,
    // or a notice — arrived. Previously we only added the bubble when
    // fullContent was truthy, which silently dropped tool-only responses
    // (model fires MCP tools without a follow-up text reply → empty
    // content → nothing renders).
    setStreamingContent(null);
    if (fullContent || toolCalls.length > 0 || notice) {
      const companionMsg: Message = {
        // Prefer the D1 UUID when the worker sent it (delete/react/edit
        // work immediately). Fall back to a local id for optimistic display
        // if the complete event arrived malformed.
        id: realCompanionId || `comp-${Date.now()}`,
        thread_id: currentThreadId || '',
        role: 'companion',
        content: fullContent,
        model: responseModel || selectedModel,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        notice,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, companionMsg]);
      if (fullContent) notifyCompanionMessage(companionName, fullContent);
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
    let toolCalls: ToolCallRecord[] = [];
    let notice: string | undefined;

    try {
      for await (const event of sendChat(newContent, threadId, selectedModel, selectedProvider)) {
        switch (event.type) {
          case 'chunk':
            if (event.content) {
              fullContent += event.content;
              setStreamingContent(fullContent);
            }
            break;
          case 'tools': {
            const results = (event.results as any[]) || [];
            toolCalls = results.map(r => ({
              name: r?.name || r?.tool_name || 'tool',
              server: r?.server_name || r?.server,
              ok: r?.ok !== false && !r?.error,
            }));
            break;
          }
          case 'notice':
            if (typeof (event as any).message === 'string') {
              notice = (event as any).message;
            }
            break;
          case 'complete':
            responseModel = event.model || selectedModel;
            if (typeof event.content === 'string' && event.content.length > 0) {
              fullContent = event.content;
              setStreamingContent(fullContent);
            }
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
    if (fullContent || toolCalls.length > 0 || notice) {
      const companionMsg: Message = {
        id: `comp-${Date.now()}`,
        thread_id: threadId || '',
        role: 'companion',
        content: fullContent,
        model: responseModel || selectedModel,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        notice,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, companionMsg]);
      if (fullContent) notifyCompanionMessage(companionName, fullContent);
    }
  }, [messages, threadId, selectedModel, selectedProvider]);

  const handleDeleteMessage = useCallback(async (messageId: string) => {
    // Optimistic: drop from the list immediately. If the server delete
    // fails (temp-id messages that never got persisted, network blip),
    // swallow silently — the next getMessages() reconciles either way.
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
    if (messageId.startsWith('temp-')) return;
    try { await deleteMessage(messageId); } catch { /* reconciles on reload */ }
  }, []);

  const handleRegenerateMessage = useCallback(async (messageId: string) => {
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;

    // Find last user message before this companion message
    let userIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { userIdx = i; break; }
    }
    if (userIdx === -1) return;

    const userMsgAtIdx = messages[userIdx];
    const companionMsgAtIdx = messages[idx];
    const userContent = userMsgAtIdx.content;

    // Delete the old user + companion rows from D1 so handleSend's re-insert
    // doesn't leave duplicates. Worker pulls ALL messages on each chat turn,
    // so stale rows would get replayed to the model. Skip IDs that are still
    // optimistic (temp-/comp-) — those never persisted.
    const toDelete: string[] = [];
    if (!userMsgAtIdx.id.startsWith('temp-') && !userMsgAtIdx.id.startsWith('comp-')) {
      toDelete.push(userMsgAtIdx.id);
    }
    if (!companionMsgAtIdx.id.startsWith('temp-') && !companionMsgAtIdx.id.startsWith('comp-')) {
      toDelete.push(companionMsgAtIdx.id);
    }
    for (const id of toDelete) {
      try { await deleteMessage(id); } catch { /* ignore, reconciles on reload */ }
    }

    // Truncate UI before the user message so handleSend's optimistic insert
    // doesn't double-up. handleSend re-adds the user turn + fires a fresh
    // reply.
    setMessages(messages.slice(0, userIdx));
    setTimeout(() => handleSend(userContent), 50);
  }, [messages, handleSend]);

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
        {/* Companion (left) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
          <div style={{ position: 'relative', flexShrink: 0 }}>
            {companionAvatar ? (
              <img src={companionAvatar} alt="" style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover' }} />
            ) : (
              <div style={{
                width: '32px', height: '32px', borderRadius: '50%',
                background: 'var(--haven-accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'white', fontSize: '14px', fontWeight: 600,
              }}>
                {companionName.charAt(0)}
              </div>
            )}
            <span style={{
              position: 'absolute', bottom: 0, right: 0, width: '8px', height: '8px', borderRadius: '50%',
              background: { online: '#4ade80', idle: '#facc15', dnd: '#f87171', offline: '#6b7280' }[companionStatus.presence || 'online'] || '#4ade80',
              border: '2px solid var(--haven-surface)',
            }} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--haven-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{companionName}</div>
            <div
              title={companionStatus.custom_status || companionStatus.presence || 'online'}
              style={{
                fontSize: '10px', color: 'var(--haven-text-secondary)', lineHeight: '1.3',
                display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
                overflow: 'hidden', maxWidth: '320px', wordBreak: 'break-word',
              }}
            >
              {companionStatus.custom_status || companionStatus.presence || 'online'}
            </div>
          </div>
        </div>

        {/* Spacer */}
        <div style={{ flex: 1 }} />

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

        {/* User (right) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
          <div style={{ minWidth: 0, textAlign: 'right' }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--haven-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {localStorage.getItem('haven-user-name') || 'You'}
            </div>
            <div style={{ fontSize: '9px', color: 'var(--haven-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100px' }}>
              {userStatus.custom_status || userStatus.presence || 'online'}
            </div>
          </div>
          <div style={{ position: 'relative', flexShrink: 0 }}>
            {localStorage.getItem('haven-user-avatar') ? (
              <img src={localStorage.getItem('haven-user-avatar')!} alt="" style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover' }} />
            ) : (
              <div style={{
                width: '32px', height: '32px', borderRadius: '50%',
                background: 'var(--haven-card)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--haven-text-secondary)', fontSize: '14px', fontWeight: 600,
              }}>
                {(localStorage.getItem('haven-user-name') || 'Y').charAt(0)}
              </div>
            )}
            <span style={{
              position: 'absolute', bottom: 0, right: 0, width: '8px', height: '8px', borderRadius: '50%',
              background: '#4ade80', border: '2px solid var(--haven-surface)',
            }} />
          </div>
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
        onDeleteMessage={handleDeleteMessage}
        onRegenerateMessage={handleRegenerateMessage}
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
          onSelect={(wp: string) => { setWallpaper(wp); saveWallpaper(wpKey, wp); }}
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
