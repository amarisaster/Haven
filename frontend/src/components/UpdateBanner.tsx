import { useEffect, useState } from 'react';
import { checkForUpdate, dismissUpdate, type UpdateInfo } from '../lib/version';

// Boot-time check against GitHub releases. If a newer release exists and the
// user hasn't dismissed that specific version's banner, shows a thin bar at
// the top of the app with a link to the release notes and an X to dismiss.
// Silent on failure — a broken network should never nag the user.
export default function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    // Delay slightly so the app boot path isn't competing with a cross-origin
    // fetch on first paint. GitHub's API is usually fast but not free of tail
    // latency.
    const t = setTimeout(() => {
      checkForUpdate().then(setInfo);
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  if (!info) return null;

  const dismiss = () => {
    dismissUpdate(info.latest);
    setInfo(null);
  };

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 999,
        padding: '8px 16px',
        background: 'var(--haven-accent)', color: 'white',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '8px', fontSize: '12px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <strong>Haven v{info.latest} is available.</strong>{' '}
        <a
          href={info.url}
          target="_blank"
          rel="noreferrer"
          style={{ color: 'white', textDecoration: 'underline' }}
        >View release</a>
      </span>
      <button
        onClick={dismiss}
        style={{
          background: 'transparent', border: 'none', color: 'white',
          cursor: 'pointer', fontSize: '14px', padding: '4px 8px',
          flexShrink: 0,
        }}
        aria-label="Dismiss update notice"
      >x</button>
    </div>
  );
}
