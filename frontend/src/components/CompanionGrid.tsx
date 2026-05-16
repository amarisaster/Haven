import { useEffect, useState } from 'react';
import type { Companion } from '../lib/types';
import { listCompanions, setActiveCompanionId, activeCompanionId } from '../lib/api';
import AuthMedia from './AuthMedia';

interface CompanionGridProps {
  onOpenCompanion: (companionId: number) => void;
  onAddCompanion: () => void;
  onOpenSettings: () => void;
}

// Home screen for v1.7 multi-companion. Shows each non-archived companion as
// a tile. Tapping a tile sets it as the active companion (localStorage +
// X-Companion-Id on all subsequent requests) and navigates into their thread
// list. Last tile is always "+ Add Companion".
export default function CompanionGrid({ onOpenCompanion, onAddCompanion, onOpenSettings }: CompanionGridProps) {
  const [companions, setCompanions] = useState<Companion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listCompanions()
      .then(rows => {
        if (!active) return;
        setCompanions(Array.isArray(rows) ? rows : []);
        setLoading(false);
      })
      .catch(e => {
        if (!active) return;
        setError(e instanceof Error ? e.message : 'Failed to load companions');
        setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const pickCompanion = (id: number) => {
    setActiveCompanionId(id);
    onOpenCompanion(id);
  };

  // Soft cap warning at 10 — the chat prompts already run long with one
  // companion's context, a household of 10+ bloats quickly.
  const nearCap = companions.length >= 10;

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      background: 'var(--haven-bg)', color: 'var(--haven-text)',
      padding: '20px', boxSizing: 'border-box', overflow: 'auto',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 700, margin: 0 }}>Your companions</h1>
        <button
          onClick={onOpenSettings}
          style={{
            background: 'transparent', border: 'none', color: 'var(--haven-text-muted)',
            cursor: 'pointer', fontSize: '18px', padding: '8px',
          }}
          title="Settings"
          aria-label="Settings"
        >⚙</button>
      </div>

      {loading && (
        <p style={{ fontSize: '13px', color: 'var(--haven-text-muted)' }}>Loading…</p>
      )}

      {error && (
        <p style={{ fontSize: '13px', color: '#f87171' }}>{error}</p>
      )}

      {!loading && !error && (
        <>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)',
            gap: '12px',
          }}>
            {companions.map(c => (
              <button
                key={c.id}
                onClick={() => pickCompanion(c.id)}
                style={{
                  background: c.id === activeCompanionId()
                    ? 'var(--haven-card)' : 'var(--haven-surface)',
                  border: '1px solid var(--haven-border)',
                  borderRadius: '14px',
                  padding: '16px 12px',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
                  cursor: 'pointer', color: 'inherit', outline: 'none',
                  minHeight: '140px',
                }}
              >
                {c.avatar_url ? (
                  <AuthMedia
                    url={c.avatar_url}
                    type="img"
                    alt=""
                    style={{ width: '56px', height: '56px', borderRadius: '50%', objectFit: 'cover' }}
                  />
                ) : (
                  <div style={{
                    width: '56px', height: '56px', borderRadius: '50%',
                    background: 'var(--haven-card)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '24px', color: 'var(--haven-text-muted)',
                  }}>
                    {c.name.slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div style={{ fontSize: '14px', fontWeight: 600, textAlign: 'center' }}>{c.name}</div>
              </button>
            ))}

            <button
              onClick={onAddCompanion}
              style={{
                background: 'transparent',
                border: '1px dashed var(--haven-border)',
                borderRadius: '14px',
                padding: '16px 12px',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: '8px', cursor: 'pointer',
                color: 'var(--haven-text-muted)', outline: 'none',
                minHeight: '140px', fontSize: '13px',
              }}
            >
              <span style={{ fontSize: '28px', lineHeight: 1 }}>+</span>
              Add Companion
            </button>
          </div>

          {nearCap && (
            <p style={{ marginTop: '16px', fontSize: '11px', color: 'var(--haven-text-muted)', textAlign: 'center' }}>
              You have {companions.length} companions. Each one's identity + files get loaded
              into their system prompt, so more companions means more places context can bloat.
              Consider archiving ones you don't actively talk to.
            </p>
          )}
        </>
      )}
    </div>
  );
}
