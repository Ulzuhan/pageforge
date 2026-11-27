// PageForge's six tools behind one menu. The choice lives in the URL's hash
// (#merge, #compress…), which never reaches the server.
import { useEffect, useState, type ComponentType } from 'react';
import { Clean } from './tools/Clean';
import { Compress } from './tools/Compress';
import { Images } from './tools/Images';
import { Merge } from './tools/Merge';
import { Organize } from './tools/Organize';
import { Split } from './tools/Split';

const TOOLS: { id: string; name: string; blurb: string; Tool: ComponentType }[] = [
  { id: 'merge', name: 'Merge', blurb: 'Join several PDFs into one, in the order you choose.', Tool: Merge },
  { id: 'organize', name: 'Organize', blurb: 'Reorder, rotate and delete pages.', Tool: Organize },
  { id: 'split', name: 'Split', blurb: 'Take pages out, or cut a PDF into several.', Tool: Split },
  { id: 'images', name: 'Images to PDF', blurb: 'JPEG and PNG, one image per page.', Tool: Images },
  { id: 'compress', name: 'Compress', blurb: 'Make a PDF smaller: photos and scans, mostly.', Tool: Compress },
  { id: 'clean', name: 'Clean', blurb: 'Remove metadata, attachments, scripts and what earlier versions left behind.', Tool: Clean },
];

const fromHash = () => TOOLS.find((t) => `#${t.id}` === location.hash)?.id ?? 'merge';

export function PageForge() {
  const [current, setCurrent] = useState(fromHash);
  useEffect(() => {
    const on = () => setCurrent(fromHash());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const tool = TOOLS.find((t) => t.id === current)!;
  return (
    <div className="tools">
      <nav className="tool-nav" aria-label="Tools">
        {TOOLS.map((t) => (
          <a key={t.id} href={`#${t.id}`} aria-current={t.id === current ? 'page' : undefined} data-testid={`tool-${t.id}`}>{t.name}</a>
        ))}
      </nav>
      <header className="tool-head">
        <h1>{tool.name}</h1>
        <p className="muted">{tool.blurb}</p>
      </header>
      <tool.Tool key={tool.id} />
    </div>
  );
}
