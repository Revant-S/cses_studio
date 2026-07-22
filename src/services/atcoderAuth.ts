import * as vscode from 'vscode';
import { AuthError } from '../core/errors';
import type { Logger } from '../core/logger';
import type { StoredCookie } from './cookieJar';
import type { CsesClient } from './csesClient';
import { extractCsrfToken } from './identity';

export { extractCsrfToken };

export interface AtCoderSession {
  readonly username: string;
  readonly cookies: readonly StoredCookie[];
  readonly createdAt: number;
}

export interface AtCoderCredentials {
  readonly username: string;
  readonly password: string;
}

const SESSION_KEY = 'atcoder.session';
const CREDENTIALS_KEY = 'atcoder.credentials';

/** AtCoder sign-in. */
export class AtCoderAuthService implements vscode.Disposable {
  private readonly log: Logger;
  private readonly changed = new vscode.EventEmitter<AtCoderSession | undefined>();
  private session: AtCoderSession | undefined;

  readonly onDidChangeSession = this.changed.event;

  constructor(
    private readonly client: CsesClient,
    private readonly secrets: vscode.SecretStorage,
    logger: Logger,
  ) {
    this.log = logger.scoped('atcoder-auth');
  }

  get currentSession(): AtCoderSession | undefined {
    return this.session;
  }

  get isAuthenticated(): boolean {
    return this.session !== undefined;
  }

  /** Restores a stored session at activation without touching the network. */
  async restore(): Promise<AtCoderSession | undefined> {
    const raw = await this.secrets.get(SESSION_KEY);
    if (!raw) {
      return undefined;
    }
    try {
      const session = JSON.parse(raw) as AtCoderSession;
      this.client.restoreSession(session.cookies);
      this.session = session;
      this.changed.fire(session);
      this.log.info(`Restored AtCoder session for ${session.username}`);
      return session;
    } catch (error) {
      this.log.warn(`Discarding unreadable AtCoder session: ${String(error)}`);
      await this.secrets.delete(SESSION_KEY);
      return undefined;
    }
  }

  async login(credentials: AtCoderCredentials, remember: boolean): Promise<AtCoderSession> {
    this.client.clearSession();

    // This GET is what mints the session cookie the token is tied to.
    const page = await this.client.get('/login');
    const token = extractCsrfToken(page.body);
    if (!token) {
      throw new AuthError(
        'Could not read the AtCoder login token. The login page layout may have changed.',
      );
    }

    const response = await this.client.postForm(
      '/login',
      {
        csrf_token: token,
        username: credentials.username,
        password: credentials.password,
      },
      { referer: '/login' },
    );

    const flash = readFlash(response.headers);
    const stayedOnLogin = /\/login/.test(response.url);
    if (stayedOnLogin || flash.error) {
      throw new AuthError(
        flash.message ?? 'AtCoder rejected the sign-in. Check your username and password.',
      );
    }

    const session: AtCoderSession = {
      username: credentials.username,
      cookies: this.client.exportSession(),
      createdAt: Date.now(),
    };

    await this.secrets.store(SESSION_KEY, JSON.stringify(session));
    if (remember) {
      await this.secrets.store(CREDENTIALS_KEY, JSON.stringify(credentials));
    } else {
      await this.secrets.delete(CREDENTIALS_KEY);
    }

    this.session = session;
    this.changed.fire(session);
    this.log.info(`Signed in to AtCoder as ${session.username}`);
    return session;
  }

  async ensureAuthenticated(): Promise<AtCoderSession> {
    if (!this.session) {
      throw new AuthError('Not signed in to AtCoder. Run "CSES: Login to AtCoder" first.');
    }

    if (await this.probeSignedIn()) {
      return this.session;
    }

    this.log.info('AtCoder session expired; attempting silent re-login');
    const saved = await this.savedCredentials();
    if (!saved) {
      await this.clearSession();
      throw new AuthError('Your AtCoder session expired. Sign in again.');
    }
    return this.login(saved, true);
  }

  private async probeSignedIn(): Promise<boolean> {
    try {
      const response = await this.client.get('/contests/dp/submit');
      return !/\/login/.test(response.url);
    } catch (error) {
      // A network blip is not proof of logout; keep the session as-is.
      this.log.warn(`Could not verify AtCoder session: ${String(error)}`);
      return true;
    }
  }

  private async savedCredentials(): Promise<AtCoderCredentials | undefined> {
    const raw = await this.secrets.get(CREDENTIALS_KEY);
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as AtCoderCredentials;
    } catch {
      await this.secrets.delete(CREDENTIALS_KEY);
      return undefined;
    }
  }

  async logout(): Promise<void> {
    await this.clearSession();
    this.log.info('Signed out of AtCoder');
  }

  private async clearSession(): Promise<void> {
    this.client.clearSession();
    this.session = undefined;
    await this.secrets.delete(SESSION_KEY);
    await this.secrets.delete(CREDENTIALS_KEY);
    this.changed.fire(undefined);
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/** Reads AtCoder's `REVEL_FLASH` cookie. */
function readFlash(headers: Headers): { error: boolean; message?: string } {
  const raw = readSetCookie(headers).find((value) => value.startsWith('REVEL_FLASH='));
  if (!raw) {
    return { error: false };
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw.slice('REVEL_FLASH='.length).split(';')[0] ?? '');
  } catch {
    return { error: false };
  }

  // Fields are NUL-separated; splitting avoids a control character in a regex.
  const field = decoded.split('\u0000').find((part) => part.startsWith('error:'));
  if (field === undefined) {
    return { error: false };
  }
  const text = field.slice('error:'.length).trim();
  // AtCoder's text is often just "Error."; a generic message beats echoing that.
  const useful = text && !/^error\.?$/i.test(text) ? text : undefined;
  return { error: true, ...(useful ? { message: useful } : {}) };
}

function readSetCookie(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === 'function') {
    return withGetter.getSetCookie();
  }
  const raw = headers.get('set-cookie');
  return raw ? raw.split(/,\s*(?=[^;,\s]+=)/) : [];
}
