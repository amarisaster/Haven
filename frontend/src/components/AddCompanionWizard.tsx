import { useState } from 'react';
import {
  createCompanion, addIdentity, setActiveCompanionId,
} from '../lib/api';

interface AddCompanionWizardProps {
  onComplete: (companionId: number) => void;
  onCancel: () => void;
}

// New-companion flow for v1.7. Lands a new row in the companion table, then
// seeds their identity rows. Mirrors SetupWizard's flexible identity parser
// (accepts plain text OR a JSON character card) so imports from SillyTavern /
// TavernAI / Chub "just work". Skips the Worker URL + API key steps since
// those are global per-install, not per-companion.
export default function AddCompanionWizard({ onComplete, onCancel }: AddCompanionWizardProps) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [descFile, setDescFile] = useState('');
  const [appearance, setAppearance] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleFinish = async () => {
    if (!name.trim()) { setError('Please enter a name'); setStep(1); return; }
    setSaving(true);
    setError('');
    try {
      const { id: newId } = await createCompanion({ name: name.trim() });

      // Make the newly-created companion the active one BEFORE inserting
      // identity rows, so the X-Companion-Id header on addIdentity points
      // at the right row.
      setActiveCompanionId(newId);

      // Flexible character-card parser — same logic as SetupWizard. Handles
      // SillyTavern / TavernAI / Chub JSON or plain text.
      const parseCharacterData = (text: string): { name?: string; entries: Array<{ content: string; type: string; priority: number; pinned?: boolean }> } => {
        const entries: Array<{ content: string; type: string; priority: number; pinned?: boolean }> = [];
        let cardName: string | undefined;
        try {
          const json = JSON.parse(text);
          const extract = (obj: any) => {
            if (!obj || typeof obj !== 'object') return;
            for (const [key, val] of Object.entries(obj)) {
              const k = key.toLowerCase().replace(/[_-]/g, '');
              if (typeof val === 'string' && val.trim()) {
                const v = val.trim();
                if ((k === 'name' || k === 'charname' || k === 'charactername') && !cardName) {
                  cardName = v; continue;
                }
                if (['description', 'backstory', 'bio', 'background', 'lore', 'characterdescription', 'chardescription'].includes(k)) {
                  entries.push({ content: v, type: 'backstory', priority: 10, pinned: true });
                } else if (['personality', 'personalitysummary', 'traits', 'charactertraits', 'persona'].includes(k)) {
                  entries.push({ content: v, type: 'personality', priority: 9, pinned: true });
                } else if (['systemprompt', 'system', 'instructions', 'prompt', 'posthistoryinstructions', 'charinstruction'].includes(k)) {
                  entries.push({ content: v, type: 'anchor', priority: 10, pinned: true });
                } else if (['scenario', 'context', 'world', 'setting', 'worldinfo'].includes(k)) {
                  entries.push({ content: v, type: 'dynamic', priority: 7 });
                } else if (['firstmes', 'firstmessage', 'greeting', 'openingmessage'].includes(k)) {
                  entries.push({ content: `First message style: ${v}`, type: 'voice', priority: 6 });
                } else if (['mesexample', 'messageexample', 'exampledialogue', 'examplemessages', 'dialogueexamples'].includes(k)) {
                  entries.push({ content: `Example dialogue:\n${v}`, type: 'voice', priority: 5 });
                } else if (['appearance', 'charappearance', 'looks', 'physicaldescription', 'visual'].includes(k)) {
                  entries.push({ content: v, type: 'dynamic', priority: 8 });
                } else if (['creatornotes', 'notes', 'creatorscomment', 'comment'].includes(k)) {
                  entries.push({ content: v, type: 'dynamic', priority: 3 });
                }
              } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
                extract(val);
              }
            }
          };
          extract(json);
          return { name: cardName, entries };
        } catch {
          return { entries: [] };
        }
      };

      if (description.trim()) {
        const result = parseCharacterData(description.trim());
        if (result.entries.length > 0) {
          for (const entry of result.entries) {
            await addIdentity({ content: entry.content, identity_type: entry.type, priority: entry.priority, pinned: entry.pinned });
          }
        } else {
          await addIdentity({ content: description.trim(), identity_type: 'backstory', priority: 10, pinned: true });
        }
      }

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

      onComplete(newId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create companion');
    } finally {
      setSaving(false);
    }
  };

  const progressDots = [1, 2, 3];

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
        position: 'relative',
      }}>
        {/* Cancel */}
        <button
          onClick={onCancel}
          style={{
            position: 'absolute', top: '12px', right: '12px',
            background: 'transparent', border: 'none',
            color: 'var(--haven-text-muted)', cursor: 'pointer',
            fontSize: '20px', padding: '4px 10px',
          }}
          title="Cancel"
          aria-label="Cancel"
        >×</button>

        {/* Progress dots */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginBottom: '28px' }}>
          {progressDots.map((s) => (
            <div key={s} style={{
              width: '8px', height: '8px', borderRadius: '50%',
              background: s <= step ? 'var(--haven-accent)' : 'var(--haven-border)',
              transition: 'background 0.2s',
            }} />
          ))}
        </div>

        {/* Step 1: Name */}
        {step === 1 && (
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '8px', textAlign: 'center' }}>
              Name your companion
            </h2>
            <p style={{ fontSize: '13px', color: 'var(--haven-text-muted)', textAlign: 'center', marginBottom: '24px' }}>
              What do you want to call them?
            </p>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Nova, Echo, Riven..."
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) setStep(2); }}
              style={{
                width: '100%', padding: '12px 16px', borderRadius: '10px',
                background: 'var(--haven-card)', border: '1px solid var(--haven-border)',
                color: 'var(--haven-text)', fontSize: '15px', outline: 'none',
                textAlign: 'center',
              }}
            />
            {error && (
              <p style={{ color: '#f87171', fontSize: '12px', marginTop: '8px', textAlign: 'center' }}>{error}</p>
            )}
            <button
              onClick={() => { if (name.trim()) setStep(2); }}
              disabled={!name.trim()}
              style={{
                width: '100%', marginTop: '20px', padding: '12px',
                borderRadius: '10px', border: 'none',
                background: name.trim() ? 'var(--haven-accent)' : 'var(--haven-border)',
                color: 'white', fontSize: '14px', fontWeight: 600,
                cursor: name.trim() ? 'pointer' : 'default',
              }}
            >Next</button>
          </div>
        )}

        {/* Step 2: Identity */}
        {step === 2 && (
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '8px', textAlign: 'center' }}>
              Who are they?
            </h2>
            <p style={{ fontSize: '13px', color: 'var(--haven-text-muted)', textAlign: 'center', marginBottom: '24px' }}>
              Personality, voice, values, boundaries. Plain text, markdown, or paste a JSON character card — we'll parse whatever you give us.
            </p>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={`Who is ${name || 'your companion'}?`}
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
                onClick={() => setStep(1)}
                style={{
                  flex: 1, padding: '12px', borderRadius: '10px',
                  border: '1px solid var(--haven-border)', background: 'transparent',
                  color: 'var(--haven-text-secondary)', fontSize: '14px', cursor: 'pointer',
                }}
              >Back</button>
              <button
                onClick={() => setStep(3)}
                style={{
                  flex: 2, padding: '12px', borderRadius: '10px', border: 'none',
                  background: 'var(--haven-accent)', color: 'white',
                  fontSize: '14px', fontWeight: 600, cursor: 'pointer',
                }}
              >Next</button>
            </div>
          </div>
        )}

        {/* Step 3: Appearance (optional) + Finish */}
        {step === 3 && (
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '8px', textAlign: 'center' }}>
              What do they look like?
            </h2>
            <p style={{ fontSize: '13px', color: 'var(--haven-text-muted)', textAlign: 'center', marginBottom: '24px' }}>
              Optional. Describe their appearance, or skip.
            </p>
            <textarea
              value={appearance}
              onChange={(e) => setAppearance(e.target.value)}
              placeholder="e.g. Tall, dark hair, warm brown eyes..."
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
                onClick={() => setStep(2)}
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
                  fontSize: '14px', fontWeight: 600,
                  cursor: saving ? 'default' : 'pointer',
                  opacity: saving ? 0.7 : 1,
                }}
              >{saving ? 'Creating…' : 'Finish'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
