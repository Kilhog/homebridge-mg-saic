// Request resilience: per-attempt timeout, transient network error classification, bounded
// retries. Every test stubs global fetch - nothing here talks to the real SAIC gateway.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SaicClient, SaicError, SaicTransportError, SaicCommandOutcomeUnknown, classifyTransportError, TRANSPORT_RETRY,
  LOGIN_COOLDOWN,
} from '../src/saic-client.js';
import { MgSaicAccessory } from '../src/accessory.js';
import { MgSaicPlatform, POLL_BACKOFF_MAX_FACTOR } from '../src/platform.js';
import { makeStubAccessory } from './accessory-stub.js';

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

/** The event-id header of every request fetch was asked to send, in order. */
const sentEventIds = (fetchMock) => fetchMock.mock.calls.map(([, init]) => init.headers['event-id']);

/**
 * A real MgSaicAccessory on a stub HomeKit: every Characteristic constant reads as its own
 * name (LockCurrentState.UNKNOWN === 'UNKNOWN'), every Service type as its name.
 */
function makeHapStub() {
  const characteristics = {};
  const Characteristic = new Proxy({}, {
    get: (_, name) => (characteristics[name] ??= new Proxy({ name }, {
      get: (t, k) => (typeof k === 'symbol' ? undefined : (k in t ? t[k] : k)),
    })),
  });
  const Service = new Proxy({}, { get: (_, name) => name });
  const platformAccessory = makeStubAccessory(Characteristic.Name);
  // services['Driver door']: a service by its display name.
  const services = new Proxy({}, { get: (_, name) => platformAccessory.getService(name) });
  const hap = {
    Characteristic, Service,
    uuid: { generate: (x) => x },
    HapStatusError: class HapStatusError extends Error { constructor(status) { super('HapStatusError'); this.hapStatus = status; } },
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402, READ_ONLY_CHARACTERISTIC: -70404 },
  };
  return { hap, platformAccessory, services, Characteristic };
}

function makeAccessoryHarness(client, opts = {}) {
  const { hap, platformAccessory, services, Characteristic } = makeHapStub();
  const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() };
  const acc = new MgSaicAccessory(platformAccessory, client, {
    vin: 'VIN', log, api: { hap }, enablePreconditioning: true, enableDoorSensors: true,
    enableTemperatureSensors: true, enableHeatedSeats: false, enableRearDefrost: false, enableFrontDefrost: false,
    ...opts,
  });
  return { acc, log, services, Characteristic };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

// ---------------------------------------------------------------------------
// event-id loop: tracking phase and the command re-send policy
// ---------------------------------------------------------------------------

describe('event-id loop and control commands', () => {
  const pending = (id) => response({ code: 4, message: 'The remote control instruction failed, please try again later.' }, { headers: { 'event-id': id } });
  const done = response({ code: 0, data: { rvcReqSts: 2, failureType: 0 } });

  it('keeps following the same event id through network errors, never sending the command again', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(pending('E1'))
      .mockRejectedValueOnce(fetchFailed('ECONNRESET'))
      .mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'))
      .mockResolvedValue(done);
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();
    await client.lockVehicle('VIN');
    expect(sentEventIds(fetchMock)).toEqual(['0', 'E1', 'E1', 'E1']);
  });

  it('does the same for a status poll', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(pending('S1'))
      .mockRejectedValueOnce(fetchFailed('UND_ERR_SOCKET'))
      .mockResolvedValue(response({ code: 0, data: { basicVehicleStatus: {} } }));
    vi.stubGlobal('fetch', fetchMock);
    await makeClient().vehicleStatus('VIN');
    expect(sentEventIds(fetchMock)).toEqual(['0', 'S1', 'S1']);
  });

  it('re-sends the first POST only when the error proves it never left (connect timeout)', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(fetchFailed('UND_ERR_CONNECT_TIMEOUT'))
      .mockRejectedValueOnce(fetchFailed('ENOTFOUND'))
      .mockResolvedValue(done);
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();
    client.onControlSettled = vi.fn();
    await client.lockVehicle('VIN');
    expect(sentEventIds(fetchMock)).toEqual(['0', '0', '0']);
    expect(client.onControlSettled).toHaveBeenCalledWith('ok');
  });

  for (const [label, failure] of [
    ['a reset after sending', () => Promise.reject(fetchFailed('ECONNRESET'))],
    ['a read timeout', () => Promise.reject(new DOMException('timeout', 'TimeoutError'))],
    ['an HTTP 502', () => Promise.resolve(response('bad gateway', { status: 502 }))],
  ]) {
    it(`gives up with "outcome unknown" and does not re-send after ${label}`, async () => {
      const fetchMock = vi.fn(failure);
      vi.stubGlobal('fetch', fetchMock);
      const client = makeClient();
      client.onControlSettled = vi.fn();
      const err = await client.lockVehicle('VIN').catch((e) => e);
      expect(err).toBeInstanceOf(SaicCommandOutcomeUnknown);
      expect(err.message).toMatch(/Outcome unknown/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(client.onControlSettled).toHaveBeenCalledWith('unknown', err);
    });
  }

  it('reports a command that never got an answer after being accepted as outcome unknown (408)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pending('E9')));
    const client = makeClient();
    client._sleep = (ms) => new Promise((r) => setTimeout(r, 5));
    const err = await client.requestWithEventId('POST', '/vehicle/control', { jsonBody: {} }, { timeoutMs: 30, isCommand: true })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SaicCommandOutcomeUnknown);
    expect(err.code).toBe(408);
    expect(err.message).toMatch(/may still have reached the car/);
  });

  it('keeps a plain 408 timeout for status polls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pending('S9')));
    const client = makeClient();
    client._sleep = (ms) => new Promise((r) => setTimeout(r, 5));
    const err = await client.requestWithEventId('GET', '/vehicle/status', {}, { timeoutMs: 30 }).catch((e) => e);
    expect(err).not.toBeInstanceOf(SaicCommandOutcomeUnknown);
    expect(err.code).toBe(408);
  });

  it('reports a definitive rejection as "failed", not unknown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ code: 8, message: 'Vehicle not locked.' })));
    const client = makeClient();
    client.onControlSettled = vi.fn();
    await expect(client.lockVehicle('VIN')).rejects.not.toBeInstanceOf(SaicCommandOutcomeUnknown);
    expect(client.onControlSettled).toHaveBeenCalledWith('failed', expect.any(SaicError));
  });
});

describe('accessory: unknown command outcome', () => {
  it('fails the HomeKit write, shows the lock as UNKNOWN, and re-reads the state 30 s later', async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const fetchMock = vi.fn().mockRejectedValue(fetchFailed('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);
    const { acc, services, Characteristic } = makeAccessoryHarness(client);
    client.vehicleStatus = vi.fn().mockResolvedValue({ basicVehicleStatus: { lockStatus: 1 } });
    client.chargingStatus = vi.fn().mockResolvedValue({ chrgMgmtData: {} });

    await expect(acc.setLockTarget(Characteristic.LockTargetState.SECURED)).rejects.toThrow('HapStatusError');
    expect(fetchMock).toHaveBeenCalledTimes(1); // not re-sent
    const lock = services.LockMechanism;
    expect(lock.updateCharacteristic).toHaveBeenLastCalledWith(Characteristic.LockCurrentState, 'UNKNOWN');
    expect(acc._lastStatus).toBeNull(); // nothing patched optimistically

    expect(client.vehicleStatus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.vehicleStatus).toHaveBeenCalledTimes(1);
    expect(acc.readLockState()).toBe('SECURED');
  });

  it('schedules a single re-read for several unknown outcomes in a row', async () => {
    vi.useFakeTimers();
    const client = makeClient();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailed('ECONNRESET')));
    const { acc } = makeAccessoryHarness(client, { enableHeatedSeats: true });
    client.vehicleStatus = vi.fn().mockResolvedValue({ basicVehicleStatus: {} });
    client.chargingStatus = vi.fn().mockResolvedValue({ chrgMgmtData: {} });
    await acc.setSeatHeat('left', true).catch(() => {});
    await acc.setSeatHeat('right', true).catch(() => {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.vehicleStatus).toHaveBeenCalledTimes(1);
  });

  it('shows JAMMED, not UNKNOWN, when the car definitely refused', async () => {
    const client = makeClient();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ code: 8, message: 'Vehicle is powered on.' })));
    const { acc, services, Characteristic } = makeAccessoryHarness(client);
    await expect(acc.setLockTarget(Characteristic.LockTargetState.SECURED)).rejects.toThrow('HapStatusError');
    expect(services.LockMechanism.updateCharacteristic).toHaveBeenLastCalledWith(Characteristic.LockCurrentState, 'JAMMED');
  });
});

// ---------------------------------------------------------------------------
// session: one re-login per request, no login storms
// ---------------------------------------------------------------------------

describe('session renewal', () => {
  const loggedOut = () => response({ code: 401, message: 'Token expired' });
  const loginOk = (token) => response({ code: 0, data: { access_token: token } });
  const paths = (fetchMock) => fetchMock.mock.calls.map(([url]) => new URL(url).pathname.replace('/api.app/v1', ''));

  /** A client that has logged in once already, with fetch reset afterwards. */
  async function loggedInClient(fetchMock) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(loginOk('T1')));
    const client = makeClient();
    await client.login('user@example.com', 'secret');
    vi.stubGlobal('fetch', fetchMock);
    return client;
  }

  it('renews an expired session once and retries the request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loggedOut())
      .mockResolvedValueOnce(loginOk('T2'))
      .mockResolvedValue(response({ code: 0, data: { vinList: [] } }));
    const client = await loggedInClient(fetchMock);
    await expect(client.vehicleList()).resolves.toEqual({ vinList: [] });
    expect(paths(fetchMock)).toEqual(['/vehicle/list', '/oauth/token', '/vehicle/list']);
    expect(client.token).toBe('T2');
  });

  it('gives up after one renewal if the retried request is refused again', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loggedOut())
      .mockResolvedValueOnce(loginOk('T2'))
      .mockResolvedValue(loggedOut());
    const client = await loggedInClient(fetchMock);
    await expect(client.vehicleList()).rejects.toMatchObject({ code: 401 });
    expect(paths(fetchMock).filter((p) => p === '/oauth/token')).toHaveLength(1);
  });

  it('renews the session during a status poll and carries on', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loggedOut())
      .mockResolvedValueOnce(loginOk('T2'))
      .mockResolvedValue(response({ code: 0, data: { basicVehicleStatus: {} } }));
    const client = await loggedInClient(fetchMock);
    await client.vehicleStatus('VIN');
    expect(paths(fetchMock)).toEqual(['/vehicle/status', '/oauth/token', '/vehicle/status']);
  });

  it('re-sends a command refused for its session (it was never processed), once', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loggedOut())
      .mockResolvedValueOnce(loginOk('T2'))
      .mockResolvedValue(response({ code: 0, data: { rvcReqSts: 2 } }));
    const client = await loggedInClient(fetchMock);
    await client.lockVehicle('VIN');
    expect(paths(fetchMock)).toEqual(['/vehicle/control', '/oauth/token', '/vehicle/control']);
  });

  it('keeps following the same event id when the session expires mid-wait', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 4, message: 'wait' }, { headers: { 'event-id': 'E1' } }))
      .mockResolvedValueOnce(loggedOut())
      .mockResolvedValueOnce(loginOk('T2'))
      .mockResolvedValue(response({ code: 0, data: { rvcReqSts: 2 } }));
    const client = await loggedInClient(fetchMock);
    await client.lockVehicle('VIN');
    const controlEventIds = fetchMock.mock.calls
      .filter(([url]) => url.includes('/vehicle/control'))
      .map(([, init]) => init.headers['event-id']);
    expect(controlEventIds).toEqual(['0', 'E1', 'E1']);
  });

  it('shares one login between requests that get logged out together', async () => {
    let loginCalls = 0;
    const fetchMock = vi.fn(async (url, init) => {
      if (url.includes('/oauth/token')) {
        loginCalls++;
        return loginOk('T2');
      }
      return init.headers['blade-auth'] === 'T2' ? response({ code: 0, data: { ok: true } }) : loggedOut();
    });
    const client = await loggedInClient(fetchMock);
    await Promise.all([client.vehicleList(), client.vehicleList(), client.vehicleStatus('VIN')]);
    expect(loginCalls).toBe(1);
  });

  it('does not log in again for a request that was sent before someone else already did', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ code: 0, data: { ok: true } }));
    const client = await loggedInClient(fetchMock);
    client.token = 'T2'; // another request renewed the session meanwhile
    client.login = vi.fn();
    await client._recoverSession(new SaicError('Logged out', 401), 'T1');
    expect(client.login).not.toHaveBeenCalled();
  });

  it('pauses logins after the gateway refuses one, with a growing cooldown', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(response({ code: 3, message: 'Wrong password' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();
    await expect(client.login('u@example.com', 'bad')).rejects.toThrow('Wrong password');
    await expect(client.login('u@example.com', 'bad')).rejects.toThrow(/Not logging in again/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(LOGIN_COOLDOWN.baseMs);
    await expect(client.login('u@example.com', 'bad')).rejects.toThrow('Wrong password');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(LOGIN_COOLDOWN.baseMs); // second refusal doubled the pause
    await expect(client.login('u@example.com', 'bad')).rejects.toThrow(/Not logging in again/);
  });

  it('does not pause logins after a network failure (it never reached SAIC)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(fetchFailed('UND_ERR_CONNECT_TIMEOUT'));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();
    await expect(client.login('u@example.com', 'pw')).rejects.toBeInstanceOf(SaicTransportError);
    fetchMock.mockResolvedValue(loginOk('T1'));
    await expect(client.login('u@example.com', 'pw')).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// polling: no overlap, backoff, quiet logs, stale data
// ---------------------------------------------------------------------------

/** A platform (EU, 15 min polls) on a stub Homebridge API, with its accessory registered. */
function makePlatform() {
  const { hap, platformAccessory } = makeHapStub();
  const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() };
  const api = {
    hap,
    on: vi.fn(),
    platformAccessory: function PlatformAccessory() { return platformAccessory; },
    registerPlatformAccessories: vi.fn(),
    updatePlatformAccessories: vi.fn(),
  };
  const platform = new MgSaicPlatform(log, { username: 'u@example.com', password: 'pw', region: 'EU' }, api);
  platform.client._sleep = vi.fn().mockResolvedValue(undefined);
  platform.client.token = 'T1';
  platform.registerAccessory('VIN');
  return { platform, log };
}

const lines = (fn) => fn.mock.calls.map(([m]) => m);

describe('platform polling', () => {
  it('never runs two polls at once', async () => {
    const { platform } = makePlatform();
    let finish;
    platform.vehicle.refresh = vi.fn(() => new Promise((r) => { finish = r; }));
    const first = platform.pollOnce();
    await platform.pollOnce();
    expect(platform.vehicle.refresh).toHaveBeenCalledTimes(1);
    finish(true);
    await first;
  });

  it('logs an outage once at warn, then at debug, then one recovery line', async () => {
    const { platform, log } = makePlatform();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailed('UND_ERR_CONNECT_TIMEOUT')));
    for (let i = 0; i < 3; i++) await platform.pollOnce();
    expect(lines(log.warn).filter((m) => m.includes('SAIC API unreachable'))).toHaveLength(1);
    expect(lines(log.debug).filter((m) => m.includes('SAIC API still unreachable'))).toHaveLength(2);

    vi.stubGlobal('fetch', vi.fn(async (url) => response({
      code: 0, data: url.includes('charging') ? { chrgMgmtData: {} } : { basicVehicleStatus: { lockStatus: 1 } },
    })));
    await platform.pollOnce();
    expect(lines(log.info)).toContainEqual(expect.stringMatching(/SAIC API reachable again after 3 failed attempt\(s\)/));
  });

  it('backs the poll interval off after consecutive failures, capped, and resets on success', async () => {
    const { platform } = makePlatform();
    const interval = 15 * 60_000;
    platform.vehicle.refresh = vi.fn().mockResolvedValue(false);
    expect(platform.nextPollDelay()).toBe(interval);
    const delays = [];
    for (let i = 0; i < 5; i++) {
      await platform.pollOnce();
      delays.push(platform.nextPollDelay());
    }
    expect(delays).toEqual([interval, 2 * interval, 4 * interval, 4 * interval, 4 * interval]);
    expect(4).toBe(POLL_BACKOFF_MAX_FACTOR);
    platform.vehicle.refresh = vi.fn().mockResolvedValue(true);
    await platform.pollOnce();
    expect(platform.nextPollDelay()).toBe(interval);
  });

  it('schedules the next poll only after the previous one, using the backed-off delay', async () => {
    vi.useFakeTimers();
    const { platform } = makePlatform();
    platform.vehicle.refresh = vi.fn().mockResolvedValue(false);
    platform.startPolling();
    await vi.advanceTimersByTimeAsync(10_000); // first poll
    await vi.advanceTimersByTimeAsync(15 * 60_000); // 1 failure: normal interval
    expect(platform.vehicle.refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15 * 60_000); // 2 failures: now 30 min
    expect(platform.vehicle.refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(platform.vehicle.refresh).toHaveBeenCalledTimes(3);
  });

  it('counts a failed re-login as a failed poll', async () => {
    const { platform, log } = makePlatform();
    platform.client.token = '';
    platform.client.login = vi.fn().mockRejectedValue(new SaicTransportError('Network error: ENOTFOUND', 'ENOTFOUND', true));
    platform.vehicle.refresh = vi.fn();
    await platform.pollOnce();
    await platform.pollOnce();
    expect(platform.vehicle.refresh).not.toHaveBeenCalled();
    expect(lines(log.warn)).toEqual([expect.stringContaining('login failed')]);
  });
});

describe('accessory refresh under outages', () => {
  const okFetch = (status = { lockStatus: 1, interiorTemperature: 20, exteriorTemperature: 10 }) => vi.fn(async (url) => response({
    code: 0, data: url.includes('charging') ? { chrgMgmtData: { ccuOnbdChrgrPlugOn: 1 } } : { basicVehicleStatus: status },
  }));

  it('shares one refresh between overlapping callers', async () => {
    const client = makeClient();
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { acc } = makeAccessoryHarness(client);
    const [a, b] = await Promise.all([acc.refresh(), acc.refresh()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(fetchMock.mock.calls.filter(([url]) => url.includes('/vehicle/status'))).toHaveLength(1);
  });

  it('keeps serving the last values when the API is unreachable, and reports the failure', async () => {
    const client = makeClient();
    vi.stubGlobal('fetch', okFetch());
    const { acc, log } = makeAccessoryHarness(client);
    await acc.refresh();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailed('UND_ERR_CONNECT_TIMEOUT')));
    expect(await acc.refresh()).toBe(false);
    expect(acc.lastStatusError).toMatch(/UND_ERR_CONNECT_TIMEOUT/);
    expect(acc.readLockState()).toBe('SECURED');
    expect(acc.readTemperature('interiorTemperature')).toBe(20);
    expect(lines(log.warn).filter((m) => m.startsWith('Status refresh failed'))).toHaveLength(0);
  });

  it('flags StatusFault on contact and temperature sensors once the data is too old', async () => {
    vi.useFakeTimers();
    const client = makeClient();
    vi.stubGlobal('fetch', okFetch());
    const { acc, services, Characteristic } = makeAccessoryHarness(client, { staleAfterMs: 45 * 60_000 });
    await acc.refresh();
    expect(acc.readTemperatureFault('interiorTemperature')).toBe('NO_FAULT');
    expect(acc.readStaleFault()).toBe('NO_FAULT');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailed('ECONNREFUSED')));
    vi.advanceTimersByTime(46 * 60_000);
    await acc.refresh();
    expect(acc.readTemperatureFault('interiorTemperature')).toBe('GENERAL_FAULT');
    expect(services['Driver door'].updateCharacteristic)
      .toHaveBeenLastCalledWith(Characteristic.StatusFault, 'GENERAL_FAULT');

    vi.stubGlobal('fetch', okFetch());
    await acc.refresh();
    expect(services['Driver door'].updateCharacteristic)
      .toHaveBeenLastCalledWith(Characteristic.StatusFault, 'NO_FAULT');
  });

  it('logs a failing charging endpoint once, not on every poll', async () => {
    const client = makeClient();
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('charging')) throw fetchFailed('ECONNRESET');
      return response({ code: 0, data: { basicVehicleStatus: { lockStatus: 1 } } });
    }));
    const { acc, log } = makeAccessoryHarness(client);
    await acc.refresh();
    await acc.refresh();
    expect(lines(log.warn).filter((m) => m.includes('Charging status unreachable'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// useStatusCache: routine polls without waking the car
// ---------------------------------------------------------------------------

describe('status cache (useStatusCache)', () => {
  // Fields of the reference client's /vehicle/status/cache capture (no doors, no temperatures).
  const CACHE_BASIC = { lockStatus: 1, bootStatus: 0, bonnetStatus: 0, remoteClimateStatus: 0, rmtHtdRrWndSt: 0, driverWindow: 0 };
  const FULL_BASIC = {
    ...CACHE_BASIC, driverDoor: 0, passengerDoor: 0, rearLeftDoor: 0, rearRightDoor: 0,
    interiorTemperature: 19, exteriorTemperature: 8,
  };

  /** fetch answering status, cache and charging requests; returns it with a per-path counter. */
  function vehicleFetch({ cacheBasic = CACHE_BASIC, cacheFails = false } = {}) {
    const fetchMock = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/vehicle/status/cache')) {
        if (cacheFails) throw fetchFailed('ECONNRESET');
        return response({ code: 0, data: { basicVehicleStatus: cacheBasic, statusTime: 1792774872, onlineStatus: 1 } });
      }
      if (path.endsWith('/vehicle/status')) return response({ code: 0, data: { basicVehicleStatus: FULL_BASIC } });
      return response({ code: 0, data: { chrgMgmtData: { ccuOnbdChrgrPlugOn: 1 } } });
    });
    fetchMock.count = (suffix) => fetchMock.mock.calls.filter(([url]) => new URL(url).pathname.endsWith(suffix)).length;
    return fetchMock;
  }

  const noSensors = { enableDoorSensors: false, enableTemperatureSensors: false, useStatusCache: true };

  it('calls GET /vehicle/status/cache with the hashed VIN, as a plain request (no event id)', async () => {
    const fetchMock = vehicleFetch();
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();
    await client.vehicleStatusCached('VIN123');
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api.app/v1/vehicle/status/cache');
    expect(parsed.searchParams.get('vin')).toBe(client._vinHash('VIN123'));
    expect(parsed.searchParams.get('vehStatusReqType')).toBe('2');
    expect(init.method).toBe('GET');
    expect(init.headers['event-id']).toBeUndefined();
  });

  it('reads the full status first, then the cache on routine polls', async () => {
    const fetchMock = vehicleFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { acc } = makeAccessoryHarness(makeClient(), noSensors);
    await acc.refresh();
    await acc.refresh();
    await acc.refresh();
    expect(fetchMock.count('/vehicle/status')).toBe(1);
    expect(fetchMock.count('/vehicle/status/cache')).toBe(2);
    // fields the cache doesn't carry are kept from the full read
    expect(acc._lastStatus.basicVehicleStatus.interiorTemperature).toBe(19);
  });

  it('falls back to the full status when the cache lacks a field an enabled service needs, saying so once', async () => {
    const fetchMock = vehicleFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { acc, log } = makeAccessoryHarness(makeClient(), { useStatusCache: true }); // door + temperature sensors on
    await acc.refresh();
    await acc.refresh();
    await acc.refresh();
    expect(fetchMock.count('/vehicle/status')).toBe(3);
    const explained = lines(log.info).filter((m) => m.includes('The status cache lacks'));
    expect(explained).toHaveLength(1);
    expect(explained[0]).toMatch(/driverDoor.*interiorTemperature/);
  });

  it('reads the full status again after a command', async () => {
    const fetchMock = vehicleFetch();
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();
    const { acc } = makeAccessoryHarness(client, noSensors);
    await acc.refresh();
    client.onControlSettled('ok');
    await acc.refresh();
    expect(fetchMock.count('/vehicle/status')).toBe(2);
    expect(fetchMock.count('/vehicle/status/cache')).toBe(0);
  });

  it('falls back to the full status when the cache itself can\'t be read', async () => {
    const fetchMock = vehicleFetch({ cacheFails: true });
    vi.stubGlobal('fetch', fetchMock);
    const { acc } = makeAccessoryHarness(makeClient(), noSensors);
    await acc.refresh();
    expect(await acc.refresh()).toBe(true);
    expect(fetchMock.count('/vehicle/status')).toBe(2);
  });

  it('never touches the cache when the option is off (the default)', async () => {
    const fetchMock = vehicleFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { acc } = makeAccessoryHarness(makeClient(), { enableDoorSensors: false, enableTemperatureSensors: false });
    await acc.refresh();
    await acc.refresh();
    expect(fetchMock.count('/vehicle/status/cache')).toBe(0);
    expect(fetchMock.count('/vehicle/status')).toBe(2);
  });
});
