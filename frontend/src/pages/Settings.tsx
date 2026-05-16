import { useState, useEffect, lazy, Suspense } from 'react';
import type { Identity } from '../lib/types';
import AuthMedia from '../components/AuthMedia';
import {
  getCompanion, updateCompanion,
  getSettings, updateSettings,
  getIdentity, addIdentity, deleteIdentity,
  uploadFile, getUserStatus, setUserStatus, apiBase,
  archiveCompanion, setActiveCompanionId, activeCompanionId,
  exportCompanion, getStorageUsage, clearChatFiles,
  getAuthStatus, generateAuthToken, saveAuthToken, getAuthToken, clearAuthToken, revokeAuthToken,
} from '../lib/api';
import { getTTSSettings, saveTTSSettings, getBrowserVoices } from '../lib/tts';
import WallpaperPicker from '../components/WallpaperPicker';
const FilesPanel = lazy(() => import('../components/FilesPanel'));

interface SettingsProps {
  onImport?: () => void;
  onBack?: () => void;
}

export default function Settings({ onImport, onBack }: SettingsProps) {
  // Companion
  const [compName, setCompName] = useState('');
  const [compId, setCompId] = useState<number>(activeCompanionId());
  const [avatarUrl, setAvatarUrl] = useState('');
  const [compSaving, setCompSaving] = useState(false);
  const [compMsg, setCompMsg] = useState('');
  const [archiving, setArchiving] = useState(false);

  // API Key — one field, auto-detect provider
  const [apiKey, setApiKey] = useState('');
  const [apiSaving, setApiSaving] = useState(false);
  const [apiMsg, setApiMsg] = useState('');
  const [connectedProviders, setConnectedProviders] = useState<string[]>([]);
  // Per-provider enabled toggles. Each entry is the ENABLED setting key on
  // the worker side (openrouter_enabled, ollama_enabled, custom_enabled).
  // "false" string = disabled; anything else = enabled (default).
  const [providerEnabled, setProviderEnabled] = useState<Record<string, boolean>>({
    openrouter: true, ollama: true, custom: true,
  });

  // Chat
  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem('haven-font-size');
    return saved ? parseInt(saved, 10) : 15;
  });
  const [wallpaper, setWallpaper] = useState(() => localStorage.getItem('haven-wallpaper') || '');
  const [showWallpaper, setShowWallpaper] = useState(false);
  const [fontFamily, setFontFamily] = useState(() => localStorage.getItem('haven-font-family') || 'System');
  const [textColor, setTextColor] = useState(() => localStorage.getItem('haven-text-color') || '');

  // User status
  const [userStatusText, setUserStatusText] = useState('');
  const [userPresence, setUserPresence] = useState('online');
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  // Storage
  const [storage, setStorage] = useState<{ chat: { count: number; bytes: number }; project: { count: number; bytes: number } } | null>(null);
  const [clearingStorage, setClearingStorage] = useState(false);

  // Voice / TTS
  const [ttsMode, setTtsMode] = useState<'browser' | 'elevenlabs'>(() => getTTSSettings().mode);
  const [browserVoice, setBrowserVoice] = useState(() => getTTSSettings().browserVoice);
  const [elevenKey, setElevenKey] = useState(() => getTTSSettings().elevenLabsKey);
  const [elevenVoiceId, setElevenVoiceId] = useState(() => getTTSSettings().elevenLabsVoiceId);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    const loadVoices = () => setVoices(getBrowserVoices());
    loadVoices();
    try {
      if (typeof speechSynthesis === 'undefined') return;
      speechSynthesis.addEventListener('voiceschanged', loadVoices);
      return () => { try { speechSynthesis.removeEventListener('voiceschanged', loadVoices); } catch {} };
    } catch {}
  }, []);

  const [voiceSaving, setVoiceSaving] = useState(false);
  const [voiceMsg, setVoiceMsg] = useState('');
  const saveVoice = async () => {
    setVoiceSaving(true);
    try {
      saveTTSSettings({ mode: ttsMode, browserVoice, elevenLabsKey: elevenKey, elevenLabsVoiceId: elevenVoiceId });
      setVoiceMsg('Saved');
    } catch {
      setVoiceMsg('Error');
    }
    setVoiceSaving(false);
    setTimeout(() => setVoiceMsg(''), 2000);
  };

  // Identity
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [newContent, setNewContent] = useState('');
  const [newType, setNewType] = useState('personality');
  const [idLoading, setIdLoading] = useState(false);

  const refreshProviders = () => {
    getSettings().then((s) => {
      setApiKey(s.openrouter_key || s.ollama_key || s.anthropic_key || s.openai_key || s.groq_key || s.xai_key || s.huggingface_key || s.custom_key || s.ollama_url || '');
      const connected: string[] = [];
      if (s.openrouter_key) connected.push('OpenRouter');
      if (s.ollama_key || s.ollama_url) connected.push('Ollama');
      if (s.anthropic_key) connected.push('Anthropic');
      if (s.openai_key) connected.push('OpenAI');
      if (s.groq_key) connected.push('Groq');
      if (s.xai_key) connected.push('xAI');
      if (s.huggingface_key) connected.push('Hugging Face');
      if (s.custom_key && !s.anthropic_key && !s.openai_key && !s.groq_key && !s.xai_key && !s.huggingface_key) {
        connected.push(s.provider || 'Custom');
      }
      setConnectedProviders(connected);
      setProviderEnabled({
        openrouter: (s as any).openrouter_enabled !== 'false',
        ollama: (s as any).ollama_enabled !== 'false',
        custom: (s as any).custom_enabled !== 'false',
      });
    }).catch((e) => console.warn('[settings] getSettings failed', e));
  };

  useEffect(() => {
    getCompanion().then((c) => {
      setCompName(c.name);
      setCompId(c.id);
      setAvatarUrl(c.avatar_url || '');
    }).catch((e) => console.warn('[settings] getCompanion failed', e));

    refreshProviders();

    loadIdentities();

    getUserStatus().then((s) => {
      setUserStatusText(s.custom_status || '');
      setUserPresence(s.presence || 'online');
    }).catch((e) => console.warn('[settings] getUserStatus failed', e));

    getStorageUsage().then(setStorage).catch(() => {});
  }, []);

  const saveUserStatus = async () => {
    setStatusSaving(true);
    setStatusMsg('');
    try {
      await setUserStatus({ custom_status: userStatusText, presence: userPresence });
      setStatusMsg('Saved');
      setTimeout(() => setStatusMsg(''), 2000);
    } catch { setStatusMsg('Error'); }
    setStatusSaving(false);
  };

  const loadIdentities = () => {
    setIdLoading(true);
    getIdentity().then(setIdentities).catch(() => {}).finally(() => setIdLoading(false));
  };

  const saveCompanion = async () => {
    setCompSaving(true);
    setCompMsg('');
    try {
      await updateCompanion({ name: compName, avatar_url: avatarUrl || null });
      setCompMsg('Saved');
      setTimeout(() => setCompMsg(''), 2000);
    } catch { setCompMsg('Error'); }
    setCompSaving(false);
  };

  const saveApi = async () => {
    setApiSaving(true);
    setApiMsg('');
    try {
      const settings: Record<string, string> = {};
      const key = apiKey.trim();
      if (key.startsWith('http://') || key.startsWith('https://')) {
        try { new URL(key); }
        catch { throw new Error('Invalid URL'); }
        settings.ollama_url = key;
        settings.provider = 'ollama';
      } else if (key.startsWith('hf_')) {
        settings.huggingface_key = key;
        settings.provider = 'huggingface';
      } else if (key.startsWith('sk-or-')) {
        settings.openrouter_key = key;
        settings.provider = 'openrouter';
      } else if (key.startsWith('gsk_')) {
        settings.groq_key = key;
        settings.provider = 'groq';
      } else if (key.startsWith('sk-ant-')) {
        settings.anthropic_key = key;
        settings.provider = 'anthropic';
      } else if (key.startsWith('sk-') || key.startsWith('sk-proj-')) {
        settings.openai_key = key;
        settings.provider = 'openai';
      } else if (key.startsWith('xai-')) {
        settings.xai_key = key;
        settings.provider = 'xai';
      } else if (/^[a-f0-9]+\.[a-zA-Z0-9_-]+$/.test(key)) {
        settings.ollama_key = key;
        settings.provider = 'ollama';
      } else if (key) {
        settings.openrouter_key = key;
        settings.provider = 'openrouter';
      }
      await updateSettings(settings);
      refreshProviders();
      setApiMsg('Saved');
      setTimeout(() => setApiMsg(''), 2000);
    } catch { setApiMsg('Error'); }
    setApiSaving(false);
  };

  const handleAddIdentity = async () => {
    if (!newContent.trim()) return;
    await addIdentity({ content: newContent.trim(), identity_type: newType, priority: 0 });
    setNewContent('');
    loadIdentities();
  };

  const handleDeleteIdentity = async (id: number) => {
    if (!confirm('Delete this identity entry? This cannot be undone.')) return;
    await deleteIdentity(id);
    loadIdentities();
  };

  const handleFontChange = (val: number) => {
    setFontSize(val);
    localStorage.setItem('haven-font-size', String(val));
  };

  const handleWallpaperChange = (val: string) => {
    setWallpaper(val);
    localStorage.setItem('haven-wallpaper', val);
  };

  const sectionStyle: React.CSSProperties = {
    background: 'var(--haven-surface)',
    border: '1px solid var(--haven-border)',
    borderRadius: '12px',
    padding: '20px',
    marginBottom: '16px',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '12px', color: 'var(--haven-text-secondary)', marginBottom: '6px', display: 'block',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: '8px',
    background: 'var(--haven-card)', border: '1px solid var(--haven-border)',
    color: 'var(--haven-text)', fontSize: '14px', outline: 'none',
  };

  const btnStyle: React.CSSProperties = {
    padding: '8px 20px', borderRadius: '8px', border: 'none',
    background: 'var(--haven-accent)', color: 'white', fontSize: '13px',
    fontWeight: 600, cursor: 'pointer',
  };

  const typeLabels: Record<string, string> = {
    backstory: 'Identity',
    dynamic: 'Traits',
    anchor: 'Core Rule',
    voice: 'Voice',
    trait: 'Trait',
    boundary: 'Boundary',
    value: 'Value',
  };

  const typeBadge = (type: string) => (
    <span style={{
      fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
      background: 'var(--haven-card)', color: 'var(--haven-accent)',
      borderRadius: '4px', padding: '2px 6px', marginLeft: '6px',
      border: '1px solid var(--haven-border)',
    }}>{typeLabels[type] || type}</span>
  );

  return (
    <div className="hide-scrollbar" style={{
      height: '100%', overflowY: 'scroll', padding: '20px',
      maxWidth: '600px', margin: '0 auto',
      WebkitOverflowScrolling: 'touch' as any, touchAction: 'pan-y',
    }}>
      {/* Back link */}
      <div style={{ marginBottom: '20px' }}>
        <button
          onClick={onBack || (() => window.history.back())}
          style={{ background: 'none', border: 'none', color: 'var(--haven-text-muted)', cursor: 'pointer', fontSize: '13px', padding: 0 }}
        >
          ← Back to chat
        </button>
      </div>

      <h1 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--haven-text)', marginBottom: '20px' }}>Settings</h1>

      {/* Backend URL */}
      <div style={sectionStyle}>
        <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '8px' }}>Backend</h3>
        <p style={{ fontSize: '11px', color: 'var(--haven-text-muted)', marginBottom: '12px' }}>
          Your Haven Worker URL. Leave empty if using the same origin.
        </p>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text"
            placeholder="https://your-haven-worker.workers.dev"
            value={localStorage.getItem('haven-api-url') || ''}
            onChange={(e) => {
              const val = e.target.value.trim();
              if (val) localStorage.setItem('haven-api-url', val);
              else localStorage.removeItem('haven-api-url');
            }}
            style={inputStyle}
          />
          <button
            onClick={() => window.location.reload()}
            style={{ ...btnStyle, whiteSpace: 'nowrap' }}
          >
            Apply
          </button>
        </div>
      </div>

      {/* Security */}
      <SecuritySection sectionStyle={sectionStyle} btnStyle={btnStyle} />

      {/* Your Profile & Status */}
      <div style={sectionStyle}>
        <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '12px' }}>You</h3>
        <div style={{ marginBottom: '12px' }}>
          <label style={labelStyle}>Display Name</label>
          <input
            type="text"
            placeholder="Your name"
            defaultValue={localStorage.getItem('haven-user-name') || ''}
            onBlur={(e) => {
              const val = e.target.value.trim();
              if (val) localStorage.setItem('haven-user-name', val);
              else localStorage.removeItem('haven-user-name');
            }}
            style={inputStyle}
          />
        </div>
        <div style={{ marginBottom: '12px' }}>
          <label style={labelStyle}>Avatar</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <label style={{ cursor: 'pointer' }}>
              {localStorage.getItem('haven-user-avatar') ? (
                <img src={localStorage.getItem('haven-user-avatar')!} alt="" style={{ width: '48px', height: '48px', borderRadius: '50%', objectFit: 'cover' }} />
              ) : (
                <div style={{
                  width: '48px', height: '48px', borderRadius: '50%',
                  background: 'var(--haven-card)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'var(--haven-text-muted)', fontSize: '20px',
                }}>+</div>
              )}
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                  localStorage.setItem('haven-user-avatar', reader.result as string);
                  window.location.reload();
                };
                reader.readAsDataURL(file);
              }} />
            </label>
            <span style={{ fontSize: '11px', color: 'var(--haven-text-muted)' }}>Tap to upload</span>
            {localStorage.getItem('haven-user-avatar') && (
              <button
                onClick={() => { localStorage.removeItem('haven-user-avatar'); window.location.reload(); }}
                style={{ fontSize: '11px', color: '#f87171', background: 'transparent', border: 'none', cursor: 'pointer' }}
              >Remove</button>
            )}
          </div>
        </div>
        <div style={{ marginBottom: '12px' }}>
          <label style={labelStyle}>Status</label>
          <input
            type="text"
            placeholder="What's on your mind?"
            value={userStatusText}
            onChange={(e) => setUserStatusText(e.target.value)}
            style={inputStyle}
          />
        </div>
        <div style={{ marginBottom: '12px' }}>
          <label style={labelStyle}>Presence</label>
          <div style={{ display: 'flex', gap: '6px' }}>
            {[
              { label: 'Online', value: 'online', color: '#4ade80' },
              { label: 'Idle', value: 'idle', color: '#facc15' },
              { label: 'DND', value: 'dnd', color: '#f87171' },
              { label: 'Offline', value: 'offline', color: '#6b7280' },
            ].map((p) => (
              <button
                key={p.value}
                onClick={() => setUserPresence(p.value)}
                style={{
                  flex: 1, padding: '6px', borderRadius: '8px', fontSize: '11px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
                  background: userPresence === p.value ? 'var(--haven-card)' : 'transparent',
                  color: userPresence === p.value ? 'var(--haven-text)' : 'var(--haven-text-muted)',
                  border: `1px solid ${userPresence === p.value ? p.color : 'var(--haven-border)'}`,
                }}
              >
                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: p.color }} />
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button onClick={saveUserStatus} disabled={statusSaving} style={btnStyle}>
            {statusSaving ? 'Saving...' : 'Save'}
          </button>
          {statusMsg && <span style={{ fontSize: '12px', color: statusMsg === 'Saved' ? '#4ade80' : '#f87171' }}>{statusMsg}</span>}
        </div>
      </div>

      {/* Companion */}
      <div style={sectionStyle}>
        <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '16px' }}>Companion</h3>
        <div style={{ marginBottom: '12px' }}>
          <label style={labelStyle}>Name</label>
          <input type="text" value={compName} onChange={(e) => setCompName(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ marginBottom: '12px' }}>
          <label style={labelStyle}>Avatar</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {avatarUrl && (
              <AuthMedia url={avatarUrl} type="img" alt="avatar" style={{ width: '48px', height: '48px', borderRadius: '50%', objectFit: 'cover', border: '2px solid var(--haven-border)' }} />
            )}
            <label style={{
              flex: 1, padding: '10px', borderRadius: '8px', textAlign: 'center',
              background: 'var(--haven-card)', border: '1px solid var(--haven-border)',
              color: 'var(--haven-text-secondary)', fontSize: '13px', cursor: 'pointer',
            }}>
              Upload Image
              <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  const result = await uploadFile(file);
                  setAvatarUrl(`${apiBase()}${result.url}`);
                } catch {}
              }} />
            </label>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <button onClick={saveCompanion} disabled={compSaving} style={btnStyle}>
            {compSaving ? 'Saving...' : 'Save'}
          </button>
          {/* Export companion — downloads a JSON bundle with identity /
              memories / people / important_dates / files (text only) so
              the companion can be re-imported into another Haven instance.
              Threads intentionally not included. */}
          <button
            onClick={() => exportCompanion(compId, compName || 'companion').catch(() => {})}
            style={{
              ...btnStyle,
              background: 'transparent',
              border: '1px solid var(--haven-border)',
              color: 'var(--haven-text-secondary)',
              cursor: 'pointer',
            }}
          >
            Export this companion
          </button>
          {compMsg && <span style={{ fontSize: '12px', color: compMsg === 'Saved' ? '#4ade80' : '#f87171' }}>{compMsg}</span>}
        </div>

        {/* Project Files — v1.7. Attach files whose extracted text gets
            injected into this companion's system prompt on every chat. */}
        <div style={{
          marginTop: '20px', paddingTop: '16px',
          borderTop: '1px solid var(--haven-border)',
        }}>
          <h4 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '12px' }}>Project Files</h4>
          <Suspense fallback={<div style={{ fontSize: '12px', color: 'var(--haven-text-muted)' }}>Loading...</div>}>
            <FilesPanel companionId={compId} />
          </Suspense>
        </div>

        {/* Archive companion — v1.7 multi-companion. The default seed
            companion (id=1) can't be archived because the rest of the
            scoped tables default their companion_id to 1 when nothing
            else is set. */}
        {compId > 1 && (
          <div style={{
            marginTop: '20px', paddingTop: '16px',
            borderTop: '1px solid var(--haven-border)',
          }}>
            <p style={{ fontSize: '11px', color: 'var(--haven-text-muted)', marginBottom: '8px' }}>
              Archiving hides this companion from the grid and switcher without deleting anything. Their threads, identity, and memories are preserved — you can restore them later.
            </p>
            <button
              onClick={async () => {
                if (!confirm(`Archive ${compName}? Their data is preserved and they can be restored later.`)) return;
                setArchiving(true);
                try {
                  await archiveCompanion(compId);
                  // Switch active back to the default seed companion so the
                  // next view isn't operating on an archived id.
                  setActiveCompanionId(1);
                  if (onBack) onBack();
                  else window.location.reload();
                } catch (e) {
                  alert('Archive failed: ' + (e instanceof Error ? e.message : 'unknown error'));
                } finally {
                  setArchiving(false);
                }
              }}
              disabled={archiving}
              style={{
                ...btnStyle,
                background: 'transparent',
                border: '1px solid #f87171',
                color: '#f87171',
                opacity: archiving ? 0.6 : 1,
              }}
            >
              {archiving ? 'Archiving…' : 'Archive companion'}
            </button>
          </div>
        )}
      </div>

      {/* API Key */}
      <div style={sectionStyle}>
        <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '8px' }}>Connect</h3>
        {connectedProviders.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
            {connectedProviders.map(p => {
              // Map display name → toggle key. OpenRouter + Ollama are their
              // own providers; everything custom (HF, Groq, OpenAI, etc.)
              // shares the `custom_enabled` flag since it's one stored key.
              const toggleKey =
                p === 'OpenRouter' ? 'openrouter' :
                p === 'Ollama' ? 'ollama' : 'custom';
              const enabled = providerEnabled[toggleKey];
              const dot = enabled ? '#4ade80' : 'var(--haven-text-muted)';
              const bg = enabled ? '#16a34a15' : 'var(--haven-card)';
              const textColor = enabled ? '#4ade80' : 'var(--haven-text-muted)';
              const toggle = async () => {
                const next = !enabled;
                setProviderEnabled(prev => ({ ...prev, [toggleKey]: next }));
                try {
                  await updateSettings({ [`${toggleKey}_enabled`]: next ? 'true' : 'false' });
                } catch {
                  setProviderEnabled(prev => ({ ...prev, [toggleKey]: !next }));
                }
              };
              return (
                <button
                  key={p}
                  onClick={toggle}
                  title={enabled ? `Click to disable ${p}` : `Click to enable ${p}`}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '5px',
                    fontSize: '11px', color: textColor,
                    background: bg, borderRadius: '6px', padding: '3px 8px',
                    border: 'none', cursor: 'pointer',
                    opacity: enabled ? 1 : 0.6,
                    textDecoration: enabled ? 'none' : 'line-through',
                  }}
                >
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: dot, flexShrink: 0 }} />
                  {p}
                </button>
              );
            })}
          </div>
        )}
        <div style={{ marginBottom: '12px' }}>
          <label style={labelStyle}>API Key</label>
          <input
            type={apiKey.startsWith('http') ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste your API key or local URL"
            style={{ ...inputStyle, fontFamily: 'monospace' }}
          />
          <p style={{ fontSize: '11px', color: 'var(--haven-text-muted)', margin: '4px 0 0', lineHeight: '1.4' }}>
            {(() => {
              const k = apiKey.trim();
              if (!k) return 'Supports: OpenRouter, Ollama, OpenAI, Anthropic, Groq, xAI, or any local URL';
              if (k.includes('***')) return connectedProviders.length > 0 ? `Connected: ${connectedProviders.join(', ')}` : 'Key saved';
              if (k.startsWith('hf_')) return 'Hugging Face detected';
              if (k.startsWith('sk-or-')) return 'OpenRouter detected';
              if (k.startsWith('http')) return 'Local Ollama URL detected';
              if (k.startsWith('gsk_')) return 'Groq detected';
              if (k.startsWith('sk-ant-')) return 'Anthropic detected';
              if (k.startsWith('sk-')) return 'OpenAI detected';
              if (k.startsWith('xai-')) return 'xAI / Grok detected';
              if (/^[a-f0-9]+\.[a-zA-Z0-9_-]+$/.test(k)) return 'Ollama Cloud detected';
              return 'Will route through OpenRouter';
            })()}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button onClick={saveApi} disabled={apiSaving} style={btnStyle}>
            {apiSaving ? 'Saving...' : 'Save'}
          </button>
          {apiMsg && <span style={{ fontSize: '12px', color: apiMsg === 'Saved' ? '#4ade80' : '#f87171' }}>{apiMsg}</span>}
        </div>
      </div>

      {/* MCP Servers */}
      <McpServersSection apiUrl={apiBase()} />

      {/* Chat */}
      <div style={sectionStyle}>
        <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '16px' }}>Chat</h3>
        <div style={{ marginBottom: '16px' }}>
          <label style={labelStyle}>Font Size: {fontSize}px</label>
          <input
            type="range" min="12" max="24" value={fontSize}
            onChange={(e) => handleFontChange(parseInt(e.target.value, 10))}
            style={{ width: '100%', accentColor: 'var(--haven-accent)' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--haven-text-muted)' }}>
            <span>12px</span><span>24px</span>
          </div>
        </div>
        <div style={{ marginBottom: '16px' }}>
          <label style={labelStyle}>Font</label>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {[
              { label: 'System', value: 'System' },
              { label: 'Serif', value: 'Georgia, serif' },
              { label: 'Mono', value: 'ui-monospace, monospace' },
              { label: 'Dyslexic', value: 'OpenDyslexic, sans-serif' },
            ].map((f) => (
              <button
                key={f.label}
                onClick={() => { setFontFamily(f.value); localStorage.setItem('haven-font-family', f.value); }}
                style={{
                  padding: '6px 12px', borderRadius: '8px', fontSize: '12px', cursor: 'pointer',
                  fontFamily: f.value === 'System' ? 'inherit' : f.value,
                  background: fontFamily === f.value ? 'var(--haven-accent)' : 'var(--haven-card)',
                  color: fontFamily === f.value ? 'white' : 'var(--haven-text-secondary)',
                  border: `1px solid ${fontFamily === f.value ? 'var(--haven-accent)' : 'var(--haven-border)'}`,
                }}
              >{f.label}</button>
            ))}
          </div>
        </div>
        <div style={{ marginBottom: '16px' }}>
          <label style={labelStyle}>Text Color</label>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
            {[
              { label: 'Default', value: '' },
              { label: 'Warm', value: '#fde68a' },
              { label: 'Cool', value: '#93c5fd' },
              { label: 'Rose', value: '#fda4af' },
              { label: 'Mint', value: '#6ee7b7' },
              { label: 'Lavender', value: '#c4b5fd' },
            ].map((c) => (
              <button
                key={c.label}
                onClick={() => { setTextColor(c.value); localStorage.setItem('haven-text-color', c.value); }}
                style={{
                  padding: '6px 12px', borderRadius: '8px', fontSize: '12px', cursor: 'pointer',
                  background: textColor === c.value ? (c.value || 'var(--haven-accent)') : 'var(--haven-card)',
                  color: textColor === c.value ? (c.value ? '#000' : 'white') : (c.value || 'var(--haven-text-secondary)'),
                  border: `1px solid ${textColor === c.value ? (c.value || 'var(--haven-accent)') : 'var(--haven-border)'}`,
                }}
              >{c.label}</button>
            ))}
            <input
              type="color"
              value={textColor || '#e7e5e4'}
              onChange={(e) => { setTextColor(e.target.value); localStorage.setItem('haven-text-color', e.target.value); }}
              style={{ width: '28px', height: '28px', border: 'none', background: 'transparent', cursor: 'pointer' }}
              title="Custom color"
            />
          </div>
        </div>
        <div>
          <label style={labelStyle}>Wallpaper</label>
          <button
            onClick={() => setShowWallpaper(true)}
            style={{
              padding: '8px 16px', borderRadius: '8px',
              border: '1px solid var(--haven-border)', background: 'var(--haven-card)',
              color: 'var(--haven-text-secondary)', fontSize: '13px', cursor: 'pointer',
            }}
          >
            {wallpaper ? 'Change Wallpaper' : 'Choose Wallpaper'}
          </button>
        </div>
      </div>

      {/* Voice */}
      <div style={sectionStyle}>
        <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '16px' }}>Voice</h3>
        <div style={{ marginBottom: '12px' }}>
          <label style={labelStyle}>TTS Provider</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => { setTtsMode('browser'); saveTTSSettings({ mode: 'browser' }); }}
              style={{
                flex: 1, padding: '8px', borderRadius: '8px', fontSize: '12px', cursor: 'pointer',
                background: ttsMode === 'browser' ? 'var(--haven-accent)' : 'var(--haven-card)',
                color: ttsMode === 'browser' ? 'white' : 'var(--haven-text-secondary)',
                border: `1px solid ${ttsMode === 'browser' ? 'var(--haven-accent)' : 'var(--haven-border)'}`,
              }}
            >Browser</button>
            <button
              onClick={() => { setTtsMode('elevenlabs'); saveTTSSettings({ mode: 'elevenlabs' }); }}
              style={{
                flex: 1, padding: '8px', borderRadius: '8px', fontSize: '12px', cursor: 'pointer',
                background: ttsMode === 'elevenlabs' ? 'var(--haven-accent)' : 'var(--haven-card)',
                color: ttsMode === 'elevenlabs' ? 'white' : 'var(--haven-text-secondary)',
                border: `1px solid ${ttsMode === 'elevenlabs' ? 'var(--haven-accent)' : 'var(--haven-border)'}`,
              }}
            >ElevenLabs</button>
          </div>
        </div>

        {ttsMode === 'browser' && (
          <div style={{ marginBottom: '12px' }}>
            <label style={labelStyle}>Voice</label>
            <select
              value={browserVoice}
              onChange={(e) => { setBrowserVoice(e.target.value); saveTTSSettings({ browserVoice: e.target.value }); }}
              style={{ ...inputStyle, fontSize: '12px' }}
            >
              <option value="">Default</option>
              {voices.map(v => (
                <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>
              ))}
            </select>
            <button
              onClick={() => {
                if (typeof speechSynthesis === 'undefined') return;
                const u = new SpeechSynthesisUtterance('Hello, this is how I sound.');
                const match = voices.find(v => v.name === browserVoice);
                if (match) u.voice = match;
                speechSynthesis.speak(u);
              }}
              style={{ marginTop: '6px', padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--haven-border)', background: 'var(--haven-card)', color: 'var(--haven-text-secondary)', fontSize: '11px', cursor: 'pointer' }}
            >Test voice</button>
          </div>
        )}

        {ttsMode === 'elevenlabs' && (
          <>
            <div style={{ marginBottom: '12px' }}>
              <label style={labelStyle}>
                ElevenLabs API Key{' '}
                <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--haven-accent)', textDecoration: 'none' }}>(get one)</a>
              </label>
              <input
                type="password"
                value={elevenKey}
                onChange={(e) => setElevenKey(e.target.value)}
                placeholder="xi_..."
                style={{ ...inputStyle, fontFamily: 'monospace', fontSize: '12px' }}
              />
            </div>
            <div style={{ marginBottom: '12px' }}>
              <label style={labelStyle}>
                Voice ID{' '}
                <a href="https://elevenlabs.io/app/voice-lab" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--haven-accent)', textDecoration: 'none' }}>(find yours)</a>
              </label>
              <input
                type="text"
                value={elevenVoiceId}
                onChange={(e) => setElevenVoiceId(e.target.value)}
                placeholder="Voice ID from ElevenLabs"
                style={{ ...inputStyle, fontFamily: 'monospace', fontSize: '12px' }}
              />
            </div>
            <button
              onClick={saveVoice}
              disabled={voiceSaving}
              style={btnStyle}
            >{voiceSaving ? 'Saving...' : 'Save'}</button>
            {voiceMsg && <span style={{ fontSize: '12px', color: voiceMsg === 'Saved' ? '#4ade80' : '#f87171', marginLeft: '8px' }}>{voiceMsg}</span>}
            <p style={{ fontSize: '11px', color: 'var(--haven-text-muted)', marginTop: '8px' }}>
              Clone a voice in ElevenLabs Voice Lab, copy the Voice ID, paste it here. Your companion speaks with that voice.
            </p>
          </>
        )}
      </div>

      {/* Identity */}
      <div style={sectionStyle}>
        <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '16px' }}>Identity</h3>
        {idLoading ? (
          <p style={{ color: 'var(--haven-text-muted)', fontSize: '13px' }}>Loading...</p>
        ) : (
          <>
            {identities.map((id) => (
              <div key={id.id} style={{
                display: 'flex', alignItems: 'flex-start', gap: '8px',
                padding: '10px', background: 'var(--haven-card)', borderRadius: '8px',
                marginBottom: '8px', border: '1px solid var(--haven-border)',
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', marginBottom: '4px' }}>
                    {typeBadge(id.identity_type)}
                    {id.pinned && <span style={{ fontSize: '10px', marginLeft: '4px' }}>📌</span>}
                  </div>
                  <p style={{ fontSize: '13px', color: 'var(--haven-text)', lineHeight: '1.4', margin: 0 }}>{id.content}</p>
                </div>
                <button
                  onClick={() => handleDeleteIdentity(id.id)}
                  style={{
                    background: 'transparent', border: 'none', color: 'var(--haven-text-muted)',
                    cursor: 'pointer', fontSize: '16px', padding: '2px', flexShrink: 0,
                  }}
                >x</button>
              </div>
            ))}

            {/* Add new */}
            <div style={{ marginTop: '12px' }}>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                <select
                  value={newType}
                  onChange={(e) => setNewType(e.target.value)}
                  style={{
                    padding: '8px', borderRadius: '8px',
                    background: 'var(--haven-card)', border: '1px solid var(--haven-border)',
                    color: 'var(--haven-text)', fontSize: '12px', outline: 'none',
                  }}
                >
                  <option value="backstory">Identity / Personality</option>
                  <option value="dynamic">Traits</option>
                  <option value="anchor">Core Rule</option>
                  <option value="voice">Voice / Speech Pattern</option>
                  <option value="trait">Trait</option>
                  <option value="boundary">Boundary</option>
                  <option value="value">Value</option>
                </select>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="text"
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  placeholder="Add identity fragment..."
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddIdentity(); }}
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button onClick={handleAddIdentity} style={btnStyle}>Add</button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Import */}
      <div style={sectionStyle}>
        <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '8px' }}>Import Conversations</h3>
        <p style={{ fontSize: '12px', color: 'var(--haven-text-muted)', marginBottom: '12px' }}>
          Bring conversations from ChatGPT, Claude, SillyTavern, or another Haven instance.
        </p>
        <button
          onClick={onImport}
          style={{
            width: '100%', padding: '10px', borderRadius: '8px',
            border: '1px solid var(--haven-border)', background: 'var(--haven-card)',
            color: 'var(--haven-text)', fontSize: '13px', cursor: 'pointer',
          }}
        >
          Import from JSON
        </button>
      </div>

      {/* Storage */}
      <div style={sectionStyle}>
        <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '16px' }}>Storage</h3>
        {storage?.chat && storage?.project ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: '13px', color: 'var(--haven-text)' }}>Chat Uploads</div>
                <div style={{ fontSize: '11px', color: 'var(--haven-text-muted)' }}>
                  {storage.chat.count} file{storage.chat.count !== 1 ? 's' : ''} — {storage.chat.bytes < 1024 * 1024 ? `${Math.round(storage.chat.bytes / 1024)} KB` : `${(storage.chat.bytes / (1024 * 1024)).toFixed(1)} MB`}
                </div>
              </div>
              {storage.chat.count > 0 && (
                <button
                  onClick={async () => {
                    if (!confirm('Delete all uploaded images/files from chat? Messages stay, but embedded images will break.')) return;
                    setClearingStorage(true);
                    try {
                      await clearChatFiles();
                      setStorage(prev => prev ? { ...prev, chat: { count: 0, bytes: 0 } } : prev);
                    } catch {}
                    setClearingStorage(false);
                  }}
                  disabled={clearingStorage}
                  style={{
                    padding: '6px 12px', borderRadius: '6px',
                    border: '1px solid #7f1d1d', background: 'transparent',
                    color: '#f87171', fontSize: '11px', cursor: 'pointer',
                  }}
                >{clearingStorage ? 'Clearing...' : 'Clear'}</button>
              )}
            </div>
            <div>
              <div style={{ fontSize: '13px', color: 'var(--haven-text)' }}>Project Files</div>
              <div style={{ fontSize: '11px', color: 'var(--haven-text-muted)' }}>
                {storage.project.count} file{storage.project.count !== 1 ? 's' : ''} — {storage.project.bytes < 1024 * 1024 ? `${Math.round(storage.project.bytes / 1024)} KB` : `${(storage.project.bytes / (1024 * 1024)).toFixed(1)} MB`}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: '12px', color: 'var(--haven-text-muted)' }}>—</div>
        )}
      </div>

      {/* Data & Export */}
      <div style={sectionStyle}>
        <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '16px' }}>Data & Export</h3>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
          <a
            href={`${apiBase()}/api/export/all`}
            download
            style={{
              flex: 1, padding: '10px', borderRadius: '8px', textAlign: 'center',
              background: 'var(--haven-card)', border: '1px solid var(--haven-border)',
              color: 'var(--haven-text-secondary)', fontSize: '13px', textDecoration: 'none',
            }}
          >
            Export Everything
          </a>
          <button
            onClick={() => { localStorage.clear(); window.location.reload(); }}
            style={{
              flex: 1, padding: '10px', borderRadius: '8px',
              border: '1px solid #7f1d1d', background: 'transparent',
              color: '#f87171', fontSize: '13px', cursor: 'pointer',
            }}
          >
            Clear Cache
          </button>
        </div>
        <p style={{ fontSize: '11px', color: 'var(--haven-text-muted)', margin: 0 }}>
          Export downloads all threads, messages, memories, identity, and people as JSON.
        </p>
      </div>

      {/* App Info */}
      <div style={sectionStyle}>
        <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '8px' }}>About</h3>
        <p style={{ fontSize: '13px', color: 'var(--haven-text-secondary)', margin: '0 0 4px' }}>Haven v1.0.0</p>
        <p style={{ fontSize: '12px', color: 'var(--haven-text-muted)', margin: 0 }}>Haven — self-hosted companion chat</p>
      </div>

      {/* Bottom spacing */}
      <div style={{ height: '40px' }} />

      {/* Wallpaper picker */}
      {showWallpaper && (
        <WallpaperPicker
          current={wallpaper}
          onSelect={handleWallpaperChange}
          onClose={() => setShowWallpaper(false)}
        />
      )}
    </div>
  );
}

// ============================================================
// Security Section
// ============================================================

function SecuritySection({ sectionStyle, btnStyle }: { sectionStyle: React.CSSProperties; btnStyle: React.CSSProperties }) {
  const [secured, setSecured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  useEffect(() => {
    getAuthStatus().then(s => setSecured(s.secured)).catch(() => setSecured(null));
  }, []);

  if (secured === null) return null;

  const token = getAuthToken();
  const masked = token ? `${token.slice(0, 8)}...${token.slice(-8)}` : '';

  const handleSecure = async () => {
    setBusy(true);
    try {
      const { token: t } = await generateAuthToken();
      saveAuthToken(t);
      setSecured(true);
    } catch { /* banner handles this */ }
    setBusy(false);
  };

  const handleRegenerate = async () => {
    setBusy(true);
    try {
      const { token: t } = await generateAuthToken();
      saveAuthToken(t);
    } catch { /* */ }
    setBusy(false);
  };

  const handleCopy = () => {
    if (token) navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRevoke = async () => {
    setBusy(true);
    try {
      await revokeAuthToken();
      clearAuthToken();
      setSecured(false);
      setConfirmRevoke(false);
    } catch { /* */ }
    setBusy(false);
  };

  return (
    <div style={sectionStyle}>
      <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '8px' }}>Security</h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: secured ? '#22c55e' : '#ef4444',
          display: 'inline-block', flexShrink: 0,
        }} />
        <span style={{ fontSize: '13px', color: 'var(--haven-text-secondary)' }}>
          {secured ? 'Secured with auth token' : 'Unsecured — anyone with your Worker URL can access your data'}
        </span>
      </div>

      {!secured && (
        <button onClick={handleSecure} disabled={busy} style={{ ...btnStyle, background: 'var(--haven-accent)', color: 'white', border: 'none' }}>
          {busy ? 'Securing...' : 'Secure Haven'}
        </button>
      )}

      {secured && token && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <code style={{
              fontSize: '12px', color: 'var(--haven-text-muted)',
              background: 'var(--haven-card)', padding: '4px 8px', borderRadius: 4,
              cursor: 'pointer',
            }} onClick={() => setShowToken(!showToken)}>
              {showToken ? token : masked}
            </code>
            <button onClick={handleCopy} style={{ ...btnStyle, fontSize: '12px', padding: '4px 10px' }}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={handleRegenerate} disabled={busy} style={btnStyle}>
              {busy ? 'Regenerating...' : 'Regenerate key'}
            </button>
            {!confirmRevoke ? (
              <button onClick={() => setConfirmRevoke(true)} style={{ ...btnStyle, color: '#ef4444', borderColor: '#ef4444' }}>
                Remove security
              </button>
            ) : (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: '12px', color: '#ef4444' }}>Are you sure?</span>
                <button onClick={handleRevoke} disabled={busy} style={{ ...btnStyle, color: '#ef4444', borderColor: '#ef4444' }}>Yes, remove</button>
                <button onClick={() => setConfirmRevoke(false)} style={btnStyle}>Cancel</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// MCP Servers Section
// ============================================================

function McpServersSection({ apiUrl }: { apiUrl: string }) {
  const [servers, setServers] = useState<Array<{ id: number; name: string; url: string; enabled: number; last_discovered: string | null }>>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [adding, setAdding] = useState(false);
  const [discovering, setDiscovering] = useState<number | null>(null);
  const [toolCount, setToolCount] = useState<Record<number, number>>({});
  const [discoverError, setDiscoverError] = useState<Record<number, string>>({});
  const [expanded, setExpanded] = useState(false);

  const authHeaders = (): Record<string, string> => {
    const t = getAuthToken();
    return t ? { 'Authorization': `Bearer ${t}` } : {};
  };

  const loadServers = async () => {
    try {
      const resp = await fetch(`${apiUrl}/api/mcp-servers`, { headers: authHeaders() });
      if (resp.ok) setServers(await resp.json());
    } catch {}
  };

  useEffect(() => { loadServers(); }, []);

  const handleAdd = async () => {
    if (!name.trim() || !url.trim()) return;
    setAdding(true);
    try {
      await fetch(`${apiUrl}/api/mcp-servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ name: name.trim(), url: url.trim(), api_key: key.trim() || null }),
      });
      setName(''); setUrl(''); setKey('');
      loadServers();
    } catch {} finally { setAdding(false); }
  };

  const handleDelete = async (id: number) => {
    await fetch(`${apiUrl}/api/mcp-servers/${id}`, { method: 'DELETE', headers: authHeaders() });
    loadServers();
  };

  const handleToggle = async (id: number) => {
    await fetch(`${apiUrl}/api/mcp-servers/${id}/toggle`, { method: 'PUT', headers: authHeaders() });
    loadServers();
  };

  const handleDiscover = async (id: number) => {
    setDiscovering(id);
    setDiscoverError(prev => { const n = { ...prev }; delete n[id]; return n; });
    try {
      const resp = await fetch(`${apiUrl}/api/mcp-servers/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ id }),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) {
        setToolCount(prev => ({ ...prev, [id]: data.tools?.length || 0 }));
        if ((data.tools?.length || 0) === 0) {
          setDiscoverError(prev => ({ ...prev, [id]: 'Connected, but server reported zero tools.' }));
        }
      } else {
        setDiscoverError(prev => ({ ...prev, [id]: data.error || `Discovery failed (HTTP ${resp.status})` }));
      }
    } catch (e) {
      setDiscoverError(prev => ({ ...prev, [id]: e instanceof Error ? e.message : 'Network error' }));
    } finally { setDiscovering(null); }
  };

  const sectionStyle = { marginBottom: '24px', padding: '16px', background: 'var(--haven-card)', borderRadius: '12px', border: '1px solid var(--haven-border)' };
  const inputStyle: React.CSSProperties = { width: '100%', padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--haven-border)', background: 'var(--haven-surface)', color: 'var(--haven-text)', fontSize: '13px', outline: 'none' };

  return (
    <div style={sectionStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: expanded ? '12px' : 0 }}>
        <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--haven-text)', margin: 0 }}>
          MCP Servers {servers.length > 0 && <span style={{ fontSize: '11px', color: 'var(--haven-text-muted)', fontWeight: 400 }}>({servers.filter(s => s.enabled).length} active)</span>}
        </h3>
        <button onClick={() => setExpanded(!expanded)} style={{ background: 'none', border: 'none', color: 'var(--haven-text-muted)', cursor: 'pointer', fontSize: '12px' }}>
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>

      {expanded && (
        <>
          <p style={{ fontSize: '11px', color: 'var(--haven-text-muted)', marginBottom: '12px', lineHeight: '1.4' }}>
            Connect Cloudflare Workers with /mcp endpoints. Your companion gets their tools automatically.
          </p>

          {/* Existing servers */}
          {servers.map(s => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', padding: '8px 10px', background: 'var(--haven-surface)', borderRadius: '8px', border: '1px solid var(--haven-border)' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: s.enabled ? '#4ade80' : '#6b7280', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13px', color: 'var(--haven-text)', fontWeight: 500 }}>{s.name}</div>
                <div style={{ fontSize: '10px', color: 'var(--haven-text-muted)', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.url}</div>
                {toolCount[s.id] !== undefined && !discoverError[s.id] && (
                  <div style={{ fontSize: '10px', color: '#4ade80' }}>{toolCount[s.id]} tools discovered</div>
                )}
                {discoverError[s.id] && (
                  <div style={{ fontSize: '10px', color: '#f87171', wordBreak: 'break-word' }}>{discoverError[s.id]}</div>
                )}
              </div>
              <button onClick={() => handleDiscover(s.id)} disabled={discovering === s.id} style={{ background: 'none', border: '1px solid var(--haven-border)', borderRadius: '6px', padding: '3px 8px', fontSize: '10px', color: 'var(--haven-text-muted)', cursor: 'pointer' }}>
                {discovering === s.id ? '...' : 'Test'}
              </button>
              <button onClick={() => handleToggle(s.id)} style={{ background: 'none', border: 'none', color: s.enabled ? '#4ade80' : '#6b7280', cursor: 'pointer', fontSize: '11px' }}>
                {s.enabled ? 'ON' : 'OFF'}
              </button>
              <button onClick={() => handleDelete(s.id)} style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: '14px' }}>
                ×
              </button>
            </div>
          ))}

          {/* Add new */}
          <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" style={{ ...inputStyle, flex: 1 }} />
              <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://worker.dev/mcp" style={{ ...inputStyle, flex: 2, fontFamily: 'monospace' }} />
            </div>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder="API key (optional)" style={{ ...inputStyle, flex: 1 }} />
              <button onClick={handleAdd} disabled={adding || !name.trim() || !url.trim()} style={{ padding: '8px 16px', borderRadius: '8px', border: 'none', background: 'var(--haven-accent)', color: 'white', fontSize: '12px', fontWeight: 600, cursor: 'pointer', opacity: (!name.trim() || !url.trim()) ? 0.5 : 1, whiteSpace: 'nowrap' }}>
                {adding ? '...' : '+ Add'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
