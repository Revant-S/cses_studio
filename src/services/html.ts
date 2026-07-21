import { type HTMLElement, parse } from 'node-html-parser';

export { type HTMLElement };

/** Parses a cses.fi page. */
export function parseHtml(html: string): HTMLElement {
  return parse(closeImpliedOptionTags(html), {
    lowerCaseTagName: false,
    comment: false,
    blockTextElements: { script: true, noscript: true, style: true, pre: true },
  });
}

/** Inserts the `</option>` end tags HTML5 only implies. */
function closeImpliedOptionTags(html: string): string {
  return html.replace(/<select\b[^>]*>[\s\S]*?<\/select>/gi, (block) =>
    block.replace(
      /(<option\b[^>]*>)([^<]*?)(?=\s*(?:<option\b|<optgroup\b|<\/optgroup>|<\/select>))/gi,
      '$1$2</option>',
    ),
  );
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

/** Decodes the handful of entities CSES emits, plus numeric references. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (match) => ENTITIES[match] ?? match)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

/** Collapses whitespace and decodes entities. */
export function normalizeText(text: string): string {
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

export function preformattedText(element: HTMLElement): string {
  const text = decodeEntities(
    element.innerHTML.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''),
  );
  return `${text.replace(/\r\n/g, '\n').replace(/\s+$/, '')}\n`;
}

/** Elements never worth keeping from a scraped statement. */
const FORBIDDEN_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'form',
  'input',
  'button',
]);

export function sanitizeHtml(root: HTMLElement): HTMLElement {
  for (const element of root.querySelectorAll('*')) {
    const tag = element.rawTagName?.toLowerCase();
    if (tag && FORBIDDEN_TAGS.has(tag)) {
      element.remove();
      continue;
    }
    for (const name of Object.keys(element.attributes)) {
      const lower = name.toLowerCase();
      const value = element.getAttribute(name) ?? '';
      // Drop every event handler, plus javascript:/data: URLs on links and images.
      if (lower.startsWith('on') || /^\s*javascript:/i.test(value)) {
        element.removeAttribute(name);
      } else if ((lower === 'href' || lower === 'src') && /^\s*data:/i.test(value)) {
        element.removeAttribute(name);
      }
    }
  }
  return root;
}
