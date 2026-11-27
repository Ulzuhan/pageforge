// Page ranges as people write them. No PDF library here: the interface
// imports this to check what is typed before anything is sent to the worker.

export class PageRangeError extends Error {}

/**
 * «1-3, 7, 9-» → [[0,1,2],[6],[8,…,last]]. Each comma-separated part is a
 * group. «n-» runs to the last page and «-n» from the first. Pages count from
 * 1, as people count them.
 */
export function parseRanges(text: string, pageCount: number): number[][] {
  const parts = text.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new PageRangeError('Write the pages you want, for example 1-3, 7.');
  return parts.map((part) => {
    const single = /^\d+$/.exec(part);
    const range = /^(\d*)\s*[-–]\s*(\d*)$/.exec(part);
    let a: number, b: number;
    if (single) a = b = Number(part);
    else if (range && (range[1] || range[2])) {
      a = range[1] ? Number(range[1]) : 1;
      b = range[2] ? Number(range[2]) : pageCount;
    } else throw new PageRangeError(`«${part}» is not a page or a range. Use numbers like 4 or 2-5.`);
    if (a < 1 || a > pageCount || b > pageCount) {
      throw new PageRangeError(`«${part}» is outside the document, which has ${pageCount} page${pageCount === 1 ? '' : 's'}.`);
    }
    if (b < a) throw new PageRangeError(`«${part}» runs backwards. Write it as ${b}-${a}.`);
    return Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i);
  });
}

/** A file-name label for a group of 0-based pages: «page-7», «pages-1-3», «pages-1_4_9». */
export function groupLabel(g: number[]): string {
  if (g.length === 1) return `page-${g[0] + 1}`;
  if (g.every((p, i) => i === 0 || p === g[i - 1] + 1)) return `pages-${g[0] + 1}-${g[g.length - 1] + 1}`;
  const list = `pages-${g.map((p) => p + 1).join('_')}`;
  return list.length <= 40 ? list : 'selection';
}
