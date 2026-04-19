import { useState, useEffect, useCallback } from 'react';
import { getCompanion, setActiveCompanionId, activeCompanionId } from './lib/api';
import ThreadList from './components/ThreadList';
import ChatContainer from './components/ChatContainer';
import SetupWizard from './components/SetupWizard';
import ImportWizard from './components/ImportWizard';
import CompanionGrid from './components/CompanionGrid';
import AddCompanionWizard from './components/AddCompanionWizard';
import Settings from './pages/Settings';

type View = 'grid' | 'threads' | 'chat' | 'settings';

export default function App() {
  const [view, setView] = useState<View>('grid');
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [companionName, setCompanionName] = useState('');
  const [companionAvatar, setCompanionAvatar] = useState('');
  const [needsSetup, setNeedsSetup] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAddCompanion, setShowAddCompanion] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Fetch companion data for the active companion id (from localStorage).
  const refreshActiveCompanion = useCallback(async () => {
    try {
      const c = await getCompanion();
      setCompanionName(c.name);
      setCompanionAvatar(c.avatar_url || '');
      if (c.name === 'Companion') setNeedsSetup(true);
    } catch {
      setNeedsSetup(true);
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
    return <SetupWizard onComplete={handleSetupComplete} />;
  }

  return (
    <div style={{ height: '100%', background: 'var(--haven-bg)' }}>
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
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          <Settings onImport={() => setShowImport(true)} onBack={goBack} />
        </div>
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
  );
}
