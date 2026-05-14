import { useEffect, useState } from 'react';
import { getAuthStatus, generateAuthToken, saveAuthToken, getAuthToken } from '../lib/api';

export default function SecurityBanner() {
  const [state, setState] = useState<'loading' | 'unsecured' | 'need-token' | 'secured' | 'hidden'>('loading');
  const [tokenInput, setTokenInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [generatedToken, setGeneratedToken] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getAuthStatus()
      .then(({ secured }) => {
        if (!secured) setState('unsecured');
        else if (!getAuthToken()) setState('need-token');
        else setState('secured');
      })
      .catch(() => setState('hidden'));
  }, []);

  useEffect(() => {
    const onExpired = () => setState('need-token');
    window.addEventListener('haven-auth-expired', onExpired);
    return () => window.removeEventListener('haven-auth-expired', onExpired);
  }, []);

  if (state === 'loading' || state === 'secured' || state === 'hidden') return null;

  const handleSecure = async () => {
    setBusy(true);
    setError('');
    try {
      const { token } = await generateAuthToken();
      saveAuthToken(token);
      setGeneratedToken(token);
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  };

  const handleDone = () => setState('secured');

  const handleConnect = () => {
    if (!tokenInput.trim()) return;
    saveAuthToken(tokenInput.trim());
    setState('secured');
    window.location.reload();
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(generatedToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const bannerStyle: React.CSSProperties = {
    position: 'fixed', top: 0, left: 0, right: 0, zIndex: 998,
    padding: '10px 16px',
    background: state === 'unsecured' ? '#b45309' : '#1e40af',
    color: 'white',
    fontSize: '12px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
  };

  if (generatedToken) {
    return (
      <div style={bannerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong>Haven secured!</strong>
          <span>Your key (save it for other devices):</span>
          <code style={{
            background: 'rgba(0,0,0,0.3)', padding: '2px 8px', borderRadius: 4,
            fontSize: '11px', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{generatedToken}</code>
          <button onClick={handleCopy} style={btnStyle}>{copied ? 'Copied' : 'Copy'}</button>
          <button onClick={handleDone} style={btnStyle}>Done</button>
        </div>
      </div>
    );
  }

  if (state === 'need-token') {
    return (
      <div style={bannerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong>This Haven is secured.</strong>
          <span>Enter your key to connect:</span>
          <input
            type="password"
            value={tokenInput}
            onChange={e => setTokenInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleConnect()}
            placeholder="Paste your Haven key"
            style={{
              background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.3)',
              color: 'white', padding: '3px 8px', borderRadius: 4, fontSize: '12px', width: 220,
            }}
          />
          <button onClick={handleConnect} style={btnStyle}>Connect</button>
        </div>
      </div>
    );
  }

  return (
    <div style={bannerStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span>
          <strong>Your Haven is unsecured.</strong> Anyone with your Worker URL can access your data.
        </span>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button onClick={handleSecure} disabled={busy} style={btnStyle}>
            {busy ? 'Securing...' : 'Secure Now'}
          </button>
          <button onClick={() => setState('hidden')} style={{ ...btnStyle, opacity: 0.6 }} aria-label="Dismiss">x</button>
        </div>
      </div>
      {error && <div style={{ marginTop: 4, color: '#fecaca' }}>{error}</div>}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.3)',
  color: 'white', padding: '3px 12px', borderRadius: 4, cursor: 'pointer', fontSize: '12px',
};
