// Request resilience: per-attempt timeout, transient network error classification, bounded
// retries. Every test stubs global fetch - nothing here talks to the real SAIC gateway.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SaicClient, SaicError, SaicTransportError, classifyTransportError, TRANSPORT_RETRY,
} from '../src/saic-client.js';

// ---------------------------------------------------------------------------
// helpers: simulated fetch outcomes
// ---------------------------------------------------------------------------

/** A plaintext JSON response (no app-send-date header, so rawRequest doesn't try to decrypt). */
function response(json, { status = 200, headers = {} } = {}) {
  return {
    status,
    text: async () => (typeof json === 'string' ? json : JSON.stringify(json)),
    headers: { get: (h) => headers[h.toLowerCase()] ?? null },
  };
}

/** What Node 22's fetch throws on a network failure: TypeError "fetch failed" with a coded cause. */
function fetchFailed(code) {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`cause ${code}`), { code }) });
}

/** fetch rejecting once its AbortSignal fires, like a stalled connection hitting the timeout. */
const stalledFetch = (url, { signal }) => new Promise((_, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason));
});

function makeClient(opts = {}) {
  const client = new SaicClient('EU', { log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() }, ...opts });
  client._sleep = vi.fn().mockResolvedValue(undefined); // no real waiting between retries
  return client;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

describe('classifyTransportError', () => {
  it('marks connect timeout, refused connection and DNS failures as "not sent"', () => {
    for (const code of ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
      const err = classifyTransportError(fetchFailed(code));
      expect(err).toBeInstanceOf(SaicTransportError);
      expect(err.notSent).toBe(true);
      expect(err.reason).toBe(code);
    }
  });

  it('marks socket errors, resets and read timeouts as transient but possibly sent', () => {
    for (const code of ['UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']) {
      const err = classifyTransportError(fetchFailed(code));
      expect(err).toBeInstanceOf(SaicTransportError);
      expect(err.notSent).toBe(false);
    }
  });

  it('reads the codes of an AggregateError cause (several addresses tried)', () => {
    const cause = Object.assign(new AggregateError([
      Object.assign(new Error('a'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('b'), { code: 'ECONNREFUSED' }),
    ]), { code: 'ECONNREFUSED' });
    const err = classifyTransportError(Object.assign(new TypeError('fetch failed'), { cause }));
    expect(err.notSent).toBe(true);
  });

  it('treats an abort / timeout as transient and possibly sent', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(classifyTransportError(timeout)).toMatchObject({ notSent: false, reason: 'TimeoutError' });
    expect(classifyTransportError(new DOMException('aborted', 'AbortError'))).toMatchObject({ reason: 'AbortError' });
  });

  it('returns null for anything that is not a transient network problem', () => {
    expect(classifyTransportError(new SaicError('Vehicle not locked', 8))).toBeNull();
    expect(classifyTransportError(new TypeError('fetch failed'))).toBeNull();
    expect(classifyTransportError(fetchFailed('ERR_INVALID_URL'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// rawRequest: timeout and HTTP 5xx / 429
// ---------------------------------------------------------------------------

describe('rawRequest transport handling', () => {
  it('passes an AbortSignal and turns a stalled request into a SaicTransportError', async () => {
    const fetchMock = vi.fn(stalledFetch);
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient({ requestTimeoutMs: 20 });
    const err = await client.rawRequest('GET', '/vehicle/list').catch((e) => e);
    expect(err).toBeInstanceOf(SaicTransportError);
    expect(err.reason).toBe('TimeoutError');
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('turns a network failure into a SaicTransportError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailed('UND_ERR_CONNECT_TIMEOUT')));
    const err = await makeClient().rawRequest('GET', '/vehicle/list').catch((e) => e);
    expect(err).toBeInstanceOf(SaicTransportError);
    expect(err.notSent).toBe(true);
  });

  it('treats HTTP 5xx and 429 from the gateway as transient', async () => {
    for (const status of [502, 503, 429]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('<html>Bad gateway</html>', { status })));
      const err = await makeClient().rawRequest('GET', '/vehicle/list').catch((e) => e);
      expect(err).toBeInstanceOf(SaicTransportError);
      expect(err.code).toBe(status);
    }
  });

  it('leaves API-level errors alone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ code: 8, message: 'Vehicle not locked.' })));
    const err = await makeClient().rawRequest('POST', '/vehicle/control').catch((e) => e);
    expect(err).not.toBeInstanceOf(SaicTransportError);
    expect(err.code).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// bounded retries with backoff: login, vehicle list, status, charging
// ---------------------------------------------------------------------------

describe('transport retries', () => {
  it('login survives a short outage like the 13 Nov incident (connect timeouts, then OK)', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(fetchFailed('UND_ERR_CONNECT_TIMEOUT'))
      .mockRejectedValueOnce(fetchFailed('UND_ERR_CONNECT_TIMEOUT'))
      .mockResolvedValue(response({ code: 0, data: { access_token: 'tok' } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();
    await client.login('user@example.com', 'secret');
    expect(client.token).toBe('tok');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(client._sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after TRANSPORT_RETRY.attempts and surfaces the network error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(fetchFailed('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();
    await expect(client.vehicleList()).rejects.toBeInstanceOf(SaicTransportError);
    expect(fetchMock).toHaveBeenCalledTimes(TRANSPORT_RETRY.attempts);
  });

  it('backs off exponentially with jitter, capped', () => {
    const client = new SaicClient('EU');
    for (let attempt = 1; attempt <= 6; attempt++) {
      const ceiling = Math.min(TRANSPORT_RETRY.maxDelayMs, TRANSPORT_RETRY.baseDelayMs * 2 ** (attempt - 1));
      const wait = client._backoffDelay(attempt);
      expect(wait).toBeGreaterThanOrEqual(ceiling / 2);
      expect(wait).toBeLessThanOrEqual(ceiling);
    }
  });

  it('does not retry a definitive API error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ code: 3, message: 'bad request' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeClient().vehicleList()).rejects.toThrow('bad request');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries the first request of a status poll, then follows the event id as usual', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(fetchFailed('EAI_AGAIN'))
      .mockResolvedValueOnce(response({ code: 4, message: 'wait' }, { headers: { 'event-id': 'E1' } }))
      .mockResolvedValue(response({ code: 0, data: { basicVehicleStatus: { lockStatus: 1 } } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();
    const data = await client.vehicleStatus('VIN');
    expect(data).toEqual({ basicVehicleStatus: { lockStatus: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never re-sends a control command after a network error that may have reached the server', async () => {
    const fetchMock = vi.fn().mockRejectedValue(fetchFailed('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeClient().lockVehicle('VIN')).rejects.toBeInstanceOf(SaicError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries the first charging request too', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response('busy', { status: 503 }))
      .mockResolvedValue(response({ code: 0, data: { chrgMgmtData: { bmsPackSOCDsp: 500 } } }));
    vi.stubGlobal('fetch', fetchMock);
    const data = await makeClient().chargingStatus('VIN');
    expect(data).toEqual({ chrgMgmtData: { bmsPackSOCDsp: 500 } });
  });
});
