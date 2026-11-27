import '@shell/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from '@shell';
import { PageForge } from './PageForge';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Shell title="PageForge" tagline="PDF tools in your browser">
      <PageForge />
    </Shell>
  </StrictMode>,
);
