import { decodeEntities, parseHtml } from './html';

/** Pure page-inspection helpers shared by the auth and submission services. */

/** Reads the signed-in user from a page's header. */
export function parseIdentity(html: string): { username: string; userId?: string } | undefined {
  const root = parseHtml(html);
  const account = root.querySelector('a.account');
  const href = account?.getAttribute('href') ?? '';
  if (!account || !href.includes('/user/')) {
    return undefined;
  }
  const username = account.text.trim();
  if (!username) {
    return undefined;
  }
  const userId = /\/user\/(\d+)/.exec(href)?.[1];
  return { username, ...(userId ? { userId } : {}) };
}

/** Reads the per-form CSRF token both sites require on every POST. */
export function extractCsrfToken(html: string): string | undefined {
  const root = parseHtml(html);
  for (const input of root.querySelectorAll('input[name="csrf_token"]')) {
    const value = input.getAttribute('value');
    if (value) {
      return decodeEntities(value);
    }
  }
  return undefined;
}
