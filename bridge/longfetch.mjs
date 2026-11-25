/**
 * A fetch for REQUESTS THAT MAY STAY SILENT FOR MINUTES (a thinking model on Gemini web).
 * Node's built-in fetch gives up after 5 minutes without a header or a body byte (undici's default), and the bridge then
 * falls back to the slow browser path or fails with "fetch failed". This one uses node:http / node:https, which have no
 * such limit: the only ways it ends are the server answering or the caller's `signal`.
 * It returns just what the bridge needs of a Response: status, ok, headers.get / getSetCookie, text(), json(), and `body`
 * (an async iterable of Buffers, for streams).
 */
import http from 'node:http';
import https from 'node:https';

const httpAgent = new http.Agent({ keepAlive: true, maxFreeSockets: 4, scheduling: 'lifo' });
const httpsAgent = new https.Agent({ keepAlive: true, maxFreeSockets: 4, scheduling: 'lifo' });

export function longFetch(url, { method = 'GET', headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : String(body));
    const h = { 'accept-encoding': 'identity', ...headers }; // plain bytes: no gzip to decode by hand
    if (payload) h['content-length'] = payload.length;
    const req = lib.request(u, { method, headers: h, agent: lib === https ? httpsAgent : httpAgent }, (res) => {
      res.once('close', () => signal?.removeEventListener('abort', onAbort));
      const one = (n) => { const v = res.headers[String(n).toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v ?? null; };
      const text = async () => { const chunks = []; for await (const c of res) chunks.push(c); return Buffer.concat(chunks).toString('utf8'); };
      resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        headers: { get: one, getSetCookie: () => res.headers['set-cookie'] || [] },
        body: res,
        text,
        json: async () => JSON.parse(await text())
      });
    });
    const onAbort = () => req.destroy(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e); });
    req.end(payload);
  });
}
