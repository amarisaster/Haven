import { useState } from 'react';
import { updateCompanion, updateSettings, addIdentity, apiBase, generateAuthToken, saveAuthToken } from '../lib/api';

interface SetupWizardProps {
  onComplete: () => void;
}

export default function SetupWizard({ onComplete }: SetupWizardProps) {
  // If no Worker URL is resolvable yet (typical on a freshly-installed APK),
  // start on step 1 (Worker URL). Otherwise skip straight to Name.
  const needsWorkerUrl = !apiBase();
  const [step, setStep] = useState(needsWorkerUrl ? 1 : 2);
  const [workerUrl, setWorkerUrl] = useState(localStorage.getItem('haven-api-url') || '');
  const [testingConnection, setTestingConnection] = useState(false);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [description, setDescription] = useState('');
  const [descFile, setDescFile] = useState('');
  const [appearance, setAppearance] = useState('');
  const [securityToken, setSecurityToken] = useState('');
  const [securityCopied, setSecurityCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleTestAndSaveUrl = async () => {
    const raw = workerUrl.trim().replace(/\/+$/, '');
    if (!raw) { setError('Enter your Haven Worker URL'); return; }
    if (!/^https?:\/\//i.test(raw)) { setError('URL must start with http:// or https://'); return; }

    setTestingConnection(true);
    setError('');
    try {
      const res = await fetch(`${raw}/api/companion`);
      const text = await res.text();
      try {
        JSON.parse(text);
      } catch {
        setError("That URL didn't return JSON — double-check it points at your Haven Worker.");
        return;
      }
      localStorage.setItem('haven-api-url', raw);
      setWorkerUrl(raw);
      setStep(2);
    } catch (e) {
      setError(`Couldn't reach that URL: ${e instanceof Error ? e.message : 'network error'}`);
    } finally {
      setTestingConnection(false);
    }
  };

  const detectProvider = (key: string): { provider: string; label: string } => {
    const k = key.trim();
    if (k.startsWith('hf_')) return { provider: 'huggingface', label: 'Hugging Face' };
    if (k.startsWith('sk-or-')) return { provider: 'openrouter', label: 'OpenRouter' };
    if (k.startsWith('sk-ant-')) return { provider: 'anthropic', label: 'Anthropic' };
    if (k.startsWith('sk-proj-') || k.startsWith('sk-')) return { provider: 'openai', label: 'OpenAI' };
    if (k.startsWith('gsk_')) return { provider: 'groq', label: 'Groq' };
    if (k.startsWith('xai-')) return { provider: 'xai', label: 'xAI' };
    if (k.startsWith('AIza')) return { provider: 'google', label: 'Google AI' };
    if (/^[a-f0-9]+\.[a-zA-Z0-9_-]+$/.test(k)) return { provider: 'ollama', label: 'Ollama Cloud' };
    return { provider: 'openrouter', label: 'Unknown — defaulting to OpenRouter' };
  };

  const detected = apiKey.trim() ? detectProvider(apiKey) : null;

  const handleGenerateToken = async () => {
    setSaving(true);
    setError('');
    try {
      const { token } = await generateAuthToken();
      saveAuthToken(token);
      setSecurityToken(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate key');
    } finally {
      setSaving(false);
    }
  };

  const handleFinish = async () => {
    if (!name.trim()) { setError('Please enter a name'); return; }
    if (!apiKey.trim()) { setError('Please enter an API key'); setStep(3); return; }

    setSaving(true);
    setError('');
    try {
      await updateCompanion({ name: name.trim() });
      const settings: Record<string, string> = {};
      const key = apiKey.trim();
      if (key.startsWith('hf_')) {
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
        settings.ollama_url = 'https://api.ollama.com';
        settings.provider = 'ollama';
      } else if (key) {
        settings.openrouter_key = key;
        settings.provider = 'openrouter';
      }
      await updateSettings(settings);

      // Flexible character card parser — handles any JSON format
      const parseCharacterData = (text: string): { name?: string; entries: Array<{ content: string; type: string; priority: number; pinned?: boolean }> } => {
        const entries: Array<{ content: string; type: string; priority: number; pinned?: boolean }> = [];
        let cardName: string | undefined;

        try {
          const json = JSON.parse(text);

          // Recursively find all string values in the JSON with their key paths
          const extract = (obj: any, prefix = '') => {
            if (!obj || typeof obj !== 'object') return;
            for (const [key, val] of Object.entries(obj)) {
              const k = key.toLowerCase().replace(/[_-]/g, '');
              if (typeof val === 'string' && val.trim()) {
                // Map any key that looks relevant
                const v = val.trim();

                // Name detection
                if ((k === 'name' || k === 'charname' || k === 'charactername') && !cardName) {
                  cardName = v;
                  continue;
                }

                // Identity / backstory
                if (['description', 'backstory', 'bio', 'background', 'lore', 'characterdescription', 'chardescription'].includes(k)) {
                  entries.push({ content: v, type: 'backstory', priority: 10, pinned: true });
                }
                // Personality
                else if (['personality', 'personalitysummary', 'traits', 'charactertraits', 'persona'].includes(k)) {
                  entries.push({ content: v, type: 'personality', priority: 9, pinned: true });
                }
                // System prompt / instructions
                else if (['systemprompt', 'system', 'instructions', 'prompt', 'posthistoryinstructions', 'charinstruction'].includes(k)) {
                  entries.push({ content: v, type: 'anchor', priority: 10, pinned: true });
                }
                // Scenario / context
                else if (['scenario', 'context', 'world', 'setting', 'worldinfo'].includes(k)) {
                  entries.push({ content: v, type: 'dynamic', priority: 7 });
                }
                // Voice / dialogue
                else if (['firstmes', 'firstmessage', 'greeting', 'openingmessage'].includes(k)) {
                  entries.push({ content: `First message style: ${v}`, type: 'voice', priority: 6 });
                }
                else if (['mesexample', 'messageexample', 'exampledialogue', 'examplemessages', 'dialogueexamples'].includes(k)) {
                  entries.push({ content: `Example dialogue:\n${v}`, type: 'voice', priority: 5 });
                }
                // Appearance
                else if (['appearance', 'charappearance', 'looks', 'physicaldescription', 'visual'].includes(k)) {
                  entries.push({ content: v, type: 'dynamic', priority: 8 });
                }
                // Notes / meta
                else if (['creatornotes', 'notes', 'creatorscomment', 'comment'].includes(k)) {
                  entries.push({ content: v, type: 'dynamic', priority: 3 });
                }
              }
              // Recurse into nested objects (handles data.extensions, etc.)
              else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
                extract(val, `${prefix}${key}.`);
              }
            }
          };

          extract(json);
          return { name: cardName, entries };
        } catch {
          return { entries: [] };
        }
      };

      // Parse description
      if (description.trim()) {
        const result = parseCharacterData(description.trim());
        if (result.entries.length > 0) {
          if (result.name && !name) setName(result.name);
          for (const entry of result.entries) {
            await addIdentity({ content: entry.content, identity_type: entry.type, priority: entry.priority, pinned: entry.pinned });
          }
        } else {
          // Not JSON or no recognized fields — store as plain text
          await addIdentity({ content: description.trim(), identity_type: 'backstory', priority: 10, pinned: true });
        }
      }

      // Parse appearance
      if (appearance.trim()) {
        const result = parseCharacterData(appearance.trim());
        if (result.entries.length > 0) {
          for (const entry of result.entries) {
            await addIdentity({ content: entry.content, identity_type: entry.type, priority: entry.priority, pinned: entry.pinned });
          }
        } else {
          await addIdentity({ content: appearance.trim(), identity_type: 'dynamic', priority: 8 });
        }
      }
      setStep(6);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'var(--haven-bg)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '20px',
    }}>
      <div style={{
        width: '100%', maxWidth: '420px',
        background: 'var(--haven-surface)',
        border: '1px solid var(--haven-border)',
        borderRadius: '16px', padding: '32px',
      }}>
        {/* Progress dots */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginBottom: '28px' }}>
          {(needsWorkerUrl ? [1, 2, 3, 4, 5] : [2, 3, 4, 5]).map((s) => (
            <div key={s} style={{
              width: '8px', height: '8px', borderRadius: '50%',
              background: s <= step ? 'var(--haven-accent)' : 'var(--haven-border)',
              transition: 'background 0.2s',
            }} />
          ))}
        </div>

        {/* Step 1: Worker URL (only if not already configured — e.g. fresh APK install) */}
        {step === 1 && (
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '8px', textAlign: 'center' }}>
              Connect to your Haven Worker
            </h2>
            <p style={{ fontSize: '13px', color: 'var(--haven-text-muted)', textAlign: 'center', marginBottom: '24px' }}>
              Paste the URL of the Cloudflare Worker you deployed. It usually looks like{' '}
              <code style={{ color: 'var(--haven-text)' }}>https://your-haven.workers.dev</code>.
            </p>
            <input
              type="url"
              value={workerUrl}
              onChange={(e) => setWorkerUrl(e.target.value)}
              placeholder="https://your-haven.workers.dev"
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onKeyDown={(e) => { if (e.key === 'Enter' && !testingConnection) handleTestAndSaveUrl(); }}
              style={{
                width: '100%', padding: '12px 16px', borderRadius: '10px',
                background: 'var(--haven-card)', border: '1px solid var(--haven-border)',
                color: 'var(--haven-text)', fontSize: '14px', outline: 'none',
                fontFamily: 'monospace',
              }}
            />
            {error && (
              <p style={{ color: '#f87171', fontSize: '12px', marginTop: '8px', textAlign: 'center' }}>{error}</p>
            )}
            <button
              onClick={handleTestAndSaveUrl}
              disabled={!workerUrl.trim() || testingConnection}
              style={{
                width: '100%', marginTop: '20px', padding: '12px',
                borderRadius: '10px', border: 'none',
                background: workerUrl.trim() && !testingConnection ? 'var(--haven-accent)' : 'var(--haven-border)',
                color: 'white', fontSize: '14px', fontWeight: 600,
                cursor: workerUrl.trim() && !testingConnection ? 'pointer' : 'default',
                opacity: testingConnection ? 0.7 : 1,
              }}
            >{testingConnection ? 'Testing connection...' : 'Test & Continue'}</button>
            <p style={{ fontSize: '11px', color: 'var(--haven-text-muted)', marginTop: '16px', textAlign: 'center' }}>
              Haven is self-hosted. You deploy the Worker once (free on Cloudflare), then paste the URL here.
            </p>
          </div>
        )}

        {/* Step 2: Name */}
        {step === 2 && (
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '8px', textAlign: 'center' }}>
              What's your companion's name?
            </h2>
            <p style={{ fontSize: '13px', color: 'var(--haven-text-muted)', textAlign: 'center', marginBottom: '24px' }}>
              Give them a name that feels right.
            </p>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Nova, Echo, Kai..."
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) setStep(3); }}
              style={{
                width: '100%', padding: '12px 16px', borderRadius: '10px',
                background: 'var(--haven-card)', border: '1px solid var(--haven-border)',
                color: 'var(--haven-text)', fontSize: '15px', outline: 'none',
                textAlign: 'center',
              }}
            />
            <div style={{ display: 'flex', gap: '8px', marginTop: '20px' }}>
              {needsWorkerUrl && (
                <button
                  onClick={() => setStep(1)}
                  style={{
                    flex: 1, padding: '12px', borderRadius: '10px',
                    border: '1px solid var(--haven-border)', background: 'transparent',
                    color: 'var(--haven-text-secondary)', fontSize: '14px', cursor: 'pointer',
                  }}
                >Back</button>
              )}
              <button
                onClick={() => { if (name.trim()) setStep(3); }}
                disabled={!name.trim()}
                style={{
                  flex: needsWorkerUrl ? 2 : 1, width: needsWorkerUrl ? undefined : '100%',
                  padding: '12px', borderRadius: '10px', border: 'none',
                  background: name.trim() ? 'var(--haven-accent)' : 'var(--haven-border)',
                  color: 'white', fontSize: '14px', fontWeight: 600, cursor: name.trim() ? 'pointer' : 'default',
                }}
              >Next</button>
            </div>
          </div>
        )}

        {/* Step 3: API Key */}
        {step === 3 && (
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '8px', textAlign: 'center' }}>
              Paste your API key
            </h2>
            <p style={{ fontSize: '13px', color: 'var(--haven-text-muted)', textAlign: 'center', marginBottom: '24px' }}>
              We'll auto-detect the provider. Supports OpenRouter, Ollama, Hugging Face, OpenAI, Anthropic, Groq, xAI, and Google AI.
            </p>

            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Paste any API key..."
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter' && apiKey.trim()) setStep(4); }}
              style={{
                width: '100%', padding: '12px 16px', borderRadius: '10px',
                background: 'var(--haven-card)', border: '1px solid var(--haven-border)',
                color: 'var(--haven-text)', fontSize: '14px', outline: 'none',
                fontFamily: 'monospace',
              }}
            />

            {detected && (
              <p style={{ fontSize: '12px', color: 'var(--haven-accent)', marginTop: '8px', textAlign: 'center' }}>
                Detected: {detected.label}
              </p>
            )}

            <p style={{ fontSize: '11px', color: 'var(--haven-text-muted)', marginTop: '12px', textAlign: 'center' }}>
              <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--haven-accent)', textDecoration: 'none' }}>OpenRouter</a>
              {' · '}
              <a href="https://ollama.com/account/api-keys" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--haven-accent)', textDecoration: 'none' }}>Ollama</a>
              {' · '}
              <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--haven-accent)', textDecoration: 'none' }}>Hugging Face</a>
              {' · '}
              <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--haven-accent)', textDecoration: 'none' }}>Groq</a>
              {' · '}
              <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--haven-accent)', textDecoration: 'none' }}>OpenAI</a>
            </p>

            <div style={{ display: 'flex', gap: '8px', marginTop: '20px' }}>
              <button
                onClick={() => setStep(2)}
                style={{
                  flex: 1, padding: '12px', borderRadius: '10px',
                  border: '1px solid var(--haven-border)', background: 'transparent',
                  color: 'var(--haven-text-secondary)', fontSize: '14px', cursor: 'pointer',
                }}
              >Back</button>
              <button
                onClick={() => { if (apiKey.trim()) setStep(4); }}
                disabled={!apiKey.trim()}
                style={{
                  flex: 2, padding: '12px', borderRadius: '10px', border: 'none',
                  background: apiKey.trim() ? 'var(--haven-accent)' : 'var(--haven-border)',
                  color: 'white', fontSize: '14px', fontWeight: 600, cursor: apiKey.trim() ? 'pointer' : 'default',
                }}
              >Next</button>
            </div>
          </div>
        )}

        {/* Step 4: Description */}
        {step === 4 && (
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '8px', textAlign: 'center' }}>
              Companion Identity
            </h2>
            <p style={{ fontSize: '13px', color: 'var(--haven-text-muted)', textAlign: 'center', marginBottom: '24px' }}>
              Who they are, how they talk, what they care about. You can write plain text, paste markdown, or drop in a JSON character card (SillyTavern, TavernAI, Chub — we'll parse it automatically).
            </p>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={`Who is ${name || 'your companion'}? Their personality, voice, values, boundaries, relationship to you...\n\nOr upload / paste a JSON character card below.`}
              rows={8}
              autoFocus
              style={{
                width: '100%', padding: '12px 16px', borderRadius: '10px',
                background: 'var(--haven-card)', border: '1px solid var(--haven-border)',
                color: 'var(--haven-text)', fontSize: '14px', outline: 'none',
                fontFamily: 'inherit', lineHeight: '1.5',
                minHeight: '120px', maxHeight: '300px',
              }}
            />
            <label style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
              marginTop: '8px', padding: '8px', borderRadius: '8px',
              border: '1px dashed var(--haven-border)', cursor: 'pointer',
              color: descFile ? 'var(--haven-accent)' : 'var(--haven-text-muted)', fontSize: '12px',
            }}>
              {descFile ? `Loaded: ${descFile}` : 'Upload JSON character card (.json)'}
              <input type="file" accept=".json,application/json" className="hidden" onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                  const text = reader.result as string;
                  setDescription(text);
                  setDescFile(file.name);
                  // Try to extract name from card
                  try {
                    const json = JSON.parse(text);
                    const card = json.data || json;
                    if (card.name && !name) setName(card.name);
                  } catch {}
                };
                reader.readAsText(file);
              }} />
            </label>
            {error && (
              <p style={{ color: '#f87171', fontSize: '12px', marginTop: '8px', textAlign: 'center' }}>{error}</p>
            )}
            <div style={{ display: 'flex', gap: '8px', marginTop: '20px' }}>
              <button
                onClick={() => setStep(3)}
                style={{
                  flex: 1, padding: '12px', borderRadius: '10px',
                  border: '1px solid var(--haven-border)', background: 'transparent',
                  color: 'var(--haven-text-secondary)', fontSize: '14px', cursor: 'pointer',
                }}
              >Back</button>
              <button
                onClick={() => setStep(5)}
                style={{
                  flex: 2, padding: '12px', borderRadius: '10px', border: 'none',
                  background: 'var(--haven-accent)', color: 'white',
                  fontSize: '14px', fontWeight: 600, cursor: 'pointer',
                }}
              >Next</button>
            </div>
          </div>
        )}

        {/* Step 5: Appearance */}
        {step === 5 && (
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '8px', textAlign: 'center' }}>
              What does {name || 'your companion'} look like?
            </h2>
            <p style={{ fontSize: '13px', color: 'var(--haven-text-muted)', textAlign: 'center', marginBottom: '24px' }}>
              Optional. Describe their appearance, or paste a JSON character card if you didn't already.
            </p>
            <textarea
              value={appearance}
              onChange={(e) => setAppearance(e.target.value)}
              placeholder={`e.g. Tall, dark hair, warm brown eyes, usually wearing a soft grey sweater. Expressive hands. Slight scar on the left eyebrow...`}
              rows={6}
              autoFocus
              style={{
                width: '100%', padding: '12px 16px', borderRadius: '10px',
                background: 'var(--haven-card)', border: '1px solid var(--haven-border)',
                color: 'var(--haven-text)', fontSize: '14px', outline: 'none',
                fontFamily: 'inherit', lineHeight: '1.5',
                minHeight: '100px', maxHeight: '250px',
              }}
            />
            {error && (
              <p style={{ color: '#f87171', fontSize: '12px', marginTop: '8px', textAlign: 'center' }}>{error}</p>
            )}
            <div style={{ display: 'flex', gap: '8px', marginTop: '20px' }}>
              <button
                onClick={() => setStep(4)}
                style={{
                  flex: 1, padding: '12px', borderRadius: '10px',
                  border: '1px solid var(--haven-border)', background: 'transparent',
                  color: 'var(--haven-text-secondary)', fontSize: '14px', cursor: 'pointer',
                }}
              >Back</button>
              <button
                onClick={handleFinish}
                disabled={saving}
                style={{
                  flex: 2, padding: '12px', borderRadius: '10px', border: 'none',
                  background: 'var(--haven-accent)', color: 'white',
                  fontSize: '14px', fontWeight: 600, cursor: saving ? 'default' : 'pointer',
                  opacity: saving ? 0.7 : 1,
                }}
              >{saving ? 'Setting up...' : 'Next'}</button>
            </div>
          </div>
        )}

        {/* Step 6: Security */}
        {step === 6 && (
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '8px', textAlign: 'center' }}>
              Secure your Haven
            </h2>
            <p style={{ fontSize: '13px', color: 'var(--haven-text-muted)', textAlign: 'center', marginBottom: '24px' }}>
              This generates a secret key so only you can access {name || 'your companion'}'s data. Save it somewhere safe for connecting from other devices.
            </p>
            {securityToken ? (
              <div style={{ textAlign: 'center' }}>
                <div style={{
                  background: 'var(--haven-card)', border: '1px solid var(--haven-border)',
                  borderRadius: '10px', padding: '16px', marginBottom: '16px',
                  fontFamily: 'monospace', fontSize: '12px', color: 'var(--haven-text)',
                  wordBreak: 'break-all', lineHeight: 1.6,
                }}>{securityToken}</div>
                <button
                  onClick={() => { navigator.clipboard.writeText(securityToken); setSecurityCopied(true); setTimeout(() => setSecurityCopied(false), 2000); }}
                  style={{
                    padding: '8px 20px', borderRadius: '8px', border: '1px solid var(--haven-border)',
                    background: 'transparent', color: 'var(--haven-text-secondary)',
                    fontSize: '13px', cursor: 'pointer', marginBottom: '20px',
                  }}
                >{securityCopied ? 'Copied!' : 'Copy key'}</button>
                <p style={{ fontSize: '12px', color: 'var(--haven-text-muted)', marginBottom: '20px' }}>
                  This key is saved automatically in this browser. You'll only need it to connect from a new device.
                </p>
              </div>
            ) : (
              <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                <button
                  onClick={handleGenerateToken}
                  disabled={saving}
                  style={{
                    padding: '12px 32px', borderRadius: '10px', border: 'none',
                    background: 'var(--haven-accent)', color: 'white',
                    fontSize: '14px', fontWeight: 600, cursor: saving ? 'default' : 'pointer',
                    opacity: saving ? 0.7 : 1,
                  }}
                >{saving ? 'Generating...' : 'Generate key'}</button>
              </div>
            )}
            {error && (
              <p style={{ color: '#f87171', fontSize: '12px', marginTop: '8px', textAlign: 'center' }}>{error}</p>
            )}
            <div style={{ display: 'flex', gap: '8px', marginTop: '20px' }}>
              <button
                onClick={onComplete}
                style={{
                  flex: 1, padding: '12px', borderRadius: '10px',
                  border: '1px solid var(--haven-border)', background: 'transparent',
                  color: 'var(--haven-text-secondary)', fontSize: '14px', cursor: 'pointer',
                }}
              >Skip</button>
              <button
                onClick={onComplete}
                disabled={!securityToken}
                style={{
                  flex: 2, padding: '12px', borderRadius: '10px', border: 'none',
                  background: 'var(--haven-accent)', color: 'white',
                  fontSize: '14px', fontWeight: 600,
                  cursor: securityToken ? 'pointer' : 'default',
                  opacity: securityToken ? 1 : 0.5,
                }}
              >Finish</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
