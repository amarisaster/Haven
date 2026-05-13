import { useState, useEffect, useCallback, Component, type ReactNode } from 'react';
import { getCompanion, setActiveCompanionId, activeCompanionId } from './lib/api';
import ThreadList from './components/ThreadList';
import ChatContainer from './components/ChatContainer';
import SetupWizard from './components/SetupWizard';
import ImportWizard from './components/ImportWizard';
import CompanionGrid from './components/CompanionGrid';
import AddCompanionWizard from './components/AddCompanionWizard';
import Settings from './pages/Settings';
import UpdateBanner from './components/UpdateBanner';
import SecurityBanner from './components/SecurityBanner';

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(err: Error) { return { error: err.message }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#0c0a09', color: '#fafaf9', padding: '40px 20px', textAlign: 'center' }}>
          <p style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>Something went wrong</p>
          <p style={{ fontSize: '13px', color: '#a8a29e', marginBottom: '24px', maxWidth: '400px' }}>{this.state.error}</p>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button onClick={() => window.location.reload()} style={{ padding: '10px 24px', borderRadius: '8px', border: 'none', background: '#d4748a', color: 'white', fontSize: '14px', cursor: 'pointer' }}>Reload</button>
            <button onClick={() => { localStorage.removeItem('haven-view'); localStorage.removeItem('haven-active-thread'); window.location.reload(); }} style={{ padding: '10px 24px', borderRadius: '8px', border: '1px solid #3f3f46', background: 'transparent', color: '#a8a29e', fontSize: '14px', cursor: 'pointer' }}>Reset view</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

class SettingsErrorBoundary extends Component<{ children: ReactNode; onBack: () => void }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(err: Error) { return { error: err.message }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '40px 20px', color: '#fafaf9', textAlign: 'center' }}>
          <p style={{ fontSize: '16px', marginBottom: '12px' }}>Settings failed to load</p>
          <p style={{ fontSize: '12px', color: '#a8a29e', marginBottom: '20px' }}>{this.state.error}</p>
          <button onClick={this.props.onBack} style={{ padding: '10px 24px', borderRadius: '8px', border: 'none', background: '#d4748a', color: 'white', fontSize: '14px' }}>Back</button>
        </div>
      );
    }
    return this.props.children;
  }
}

type View = 'grid' | 'threads' | 'chat' | 'settings';

// Persist view + activeThreadId across refreshes so hitting F5 inside a
// chat thread lands you back in that same thread instead of the grid.
const LS_VIEW = 'haven-view';
const LS_THREAD = 'haven-active-thread';

function readStoredView(): View {
  const v = localStorage.getItem(LS_VIEW);
  if (v === 'grid' || v === 'threads' || v === 'chat' || v === 'settings') return v;
  return 'grid';
}

export default function App() {
  const [view, setView] = useState<View>(() => readStoredView());
  const [activeThreadId, setActiveThreadId] = useState<string | null>(() => localStorage.getItem(LS_THREAD));
  const [companionName, setCompanionName] = useState('');
  const [companionAvatar, setCompanionAvatar] = useState('');
  const [needsSetup, setNeedsSetup] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAddCompanion, setShowAddCompanion] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Persist on every change. Null thread clears the key so a fresh "new
  // chat" doesn't resurrect a deleted thread on next refresh.
  useEffect(() => { localStorage.setItem(LS_VIEW, view); }, [view]);
  useEffect(() => {
    if (activeThreadId) localStorage.setItem(LS_THREAD, activeThreadId);
    else localStorage.removeItem(LS_THREAD);
  }, [activeThreadId]);

  // Fetch companion data for the active companion id (from localStorage).
  const refreshActiveCompanion = useCallback(async () => {
    try {
      const c = await getCompanion();
      setCompanionName(c.name || '');
      setCompanionAvatar(c.avatar_url || '');
      const hasRealName = c.name && c.name !== 'Companion';
      if (hasRealName || c.has_identity || c.has_threads) {
        localStorage.setItem('haven-setup-done', 'true');
      } else if (!localStorage.getItem('haven-setup-done')) {
        setNeedsSetup(true);
      }
    } catch {
      if (!localStorage.getItem('haven-setup-done')) setNeedsSetup(true);
    }
  }, []);

  useEffect(() => {
    refreshActiveCompanion().finally(() => setLoaded(true));
  }, [refreshActiveCompanion]);

  // Handle browser back button
  useEffect(() => {
    const onPop = () => {
      if (view === 'chat') setView('threads');
      else if (view === 'settings') setView('threads');
      else if (view === 'threads') setView('grid');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [view]);

  const openThread = useCallback((id: string) => {
    setActiveThreadId(id);
    setView('chat');
    window.history.pushState({ view: 'chat' }, '');
  }, []);

  const openNewThread = useCallback(() => {
    setActiveThreadId(null);
    setView('chat');
    window.history.pushState({ view: 'chat' }, '');
  }, []);

  const goBack = useCallback(() => {
    setView('threads');
    window.history.back();
  }, []);

  const openCompanion = useCallback((companionId: number) => {
    // Grid tile tapped — set active companion in localStorage, refresh the
    // header data for that companion, then navigate into their thread list.
    setActiveCompanionId(companionId);
    refreshActiveCompanion();
    setView('threads');
    window.history.pushState({ view: 'threads' }, '');
  }, [refreshActiveCompanion]);

  const goToGrid = useCallback(() => {
    setView('grid');
    window.history.pushState({ view: 'grid' }, '');
  }, []);

  const handleSwitchCompanion = useCallback((companionId: number) => {
    // Persistent avatar strip in thread list header tapped — same as
    // openCompanion but without a history push (we stay in 'threads' view,
    // just for a different companion).
    setActiveCompanionId(companionId);
    refreshActiveCompanion();
    setActiveThreadId(null);
  }, [refreshActiveCompanion]);

  const handleAddCompanion = useCallback(() => {
    setShowAddCompanion(true);
  }, []);

  const handleAddCompanionComplete = useCallback((newId: number) => {
    setShowAddCompanion(false);
    // Open the newly-created companion's (empty) thread list immediately —
    // feels more satisfying than dumping back onto the grid.
    openCompanion(newId);
  }, [openCompanion]);

  const handleThreadCreated = useCallback((id: string) => {
    setActiveThreadId(id);
  }, []);

  const handleSetupComplete = useCallback(() => {
    localStorage.setItem('haven-setup-done', '1');
    setNeedsSetup(false);
    getCompanion()
      .then((c) => {
        setCompanionName(c.name);
        setCompanionAvatar(c.avatar_url || '');
      })
      .catch(() => {});
  }, []);

  if (!loaded) {
    return (
      <div style={{
        height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--haven-bg)',
      }}>
        <div style={{
          width: '24px', height: '24px', border: '2px solid var(--haven-accent)',
          borderTopColor: 'transparent', borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (needsSetup) {
    return <AppErrorBoundary><SetupWizard onComplete={handleSetupComplete} /></AppErrorBoundary>;
  }

  return (
    <AppErrorBoundary>
    <div style={{ height: '100%', background: 'var(--haven-bg)' }}>
      <UpdateBanner />
      <SecurityBanner />

      {/* Companion grid (home) — v1.7 multi-companion landing */}
      {view === 'grid' && (
        <CompanionGrid
          onOpenCompanion={openCompanion}
          onAddCompanion={handleAddCompanion}
          onOpenSettings={() => { setView('settings'); window.history.pushState({ view: 'settings' }, ''); }}
        />
      )}

      {/* Thread List — scoped to the active companion */}
      {view === 'threads' && (
        <ThreadList
          companionName={companionName}
          companionAvatar={companionAvatar}
          onSelectThread={openThread}
          onNewThread={openNewThread}
          onOpenSettings={() => { setView('settings'); window.history.pushState({ view: 'settings' }, ''); }}
          onOpenImport={() => setShowImport(true)}
          onSwitchCompanion={handleSwitchCompanion}
          onBackToGrid={goToGrid}
          activeCompanionId={activeCompanionId()}
        />
      )}

      {/* Chat */}
      {view === 'chat' && (
        <ChatContainer
          threadId={activeThreadId}
          onThreadCreated={handleThreadCreated}
          companionName={companionName}
          companionAvatar={companionAvatar}
          onBack={goBack}
        />
      )}

      {/* Settings */}
      {view === 'settings' && (
        <SettingsErrorBoundary onBack={goBack}>
          <Settings onImport={() => setShowImport(true)} onBack={goBack} />
        </SettingsErrorBoundary>
      )}

      {/* Import Wizard */}
      {showImport && (
        <ImportWizard
          onClose={() => setShowImport(false)}
          onComplete={() => { setShowImport(false); setView('threads'); }}
        />
      )}

      {/* Add Companion Wizard (v1.7) */}
      {showAddCompanion && (
        <AddCompanionWizard
          onComplete={handleAddCompanionComplete}
          onCancel={() => setShowAddCompanion(false)}
        />
      )}
    </div>
    </AppErrorBoundary>
  );
}
