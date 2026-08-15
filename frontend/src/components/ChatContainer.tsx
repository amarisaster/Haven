import { useState, useEffect, useCallback, useRef } from 'react';
import type { Message, ToolCallRecord, StreamEvent } from '../lib/types';
import type { ModelInfo } from '../lib/types';
import { getMessages, sendChat, getCompanionStatus, getUserStatus, deleteMessage, reactMessage, pushPreference, getModels, activeCompanionId, getCodexRunContext, persistCodexMessage, uploadFile, setThreadEphemeral, getThreadContext, compactThread, type ThreadContext } from '../lib/api';
import { sendChatCodex, setCodexProviderActive, subscribeCodexPresence } from '../lib/codex-ws';
import { notifyCompanionMessage } from '../lib/notifications';
import { getWallpaper as loadWallpaper, setWallpaper as saveWallpaper } from '../lib/wallpaper-store';
import ChatMessages from './ChatMessages';
import ChatInput from './ChatInput';
import ModelSelector from './ModelSelector';
import ModelSettingsPanel from './ModelSettingsPanel';
import WallpaperPicker from './WallpaperPicker';
import AuthMedia from './AuthMedia';
import { loadCustomEmoji, useCustomEmojiList, renderEmojiText } from './MessageBubble';

interface ChatContainerProps {
  threadId: string | null;
  onThreadCreated: (id: string) => void;
  companionName: string;
  companionAvatar?: string;
  onBack?: () => void;
  // Persisted "private" flag of the open thread (1 = private). Optional so
  // older callers keep compiling.
  threadEphemeral?: number;
}

const LS_FONT = 'haven-font-size';
const LS_MODEL = 'haven-model';
const LS_PROVIDER = 'haven-provider';

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function codexDiffTag(file: string, changeType = 'update', summary?: string): string {
  return `<codex-diff file="${xmlEscape(file)}" change="${xmlEscape(changeType)}">${summary ? xmlEscape(summary) : ''}</codex-diff>`;
}

export default function ChatContainer({ threadId, onThreadCreated, companionName, companionAvatar, onBack, threadEphemeral }: ChatContainerProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem(LS_MODEL) || 'openai/gpt-4o-mini');
  const [selectedProvider, setSelectedProvider] = useState(() => localStorage.getItem(LS_PROVIDER) || 'openrouter');
  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem(LS_FONT);
    return saved ? parseInt(saved, 10) : 15;
  });
  const [wallpaper, setWallpaper] = useState('');
  // "Private" thread — excluded from proactive memory extraction. Held locally
  // before the first message, because the thread row doesn't exist until then;
  // it's passed into the first sendChat so the row is born flagged.
  const [isPrivate, setIsPrivate] = useState(false);

  // Reset on a brand-new chat; adopt the persisted flag when opening a thread.
  useEffect(() => {
    setIsPrivate(threadId ? !!threadEphemeral : false);
  }, [threadId, threadEphemeral]);

  const togglePrivate = async () => {
    const next = !isPrivate;
    setIsPrivate(next);
    if (!threadId) return; // no row yet — carried into the first sendChat
    try {
      await setThreadEphemeral(threadId, next);
    } catch {
      setIsPrivate(!next); // revert if the write failed
    }
  };
  const fontFamily = localStorage.getItem('haven-font-family') || undefined;
  const textColor = localStorage.getItem('haven-text-color') || undefined;
  const [showMenu, setShowMenu] = useState(false);
  const [showWallpaper, setShowWallpaper] = useState(false);
  const [modelSettingsTarget, setModelSettingsTarget] = useState<{ provider: string; modelId: string; modelName: string } | null>(null);
  const [thinking, setThinking] = useState(() => localStorage.getItem('haven-thinking') === 'true');
  const [webSearch, setWebSearch] = useState(() => localStorage.getItem('haven-websearch') === 'true');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [companionStatus, setCompanionStatus] = useState<{ custom_status: string | null; presence: string }>({ custom_status: null, presence: 'online' });
  const [userStatus, setUserStatus] = useState<{ custom_status: string | null; presence: string }>({ custom_status: null, presence: 'online' });
  const [models, setModels] = useState<ModelInfo[]>([]);
  // Server-computed context usage. The old counter summed every message in the
  // thread while the worker only ever sends a window of it, so a long thread
  // read as catastrophically over the limit when the real payload was a
  // fraction of that. Only the server knows how it windows, so it does the sum.
  const [ctxInfo, setCtxInfo] = useState<ThreadContext | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [codexGear, setCodexGear] = useState<'ask' | 'code'>('ask');
  const [codexOnline, setCodexOnline] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);

  // Custom-emoji cache for status lines (:name: → image). Subscribing re-renders
  // the status once the emoji set finishes loading; the effect kicks the fetch in
  // case no message bubble has mounted yet (e.g. an empty chat).
  useCustomEmojiList();
  useEffect(() => { loadCustomEmoji(); }, []);

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

  useEffect(() => { getModels().then(m => setModels(Array.isArray(m) ? m : [])).catch(() => {}); }, []);

  // Load messages when thread changes. Skip if a send is in progress —
  // new-thread creation updates threadId mid-stream and we must not abort
  // the active chat or replace the optimistic messages.
  useEffect(() => {
    if (sendingRef.current) return;
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    setStreamingContent(null);
    if (!threadId) {
      setMessages([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    getMessages(threadId)
      .then(data => setMessages(Array.isArray(data) ? data : []))
      .catch((err) => setError(err.message))
      .finally(() => setIsLoading(false));
  }, [threadId]);

  // Persist settings
  useEffect(() => { localStorage.setItem(LS_FONT, String(fontSize)); }, [fontSize]);
  // Load wallpaper from IndexedDB — one wallpaper per companion
  const wpKey = `wp-companion-${activeCompanionId()}`;
  useEffect(() => { loadWallpaper(wpKey).then(setWallpaper); }, [wpKey, companionName]);
  useEffect(() => { localStorage.setItem(LS_MODEL, selectedModel); }, [selectedModel]);
  useEffect(() => { localStorage.setItem(LS_PROVIDER, selectedProvider); }, [selectedProvider]);
  useEffect(() => {
    const active = selectedProvider === 'codex';
    setCodexProviderActive(active);
    const unsubscribe = subscribeCodexPresence(setCodexOnline);
    return () => {
      unsubscribe();
      setCodexProviderActive(false);
    };
  }, [selectedProvider]);
  useEffect(() => { localStorage.setItem('haven-thinking', String(thinking)); pushPreference('thinking', String(thinking)); }, [thinking]);
  useEffect(() => { localStorage.setItem('haven-websearch', String(webSearch)); pushPreference('web_search', String(webSearch)); }, [webSearch]);

  // Refresh context usage when the thread changes or a turn completes.
  const refreshCtx = useCallback(() => {
    if (!threadId) { setCtxInfo(null); return; }
    getThreadContext(threadId).then(setCtxInfo).catch(() => {});
  }, [threadId]);
  useEffect(() => { refreshCtx(); }, [refreshCtx, messages.length]);

  const handleCompact = useCallback(async () => {
    if (!threadId || compacting) return;
    setShowMenu(false);
    setCompacting(true);
    setError(null);
    try {
      const r = await compactThread(threadId, 20);
      refreshCtx();
      setError(`Compacted ${r.compacted_messages} older messages into memory — the last ${r.kept_verbatim} stay word-for-word. Nothing was deleted.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Compaction failed');
    } finally {
      setCompacting(false);
    }
  }, [threadId, compacting, refreshCtx]);

  const handleModelChange = (model: string, provider: string) => {
    setSelectedModel(model);
    setSelectedProvider(provider);
  };

  const handleSend = useCallback(async (content: string, image?: string, fileContext?: string) => {
    setError(null);
    setShowMenu(false);
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    sendingRef.current = true;

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
    let codexCompleted = false;
    let streamFailed = false;

    try {
      let events;
      if (selectedProvider === 'codex') {
        const context = await getCodexRunContext(threadId);
        let attachments: Array<{ type: 'image'; key: string; name: string }> | undefined;
        if (image) {
          const blob = await fetch(image).then((response) => response.blob());
          const mime = blob.type || image.match(/^data:([^;,]+)/)?.[1] || 'image/png';
          const subtype = mime.split('/')[1]?.split('+')[0] || 'png';
          const extension = subtype === 'jpeg' ? 'jpg' : subtype.replace(/[^a-zA-Z0-9]/g, '') || 'png';
          const name = `image.${extension}`;
          const uploaded = await uploadFile(new File([blob], name, { type: mime }));
          const filePrefix = '/api/files/';
          if (!uploaded.url.startsWith(filePrefix) || uploaded.url.length === filePrefix.length) {
            throw new Error('Upload returned an invalid file URL');
          }
          attachments = [{ type: 'image', key: uploaded.url.slice(filePrefix.length), name }];
        }
        const persisted = await persistCodexMessage(threadId, 'user', persistedContent);
        realUserId = persisted.id;
        currentThreadId = persisted.threadId;
        if (!threadId) onThreadCreated(persisted.threadId);
        const requestId = crypto.randomUUID();
        events = sendChatCodex({
          prompt: persistedContent,
          systemPrompt: context.systemPrompt,
          companionId: context.companionId,
          companionName: context.companionName,
          mcpServers: context.mcpServers,
          gear: codexGear,
          requestId,
          threadKey: currentThreadId,
          ...(attachments && { attachments }),
          ...(selectedModel.startsWith('codex:') && { model: selectedModel.slice('codex:'.length) }),
        }, controller.signal);
      } else {
        events = sendChat(persistedContent, threadId, selectedModel, selectedProvider, image, thinking, webSearch, controller.signal, isPrivate);
      }

      for await (const event of events) {
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
          case 'file_change': {
            const codexEvent = event as StreamEvent;
            if (codexEvent.file) {
              const tag = codexDiffTag(codexEvent.file, codexEvent.changeType, codexEvent.summary);
              fullContent += `${fullContent && !fullContent.endsWith('\n') ? '\n' : ''}${tag}\n`;
              setStreamingContent(fullContent);
            }
            break;
          }
          case 'tools': {
            // Worker emits one event with all tool results at the end of a
            // tool-calling inference round. We map each to a compact record
            // (name + ok) for rendering as chips under the assistant bubble.
            const results = (event.results as any[]) || [];
            toolCalls = results.map(r => ({
              name: r?.name || r?.tool_name || 'tool',
              server: r?.server_name || r?.server,
              ok: r?.ok !== false && !r?.error,
              arguments: r?.arguments,
              result: r?.result,
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
            codexCompleted = selectedProvider === 'codex';
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
            streamFailed = true;
            setError(event.message || 'Stream error');
            break;
        }
      }

      if (selectedProvider === 'codex' && codexCompleted && currentThreadId && fullContent.trim()) {
        const persisted = await persistCodexMessage(currentThreadId, 'companion', fullContent, 'codex');
        realCompanionId = persisted.id;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') { sendingRef.current = false; return; }
      setError(err instanceof Error ? err.message : 'Failed to send message');
    }
    sendingRef.current = false;

    // Swap the optimistic user temp-id for the D1 UUID so delete/react/edit
    // hit the right row. Done in a single setMessages to avoid two renders.
    if (realUserId) {
      setMessages((prev) => prev.map((m) =>
        m.id === userMsg.id ? { ...m, id: realUserId!, thread_id: currentThreadId || m.thread_id } : m
      ));
    }

    setStreamingContent(null);
    if (fullContent || toolCalls.length > 0 || notice) {
      const companionMsg: Message = {
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
    } else if (!streamFailed) {
      setError('No response received — the model may be unavailable or the connection was interrupted. Try again.');
    }
  }, [threadId, selectedModel, selectedProvider, onThreadCreated, thinking, webSearch, codexGear, companionName]);

  // Rewind the conversation to `fromIdx` and send `content` as the new turn
  // there — the shared spine of both "edit a message" and "regenerate a reply".
  //
  // The rule both paths need: a branch REPLACES everything from that point on,
  // it does not add a second copy alongside it. The screen has always truncated
  // correctly; the D1 rows were the half that got left behind. That matters
  // because the worker replays the thread's latest 50 rows on every turn
  // (worker/src/index.ts:2121) — so any row still in the table keeps reaching
  // the model no matter what the screen shows.
  //
  // Edit and regenerate each used to carry their own copy of this, and only
  // regenerate's was ever (partly) right. One implementation so they can't
  // drift apart again.
  const rewindAndSend = useCallback(async (fromIdx: number, content: string, image?: string) => {
    // Optimistic ids (temp-/comp-) never reached D1 — nothing to delete.
    const doomed = messages.slice(fromIdx).filter(m => !m.id.startsWith('temp-') && !m.id.startsWith('comp-'));
    for (const m of doomed) {
      try { await deleteMessage(m.id); } catch { /* reconciles on reload */ }
    }
    // Truncate BEFORE the turn being replaced — handleSend re-inserts the user
    // message optimistically and reconciles its real D1 id, so re-adding it
    // here would double it up.
    setMessages(messages.slice(0, fromIdx));
    setTimeout(() => handleSend(content, image), 50);
  }, [messages, handleSend]);

  const handleEditMessage = useCallback(async (messageId: string, newContent: string) => {
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    // Resend the edited text in place of the original turn.
    await rewindAndSend(idx, newContent, messages[idx].image);
  }, [messages, rewindAndSend]);

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

    // Replay that user turn to get a different reply. Previously this deleted
    // ONLY the user row and the one companion row being regenerated, while the
    // screen truncated everything below — so regenerating an older reply left
    // every later message orphaned: invisible on screen, still replayed to the
    // model. Rewinding from the user turn deletes the whole tail it hides.
    await rewindAndSend(userIdx, userMsgAtIdx.content, userMsgAtIdx.image);
  }, [messages, rewindAndSend]);

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
    if (!messageId.startsWith('temp-') && !messageId.startsWith('comp-')) {
      reactMessage(messageId, emoji).catch(() => {});
    }
  }, []);

  const handleRevertFile = useCallback(async (file: string) => {
    if (!threadId || streamingContent !== null) return;
    setError(null);
    setStreamingContent('');
    const requestId = crypto.randomUUID();
    let confirmation = '';
    let completed = false;
    try {
      // Revert must land in the SAME companion folder the run used.
      const context = await getCodexRunContext(threadId);
      for await (const event of sendChatCodex({
        mode: 'revert', paths: [file], requestId,
        companionId: context.companionId, companionName: context.companionName,
      })) {
        if (event.type === 'file_change' && event.file) {
          confirmation += codexDiffTag(event.file, event.changeType || 'reverted', event.summary);
          setStreamingContent(confirmation);
        } else if (event.type === 'complete') {
          completed = true;
        } else if (event.type === 'error') {
          setError(event.message || 'Revert failed');
        } else if (event.type === 'notice' && event.message) {
          setError(event.message);
        }
      }
      if (completed && confirmation) {
        const persisted = await persistCodexMessage(threadId, 'companion', confirmation, 'codex');
        setMessages((prev) => [...prev, {
          id: persisted.id,
          thread_id: persisted.threadId,
          role: 'companion',
          content: confirmation,
          model: 'codex',
          created_at: new Date().toISOString(),
        }]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revert failed');
    } finally {
      setStreamingContent(null);
    }
  }, [threadId, streamingContent]);

  const adjustFont = (delta: number) => {
    setFontSize((prev) => Math.max(12, Math.min(24, prev + delta)));
  };

  const displayedCompanionPresence = selectedProvider === 'codex'
    ? (codexOnline ? 'online' : 'offline')
    : (companionStatus.presence || 'online');
  const displayedCompanionStatus = selectedProvider === 'codex' && !codexOnline
    ? 'PC offline'
    : (companionStatus.custom_status || displayedCompanionPresence);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', padding: '8px 12px 8px 6px',
        borderBottom: '1px solid var(--haven-border)', background: 'var(--haven-surface)',
        gap: '8px', flexShrink: 0, position: 'relative', zIndex: 21,
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
              <AuthMedia url={companionAvatar} type="img" alt="" style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover' }} />
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
              background: { online: '#4ade80', idle: '#facc15', dnd: '#f87171', offline: '#6b7280' }[displayedCompanionPresence] || '#4ade80',
              border: '2px solid var(--haven-surface)',
            }} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--haven-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{companionName}</div>
            <div
              title={displayedCompanionStatus}
              style={{
                fontSize: '10px', color: 'var(--haven-text-secondary)', lineHeight: '1.3',
                display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
                overflow: 'hidden', maxWidth: '320px', wordBreak: 'break-word',
              }}
            >
              {renderEmojiText(displayedCompanionStatus)}
            </div>
          </div>
        </div>

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* User (right) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
          <div style={{ minWidth: 0, textAlign: 'right' }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--haven-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {localStorage.getItem('haven-user-name') || 'You'}
            </div>
            <div style={{ fontSize: '9px', color: 'var(--haven-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100px' }}>
              {renderEmojiText(userStatus.custom_status || userStatus.presence || 'online')}
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

      {/* Slim model bar */}
      {(() => {
        const currentModel = models.find(m => m.id === selectedModel && m.provider === selectedProvider);
        const ctxMax = currentModel?.context_length || 128000;
        // What the model actually receives — NOT the whole archive. Falls back
        // to a local estimate only until the server figures respond.
        const est = ctxInfo
          ? ctxInfo.window_tokens
          : messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
        const pct = ctxMax > 0 ? est / ctxMax : 0;
        const tokenColor = pct > 0.8 ? '#f87171' : pct > 0.5 ? '#facc15' : 'var(--haven-text-muted)';
        const tokenLabel = est < 1000 ? `~${est}` : `~${(est / 1000).toFixed(1)}k`;
        const maxLabel = ctxMax >= 1000000 ? `${(ctxMax / 1000000).toFixed(1)}M` : `${Math.round(ctxMax / 1000)}k`;
        // Past half the window, offer compaction rather than waiting for the
        // silent truncation at the top end. Never acts on its own.
        const suggestCompact = pct > 0.5;
        return (
          <div style={{
            display: 'flex', alignItems: 'center',
            padding: '3px 12px', background: 'var(--haven-surface)', borderBottom: '1px solid var(--haven-border)',
            fontSize: '10px', flexShrink: 0, opacity: 0.9, position: 'relative', zIndex: 20,
          }}>
            {/* Left: model name → tap for settings */}
            <button
              onClick={() => {
                const name = currentModel?.name || selectedModel.split('/').pop()?.replace(':free', '') || selectedModel;
                setModelSettingsTarget({ provider: selectedProvider, modelId: selectedModel, modelName: name });
              }}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'var(--haven-text-secondary)', fontSize: '10px', padding: 0,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                flex: 1, textAlign: 'left', minWidth: 0,
              }}
            >
              {currentModel?.name || selectedModel.split('/').pop()?.replace(':free', '') || selectedModel}
            </button>

            {/* Center: model selector + thinking + menu */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
              <ModelSelector
                selectedModel={selectedModel}
                selectedProvider={selectedProvider}
                onModelChange={handleModelChange}
                onOpenSettings={(p, id, name) => setModelSettingsTarget({ provider: p, modelId: id, modelName: name })}
              />
              {/* Thinking toggle */}
              <button
                onClick={() => setThinking(!thinking)}
                title={thinking ? 'Thinking ON' : 'Thinking OFF'}
                style={{
                  background: thinking ? 'var(--haven-accent)' : 'transparent',
                  border: thinking ? 'none' : '1px solid var(--haven-border)',
                  borderRadius: '4px', padding: '2px 5px', cursor: 'pointer',
                  fontSize: '10px', color: thinking ? 'white' : 'var(--haven-text-muted)',
                  lineHeight: 1,
                }}
              >🧠</button>
              {/* Web search toggle */}
              <button
                onClick={() => setWebSearch(!webSearch)}
                title={webSearch ? 'Web search ON' : 'Web search OFF'}
                style={{
                  background: webSearch ? 'var(--haven-accent)' : 'transparent',
                  border: webSearch ? 'none' : '1px solid var(--haven-border)',
                  borderRadius: '4px', padding: '2px 5px', cursor: 'pointer',
                  fontSize: '10px', color: webSearch ? 'white' : 'var(--haven-text-muted)',
                  lineHeight: 1,
                }}
              >🌐</button>
              {/* Private thread — excluded from proactive memory extraction.
                  Works before the first message: with no thread row yet the
                  flag rides along on the first send. */}
              <button
                onClick={togglePrivate}
                title={isPrivate
                  ? 'Private ON — nothing from this thread is saved to memory'
                  : 'Private OFF — this thread can be used for memory'}
                aria-label="Toggle private thread"
                style={{
                  background: isPrivate ? 'var(--haven-accent)' : 'transparent',
                  border: isPrivate ? 'none' : '1px solid var(--haven-border)',
                  borderRadius: '4px', padding: '2px 5px', cursor: 'pointer',
                  fontSize: '10px', color: isPrivate ? 'white' : 'var(--haven-text-muted)',
                  lineHeight: 1,
                }}
              >🔒</button>
              {/* Menu */}
              <div style={{ position: 'relative' }}>
                <button
                  onClick={() => setShowMenu(!showMenu)}
                  style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    color: 'var(--haven-text-muted)', fontSize: '14px', padding: '2px 4px', lineHeight: 1,
                  }}
                >&#8942;</button>
                {showMenu && (
                  <>
                    <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setShowMenu(false)} />
                    <div style={{
                      position: 'absolute', top: '100%', right: 0, marginTop: '4px',
                      background: 'var(--haven-surface)', border: '1px solid var(--haven-border)',
                      borderRadius: '10px', padding: '6px', minWidth: '160px', zIndex: 50,
                      boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px' }}>
                        <span style={{ fontSize: '12px', color: 'var(--haven-text-secondary)' }}>Font Size</span>
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <button onClick={() => adjustFont(-1)} style={{ width: '28px', height: '28px', borderRadius: '6px', border: '1px solid var(--haven-border)', background: 'var(--haven-card)', color: 'var(--haven-text)', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>A-</button>
                          <button onClick={() => adjustFont(1)} style={{ width: '28px', height: '28px', borderRadius: '6px', border: '1px solid var(--haven-border)', background: 'var(--haven-card)', color: 'var(--haven-text)', cursor: 'pointer', fontSize: '14px', fontWeight: 600 }}>A+</button>
                        </div>
                      </div>
                      <button
                        onClick={() => { setShowWallpaper(true); setShowMenu(false); }}
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 8px', background: 'transparent', border: 'none', color: 'var(--haven-text-secondary)', fontSize: '12px', cursor: 'pointer', borderRadius: '6px', textAlign: 'left' }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--haven-card)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      >🎨 Wallpaper</button>
                      {/* Compact — manual only. Folds older turns into memory he
                          carries, keeping the last 20 word-for-word. Messages
                          are never deleted; only what's sent to him narrows. */}
                      {threadId && (
                        <button
                          onClick={handleCompact}
                          disabled={compacting}
                          title={ctxInfo
                            ? `Fold the older ${Math.max(ctxInfo.archive_messages - 20, 0)} messages into memory. Nothing is deleted.`
                            : 'Fold older messages into memory. Nothing is deleted.'}
                          style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 8px', background: 'transparent', border: 'none', color: suggestCompact ? '#facc15' : 'var(--haven-text-secondary)', fontSize: '12px', cursor: compacting ? 'default' : 'pointer', borderRadius: '6px', textAlign: 'left' }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--haven-card)')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                        >🗜 {compacting ? 'Compacting…' : 'Compact thread'}</button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Right: context usage. Title carries the archive figure so the
                distinction between "sent to him" and "said in here" is
                available without cluttering a 10px bar. */}
            <span
              onClick={suggestCompact ? handleCompact : undefined}
              title={ctxInfo
                ? `Sent to ${companionName}: ~${ctxInfo.window_tokens.toLocaleString()} tokens (${ctxInfo.window_messages} messages)\n`
                  + `Whole thread: ~${ctxInfo.archive_tokens.toLocaleString()} tokens (${ctxInfo.archive_messages} messages)\n`
                  + (ctxInfo.compacted ? `${ctxInfo.compacted_messages} older messages folded into memory\n` : '')
                  + (suggestCompact ? '\nTap to compact.' : '')
                : undefined}
              style={{
                color: tokenColor, flexShrink: 0,
                cursor: suggestCompact ? 'pointer' : 'default',
                display: 'flex', alignItems: 'center', gap: '3px',
              }}
            >
              {ctxInfo?.compacted && <span title="This thread has been compacted">🗜</span>}
              {compacting ? 'compacting…' : `${tokenLabel}/${maxLabel}`}
            </span>
          </div>
        );
      })()}

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
        onRevertFile={handleRevertFile}
      />

      {/* Input */}
      <div style={{ position: 'relative' }}>
        {selectedProvider === 'codex' && (
          <button
            onClick={() => setCodexGear((current) => current === 'ask' ? 'code' : 'ask')}
            title={codexGear === 'ask' ? 'Ask mode (read-only)' : 'Code mode (workspace write)'}
            style={{
              position: 'absolute', right: '58px', bottom: '20px', zIndex: 2,
              height: '28px', minWidth: '42px', padding: '0 7px', borderRadius: '14px',
              border: '1px solid var(--haven-border)', cursor: 'pointer', fontSize: '10px',
              background: codexGear === 'code' ? 'var(--haven-accent)' : 'var(--haven-surface)',
              color: codexGear === 'code' ? 'white' : 'var(--haven-text-secondary)',
            }}
          >{codexGear === 'ask' ? 'Ask' : 'Code'}</button>
        )}
        <ChatInput
          onSend={handleSend}
          disabled={streamingContent !== null}
          placeholder={threadId ? `Message ${companionName}...` : `Start a new conversation with ${companionName}...`}
        />
      </div>

      {/* Model settings panel */}
      {modelSettingsTarget && (
        <ModelSettingsPanel
          provider={modelSettingsTarget.provider}
          modelId={modelSettingsTarget.modelId}
          modelName={modelSettingsTarget.modelName}
          model={models.find(m => m.id === modelSettingsTarget.modelId && m.provider === modelSettingsTarget.provider)}
          onClose={() => setModelSettingsTarget(null)}
        />
      )}

      {/* Wallpaper picker */}
      {showWallpaper && (
        <WallpaperPicker
          current={wallpaper}
          onSelect={(wp: string) => { setWallpaper(wp); saveWallpaper(wpKey, wp); }}
          onClose={() => setShowWallpaper(false)}
        />
      )}
    </div>
  );
}
