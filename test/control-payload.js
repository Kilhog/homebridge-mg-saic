// Shared helper for the /vehicle/control payload tests. Runs one client call with the
// transport stubbed out (nothing leaves the machine) and hands back exactly what would have
// been POSTed, with every base64 paramValue decoded back to raw bytes, so a test can compare
// the request byte by byte - the same check the reference client's own tests make
// (saic-python-client-ng, tests/test_*.py: [(paramId, base64.b64decode(paramValue)), ...]).

import crypto from 'node:crypto';
import { vi, expect } from 'vitest';
import { SaicClient } from '../src/saic-client.js';

export const VIN = 'OFFLINE0000000000';

/**
 * Calls call(client) and returns { rvcReqType, params } for the single /vehicle/control
 * request it made, params being [paramId, [byte, ...]] pairs in request order (or null).
 */
export async function sentControl(call) {
  const client = new SaicClient('EU', { log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } });
  client.requestWithEventId = vi.fn().mockResolvedValue({});
  await call(client);
  expect(client.requestWithEventId).toHaveBeenCalledTimes(1);
  const [method, path, { jsonBody }] = client.requestWithEventId.mock.calls[0];
  expect(method).toBe('POST');
  expect(path).toBe('/vehicle/control');
  expect(jsonBody.vin).toBe(crypto.createHash('sha256').update(VIN, 'utf8').digest('hex'));
  return {
    rvcReqType: jsonBody.rvcReqType,
    params: jsonBody.rvcParams === null
      ? null
      : jsonBody.rvcParams.map(({ paramId, paramValue }) => [paramId, [...Buffer.from(paramValue, 'base64')]]),
  };
}
