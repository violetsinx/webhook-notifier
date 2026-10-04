import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';

const LEVEL_COLOR = { info: 0x5865f2, success: 0x57f287, warning: 0xfee75c, error: 0xed4245 };

// Minimal SMTP client: implicit TLS (465) or plain + STARTTLS + AUTH LOGIN.
function smtpSend(cfg, { subject, text }) {
  return new Promise((resolve, reject) => {
    let socket = cfg.secure
      ? tls.connect(cfg.port, cfg.host, { servername: cfg.host })
      : net.connect(cfg.port, cfg.host);
    socket.setTimeout(15_000);
    let buf = '';
    let pending = null; // { code, lines, resolve, reject }
    let dead = false;

    const finish = (err, value) => {
      if (dead) return;
      dead = true;
      socket.destroy();
      err ? reject(err) : resolve(value);
    };
    const onErr = (e) => finish(e);

    const attach = (s) => {
      s.on('data', (d) => {
        buf += d.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx + 1).trim();
          buf = buf.slice(idx + 1);
          if (!pending) continue;
          pending.lines.push(line);
          if (/^\d{3} /.test(line)) {
            const code = Number(line.slice(0, 3));
            const p = pending;
            pending = null;
            if (code >= 400) p.reject(new Error(`SMTP ${code}: ${p.lines.join(' | ')}`));
            else p.resolve({ code, lines: p.lines });
          }
        }
      });
      s.on('error', onErr);
      s.on('timeout', () => finish(new Error('SMTP timeout')));
      s.on('close', () => finish(new Error('SMTP connection closed early')));
    };
    attach(socket);

    const read = () => new Promise((res, rej) => { pending = { lines: [], resolve: res, reject: rej }; });
    const send = (line) => socket.write(line + '\r\n');
    const ehlo = async () => {
      send('EHLO localhost');
      const r = await read();
      return new Set(r.lines.flatMap((l) => l.slice(4).trim().split(/\s+/).filter(Boolean)));
    };
    const cmd = async (line, expect) => {
      send(line);
      return read();
    };

    (async () => {
      const greet = await read();
      if (greet.code !== 220) throw new Error(`SMTP greeting ${greet.code}`);
      let caps = await ehlo();
      if (!cfg.secure && caps.has('STARTTLS')) {
        const r = await cmd('STARTTLS');
        if (r.code !== 220) throw new Error(`STARTTLS ${r.code}`);
        socket.removeAllListeners();
        socket = tls.connect({ socket, servername: cfg.host });
        attach(socket);
        await new Promise((res, rej) => {
          socket.once('secureConnect', res);
          socket.once('error', rej);
        });
        caps = await ehlo();
      }
      if (cfg.user) {
        let r = await cmd('AUTH LOGIN');
        if (r.code !== 334) throw new Error(`AUTH LOGIN ${r.code}`);
        r = await cmd(Buffer.from(cfg.user, 'utf8').toString('base64'));
        if (r.code !== 334) throw new Error(`AUTH user ${r.code}`);
        r = await cmd(Buffer.from(cfg.pass || '', 'utf8').toString('base64'));
        if (r.code !== 235) throw new Error(`AUTH pass ${r.code}`);
      }
      let r = await cmd(`MAIL FROM:<${cfg.from}>`);
      if (r.code !== 250) throw new Error(`MAIL FROM ${r.code}`);
      r = await cmd(`RCPT TO:<${cfg.to}>`);
      if (r.code !== 250) throw new Error(`RCPT TO ${r.code}`);
      r = await cmd('DATA');
      if (r.code !== 354) throw new Error(`DATA ${r.code}`);
      const body = [
        `From: ${cfg.from}`,
        `To: ${cfg.to}`,
        `Subject: ${subject}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        text.replace(/\r?\n/g, '\r\n'),
        '.',
      ].join('\r\n');
      send(body);
      r = await read();
      if (r.code !== 250) throw new Error(`message rejected ${r.code}`);
      send('QUIT');
      finish(null, true);
    })().catch(finish);
  });
}

export function createNotifiers(config, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const notifiers = {};

  if (config.discordUrl) {
    notifiers.discord = async ({ title, message, level }) => {
      const res = await fetchImpl(config.discordUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'webhook-notifier',
          embeds: [{
            title: title || 'Notification',
            description: message,
            color: LEVEL_COLOR[level] || LEVEL_COLOR.info,
            timestamp: new Date().toISOString(),
          }],
        }),
        signal: AbortSignal.timeout(10_000),
      }).catch((err) => { const e = new Error(`Discord request failed: ${err.message}`); e.cause = err.cause ?? err; throw e; });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const e = new Error(`Discord webhook HTTP ${res.status}`);
        e.cause = text.slice(0, 200);
        throw e;
      }
    };
  }

  const email = config.email;
  if (email.host && email.from && email.to) {
    notifiers.email = async ({ title, message, level }) => {
      await smtpSend(email, {
        subject: `[${level}] ${title || 'Notification'}`,
        text: message,
      });
    };
  }

  if (config.dryRun) {
    for (const name of ['discord', 'email']) {
      notifiers[name] = async (msg) => { console.log(`[dry-run] ${name}:`, JSON.stringify(msg)); };
    }
  }

  return notifiers;
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        const e = new Error('payload too large');
        e.status = 413;
        req.destroy();
        reject(e);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createApp(config, { notifiers } = {}) {
  const channels = notifiers ?? createNotifiers(config);

  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return send(res, 200, { ok: true, dryRun: config.dryRun, channels: Object.keys(channels) });
      }
      if (req.url !== '/webhook') {
        return send(res, 404, { ok: false, error: 'not found' });
      }
      if (req.method !== 'POST') {
        return send(res, 405, { ok: false, error: 'method not allowed, use POST' });
      }
      if (config.token) {
        const auth = req.headers.authorization || '';
        if (auth !== `Bearer ${config.token}`) {
          return send(res, 401, { ok: false, error: 'unauthorized' });
        }
      }

      const raw = await readBody(req, 64 * 1024);
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        return send(res, 400, { ok: false, error: 'invalid JSON' });
      }
      if (!payload || typeof payload.message !== 'string' || !payload.message.trim()) {
        return send(res, 400, { ok: false, error: '"message" is required and must be a non-empty string' });
      }

      const level = ['info', 'success', 'warning', 'error'].includes(payload.level) ? payload.level : 'info';
      const msg = {
        title: typeof payload.title === 'string' ? payload.title : '',
        message: payload.message.trim(),
        level,
      };

      const names = Object.keys(channels);
      if (names.length === 0) {
        return send(res, 503, { ok: false, error: 'no notification channels configured' });
      }

      const results = await Promise.all(names.map(async (channel) => {
        try {
          await channels[channel](msg);
          return { channel, ok: true };
        } catch (err) {
          console.error(`[${channel}] failed:`, err.message);
          return { channel, ok: false, error: err.message };
        }
      }));

      const okCount = results.filter((r) => r.ok).length;
      send(res, okCount > 0 ? 200 : 502, { ok: okCount > 0, dryRun: config.dryRun, results });
    } catch (err) {
      send(res, err.status || 500, { ok: false, error: err.message || 'internal error' });
    }
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const config = loadConfig();
  const app = createApp(config);
  app.listen(config.port, () => {
    console.log(`webhook-notifier listening on :${config.port} dryRun=${config.dryRun} channels=${Object.keys(createNotifiers(config)).join(',') || 'none'}`);
  });
}
