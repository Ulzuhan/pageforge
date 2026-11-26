import '@shell/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Inspector, Shell } from '@shell';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Shell title="InkBar" tagline="True PDF redaction in your browser">
      <Inspector intro="InkBar's redaction arrives in a later phase. For now, open a PDF to check what InkBar can read: pages, encryption, producer and every glyph of its text." />
    </Shell>
  </StrictMode>,
);
