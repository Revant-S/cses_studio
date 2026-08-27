import assert from 'node:assert/strict';
import * as net from 'node:net';
import { describe, it } from 'node:test';
import { nullLogger } from '../core/logger';
import { CsesClient } from '../services/csesClient';

/** Guards the "connect ETIMEDOUT" submission failure. */

/** The failure `fetch` raises when happy-eyeballs exhausts every address. */
function connectFailure(): Error {
  const v4 = Object.assign(new Error('connect ETIMEDOUT 164.92.159.7:443'), {
    code: 'ETIMEDOUT',
    syscall: 'connect',
  });
  const v6 = Object.assign(new Error('connect ENETUNREACH 2a03:b0c0:2:f0::7999:2001:443'), {
    code: 'ENETUNREACH',
    syscall: 'connect',
  });
  // The AggregateError copies a child's code but carries no syscall of its own.
  const aggregate = Object.assign(new AggregateError([v4, v6], ''), { code: 'ETIMEDOUT' });
  return Object.assign(new TypeError('fetch failed'), { cause: aggregate });
}

/** A connection that was established and then broke. */
function midFlightFailure(): Error {
  const reset = Object.assign(new Error('read ECONNRESET'), {
    code: 'ECONNRESET',
    syscall: 'read',
  });
  return Object.assign(new TypeError('fetch failed'), { cause: reset });
}

/** Fails the first `failures` calls with `error`, then answers 200. */
function stubFetch(failures: number, error: Error): { calls: () => number; restore: () => void } {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls <= failures) {
      throw error;
    }
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  return { calls: () => calls, restore: () => (globalThis.fetch = real) };
}

function client(): CsesClient {
  return new CsesClient(nullLogger, 'https://cses.fi');
}

describe('connect failures', () => {
  it('gives a connect attempt enough time to finish a long-haul handshake', () => {
    client();
    assert.ok(
      net.getDefaultAutoSelectFamilyAttemptTimeout() >= 1_000,
      'the 250ms default cuts off a healthy connect to cses.fi',
    );
  });

  it('retries a submission POST when the connection was never established', async () => {
    const stub = stubFetch(1, connectFailure());
    try {
      const response = await client().postMultipart(
        '/course/send.php',
        { csrf: 'token' },
        { field: 'file', filename: 'problem.cpp', content: 'int main(){}' },
      );
      assert.equal(response.status, 200);
      assert.equal(stub.calls(), 2);
    } finally {
      stub.restore();
    }
  });

  it('never replays a POST that may already have reached the server', async () => {
    const stub = stubFetch(1, midFlightFailure());
    try {
      await assert.rejects(
        client().postForm('/login', { nick: 'user', pass: 'secret' }),
        /ECONNRESET/,
      );
      assert.equal(stub.calls(), 1, 'a broken mid-flight POST must not be sent twice');
    } finally {
      stub.restore();
    }
  });

  it('still retries a GET on any transient failure', async () => {
    const stub = stubFetch(2, midFlightFailure());
    try {
      const response = await client().get('/problemset/');
      assert.equal(response.status, 200);
      assert.equal(stub.calls(), 3);
    } finally {
      stub.restore();
    }
  });

  it('gives up after the last allowed attempt', async () => {
    const stub = stubFetch(5, connectFailure());
    try {
      await assert.rejects(
        client().postMultipart(
          '/course/send.php',
          {},
          { field: 'file', filename: 'a.cpp', content: '' },
        ),
        /ETIMEDOUT/,
      );
      assert.equal(stub.calls(), 3);
    } finally {
      stub.restore();
    }
  });
});
