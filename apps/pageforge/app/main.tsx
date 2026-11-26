import '@shell/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Inspector, Shell } from '@shell';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Shell title="PageForge" tagline="PDF tools in your browser">
      <Inspector intro="PageForge's tools arrive in the next phase. For now, open a PDF to check what PageForge can read: pages, encryption, producer and every glyph of its text." />
    </Shell>
  </StrictMode>,
);
