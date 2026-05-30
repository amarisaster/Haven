import { useState, useEffect, useRef } from 'react';
import { apiBase, authedFetch } from '../lib/api';
import AuthMedia from './AuthMedia';

interface StickerPickerProps {
  onSelect: (url: string) => void;
  onClose: () => void;
}

interface MediaItem {
  id: number;
  name: string;
  type: string;
  url: string;
}

export default function StickerPicker({ onSelect, onClose }: StickerPickerProps) {
  const [tab, setTab] = useState<'emoji' | 'sticker'>('sticker');
  const [emoji, setEmoji] = useState<MediaItem[]>([]);
  const [stickers, setStickers] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const base = apiBase();
    setLoading(true);
    Promise.all([
      authedFetch(`${base}/api/custom-media?type=emoji`).then(r => r.json()).then(d => Array.isArray(d) ? d : []).catch(() => []),
      authedFetch(`${base}/api/custom-media?type=sticker`).then(r => r.json()).then(d => Array.isArray(d) ? d : []).catch(() => []),
    ]).then(([e, s]) => {
      setEmoji(e as MediaItem[]);
      setStickers(s as MediaItem[]);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const items = tab === 'emoji' ? emoji : stickers;
  const thumbSize = tab === 'emoji' ? '48px' : '100px';
  const cols = tab === 'emoji' ? 'repeat(auto-fill, 48px)' : 'repeat(auto-fill, 100px)';

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute', bottom: '100%', left: '8px', right: '8px',
        marginBottom: '8px', background: 'var(--haven-surface)',
        border: '1px solid var(--haven-border)', borderRadius: '12px',
        overflow: 'hidden', zIndex: 100, maxHeight: '360px',
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', borderBottom: '1px solid var(--haven-border)' }}>
        {(['emoji', 'sticker'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1, padding: '10px', background: 'transparent', border: 'none',
              borderBottom: tab === t ? '2px solid var(--haven-accent)' : '2px solid transparent',
              color: tab === t ? 'var(--haven-accent)' : 'var(--haven-text-muted)',
              fontSize: '13px', fontWeight: 600, cursor: 'pointer',
              textTransform: 'capitalize',
            }}
          >{t === 'emoji' ? '✨ Emoji' : '🖼 Stickers'}</button>
        ))}
      </div>

      <div
        className="hide-scrollbar"
        style={{
          flex: 1, overflowY: 'auto', padding: '8px',
          display: 'grid', gridTemplateColumns: cols,
          gap: '6px', justifyContent: 'center', alignContent: 'start',
        }}
      >
        {loading ? (
          <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '24px', color: 'var(--haven-text-muted)', fontSize: '13px' }}>
            Loading...
          </div>
        ) : items.length === 0 ? (
          <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '24px', color: 'var(--haven-text-muted)', fontSize: '13px' }}>
            No custom {tab === 'emoji' ? 'emoji' : 'stickers'} yet — add them in Settings
          </div>
        ) : (
          items.map(item => (
            <div
              key={item.id}
              title={item.name}
              onClick={() => onSelect(`${apiBase()}${item.url}`)}
              style={{
                width: thumbSize, height: thumbSize, borderRadius: '8px',
                cursor: 'pointer', transition: 'transform 0.1s',
                background: 'var(--haven-card)', padding: '4px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
              onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.05)')}
              onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')}
            >
              <AuthMedia
                url={`${apiBase()}${item.url}`}
                type="img"
                alt={item.name}
                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '4px' }}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
