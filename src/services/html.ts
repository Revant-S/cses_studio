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

/** Attributes that can carry a URL in a scraped statement. */
const URL_ATTRIBUTES = ['src', 'href'] as const;

/**
 * Rewrites site-relative URLs in a statement to absolute ones.
 *
 * Statements render inside a webview served from `vscode-webview://…`, so a
 * relative `src="/file/abc"` resolves against that origin and the image never
 * loads. Resolving against the problem's own page URL keeps images and links
 * pointing back at the judge. Absolute URLs pass through untouched, so this is
 * safe to apply to a statement that was already normalized.
 */
export function resolveUrls(html: string, baseUrl: string): string {
  if (!html.trim()) {
    return html;
  }

  const root = parseHtml(html);
  let rewritten = false;

  for (const element of root.querySelectorAll('[src], [href]')) {
    for (const name of URL_ATTRIBUTES) {
      const value = element.getAttribute(name);
      // In-page anchors must stay relative or they stop scrolling the panel.
      if (value === undefined || value === '' || value.startsWith('#')) {
        continue;
      }
      const absolute = toAbsoluteUrl(value, baseUrl);
      if (absolute && absolute !== value) {
        element.setAttribute(name, absolute);
        rewritten = true;
      }
    }
  }
  return rewritten ? root.toString() : html;
}

function toAbsoluteUrl(value: string, baseUrl: string): string | undefined {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    // A URL neither the parser nor a browser can make sense of; leave it be.
    return undefined;
  }
}
