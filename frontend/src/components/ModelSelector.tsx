import { useState, useEffect, useRef } from 'react';
import type { ModelInfo } from '../lib/types';
import { getModels } from '../lib/api';

interface ModelSelectorProps {
  selectedModel: string;
  selectedProvider: string;
  onModelChange: (model: string, provider: string) => void;
}

const LS_FAVS = 'haven-fav-models';
const LS_FILTER = 'haven-model-filter';

// Provider origin emojis — quick visual tag for "where did this model come
// from" so users don't confuse e.g. `MiniMaxAI/MiniMax-M2` (HuggingFace) with
// `minimax-m2` (Ollama Cloud). Mirrors Nexus's picker conventions.
const PROVIDER_EMOJI: Record<string, string> = {
  ollama: '🦙',
  openrouter: '🔀',
  huggingface: '🤗',
  openai: '🧠',
  anthropic: '🎭',
  groq: '⚡',
  xai: '🌀',
  custom: '🛠️',
};

function getFavorites(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(LS_FAVS) || '[]'));
  } catch { return new Set(); }
}

function saveFavorites(favs: Set<string>) {
  localStorage.setItem(LS_FAVS, JSON.stringify([...favs]));
}

function tierBadge(tier: string) {
  const labels: Record<string, string> = { included: 'cloud', local: 'local' };
  const colors: Record<string, { bg: string; text: string }> = {
    free: { bg: '#16a34a22', text: '#4ade80' },
    paid: { bg: '#d4748a22', text: '#E8A4B8' },
    cloud: { bg: '#8b5cf622', text: '#a78bfa' },
    included: { bg: '#8b5cf622', text: '#a78bfa' },
    local: { bg: '#3b82f622', text: '#60a5fa' },
  };
  const c = colors[tier] || colors.paid;
  const label = labels[tier] || tier;
  return (
    <span style={{
      fontSize: '9px', fontWeight: 600, textTransform: 'uppercase',
      background: c.bg, color: c.text, borderRadius: '4px', padding: '1px 5px',
      marginLeft: '6px', flexShrink: 0,
    }}>{label}</span>
  );
}

type Filter = 'all' | 'free' | 'cloud' | 'paid';

export default function ModelSelector({ selectedModel, selectedProvider, onModelChange }: ModelSelectorProps) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [open, setOpen] = useState(false);
  const [hoveredModel, setHoveredModel] = useState<ModelInfo | null>(null);
  const [favorites, setFavorites] = useState<Set<string>>(getFavorites);
  const [filter, setFilter] = useState<Filter>(() => (localStorage.getItem(LS_FILTER) as Filter) || 'all');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getModels()
      .then((m) => { setModels(m); setLoadState('ready'); })
      .catch((e) => { console.warn('[models] load failed', e); setLoadState('error'); });
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggleFav = (e: React.MouseEvent, modelKey: string) => {
    e.stopPropagation();
    const next = new Set(favorites);
    if (next.has(modelKey)) next.delete(modelKey);
    else next.add(modelKey);
    setFavorites(next);
    saveFavorites(next);
  };

  const setFilterAndSave = (f: Filter) => {
    setFilter(f);
    localStorage.setItem(LS_FILTER, f);
  };

  const modelKey = (m: ModelInfo) => `${m.provider}:${m.id}`;

  const matchesFilter = (m: ModelInfo) => {
    if (filter === 'all') return true;
    if (filter === 'free') return m.tier === 'free';
    if (filter === 'cloud') return m.tier === 'included' || m.provider === 'ollama';
    if (filter === 'paid') return m.tier === 'paid';
    return true;
  };

  const filtered = models.filter(matchesFilter);
  const favModels = filtered.filter(m => favorites.has(modelKey(m)));
  const otherModels = filtered.filter(m => !favorites.has(modelKey(m)));

  const grouped: Record<string, ModelInfo[]> = {};
  for (const m of otherModels) {
    (grouped[m.provider] ??= []).push(m);
  }

  const current = models.find((m) => m.id === selectedModel && m.provider === selectedProvider);
  const displayName = current?.name || selectedModel || 'Select model';

  const renderModel = (m: ModelInfo) => {
    const key = modelKey(m);
    const isFav = favorites.has(key);
    return (
      <div key={key} style={{ position: 'relative' }}>
        <button
          onClick={() => { onModelChange(m.id, m.provider); setOpen(false); setHoveredModel(null); }}
          onMouseEnter={(e) => {
            if (m.id !== selectedModel) e.currentTarget.style.background = 'var(--haven-card)';
            if (m.description || m.context_length) setHoveredModel(m);
          }}
          onMouseLeave={(e) => {
            if (m.id !== selectedModel || m.provider !== selectedProvider) e.currentTarget.style.background = 'transparent';
            setHoveredModel(null);
          }}
          style={{
            display: 'flex', alignItems: 'center', width: '100%',
            padding: '6px 12px', background: (m.id === selectedModel && m.provider === selectedProvider) ? 'var(--haven-card)' : 'transparent',
            border: 'none', color: 'var(--haven-text)', fontSize: '12px',
            cursor: 'pointer', textAlign: 'left', gap: '4px',
          }}
        >
          <span
            onClick={(e) => toggleFav(e, key)}
            style={{
              cursor: 'pointer', fontSize: '12px', flexShrink: 0,
              color: isFav ? '#facc15' : 'var(--haven-border)',
              transition: 'color 0.15s',
            }}
          >{isFav ? '\u2605' : '\u2606'}</span>
          <span
            title={m.provider}
            style={{ fontSize: '12px', flexShrink: 0, lineHeight: 1 }}
          >{PROVIDER_EMOJI[m.provider] || '❓'}</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{m.name}</span>
          {/* Tool-capable badge — only shown when the backend confirmed
              support. Unknown (undefined) stays silent to avoid false
              warnings on custom providers. */}
          {m.supports_tools === true && (
            <span
              title="Supports function calling / MCP tools"
              style={{
                fontSize: '10px', padding: '1px 5px', borderRadius: '4px',
                background: 'var(--haven-card)', color: 'var(--haven-accent)',
                border: '1px solid var(--haven-border)', flexShrink: 0,
              }}
            >🔧</span>
          )}
          {m.supports_tools === false && (
            <span
              title="Does NOT support function calling — tools won't fire"
              style={{
                fontSize: '10px', padding: '1px 5px', borderRadius: '4px',
                background: 'transparent', color: 'var(--haven-text-muted)',
                border: '1px dashed var(--haven-border)', flexShrink: 0,
                opacity: 0.6,
              }}
            >no 🔧</span>
          )}
          {tierBadge(m.tier)}
        </button>
        {hoveredModel?.id === m.id && hoveredModel?.provider === m.provider && (
          <div style={{
            position: 'absolute', right: '100%', top: 0, marginRight: '8px',
            background: 'var(--haven-bg)', border: '1px solid var(--haven-border)',
            borderRadius: '8px', padding: '10px 12px', width: '220px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)', zIndex: 110,
            pointerEvents: 'none',
          }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '4px' }}>{m.name}</div>
            {m.context_length && (
              <div style={{ fontSize: '10px', color: 'var(--haven-accent)', marginBottom: '4px' }}>
                {m.context_length >= 1000000
                  ? `${(m.context_length / 1000000).toFixed(1)}M context`
                  : `${Math.round(m.context_length / 1000)}K context`}
              </div>
            )}
            {m.description && (
              <div style={{ fontSize: '10px', color: 'var(--haven-text-muted)', lineHeight: '1.4', maxHeight: '80px', overflow: 'hidden' }}>
                {m.description.length > 200 ? m.description.slice(0, 200) + '...' : m.description}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const filterBtn = (f: Filter, label: string) => (
    <button
      onClick={() => setFilterAndSave(f)}
      style={{
        padding: '3px 8px', borderRadius: '6px', border: 'none', fontSize: '10px',
        fontWeight: 600, cursor: 'pointer',
        background: filter === f ? 'var(--haven-accent)' : 'var(--haven-card)',
        color: filter === f ? 'white' : 'var(--haven-text-muted)',
      }}
    >{label}</button>
  );

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: '4px',
          background: 'var(--haven-card)', border: '1px solid var(--haven-border)',
          borderRadius: '8px', padding: '4px 10px', fontSize: '11px',
          color: 'var(--haven-text-secondary)', cursor: 'pointer',
          maxWidth: '160px', overflow: 'hidden', whiteSpace: 'nowrap',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayName}</span>
        <svg width="10" height="10" viewBox="0 0 20 20" fill="currentColor" style={{ flexShrink: 0 }}>
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>

      {open && (
        <div
          className="hide-scrollbar"
          style={{
            position: 'absolute', top: '100%', right: 0, marginTop: '4px',
            background: 'var(--haven-surface)', border: '1px solid var(--haven-border)',
            borderRadius: '10px', width: '260px', maxHeight: '350px', overflowY: 'scroll',
            zIndex: 100, boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            WebkitOverflowScrolling: 'touch' as any, touchAction: 'pan-y',
            overscrollBehavior: 'contain',
          }}
        >
          {/* Filter tabs */}
          <div style={{
            display: 'flex', gap: '4px', padding: '8px 10px',
            borderBottom: '1px solid var(--haven-border)',
            position: 'sticky', top: 0, background: 'var(--haven-surface)', zIndex: 1,
          }}>
            {filterBtn('all', 'All')}
            {filterBtn('free', 'Free')}
            {filterBtn('cloud', 'Cloud')}
            {filterBtn('paid', 'Paid')}
          </div>

          {/* Favorites */}
          {favModels.length > 0 && (
            <div>
              <div style={{
                padding: '8px 12px 4px', fontSize: '10px', fontWeight: 600,
                color: '#facc15', textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>{'\u2605'} Favorites</div>
              {favModels.map(renderModel)}
            </div>
          )}

          {/* Grouped by provider */}
          {Object.entries(grouped).map(([provider, providerModels]) => (
            <div key={provider}>
              <div style={{
                padding: '8px 12px 4px', fontSize: '10px', fontWeight: 600,
                color: 'var(--haven-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em',
                display: 'flex', alignItems: 'center', gap: '6px',
              }}>
                <span style={{ fontSize: '12px', textTransform: 'none' }}>{PROVIDER_EMOJI[provider] || '❓'}</span>
                <span>{provider}</span>
              </div>
              {providerModels.map(renderModel)}
            </div>
          ))}

          {filtered.length === 0 && (
            <div style={{ padding: '16px', textAlign: 'center', color: loadState === 'error' ? '#f87171' : 'var(--haven-text-muted)', fontSize: '12px' }}>
              {loadState === 'loading' ? 'Loading models…'
                : loadState === 'error' ? 'Could not load models. Check your connection or API keys in Settings.'
                : models.length === 0 ? 'No models available. Add an API key in Settings.'
                : 'No models match this filter'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
