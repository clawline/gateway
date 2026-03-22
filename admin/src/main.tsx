import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { LogtoProvider } from '@logto/react';
import App from './App.tsx';
import { CallbackPage } from './CallbackPage.tsx';
import './index.css';

// Auto-clear stale Logto tokens when the app version changes
const AUTH_VERSION = '2';
const versionKey = '_auth_v';
if (localStorage.getItem(versionKey) !== AUTH_VERSION) {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.includes('logto')) keysToRemove.push(key);
  }
  keysToRemove.forEach((k) => localStorage.removeItem(k));
  for (let i = sessionStorage.length - 1; i >= 0; i--) {
    const key = sessionStorage.key(i);
    if (key && key.includes('logto')) sessionStorage.removeItem(key);
  }
  localStorage.setItem(versionKey, AUTH_VERSION);
}

const logtoConfig = {
  endpoint: 'https://logto.dr.restry.cn',
  appId: 'anbr9zjc6bgd8099ecnx3',
  resources: ['https://gateway.clawlines.net/api'],
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LogtoProvider config={logtoConfig}>
      <BrowserRouter>
        <Routes>
          <Route path="/callback" element={<CallbackPage />} />
          <Route path="*" element={<App />} />
        </Routes>
      </BrowserRouter>
    </LogtoProvider>
  </StrictMode>,
);
