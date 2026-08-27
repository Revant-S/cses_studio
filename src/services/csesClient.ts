import * as net from 'node:net';
import { NetworkError } from '../core/errors';
import type { Logger } from '../core/logger';
import { CookieJar, type StoredCookie } from './cookieJar';

export const CSES_ORIGIN = 'https://cses.fi';

const USER_AGENT =
  'Mozilla/5.0 (compatible; CSES-Studio VS Code extension; +https://github.com/cses-studio)';

const MAX_GET_ATTEMPTS = 3;
const MAX_POST_ATTEMPTS = 3;
const MAX_REDIRECTS = 8;
const RETRY_BASE_DELAY_MS = 600;

/** How long a single address gets to complete its connect. */
const CONNECT_ATTEMPT_WINDOW_MS = 1_500;

let connectWindowWidened = false;

/** Widens the connect window process-wide, once. */
function widenConnectAttemptWindow(log: Logger): void {
  if (connectWindowWidened) {
    return;
  }
  connectWindowWidened = true;

  try {
    const current = net.getDefaultAutoSelectFamilyAttemptTimeout?.();
    if (typeof current === 'number' && current >= CONNECT_ATTEMPT_WINDOW_MS) {
      return;
    }
    net.setDefaultAutoSelectFamilyAttemptTimeout?.(CONNECT_ATTEMPT_WINDOW_MS);
    log.debug(
      `Connect attempt window raised from ${current ?? 'the default'}ms to ${CONNECT_ATTEMPT_WINDOW_MS}ms`,
    );
  } catch (error) {
    log.debug(`Could not raise the connect attempt window: ${String(error)}`);
  }
}

/** Transport failures worth retrying. */
const TRANSIENT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
]);

/** Codes and syscalls raised while a connection is still being established. */
const CONNECT_SYSCALLS = new Set(['connect', 'getaddrinfo', 'lookup', 'querya', 'queryaaaa']);
const CONNECT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ENOTFOUND', 'EAI_AGAIN']);

/** One link in a failure chain, as `fetch` reports it. */
interface TransportFailure {
  readonly code?: string;
  readonly syscall?: string;
  /** No nested error underneath, i.e. the actual thing that went wrong. */
  readonly leaf: boolean;
}

function isTransient(error: unknown): boolean {
  return collectFailures(error).some(
    (failure) => failure.code !== undefined && TRANSIENT_CODES.has(failure.code),
  );
}

/** True when the request provably never left this machine. */
function isConnectFailure(error: unknown): boolean {
  const leaves = collectFailures(error).filter((failure) => failure.leaf);
  return (
    leaves.length > 0 &&
    leaves.every(
      (failure) =>
        (failure.syscall !== undefined && CONNECT_SYSCALLS.has(failure.syscall.toLowerCase())) ||
        (failure.code !== undefined && CONNECT_CODES.has(failure.code)),
    )
  );
}

function collectFailures(error: unknown, depth = 0): TransportFailure[] {
  if (depth > 4 || !(error instanceof Error)) {
    return [];
  }

  const nested: TransportFailure[] = [];
  const aggregated = (error as AggregateError & { errors?: unknown }).errors;
  if (Array.isArray(aggregated)) {
    for (const child of aggregated) {
      nested.push(...collectFailures(child, depth + 1));
    }
  }
  nested.push(...collectFailures((error as Error & { cause?: unknown }).cause, depth + 1));

  const code = (error as Error & { code?: unknown }).code;
  const syscall = (error as Error & { syscall?: unknown }).syscall;
  return [
    {
      ...(typeof code === 'string' ? { code } : {}),
      ...(typeof syscall === 'string' ? { syscall } : {}),
      leaf: nested.length === 0,
    },
    ...nested,
  ];
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Request bodies this client sends. */
type RequestBody = string | URLSearchParams | FormData;

export interface HttpResponse {
  readonly status: number;
  readonly url: string;
  readonly body: string;
  readonly headers: Headers;
}

export interface RequestOptions {
  /** Aborts the request when the caller's operation is cancelled. */
  readonly signal?: AbortSignal;
  /** Overall timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Follow redirects (default) or surface the 30x response as-is. */
  readonly redirect?: 'follow' | 'manual';
  /** Page this request originates from, sent as `Referer`. */
  readonly referer?: string;
}

export class CsesClient {
  private jar = new CookieJar();

  constructor(
    private readonly log: Logger,
    private readonly origin: string = CSES_ORIGIN,
  ) {
    widenConnectAttemptWindow(log);
  }

  get baseUrl(): string {
    return this.origin;
  }

  resolve(pathname: string): string {
    return new URL(pathname, this.origin).toString();
  }

  async get(pathname: string, options: RequestOptions = {}): Promise<HttpResponse> {
    return this.request('GET', pathname, undefined, options);
  }

  /** Submits `application/x-www-form-urlencoded` data, as the login form does. */
  async postForm(
    pathname: string,
    fields: Record<string, string>,
    options: RequestOptions = {},
  ): Promise<HttpResponse> {
    const body = new URLSearchParams(fields);
    return this.request('POST', pathname, body, options);
  }

  /** Submits `multipart/form-data`, as the solution upload form does. */
  async postMultipart(
    pathname: string,
    fields: Record<string, string>,
    file: { field: string; filename: string; content: string; contentType?: string },
    options: RequestOptions = {},
  ): Promise<HttpResponse> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      form.set(key, value);
    }
    const blob = new Blob([file.content], {
      type: file.contentType ?? 'application/octet-stream',
    });
    form.set(file.field, blob, file.filename);
    return this.request('POST', pathname, form, options);
  }

  /** Sends a request, retrying transport failures that can be replayed safely. */
  private async request(
    method: string,
    pathname: string,
    body: RequestBody | undefined,
    options: RequestOptions,
  ): Promise<HttpResponse> {
    const attempts = method === 'GET' ? MAX_GET_ATTEMPTS : MAX_POST_ATTEMPTS;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.attempt(method, pathname, body, options);
      } catch (error) {
        lastError = error;
        const replayable = method === 'GET' ? isTransient(error) : isConnectFailure(error);
        const retriable = attempt < attempts && replayable && !options.signal?.aborted;
        if (!retriable) {
          break;
        }
        const backoffMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        this.log.warn(
          `${method} ${pathname} failed (attempt ${attempt}/${attempts}); retrying in ${backoffMs}ms`,
        );
        await sleep(backoffMs, options.signal);
      }
    }
    throw lastError;
  }

  private async attempt(
    method: string,
    pathname: string,
    body: RequestBody | undefined,
    options: RequestOptions,
  ): Promise<HttpResponse> {
    const url = this.resolve(pathname);
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 20_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    const cookie = this.jar.toHeader();
    if (cookie) {
      headers['Cookie'] = cookie;
    }
    if (method === 'POST') {
      headers['Origin'] = this.origin;
      // A browser sends the page the form lived on, not the POST target.
      headers['Referer'] = options.referer ? this.resolve(options.referer) : url;
    }

    this.log.debug(`${method} ${url}`);
    const started = Date.now();

    try {
      // Follow redirects manually so Set-Cookie on each hop lands in the jar.
      let currentUrl = url;
      let currentMethod = method;
      let currentBody: RequestBody | undefined = body;
      let currentHeaders = headers;

      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const response = await fetch(currentUrl, {
          method: currentMethod,
          headers: currentHeaders,
          body: currentBody,
          redirect: 'manual',
          signal: controller.signal,
        });
        this.jar.acceptFrom(response.headers);

        const location = response.headers.get('location');
        const isRedirect = response.status >= 300 && response.status < 400 && location;

        if (!isRedirect || options.redirect === 'manual') {
          const text = await response.text();
          this.log.debug(
            `${currentMethod} ${currentUrl} -> ${response.status} in ${Date.now() - started}ms`,
          );
          return {
            status: response.status,
            url: currentUrl,
            body: text,
            headers: response.headers,
          };
        }

        // Drain the body so the socket can be reused, then hop.
        await response.text();
        currentUrl = new URL(location, currentUrl).toString();
        // 303, and 301/302 in practice, turn the follow-up into a bodyless GET.
        currentMethod = 'GET';
        currentBody = undefined;
        currentHeaders = this.redirectHeaders();
        this.log.debug(`↳ ${response.status} redirect to ${currentUrl}`);
      }

      throw new NetworkError(`Too many redirects starting from ${url}`);
    } catch (error) {
      if (controller.signal.aborted && !options.signal?.aborted) {
        throw new NetworkError(`Request to ${url} timed out after ${timeoutMs}ms`, error);
      }
      throw new NetworkError(`Request to ${url} failed: ${describe(error)}`, error);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /** Headers for a followed redirect: the current jar, no Origin/Referer/body. */
  private redirectHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    const cookie = this.jar.toHeader();
    if (cookie) {
      headers['Cookie'] = cookie;
    }
    return headers;
  }

  // -- Session handling ------------------------------------------------------

  exportSession(): StoredCookie[] {
    return this.jar.export();
  }

  restoreSession(cookies: readonly StoredCookie[]): void {
    this.jar = CookieJar.from(cookies);
  }

  clearSession(): void {
    this.jar.clear();
  }

  hasSessionCookie(): boolean {
    return this.jar.get('PHPSESSID') !== undefined;
  }
}

/** Renders a network failure into something actionable. */
function describe(error: unknown): string {
  const details = collectCauses(error);
  if (details.length === 0) {
    return error instanceof Error ? error.message : String(error);
  }
  const head = error instanceof Error ? error.message : String(error);
  return `${head} (${details.join('; ')})`;
}

function collectCauses(error: unknown, depth = 0): string[] {
  if (depth > 4 || !(error instanceof Error)) {
    return [];
  }

  const details: string[] = [];
  const code = (error as Error & { code?: unknown }).code;

  if (depth > 0) {
    const label = [typeof code === 'string' ? code : undefined, error.message]
      .filter((part) => part)
      .join(': ');
    if (label) {
      details.push(label);
    }
  }

  // AggregateError carries the per-address failures in `errors`, not `cause`.
  const aggregated = (error as AggregateError & { errors?: unknown }).errors;
  if (Array.isArray(aggregated)) {
    for (const nested of aggregated) {
      details.push(...collectCauses(nested, depth + 1));
    }
  }

  details.push(...collectCauses((error as Error & { cause?: unknown }).cause, depth + 1));
  return details;
}
