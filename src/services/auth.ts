import * as vscode from 'vscode';
import { AuthError } from '../core/errors';
import type { Logger } from '../core/logger';
import type { CsesClient } from './csesClient';
import type { StoredCookie } from './cookieJar';
import { extractCsrfToken, parseIdentity } from './identity';

export interface Session {
  readonly username: string;
  readonly userId?: string;
  readonly cookies: readonly StoredCookie[];
  readonly createdAt: number;
}

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

const SESSION_KEY = 'cses.session';
const CREDENTIALS_KEY = 'cses.credentials';

/** Owns the CSES login lifecycle. */
export { extractCsrfToken, parseIdentity };

export class AuthService implements vscode.Disposable {
  private readonly log: Logger;
  private readonly changed = new vscode.EventEmitter<Session | undefined>();
  private session: Session | undefined;

  readonly onDidChangeSession = this.changed.event;

  constructor(
    private readonly client: CsesClient,
    private readonly secrets: vscode.SecretStorage,
    logger: Logger,
  ) {
    this.log = logger.scoped('auth');
  }

  get currentSession(): Session | undefined {
    return this.session;
  }

  get isAuthenticated(): boolean {
    return this.session !== undefined;
  }

  /** Restores a stored session at activation, without contacting the network. */
  async restore(): Promise<Session | undefined> {
    const raw = await this.secrets.get(SESSION_KEY);
    if (!raw) {
      return undefined;
    }
    try {
      const session = JSON.parse(raw) as Session;
      this.client.restoreSession(session.cookies);
      this.session = session;
      this.changed.fire(session);
      this.log.info(`Restored session for ${session.username}`);
      return session;
    } catch (error) {
      this.log.warn(`Discarding unreadable stored session: ${String(error)}`);
      await this.secrets.delete(SESSION_KEY);
      return undefined;
    }
  }

  /** Signs in with username and password. */
  async login(credentials: Credentials, remember: boolean): Promise<Session> {
    this.client.clearSession();

    const page = await this.client.get('/login');
    const token = extractCsrfToken(page.body);
    if (!token) {
      throw new AuthError(
        'Could not find the login form CSRF token. The CSES login page may have changed.',
      );
    }

    const response = await this.client.postForm('/login', {
      csrf_token: token,
      nick: credentials.username,
      pass: credentials.password,
    });

    const identity = parseIdentity(response.body);
    if (!identity) {
      throw new AuthError(
        extractLoginError(response.body) ?? 'Login failed. Check your username and password.',
      );
    }

    const session: Session = {
      username: identity.username,
      ...(identity.userId ? { userId: identity.userId } : {}),
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
    this.log.info(`Signed in as ${session.username}`);
    return session;
  }

  async ensureAuthenticated(): Promise<Session> {
    if (!this.session) {
      throw new AuthError('Not signed in. Run "CSES: Login" first.');
    }

    const identity = await this.probeIdentity();
    if (identity) {
      return this.session;
    }

    this.log.info('Stored session expired; attempting silent re-login');
    const saved = await this.savedCredentials();
    if (!saved) {
      await this.clearSession();
      throw new AuthError('Your CSES session expired. Run "CSES: Login" to sign in again.');
    }
    return this.login(saved, true);
  }

  /** Reads the current identity from the site, or undefined when anonymous. */
  private async probeIdentity(): Promise<{ username: string; userId?: string } | undefined> {
    try {
      const response = await this.client.get('/problemset/');
      return parseIdentity(response.body);
    } catch (error) {
      this.log.warn(`Could not verify session: ${String(error)}`);
      // A network blip is not proof of logout.
      return this.session ? { username: this.session.username } : undefined;
    }
  }

  private async savedCredentials(): Promise<Credentials | undefined> {
    const raw = await this.secrets.get(CREDENTIALS_KEY);
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as Credentials;
    } catch {
      await this.secrets.delete(CREDENTIALS_KEY);
      return undefined;
    }
  }

  async logout(): Promise<void> {
    try {
      // Best-effort server-side invalidation; local state is cleared regardless.
      await this.client.get('/logout');
    } catch (error) {
      this.log.debug(`Server logout failed, clearing locally anyway: ${String(error)}`);
    }
    await this.clearSession();
    this.log.info('Signed out');
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

/** Surfaces the site's own error text so the user sees the real reason. */
function extractLoginError(html: string): string | undefined {
  const match = /Invalid username or password/i.exec(html);
  return match ? 'Invalid username or password.' : undefined;
}
