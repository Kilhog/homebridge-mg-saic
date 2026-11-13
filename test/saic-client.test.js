import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SaicClient, SaicError, DOOR_WINDOWS_ACTION, WINDOW_ID, HEATED_SEAT, REAR_HEATED_SEAT_ON_LEVEL,
} from '../src/saic-client.js';
import { sentControl, VIN } from './control-payload.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient() {
  return new SaicClient('Australia', { log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } });
}

// ---------------------------------------------------------------------------
// _vinHash caching
// ---------------------------------------------------------------------------

describe('_vinHash', () => {
  it('returns the same string for repeated calls', () => {
    const client = makeClient();
    const h1 = client._vinHash('TESTIN00000001234');
    const h2 = client._vinHash('TESTIN00000001234');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('caches: the SHA-256 function is only called once per VIN', () => {
    const client = makeClient();
    // Populate cache
    client._vinHash('VIN1');
    client._vinHash('VIN1');
    // The cache Map should have exactly one entry for VIN1
    expect(client._vinHashCache.size).toBe(1);
    expect(client._vinHashCache.has('VIN1')).toBe(true);
  });

  it('returns different hashes for different VINs', () => {
    const client = makeClient();
    expect(client._vinHash('VIN1')).not.toBe(client._vinHash('VIN2'));
  });
});

// ---------------------------------------------------------------------------
// _deviceId stability
// ---------------------------------------------------------------------------

describe('_deviceId', () => {
  it('is set at construction and is a non-empty string', () => {
    const client = makeClient();
    expect(typeof client._deviceId).toBe('string');
    expect(client._deviceId.length).toBeGreaterThan(10);
  });

  it('stays the same across multiple calls (not regenerated)', () => {
    const client = makeClient();
    const id1 = client._deviceId;
    const id2 = client._deviceId;
    expect(id1).toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// _enqueueControl serialisation
// ---------------------------------------------------------------------------

describe('_enqueueControl', () => {
  it('runs commands sequentially, not concurrently', async () => {
    const client = makeClient();
    const order = [];

    const makeCmd = (label, delay) => () =>
      new Promise((resolve) => {
        setTimeout(() => {
          order.push(label);
          resolve(label);
        }, delay);
      });

    // Fire two commands concurrently — they should still run in order.
    const [r1, r2] = await Promise.all([
      client._enqueueControl(makeCmd('A', 30)),
      client._enqueueControl(makeCmd('B', 10)),
    ]);

    expect(r1).toBe('A');
    expect(r2).toBe('B');
    expect(order).toEqual(['A', 'B']);
  });

  it('runs the second command even if the first rejects', async () => {
    const client = makeClient();
    const order = [];

    const failing = () => Promise.reject(new Error('boom'));
    const succeeding = () => {
      order.push('B');
      return Promise.resolve('ok');
    };

    await client._enqueueControl(failing).catch(() => {});
    const result = await client._enqueueControl(succeeding);
    expect(result).toBe('ok');
    expect(order).toEqual(['B']);
  });
});

// ---------------------------------------------------------------------------
// _loginPromise gate (prevents concurrent re-logins)
// ---------------------------------------------------------------------------

describe('login _loginPromise gate', () => {
  it('only calls _doLogin once when login is called concurrently', async () => {
    const client = makeClient();
    let callCount = 0;

    client._doLogin = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 20));
      client.token = 'tok';
      return { access_token: 'tok' };
    };

    // Fire two logins at once
    await Promise.all([
      client.login('u', 'p'),
      client.login('u', 'p'),
    ]);

    expect(callCount).toBe(1);
    expect(client.token).toBe('tok');
  });

  it('clears _loginPromise after login completes', async () => {
    const client = makeClient();
    client._doLogin = async () => {
      client.token = 'tok';
      return { access_token: 'tok' };
    };

    await client.login('u', 'p');
    expect(client._loginPromise).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SaicError
// ---------------------------------------------------------------------------

describe('SaicError', () => {
  it('stores code and message', () => {
    const err = new SaicError('something went wrong', 401);
    expect(err.message).toBe('something went wrong');
    expect(err.code).toBe(401);
    expect(err.name).toBe('SaicError');
    expect(err instanceof Error).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// code 8 vehicle-state rejections fail fast instead of retrying for 60s
// ---------------------------------------------------------------------------

describe('rawRequest / requestWithEventId - code 8', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects immediately, without retrying, on a code 8 response', async () => {
    const client = makeClient();
    const body = JSON.stringify({ code: 8, message: 'Vehicle not locked. Please lock it and try again.(2)' });
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => body,
      headers: { get: () => null },
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      client.requestWithEventId('POST', '/vehicle/control', { jsonBody: { rvcReqType: '5' } }),
    ).rejects.toThrow('Vehicle not locked. Please lock it and try again.(2)');

    // Real bug this guards against: this used to retry with backoff for the full
    // 60s timeout before surfacing a generic "Timed out" error, because code 8
    // wasn't in the hard-failure list. One fetch call means it failed fast instead.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// the timeout error carries the car's last actual response
// ---------------------------------------------------------------------------

describe('requestWithEventId - timeout message', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes the car's last response in the timeout error", async () => {
    const client = makeClient();
    // event-id header present + no data field is the "ask again with this id" shape,
    // so this drives the retry loop rather than failing outright.
    const body = JSON.stringify({
      code: 4,
      message: 'The remote control instruction failed, please try again later.',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      text: async () => body,
      headers: { get: (h) => (h === 'event-id' ? '12345' : null) },
    }));

    // Real bug this guards against: a car that answered with a specific, useful reason on
    // every single poll still surfaced only "Timed out after 60s waiting for the vehicle"
    // at warn level, so the reason was invisible without debug logging turned on.
    await expect(
      client.requestWithEventId('GET', '/vehicle/status', {}, { timeoutMs: 1 }),
    ).rejects.toThrow('The remote control instruction failed, please try again later.');
  });
});

// ---------------------------------------------------------------------------
// isLoggedIn
// ---------------------------------------------------------------------------

describe('isLoggedIn', () => {
  it('returns false when no token', () => {
    expect(makeClient().isLoggedIn).toBe(false);
  });

  it('returns true when token is set', () => {
    const client = makeClient();
    client.token = 'some-token';
    expect(client.isLoggedIn).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// heated steering wheel payload (rvcReqType "8")
// ---------------------------------------------------------------------------

describe('controlHeatedSteeringWheel payload', () => {
  // Byte for byte what saic-python-client-ng's control_heated_steering_wheel sends
  // (tests/test_heated_steering_wheel.py): param 24 = 1/0, then the 255 terminator.
  it('sends rvcReqType 8 with param 24 = 1 to turn it on', async () => {
    const body = await sentControl((c) => c.controlHeatedSteeringWheel(VIN, true));
    expect(body).toEqual({ rvcReqType: '8', params: [[24, [1]], [255, [0, 0, 0, 0]]] });
  });

  it('sends rvcReqType 8 with param 24 = 0 to turn it off', async () => {
    const body = await sentControl((c) => c.controlHeatedSteeringWheel(VIN, false));
    expect(body).toEqual({ rvcReqType: '8', params: [[24, [0]], [255, [0, 0, 0, 0]]] });
  });
});

// ---------------------------------------------------------------------------
// climate payloads (rvcReqType "6")
// ---------------------------------------------------------------------------

describe('climate payloads', () => {
  // start_ac in saic-python-client-ng: control_climate(fan_speed=2, ac_on=None,
  // temperature_idx=idx) -> 19 = 2, 20 = idx, NO param 22, then 255. Cabin Heat and the
  // experimental Cabin Cool both send exactly this.
  it('startClimate without the compressor flag is byte for byte start_ac', async () => {
    const body = await sentControl((c) => c.startClimate(VIN, 4, false));
    expect(body).toEqual({ rvcReqType: '6', params: [[19, [2]], [20, [4]], [255, [0, 0, 0, 0]]] });
  });

  // stop_ac: control_climate(fan_speed=0, ...) -> 19 = 0, no 20, 22 = 0, then 255.
  it('stopClimate is byte for byte stop_ac', async () => {
    const body = await sentControl((c) => c.stopClimate(VIN));
    expect(body).toEqual({ rvcReqType: '6', params: [[19, [0]], [22, [0]], [255, [0, 0, 0, 0]]] });
  });
});

// ---------------------------------------------------------------------------
// door windows payload, MG S6 EV format (rvcReqType "3")
// ---------------------------------------------------------------------------

describe('controlDoorWindows payload', () => {
  // Byte for byte what saic-python-client-ng's control_door_windows sends
  // (tests/test_door_windows.py): sunroof 0, the four door windows 1, then the action,
  // and NO 255 terminator.
  for (const [name, action] of [['CLOSE', 0], ['VENTILATE', 1], ['OPEN', 2]]) {
    it(`sends action ${action} (${name}) for all four door windows, without param 255`, async () => {
      expect(DOOR_WINDOWS_ACTION[name]).toBe(action);
      const body = await sentControl((c) => c.controlDoorWindows(VIN, action));
      expect(body).toEqual({
        rvcReqType: '3',
        params: [[8, [0]], [9, [1]], [10, [1]], [11, [1]], [12, [1]], [13, [action]]],
      });
    });
  }

  it('refuses an unknown action instead of sending it', async () => {
    const client = makeClient();
    client.requestWithEventId = vi.fn();
    await expect(client.controlDoorWindows(VIN, 3)).rejects.toThrow(RangeError);
    expect(client.requestWithEventId).not.toHaveBeenCalled();
  });

  it('leaves the MG4-era controlWindow unchanged (open is still 3)', async () => {
    const body = await sentControl((c) => c.controlWindow(VIN, WINDOW_ID.DRIVER, { open: true }));
    expect(body).toEqual({
      rvcReqType: '3',
      params: [[8, [0]], [9, [1]], [10, [0]], [11, [0]], [12, [0]], [13, [3]]],
    });
  });
});

// ---------------------------------------------------------------------------
// heated seat payloads (rvcReqType "5")
// ---------------------------------------------------------------------------

describe('heated seat payloads', () => {
  // Byte for byte what saic-python-client-ng's control_heated_seat sends
  // (tests/test_heated_seats.py): one param for the seat, then the 255 terminator.
  it('uses the reference client param ids per physical seat', () => {
    expect(HEATED_SEAT).toEqual({ FRONT_LEFT: 17, FRONT_RIGHT: 18, REAR_LEFT: 25, REAR_RIGHT: 26 });
    expect(REAR_HEATED_SEAT_ON_LEVEL).toBe(3);
  });

  for (const [name, param] of [['REAR_LEFT', 25], ['REAR_RIGHT', 26]]) {
    it(`controlHeatedSeat(${name}) sends a single param ${param} then 255, on = 3 and off = 0`, async () => {
      expect(await sentControl((c) => c.controlHeatedSeat(VIN, HEATED_SEAT[name], 3)))
        .toEqual({ rvcReqType: '5', params: [[param, [3]], [255, [0, 0, 0, 0]]] });
      expect(await sentControl((c) => c.controlHeatedSeat(VIN, HEATED_SEAT[name], 0)))
        .toEqual({ rvcReqType: '5', params: [[param, [0]], [255, [0, 0, 0, 0]]] });
    });
  }

  it('refuses levels outside 0-3 and unknown seats before sending anything', async () => {
    const client = makeClient();
    client.requestWithEventId = vi.fn();
    await expect(client.controlHeatedSeat(VIN, HEATED_SEAT.REAR_LEFT, 4)).rejects.toThrow(RangeError);
    await expect(client.controlHeatedSeat(VIN, HEATED_SEAT.REAR_LEFT, -1)).rejects.toThrow(RangeError);
    await expect(client.controlHeatedSeat(VIN, 24, 1)).rejects.toThrow(RangeError);
    expect(client.requestWithEventId).not.toHaveBeenCalled();
  });

  // control_heated_seats (both front seats) in the reference client, confirmed on an MG4:
  // 17 = left level, 18 = right level, then 255.
  it('leaves the two-seat front command unchanged', async () => {
    expect(await sentControl((c) => c.controlHeatedSeats(VIN, { leftLevel: 1, rightLevel: 3 })))
      .toEqual({ rvcReqType: '5', params: [[17, [1]], [18, [3]], [255, [0, 0, 0, 0]]] });
  });
});
