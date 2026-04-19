import { useState, useEffect } from 'react';
import type { Identity } from '../lib/types';
import {
  getCompanion, updateCompanion,
  getSettings, updateSettings,
  getIdentity, addIdentity, deleteIdentity,
  uploadFile, getUserStatus, setUserStatus, apiBase,
} from '../lib/api';
import { getTTSSettings, saveTTSSettings, getBrowserVoices } from '../lib/tts';
import WallpaperPicker from '../components/WallpaperPicker';

interface SettingsProps {
  onImport?: () => void;
  onBack?: () => void;
}

export default function Settings({ onImport, onBack }: SettingsProps) {
  // Companion
  const [compName, setCompName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [compSaving, setCompSaving] = useState(false);
  const [compMsg, setCompMsg] = useState('');

  // API Key — one field, auto-detect provider
  const [apiKey, setApiKey] = useState('');
  const [apiSaving, setApiSaving] = useState(false);
  const [apiMsg, setApiMsg] = useState('');
  const [connectedProviders, setConnectedProviders] = useState<string[]>([]);

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

  // Voice / TTS
  const [ttsMode, setTtsMode] = useState<'browser' | 'elevenlabs'>(() => getTTSSettings().mode);
  const [browserVoice, setBrowserVoice] = useState(() => getTTSSettings().browserVoice);
  const [elevenKey, setElevenKey] = useState(() => getTTSSettings().elevenLabsKey);
  const [elevenVoiceId, setElevenVoiceId] = useState(() => getTTSSettings().elevenLabsVoiceId);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    const loadVoices = () => setVoices(getBrowserVoices());
    loadVoices();
    // Some Android WebView builds don't expose speechSynthesis; without this
    // guard, addEventListener throws in the effect and React 18 unmounts the
    // whole Settings component — that's the "black void" Settings bug.
    if (typeof speechSynthesis === 'undefined') return;
    speechSynthesis.addEventListener('voiceschanged', loadVoices);
    return () => speechSynthesis.removeEventListener('voiceschanged', loadVoices);
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

  useEffect(() => {
    getCompanion().then((c) => {
      setCompName(c.name);
      setAvatarUrl(c.avatar_url || '');
    }).catch((e) => console.warn('[settings] getCompanion failed', e));

    getSettings().then((s) => {
      setApiKey(s.openrouter_key || s.ollama_key || s.custom_key || s.ollama_url || '');
      // Track which providers have keys
      const connected: string[] = [];
      if (s.openrouter_key) connected.push('OpenRouter');
      if (s.ollama_key) connected.push('Ollama');
      if (s.custom_key) {
        // Detect provider from base URL, not the shared provider field
        const url = s.custom_base_url || '';
        if (url.includes('huggingface') || url.includes('hf.co')) connected.push('Hugging Face');
        else if (url.includes('groq.com')) connected.push('Groq');
        else if (url.includes('openai.com')) connected.push('OpenAI');
        else if (url.includes('anthropic.com')) connected.push('Anthropic');
        else if (url.includes('x.ai')) connected.push('xAI');
        else if (s.provider) connected.push(s.provider);
      }
      setConnectedProviders(connected);
    }).catch((e) => console.warn('[settings] getSettings failed', e));

    loadIdentities();

    getUserStatus().then((s) => {
      setUserStatusText(s.custom_status || '');
      setUserPresence(s.presence || 'online');
    }).catch((e) => console.warn('[settings] getUserStatus failed', e));
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
      // Auto-detect provider from key format
      // Only set fields for the detected provider — don't blank others
      const settings: Record<string, string> = {};
      const key = apiKey.trim();
      if (key.startsWith('http://') || key.startsWith('https://')) {
        // Reject anything that's not a valid http(s) URL (e.g. javascript:, file:)
        try { new URL(key); }
        catch { throw new Error('Invalid URL'); }
        settings.ollama_url = key;
        settings.provider = 'ollama';
      } else if (key.startsWith('hf_')) {
        settings.custom_key = key;
        settings.custom_base_url = 'https://router.huggingface.co/v1';
        settings.provider = 'huggingface';
      } else if (key.startsWith('sk-or-')) {
        settings.openrouter_key = key;
        settings.provider = 'openrouter';
      } else if (key.startsWith('gsk_')) {
        settings.custom_key = key;
        settings.custom_base_url = 'https://api.groq.com/openai/v1';
        settings.provider = 'groq';
      } else if (key.startsWith('sk-ant-')) {
        settings.custom_key = key;
        settings.custom_base_url = 'https://api.anthropic.com/v1';
        settings.provider = 'anthropic';
      } else if (key.startsWith('sk-') || key.startsWith('sk-proj-')) {
        settings.custom_key = key;
        settings.custom_base_url = 'https://api.openai.com/v1';
        settings.provider = 'openai';
      } else if (key.startsWith('xai-')) {
        settings.custom_key = key;
        settings.custom_base_url = 'https://api.x.ai/v1';
        settings.provider = 'xai';
      } else if (/^[a-f0-9]+\.[a-zA-Z0-9_-]+$/.test(key)) {
        settings.ollama_key = key;
        settings.provider = 'ollama';
      } else if (key) {
        // Default: treat as OpenAI-compatible key via OpenRouter
        settings.openrouter_key = key;
        settings.provider = 'openrouter';
      }
      await updateSettings(settings);
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
      height: '100%', overflowY: 'auto', padding: '20px',
      maxWidth: '600px', margin: '0 auto',
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
              <img src={avatarUrl} alt="avatar" style={{ width: '48px', height: '48px', borderRadius: '50%', objectFit: 'cover', border: '2px solid var(--haven-border)' }} />
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button onClick={saveCompanion} disabled={compSaving} style={btnStyle}>
            {compSaving ? 'Saving...' : 'Save'}
          </button>
          {compMsg && <span style={{ fontSize: '12px', color: compMsg === 'Saved' ? '#4ade80' : '#f87171' }}>{compMsg}</span>}
        </div>
      </div>

      {/* API Key */}
      <div style={sectionStyle}>
        <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '8px' }}>Connect</h3>
        {connectedProviders.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
            {connectedProviders.map(p => (
              <span key={p} style={{
                display: 'inline-flex', alignItems: 'center', gap: '5px',
                fontSize: '11px', color: '#4ade80',
                background: '#16a34a15', borderRadius: '6px', padding: '3px 8px',
              }}>
                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#4ade80', flexShrink: 0 }} />
                {p}
              </span>
            ))}
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
              if (k.startsWith('hf_')) return 'Hugging Face detected';
              if (k.startsWith('sk-or-')) return 'OpenRouter detected';
              if (k.startsWith('http')) return 'Local Ollama URL detected';
              if (k.startsWith('gsk_')) return 'Groq detected';
              if (k.startsWith('sk-ant-')) return 'Anthropic detected';
              if (k.startsWith('sk-')) return 'OpenAI detected';
              if (k.startsWith('xai-')) return 'xAI / Grok detected';
              if (/^[a-f0-9]+\.[a-zA-Z0-9_-]+$/.test(k)) return 'Ollama Cloud detected';
              if (k) return 'Will route through OpenRouter';
              return 'Supports: OpenRouter, Ollama, OpenAI, Anthropic, Groq, xAI, or any local URL';
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

  const loadServers = async () => {
    try {
      const resp = await fetch(`${apiUrl}/api/mcp-servers`);
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), url: url.trim(), api_key: key.trim() || null }),
      });
      setName(''); setUrl(''); setKey('');
      loadServers();
    } catch {} finally { setAdding(false); }
  };

  const handleDelete = async (id: number) => {
    await fetch(`${apiUrl}/api/mcp-servers/${id}`, { method: 'DELETE' });
    loadServers();
  };

  const handleToggle = async (id: number) => {
    await fetch(`${apiUrl}/api/mcp-servers/${id}/toggle`, { method: 'PUT' });
    loadServers();
  };

  const handleDiscover = async (id: number) => {
    setDiscovering(id);
    setDiscoverError(prev => { const n = { ...prev }; delete n[id]; return n; });
    try {
      const resp = await fetch(`${apiUrl}/api/mcp-servers/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
