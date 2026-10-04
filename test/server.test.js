import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

const baseConfig = {
  port: 0,
  token: 'secret',
  dryRun: true,
  discordUrl: '',
  email: { host: '', port: 465, secure: true, user: '', pass: '', from: '', to: '' },
};

async function withServer(notifiers, fn) {
  const app = createApp(baseConfig, { notifiers });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const { port } = app.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

function post(base, body, headers = {}) {
  return fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret', ...headers },
    body,
  });
}

test('GET /health', () => withServer({ discord: async () => {} }, async (base) => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.channels, ['discord']);
}));

test('POST /webhook 401 unauthorized', () => withServer({ discord: async () => {} }, async (base) => {
  const res = await post(base, JSON.stringify({ message: 'hi' }), { authorization: 'Bearer wrong' });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.ok, false);
}));

test('POST /webhook 200 success', () => withServer({ discord: async () => {}, email: async () => {} }, async (base) => {
  const res = await post(base, JSON.stringify({ title: 'Deploy', message: 'v1.2.3 live', level: 'success' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.results.length, 2);
  assert.ok(body.results.every((r) => r.ok));
}));

test('POST /webhook 400 invalid JSON', () => withServer({ discord: async () => {} }, async (base) => {
  const res = await post(base, '{invalid');
  assert.equal(res.status, 400);
}));

test('POST /webhook 400 empty message', () => withServer({ discord: async () => {} }, async (base) => {
  const res = await post(base, JSON.stringify({ message: '   ' }));
  assert.equal(res.status, 400);
}));

test('POST /webhook 502 all channels fail', () => withServer({ discord: async () => { throw new Error('boom'); } }, async (base) => {
  const res = await post(base, JSON.stringify({ message: 'hi' }));
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.results[0].error, 'boom');
}));

test('POST /webhook 503 no channels', () => withServer({}, async (base) => {
  const res = await post(base, JSON.stringify({ message: 'hi' }));
  assert.equal(res.status, 503);
}));
