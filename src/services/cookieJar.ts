/** A single cookie retained for the cses.fi session. */
export interface StoredCookie {
  readonly name: string;
  readonly value: string;
}

/** Minimal cookie store. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  /** Records cookies from a response's `Set-Cookie` headers. */
  acceptFrom(headers: Headers): void {
    for (const header of readSetCookieHeaders(headers)) {
      const [pair] = header.split(';');
      if (!pair) {
        continue;
      }
      const separator = pair.indexOf('=');
      if (separator <= 0) {
        continue;
      }
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      // An empty value with an expiry in the past is the server clearing it.
      if (value === '' || value === 'deleted') {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  /** Serializes the jar into a `Cookie` request header, or undefined if empty. */
  toHeader(): string | undefined {
    if (this.cookies.size === 0) {
      return undefined;
    }
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  clear(): void {
    this.cookies.clear();
  }

  /** Cookies that must never be written to disk. */
  private static readonly NON_PERSISTENT = new Set(['REVEL_FLASH']);

  /** Serializes the jar for storage, omitting anything sensitive or transient. */
  export(): StoredCookie[] {
    return [...this.cookies]
      .filter(([name]) => !CookieJar.NON_PERSISTENT.has(name))
      .map(([name, value]) => ({ name, value }));
  }

  static from(cookies: readonly StoredCookie[]): CookieJar {
    const jar = new CookieJar();
    for (const { name, value } of cookies) {
      jar.set(name, value);
    }
    return jar;
  }
}

function readSetCookieHeaders(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === 'function') {
    return withGetter.getSetCookie();
  }
  const raw = headers.get('set-cookie');
  if (!raw) {
    return [];
  }
  // Split only before `name=`, never inside an `expires=Mon, 01 Jan…` value.
  return raw.split(/,\s*(?=[^;,\s]+=)/);
}
