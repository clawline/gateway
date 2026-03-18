import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { LogtoProvider } from '@logto/react';
import App from './App.tsx';
import { CallbackPage } from './CallbackPage.tsx';
import './index.css';

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
