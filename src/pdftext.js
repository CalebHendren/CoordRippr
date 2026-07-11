// Build a searchable string from a pdf.js textContent object while keeping a
// char-offset -> text-item mapping, so regex match ranges can be turned back
// into rectangles on the page. Pure module: usable from Node for testing.

/**
 * @param {object} textContent result of page.getTextContent()
 * @returns {{text: string, spans: Array<{start:number,end:number,item:object}>}}
 */
export function buildPageText(textContent) {
  const spans = [];
  let text = '';
  let prev = null;

  for (const item of textContent.items) {
    if (!item.str || item.str.length === 0) {
      if (item.hasEOL && text.length && !text.endsWith('\n')) text += '\n';
      continue;
    }
    if (prev && !text.endsWith('\n')) {
      text += pickDivider(prev, item);
    }
    const start = text.length;
    text += item.str;
    spans.push({ start, end: text.length, item });
    if (item.hasEOL) text += '\n';
    prev = item;
  }
  return { text, spans };
}

// Decide what belongs between two consecutive text items: nothing (same word),
// a space (same line), or a newline (new line / new column). PDF y grows up.
function pickDivider(prev, cur) {
  const py = prev.transform[5];
  const cy = cur.transform[5];
  const ph = prev.height || 8;
  if (Math.abs(cy - py) > ph * 0.75) return '\n';
  const prevEnd = prev.transform[4] + (prev.width || 0);
  const gap = cur.transform[4] - prevEnd;
  return gap > ph * 0.12 ? ' ' : '';
}

/**
 * Convert a character range of the built text into PDF-space rectangles
 * ([x1,y1,x2,y2], y up). One rect per touched text item, char positions
 * approximated by proportional width.
 */
export function rectsForRange(spans, start, end) {
  const rects = [];
  for (const span of spans) {
    if (span.end <= start || span.start >= end) continue;
    const item = span.item;
    const len = span.end - span.start;
    const from = Math.max(start, span.start) - span.start;
    const to = Math.min(end, span.end) - span.start;
    const w = item.width || 0;
    const h = item.height || 8;
    const x = item.transform[4] + (w * from) / len;
    const x2 = item.transform[4] + (w * to) / len;
    const y = item.transform[5];
    rects.push([x, y - h * 0.28, x2, y + h * 1.02]);
  }
  return rects;
}
