import { useEffect, useState } from 'react';
import type { Companion } from '../lib/types';
import { listCompanions, setActiveCompanionId } from '../lib/api';
import AuthMedia from './AuthMedia';

interface CompanionSwitcherProps {
  activeId: number;
  onSwitch: (companionId: number) => void;
  onBackToGrid: () => void;
}

// Horizontal avatar strip shown in the thread-list header. Tapping any
// companion's avatar switches the active companion (localStorage + header
// used on all subsequent requests) and triggers a nav back into their own
// thread list. Only non-archived companions show up. If only one companion
// exists the strip collapses (no need to switch).
export default function CompanionSwitcher({ activeId, onSwitch, onBackToGrid }: CompanionSwitcherProps) {
  const [companions, setCompanions] = useState<Companion[]>([]);

  useEffect(() => {
    let active = true;
    listCompanions()
      .then(rows => { if (active) setCompanions(Array.isArray(rows) ? rows : []); })
      .catch(() => { /* keep empty — strip just won't render */ });
    return () => { active = false; };
  }, []);

  if (companions.length <= 1) return null;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '8px',
      padding: '4px 0', overflowX: 'auto',
    }}>
      <button
        onClick={onBackToGrid}
        title="Back to companions"
        aria-label="Back to companions"
        style={{
          flex: '0 0 auto',
          width: '28px', height: '28px', borderRadius: '50%',
          background: 'transparent', border: '1px solid var(--haven-border)',
          color: 'var(--haven-text-muted)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '14px',
        }}
      >⌂</button>

      {companions.map(c => {
        const isActive = c.id === activeId;
        return (
          <button
            key={c.id}
            onClick={() => {
              if (isActive) return;
              setActiveCompanionId(c.id);
              onSwitch(c.id);
            }}
            title={c.name}
            aria-label={`Switch to ${c.name}`}
            style={{
              flex: '0 0 auto',
              width: isActive ? '36px' : '30px',
              height: isActive ? '36px' : '30px',
              borderRadius: '50%',
              border: isActive
                ? '2px solid var(--haven-accent)'
                : '1px solid var(--haven-border)',
              background: 'var(--haven-surface)',
              padding: 0, cursor: isActive ? 'default' : 'pointer',
              overflow: 'hidden',
              transition: 'all 0.15s ease',
            }}
          >
            {c.avatar_url ? (
              <AuthMedia
                url={c.avatar_url}
                type="img"
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            ) : (
              <div style={{
                width: '100%', height: '100%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '12px', fontWeight: 600,
                color: 'var(--haven-text-muted)',
              }}>
                {c.name.slice(0, 1).toUpperCase()}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
