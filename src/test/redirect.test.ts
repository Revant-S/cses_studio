import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { nullLogger } from '../core/logger';
import { CsesClient } from '../services/csesClient';

/** Guards the login redirect fix. */

let server: http.Server;
let origin: string;

before(async () => {
  server = http.createServer((req, res) => {
    const cookie = req.headers.cookie ?? '';

    if (req.url === '/login' && req.method === 'POST') {
      // Success: set the auth cookie on the 302 and redirect to a gated page.
      res.writeHead(302, { 'Set-Cookie': 'SESSION=authed; Path=/', Location: '/home' });
      res.end();
      return;
    }
    if (req.url === '/home') {
      if (cookie.includes('SESSION=authed')) {
        res.writeHead(200);
        res.end('welcome');
      } else {
        res.writeHead(302, { Location: '/login' });
        res.end();
      }
      return;
    }
    if (req.url === '/chain/1') {
      res.writeHead(302, { 'Set-Cookie': 'A=1; Path=/', Location: '/chain/2' });
      res.end();
      return;
    }
    if (req.url === '/chain/2') {
      res.writeHead(302, { 'Set-Cookie': 'B=2; Path=/', Location: '/chain/3' });
      res.end();
      return;
    }
    if (req.url === '/chain/3') {
      res.writeHead(200);
      res.end(`cookies:${cookie}`);
      return;
    }
    if (req.url === '/loop') {
      res.writeHead(302, { Location: '/loop' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

describe('redirect handling', () => {
  it('keeps a cookie set on the login 302 and lands on the gated page', async () => {
    const client = new CsesClient(nullLogger, origin);
    const response = await client.postForm('/login', { u: 'x' });

    assert.equal(response.status, 200);
    assert.match(response.url, /\/home$/);
    assert.equal(response.body, 'welcome');
    assert.ok(client.exportSession().some((c) => c.name === 'SESSION' && c.value === 'authed'));
  });

  it('accumulates cookies across a multi-hop redirect chain', async () => {
    const client = new CsesClient(nullLogger, origin);
    const response = await client.get('/chain/1');

    assert.match(response.body, /A=1/);
    assert.match(response.body, /B=2/);
  });

  it('surfaces the 30x itself when redirect is manual', async () => {
    const client = new CsesClient(nullLogger, origin);
    const response = await client.get('/home', { redirect: 'manual' });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login');
  });

  it('gives up on a redirect loop instead of hanging', async () => {
    const client = new CsesClient(nullLogger, origin);
    await assert.rejects(() => client.get('/loop'), /Too many redirects/);
  });
});
