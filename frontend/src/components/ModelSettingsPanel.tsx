import { useState, useEffect, useRef, useCallback } from 'react';
import type { ModelInfo } from '../lib/types';
import { apiBase, authedFetch } from '../lib/api';

export interface ModelSettings {
  temperature?: number;
  notes?: string;
  systemPromptAddition?: string;
}

interface Props {
  provider: string;
  modelId: string;
  modelName: string;
  model?: ModelInfo | null;
  onClose: () => void;
}

const PROVIDER_EMOJI: Record<string, string> = {
  ollama: '\u{1F999}', openrouter: '\u{1F500}', huggingface: '\u{1F917}',
  openai: '\u{1F9E0}', anthropic: '\u{1F3AD}', groq: '\u{26A1}', xai: '\u{1F300}', custom: '\u{1F6E0}',
};

async function fetchSettings(provider: string, modelId: string): Promise<ModelSettings> {
  try {
    const res = await authedFetch(`${apiBase()}/api/model-settings?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(modelId)}`);
    if (!res.ok) return {};
    return await res.json();
  } catch { return {}; }
}

async function saveSettings(provider: string, modelId: string, settings: ModelSettings): Promise<void> {
  try {
    await authedFetch(`${apiBase()}/api/model-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model: modelId, settings }),
    });
  } catch {}
}

export default function ModelSettingsPanel({ provider, modelId, modelName, model, onClose }: Props) {
  const [settings, setSettings] = useState<ModelSettings>({});
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetchSettings(provider, modelId).then(s => { setSettings(s); setLoaded(true); });
  }, [provider, modelId]);

  const update = useCallback((patch: Partial<ModelSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => saveSettings(provider, modelId, next), 500);
      return next;
    });
  }, [provider, modelId]);

  useEffect(() => {
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, []);

  const emoji = PROVIDER_EMOJI[provider] || '\u{1F6E0}\u{FE0F}';

  const overlayStyle: React.CSSProperties = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
    backdropFilter: 'blur(4px)', zIndex: 200,
  };

  const panelStyle: React.CSSProperties = {
    position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 201,
    maxHeight: '85vh', overflowY: 'auto',
    background: 'var(--haven-bg, #1a1a2e)', borderRadius: '16px 16px 0 0',
    boxShadow: '0 -8px 32px rgba(0,0,0,0.5)',
  };

  const cardStyle: React.CSSProperties = {
    background: 'var(--haven-card, #262640)', borderRadius: '12px',
    padding: '16px', marginBottom: '12px',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '12px', color: 'var(--haven-text-secondary, #888)',
    display: 'block', marginBottom: '8px',
  };

  const textareaStyle: React.CSSProperties = {
    width: '100%', background: 'var(--haven-surface, #1e1e36)', borderRadius: '8px',
    padding: '10px 12px', fontSize: '14px', color: 'var(--haven-text, #eee)',
    outline: 'none', border: '1px solid var(--haven-border, #333)',
    resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box',
  };

  const pillStyle = (color: string): React.CSSProperties => ({
    fontSize: '9px', fontWeight: 600, padding: '2px 6px', borderRadius: '6px',
    background: `${color}22`, color, border: `1px solid ${color}44`,
    whiteSpace: 'nowrap',
  });

  if (!loaded) return null;

  return (
    <>
      <div style={overlayStyle} onClick={onClose} />
      <div style={panelStyle}>
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: '12px', paddingBottom: '4px' }}>
          <div style={{ width: '40px', height: '4px', borderRadius: '2px', background: 'var(--haven-border, #333)' }} />
        </div>

        <div style={{ padding: '0 16px 24px' }}>
          {/* Header */}
          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{
                width: '40px', height: '40px', borderRadius: '12px',
                background: 'var(--haven-surface, #1e1e36)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px',
              }}>{emoji}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--haven-text, #eee)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{modelName}</div>
                <div style={{ fontSize: '10px', color: 'var(--haven-text-secondary, #888)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{provider} · {modelId}</div>
                {model && (
                  <div style={{ display: 'flex', gap: '4px', marginTop: '6px', flexWrap: 'wrap' }}>
                    {model.supports_tools === true && <span style={pillStyle('#8b5cf6')}>🔧 Tools</span>}
                    {/* Three honest states. A missing pill used to mean either
                        "can't see" or "never checked", which is why a dead
                        vision fallback went unnoticed for months. */}
                    {model.supports_vision === true && <span style={pillStyle('#3b82f6')}>👁 Vision</span>}
                    {model.supports_vision === false && <span style={pillStyle('#6b7280')}>🚫 No vision</span>}
                    {model.supports_thinking === true && <span style={pillStyle('#f59e0b')}>🧠 Thinking</span>}
                    {model.context_length && <span style={pillStyle('#6b7280')}>{model.context_length >= 1000000 ? `${(model.context_length / 1000000).toFixed(1)}M` : `${Math.round(model.context_length / 1000)}k`} ctx</span>}
                  </div>
                )}
              </div>
              <button
                onClick={onClose}
                style={{
                  width: '32px', height: '32px', borderRadius: '8px',
                  background: 'var(--haven-surface, #1e1e36)', border: 'none',
                  color: 'var(--haven-text-secondary, #888)', cursor: 'pointer', fontSize: '14px',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >{'\u2715'}</button>
            </div>
          </div>

          {/* Temperature */}
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <span style={labelStyle}>Temperature</span>
              <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--haven-text, #eee)' }}>
                {(settings.temperature ?? 0.8).toFixed(1)}
              </span>
            </div>
            <input
              type="range" min={0} max={2} step={0.1}
              value={settings.temperature ?? 0.8}
              onChange={e => update({ temperature: parseFloat(e.target.value) })}
              style={{ width: '100%', accentColor: 'var(--haven-accent, #7c3aed)' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
              <span style={{ fontSize: '10px', color: 'var(--haven-text-secondary, #888)' }}>Precise</span>
              <span style={{ fontSize: '10px', color: 'var(--haven-text-secondary, #888)' }}>Creative</span>
            </div>
          </div>

          {/* Notes */}
          <div style={cardStyle}>
            <label style={labelStyle}>Notes</label>
            <textarea
              placeholder="What's this model good at? When do you use it?"
              value={settings.notes || ''}
              onChange={e => update({ notes: e.target.value || undefined })}
              rows={2}
              style={textareaStyle}
            />
          </div>

          {/* System prompt addition */}
          <div style={cardStyle}>
            <label style={{ ...labelStyle, marginBottom: '2px' }}>System prompt addition</label>
            <p style={{ fontSize: '10px', color: 'var(--haven-text-secondary, #888)', margin: '0 0 8px', lineHeight: '1.5' }}>
              Appended to the companion's system prompt when using this model.
            </p>
            <textarea
              placeholder="Use italics for action sentences and normal text for speech..."
              value={settings.systemPromptAddition || ''}
              onChange={e => update({ systemPromptAddition: e.target.value || undefined })}
              rows={4}
              style={textareaStyle}
            />
          </div>
        </div>
      </div>
    </>
  );
}
