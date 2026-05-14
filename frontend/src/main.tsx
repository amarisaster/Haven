import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { initNotifications } from './lib/notifications';
import { syncFromNativeStorage } from './lib/storage';

syncFromNativeStorage().then(() => {
  initNotifications();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
