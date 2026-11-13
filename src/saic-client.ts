/**
 * MG / SAIC iSmart API client.
 *
 * Ported from the verified mg-saic-test.mjs reference (itself ported from
 * saic-ismart-client-ng, MIT, used by townsmcp/mg-saic-ha). Request signing
 * has been checked byte-identical to the Python reference, and login,
 * vehicle list, vehicle status and charging status have all been run live
 * against the Australian gateway.
 *
 * Two things that are easy to get wrong and give misleading errors:
 *   1. The VIN goes in as a SHA-256 hex digest, never in the clear. A raw VIN
 *      returns error 36805, "not within the package scope", which reads like
 *      a subscription problem but is not.
 *   2. Status and command endpoints are asynchronous. The first call returns
 *      an event-id header and no data. You resend with that event-id until
 *      the car answers, which can take 20 to 30 seconds if it is asleep.
 */

import crypto from 'node:crypto';

export const REGIONS: Record<string, { uri: string; code: string }> = {
  EU:        { uri: 'https://gateway-mg-eu.soimt.com/api.app/v1/', code: 'eu' },
  Australia: { uri: 'https://gateway-mg-au.soimt.com/api.app/v1/', code: 'au' },
  China:     { uri: 'https://tap-cn.soimt.com/api.app/v1/',        code: 'cn' },
  Brazil:    { uri: 'https://gateway-mg-br.soimt.com/api.app/v1/', code: 'br' },
  Israel:    { uri: 'https://gateway-mg-il.soimt.com/api.app/v1/', code: 'il' },
  Turkey:    { uri: 'https://gateway-mg-tr.soimt.com/api.app/v1/', code: 'tr' },
  India:     { uri: 'https://gateway-mg-in.soimt.com/api.app/v1/', code: 'in' },
  Thailand:  { uri: 'https://gateway-mg-th.soimt.com/api.app/v1/', code: 'th' },
};

const TENANT_ID  = '459771';
const BASIC_AUTH = 'Basic c3dvcmQ6c3dvcmRfc2VjcmV0';
const USER_AGENT = 'Europe/2.1.0 (iPad; iOS 18.5; Scale/2.00)';

// --------------------------------------------------------------------- types

export interface Logger {
  info(msg: string): void;
  debug(msg: string): void;
  warn(msg: string): void;
}

export interface RvcParam {
  paramId: number;
  paramValue: string;
}

interface RawRequestOpts {
  formBody?: Record<string, string>;
  jsonBody?: Record<string, unknown>;
  params?: Record<string, string>;
  eventId?: string;
}

interface RequestWithEventIdOpts {
  timeoutMs?: number;
  // A /vehicle/control command: never re-sent unless the error proves it wasn't sent.
  isCommand?: boolean;
}

export type ControlOutcome = 'ok' | 'failed' | 'unknown';

// --------------------------------------------------------------------- crypto

const md5Hex    = (s: string) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const sha1Hex   = (s: string) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');
const sha256Hex = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function encryptAes(plaintext: string, keyHex: string, ivHex: string): string {
  const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'));
  return Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]).toString('hex');
}

function decryptAes(cipherHex: string, keyHex: string, ivHex: string): string {
  const d = crypto.createDecipheriv('aes-128-cbc', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'));
  return Buffer.concat([d.update(Buffer.from(cipherHex, 'hex')), d.final()]).toString('utf8');
}

const normalizeContentType = (ct: string | undefined): string =>
  !ct                              ? 'application/json'
  : ct.includes('multipart')       ? 'multipart/form-data'
  : ct.includes('x-www-form-urlencoded') ? 'application/x-www-form-urlencoded'
  : 'application/json';

function appVerificationString(
  { path, ts, contentType, content, token }:
  { path: string; ts: string; contentType: string; content: string; token: string },
): string {
  const encryptKey = md5Hex(md5Hex(path + TENANT_ID + token + 'app') + ts + '1' + contentType);
  const encrypted  = content ? encryptAes(content, encryptKey, md5Hex(ts)) : '';
  const value      = path + TENANT_ID + token + 'app' + ts + '1' + contentType + encrypted;
  return crypto.createHmac('sha256', md5Hex(encryptKey + ts)).update(value, 'utf8').digest('hex');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ transport
//
// Real incident (13 Nov 2026, Node 22): two runs in a row failed at login with "TypeError:
// fetch failed", cause ConnectTimeoutError UND_ERR_CONNECT_TIMEOUT after 10 s on one gateway
// address, while another address answered curl; a minute later everything worked again.
// Before this, a network error was not a SaicRetry, so it escaped requestWithEventId at once,
// and a stalled request could sit on undici's own defaults (up to 300 s for headers/body).

/** Cap on one HTTP attempt, connect + full response. Overridable per client (tests). */
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Bounded retries for transient network failures on requests that are safe to repeat (login,
 * vehicle list, the first status/charging request): exponential backoff with jitter,
 * 2 s, 4 s, 8 s (capped at 10 s), each scaled by a random 50-100 %.
 */
export const TRANSPORT_RETRY = { attempts: 4, baseDelayMs: 2_000, maxDelayMs: 10_000 };

/**
 * Pause before logging in again after a login the gateway itself refused (wrong password,
 * account paused...): 1, 2, 4, 8 then 15 min. SAIC allows one session per account and has
 * been seen pausing an account for ~15 min when it sees too many logins, so a stuck re-login
 * loop must not hammer it. Network failures don't count, they never reached SAIC.
 */
export const LOGIN_COOLDOWN = { baseMs: 60_000, maxMs: 15 * 60_000 };

/** Codes (on fetch's TypeError cause) that prove the request never reached the server. */
const NOT_SENT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
/** Transient codes where the request may already have reached the server. */
const MAYBE_SENT_CODES = new Set([
  'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
]);

// --------------------------------------------------------------------- errors

export class SaicError extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = 'SaicError';
    this.code = code;
  }
}

/**
 * A transient transport failure: network error, per-attempt timeout, or HTTP 5xx/429 from the
 * gateway. `notSent` is true only when the error proves the request never left this machine
 * (connect timeout, connection refused, DNS failure) - the one case where even a control
 * command can safely be sent again.
 */
export class SaicTransportError extends SaicError {
  reason: string;
  notSent: boolean;
  constructor(message: string, reason: string, notSent: boolean, httpStatus = 0) {
    super(message, httpStatus);
    this.name = 'SaicTransportError';
    this.reason = reason;
    this.notSent = notSent;
  }
}

/**
 * A control command whose outcome can't be known: it may or may not have reached the car, so
 * it is deliberately not re-sent. Either the connection failed after the command was sent
 * (code 0), or the gateway accepted it but the car's answer never came within the deadline
 * (code 408, same as the plain timeout it replaces for commands).
 */
export class SaicCommandOutcomeUnknown extends SaicError {
  constructor(message: string, code: number) {
    super(message, code);
    this.name = 'SaicCommandOutcomeUnknown';
  }
}

/** Every error code on an error, its cause, and an AggregateError's inner errors. */
function errorCodes(err: unknown): string[] {
  const codes = new Set<string>();
  const visit = (e: unknown): void => {
    const x = e as { code?: unknown; errors?: unknown } | null | undefined;
    if (typeof x?.code === 'string') codes.add(x.code);
    if (Array.isArray(x?.errors)) x.errors.forEach(visit);
  };
  visit(err);
  visit((err as { cause?: unknown } | null | undefined)?.cause);
  return [...codes];
}

/**
 * Turns what fetch() (or reading its body) threw into a SaicTransportError when it's a
 * transient network problem, or null when it's something else that should surface as-is.
 * Checked against Node 22's undici: a refused connection is TypeError "fetch failed" with
 * cause.code ECONNREFUSED (an AggregateError with the same code when several addresses were
 * tried), a reset is cause UND_ERR_SOCKET, AbortSignal.timeout() rejects with a TimeoutError.
 */
export function classifyTransportError(err: unknown): SaicTransportError | null {
  if (err instanceof SaicError) return null;
  const name = (err as { name?: unknown } | null | undefined)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new SaicTransportError(`No complete response within the request timeout (${String(name)})`, String(name), false);
  }
  const codes = errorCodes(err).filter((c) => NOT_SENT_CODES.has(c) || MAYBE_SENT_CODES.has(c));
  if (codes.length === 0) return null;
  const notSent = codes.every((c) => NOT_SENT_CODES.has(c));
  return new SaicTransportError(`Network error: ${codes.join('/')}`, codes[0], notSent);
}

/** A logged-out response (401/403), as opposed to a network failure that happens to be 403-ish. */
function isAuthError(err: unknown): boolean {
  return err instanceof SaicError && !(err instanceof SaicTransportError) && (err.code === 401 || err.code === 403);
}

class SaicRetry extends Error {
  eventId: string;
  code: number;
  constructor(message: string, eventId: string, code: number) {
    super(message);
    this.name = 'SaicRetry';
    this.eventId = eventId;
    this.code = code;
  }
}

// --------------------------------------------------------------------- client

export class SaicClient {
  baseUri: string;
  region: string;
  token: string;
  log: Logger;

  requestTimeoutMs: number;
  /**
   * Called once every control command has settled. The accessory uses it to re-read the car's
   * state after an 'unknown' outcome (see SaicCommandOutcomeUnknown).
   */
  onControlSettled?: (outcome: ControlOutcome, error?: unknown) => void;

  private _deviceId: string;
  private _controlQueue: Promise<void>;
  private _loginPromise: Promise<unknown> | null;
  private _vinHashCache: Map<string, string>;
  // Kept from the last login() call so an expired session can be renewed once, mid-request.
  private _credentials?: { username: string; password: string };
  // Consecutive logins the gateway refused, and when the next attempt is allowed.
  private _loginFailures = 0;
  private _loginBlockedUntil = 0;

  constructor(region = 'Australia', { log, requestTimeoutMs = REQUEST_TIMEOUT_MS }: { log?: Logger; requestTimeoutMs?: number } = {}) {
    const r = REGIONS[region];
    if (!r) throw new Error(`Unknown region: ${region}`);
    this.baseUri = r.uri;
    this.region  = r.code;
    this.token   = '';
    this.log     = log ?? { info: () => {}, debug: () => {}, warn: () => {} };
    this.requestTimeoutMs = requestTimeoutMs;
    // Stable device identifier reused across logins so the server always sees the same device.
    this._deviceId = 'simulator*********************************************' + Math.floor(Date.now() / 1000);
    // /vehicle/control commands are serialised through this chain. Firing two at once (e.g.
    // tapping a window switch while a seat-heat switch is still mid-poll) means two independent
    // 60s event-id retry loops hit the same vehicle at once; the car appears to only track one
    // in-flight command and the earlier one then times out even though the car reacted to it.
    // See TESTING.md for how this showed up in a real Homebridge log.
    this._controlQueue = Promise.resolve();
    // When two parallel requests both get a 401 (e.g. the parallel vehicleStatus +
    // chargingStatus calls in refresh()), we only want one actual re-login HTTP call.
    // _loginPromise is set to the in-flight login while it is running, cleared on
    // settle, so a second caller just awaits the same promise.
    this._loginPromise = null;
    this._vinHashCache = new Map();
  }

  /** Runs fn() only after every previously queued control command has settled (win or lose). */
  _enqueueControl<T>(fn: () => Promise<T>): Promise<T> {
    const result = this._controlQueue.then(fn, fn);
    this._controlQueue = result.then(() => {}, () => {});
    return result;
  }

  get isLoggedIn(): boolean {
    return Boolean(this.token);
  }

  /** Waits between retries. A method so tests can replace it instead of waiting for real. */
  _sleep(ms: number): Promise<void> {
    return sleep(ms);
  }

  /** Backoff before retry number `attempt` (1-based): exponential, capped, 50-100 % jitter. */
  _backoffDelay(attempt: number): number {
    const ceiling = Math.min(TRANSPORT_RETRY.maxDelayMs, TRANSPORT_RETRY.baseDelayMs * 2 ** (attempt - 1));
    return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
  }

  /**
   * Runs fn, retrying it on a SaicTransportError up to TRANSPORT_RETRY.attempts times in all.
   * Only for requests that are safe to repeat; anything else (API errors, logged out, a
   * code 8 rejection) surfaces straight away.
   */
  async _withTransportRetries<T>(label: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof SaicTransportError) || attempt >= TRANSPORT_RETRY.attempts) throw err;
        const wait = this._backoffDelay(attempt);
        this.log.debug(`${label}: ${err.message}, retrying in ${(wait / 1000).toFixed(1)}s `
          + `(attempt ${attempt + 1}/${TRANSPORT_RETRY.attempts}).`);
        await this._sleep(wait);
      }
    }
  }

  async rawRequest(method: string, path: string, {
    formBody, jsonBody, params, eventId,
  }: RawRequestOpts = {}): Promise<unknown> {
    const query       = params ? '?' + new URLSearchParams(params).toString() : '';
    const tokenUsed   = this.token;
    const url         = this.baseUri + path.replace(/^\//, '') + query;
    const requestPath = url.replace(this.baseUri, '/');
    const ts          = String(Date.now());

    let rawBody = '';
    let ct = 'application/json';
    if (formBody) {
      rawBody = new URLSearchParams(formBody).toString();
      ct = 'application/x-www-form-urlencoded';
    } else if (jsonBody) {
      rawBody = JSON.stringify(jsonBody);
    }

    const normalized = normalizeContentType(ct);
    let payload: string | undefined;
    if (rawBody) {
      const keyHex = md5Hex(
        md5Hex(requestPath + TENANT_ID + this.token + 'app') + ts + '1' + normalized,
      );
      payload = encryptAes(rawBody.trim(), keyHex, md5Hex(ts));
    }

    const headers: Record<string, string> = {
      'User-Agent':              USER_AGENT,
      'Content-Type':            `${normalized};charset=utf-8`,
      'Accept':                  'application/json',
      'REGION':                  this.region,
      'APP-SEND-DATE':           ts,
      'APP-CONTENT-ENCRYPTED':   '1',
      'tenant-id':               TENANT_ID,
      'User-Type':               'app',
      'APP-LANGUAGE-TYPE':       'en',
      'ORIGINAL-CONTENT-TYPE':   normalized,
      'APP-VERIFICATION-STRING': appVerificationString({
        path: requestPath, ts, contentType: normalized,
        content: rawBody.trim(), token: this.token,
      }),
    };
    if (this.token)             headers['blade-auth']    = this.token;
    if (eventId !== undefined)  headers['event-id']      = eventId;
    if (path === '/oauth/token') headers['Authorization'] = BASIC_AUTH;

    // One timeout covers connecting, the headers and the body. Network failures and timeouts
    // come out as SaicTransportError (see classifyTransportError); callers decide whether the
    // request is safe to repeat.
    let res: Awaited<ReturnType<typeof fetch>>;
    let text: string;
    try {
      res  = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(this.requestTimeoutMs) });
      text = await res.text();
    } catch (err) {
      const transport = classifyTransportError(err);
      if (!transport) throw err;
      this.log.debug(`[${method} ${path}] ${transport.message}${transport.notSent ? ' (request not sent)' : ''}`);
      throw transport;
    }
    // The gateway itself failing or throttling: transient, but the request did reach it.
    if (res.status >= 500 || res.status === 429) {
      this.log.debug(`[${method} ${path}] HTTP ${res.status}`);
      throw new SaicTransportError(`HTTP ${res.status} from the SAIC gateway`, `HTTP ${res.status}`, false, res.status);
    }

    const sendDate   = res.headers.get('app-send-date');
    const originalCt = res.headers.get('original-content-type');
    let body = text;
    if (text.trim() && sendDate && originalCt) {
      try {
        body = decryptAes(text.trim(), md5Hex(sendDate + '1' + originalCt), md5Hex(sendDate));
      } catch { /* wasn't encrypted after all */ }
    }

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(body) as Record<string, unknown>;
    } catch {
      throw new SaicError(`Non-JSON response (HTTP ${res.status}): ${body.slice(0, 300)}`, res.status);
    }

    const code        = (json['code'] as number) ?? -1;
    const message     = (json['message'] as string) ?? 'Unknown error';
    const respEventId = res.headers.get('event-id');
    // Present on /vehicle/control responses when the car itself rejected the command (e.g. it's
    // asleep, or in a state that won't accept that command) rather than the request just being
    // slow. Not documented anywhere; surfaced here so a real rejection is visible instead of
    // looking identical to a plain timeout.
    const data        = json['data'] as Record<string, unknown> | undefined;
    const failureType = data?.['failureType'] ?? json['failureType'];

    this.log.debug(
      `[${method} ${path}] code=${code} event-id=${respEventId ?? '-'} data=${data !== undefined ? 'yes' : 'no'} message=${message}` +
      (failureType !== undefined ? ` failureType=${String(failureType)}` : ''),
    );

    if (code === 401 || code === 403 || res.status === 401 || res.status === 403) {
      // Only drop the token this request was sent with: another request may already have
      // logged in again while this one was in flight.
      if (this.token === tokenUsed) this.token = '';
      throw new SaicError(`Logged out: ${message}`, code === 401 || code === 403 ? code : res.status);
    }
    // code 8 was originally left out of this list and fell through to the generic retry-with-
    // same-event-id path below. A real Homebridge log (see TESTING.md) showed that's wrong: a
    // control command rejected for a vehicle-state precondition (e.g. "Vehicle not locked.
    // Please lock it and try again.", "Vehicle is powered on. Please turn it off and try
    // again.") comes back with an identical code 8 and message on every single poll for the
    // full 60s window, never resolving - so retrying just delays a fixed rejection behind a
    // misleading "Timed out after 60s" instead of surfacing the car's actual reason immediately.
    if ([2, 3, 7, 8].includes(code)) throw new SaicError(message, code);

    // Async pattern: an event-id with no data means "ask again with this id".
    if (respEventId && data === undefined) {
      throw new SaicRetry(message, respEventId, code);
    }
    if (code !== 0) {
      if (eventId !== undefined && eventId !== '0') {
        throw new SaicRetry(message, eventId, code);
      }
      throw new SaicError(message, code);
    }
    return data ?? json;
  }

  /**
   * Renews an expired session once, for a request that just got a 401/403. Logs in again only
   * if nobody else has since the request was sent (tokenBefore), so several requests failing
   * together share one login (the _loginPromise gate covers the simultaneous case). Rethrows
   * the auth error when no credentials are known yet.
   */
  async _recoverSession(authError: unknown, tokenBefore: string): Promise<void> {
    if (this.token && this.token !== tokenBefore) return;
    if (!this._credentials) throw authError;
    this.log.info('SAIC session expired; logging in again once, then retrying the request.');
    await this.login(this._credentials.username, this._credentials.password);
  }

  /** Runs fn; on a 401/403, renews the session once and runs it one more time. */
  async _withSession<T>(fn: () => Promise<T>): Promise<T> {
    const tokenBefore = this.token;
    try {
      return await fn();
    } catch (err) {
      if (!isAuthError(err)) throw err;
      await this._recoverSession(err, tokenBefore);
      return fn();
    }
  }

  /**
   * Retry loop for the asynchronous endpoints. Default timeout is generous for a cold car.
   *
   * Transient network failures (SaicTransportError) are handled by phase:
   *   - once the gateway has handed out an event id, the request was accepted: keep asking
   *     about that same event id until the deadline, never send a fresh request;
   *   - before that, a GET is retried with backoff (bounded by TRANSPORT_RETRY);
   *   - a command (isCommand) is only re-sent when the error proves it never left
   *     (connect timeout, refused, DNS). Any other failure after sending it throws
   *     SaicCommandOutcomeUnknown instead: the car may or may not have acted on it.
   * A command that times out after the gateway accepted it is SaicCommandOutcomeUnknown too.
   */
  async requestWithEventId(
    method: string, path: string, opts: RawRequestOpts = {},
    { timeoutMs = 60000, isCommand = false }: RequestWithEventIdOpts = {},
  ): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    // Exponential backoff: 3s → 5s → 8s → 12s, capped at 15s. Reduces API
    // hammering on a sleeping car while staying fast for a responsive one.
    const BACKOFF = [3000, 5000, 8000, 12000, 15000];
    let eventId = '0';
    let attempt = 0;
    // The car's own reason for the last unsuccessful poll. Without this the timeout below
    // reports only "Timed out after 60s", which looks identical whether the car never
    // answered at all or was actively telling us something useful every single poll (a real
    // log showed 20 consecutive "The remote control instruction failed, please try again
    // later." responses collapsing into that one uninformative line at warn level, with the
    // actual message visible only if debug logging happened to be on).
    let lastMessage = '';
    // Transport failures before any event id was obtained (bounded by TRANSPORT_RETRY).
    let initialFailures = 0;
    // A 401/403 renews the session once per call (see _recoverSession), never more.
    let sessionRenewed = false;

    while (Date.now() < deadline) {
      attempt++;
      const tokenBefore = this.token;
      try {
        return await this.rawRequest(method, path, { ...opts, eventId });
      } catch (err) {
        if (isAuthError(err) && !sessionRenewed) {
          // Rejected for the session, not processed: renew it once and carry on - with event id
          // '0' that re-sends the request, otherwise it keeps following the same event id.
          sessionRenewed = true;
          await this._recoverSession(err, tokenBefore);
          continue;
        }
        if (err instanceof SaicTransportError) {
          lastMessage = err.message;
          if (eventId !== '0') {
            // Already accepted by the gateway: keep asking about the same event id.
            const wait = BACKOFF[Math.min(attempt - 1, BACKOFF.length - 1)];
            this.log.debug(`[${method} ${path}] ${err.message} while waiting on event ${eventId}, `
              + `asking again in ${wait / 1000}s.`);
            await this._sleep(wait);
            continue;
          }
          const safeToResend = err.notSent || (!isCommand && method === 'GET');
          if (!safeToResend) {
            if (!isCommand) throw err;
            throw new SaicCommandOutcomeUnknown(
              `Outcome unknown: ${err.message} after the command was sent, so it may or may not have `
              + 'reached the car. Not re-sent.', 0,
            );
          }
          initialFailures++;
          if (initialFailures >= TRANSPORT_RETRY.attempts) throw err;
          const wait = this._backoffDelay(initialFailures);
          this.log.debug(`[${method} ${path}] ${err.message}${err.notSent ? ' (not sent)' : ''}, `
            + `retrying in ${(wait / 1000).toFixed(1)}s.`);
          await this._sleep(wait);
          continue;
        }
        if (!(err instanceof SaicRetry)) throw err;
        eventId = err.eventId;
        lastMessage = err.message;
        const wait = BACKOFF[Math.min(attempt - 1, BACKOFF.length - 1)];
        this.log.debug(`waiting for the car (attempt ${attempt}, ${wait / 1000}s)...`);
        await this._sleep(wait);
      }
    }
    const timedOut = `Timed out after ${timeoutMs / 1000}s waiting for the vehicle`
      + (lastMessage ? ` (the car's last response was: ${lastMessage})` : '');
    if (isCommand && eventId !== '0') {
      throw new SaicCommandOutcomeUnknown(
        `${timedOut}. The gateway had accepted the command, so it may still have reached the car.`, 408,
      );
    }
    throw new SaicError(timedOut, 408);
  }

  async login(username: string, password: string): Promise<unknown> {
    this._credentials = { username, password };
    // Gate: if a login is already in flight (e.g. two parallel 401s), piggyback
    // onto it instead of making a second simultaneous call.
    if (this._loginPromise) return this._loginPromise;

    const pause = this._loginBlockedUntil - Date.now();
    if (pause > 0) {
      throw new SaicError(
        `Not logging in again for another ${Math.ceil(pause / 1000)} s after ${this._loginFailures} `
        + 'refused login(s) in a row (SAIC has been seen pausing accounts that log in too often).', 0,
      );
    }

    this._loginPromise = this._doLogin(username, password);
    try {
      const data = await this._loginPromise;
      this._loginFailures = 0;
      this._loginBlockedUntil = 0;
      return data;
    } catch (err) {
      if (!(err instanceof SaicTransportError)) {
        this._loginFailures++;
        this._loginBlockedUntil = Date.now()
          + Math.min(LOGIN_COOLDOWN.maxMs, LOGIN_COOLDOWN.baseMs * 2 ** (this._loginFailures - 1));
      }
      throw err;
    } finally {
      this._loginPromise = null;
    }
  }

  async _doLogin(username: string, password: string): Promise<unknown> {
    // Safe to repeat on a network failure: a second login just replaces the session.
    const data = await this._withTransportRetries('login', () => this.rawRequest('POST', '/oauth/token', {
      formBody: {
        grant_type:  'password',
        username,
        password:    sha1Hex(password),
        scope:       'all',
        deviceId:    `${this._deviceId}###com.saicmotor.europecar`,
        deviceType:  '0',
        language:    'EN',
        loginType:   username.includes('@') ? '2' : '1',
      },
    })) as Record<string, unknown>;

    const token = (data['access_token'] ?? data['accessToken']) as string | undefined;
    if (!token) throw new SaicError('No access token returned. Check your credentials.', 401);
    this.token = token;
    return data;
  }

  /** Returns the SHA-256 hex digest of the VIN, cached by VIN string. */
  _vinHash(vin: string): string {
    let h = this._vinHashCache.get(vin);
    if (!h) {
      h = sha256Hex(vin);
      this._vinHashCache.set(vin, h);
    }
    return h;
  }

  vehicleList(): Promise<unknown> {
    return this._withTransportRetries('vehicle list', () => this._withSession(() => this.rawRequest('GET', '/vehicle/list')));
  }

  /** VIN must be hashed. Sending it raw returns the misleading error 36805. */
  vehicleStatus(vin: string): Promise<unknown> {
    return this.requestWithEventId('GET', '/vehicle/status', {
      params: { vin: this._vinHash(vin), vehStatusReqType: '2' },
    });
  }

  chargingStatus(vin: string): Promise<unknown> {
    return this.requestWithEventId('GET', '/vehicle/charging/mgmtData', {
      params: { vin: this._vinHash(vin) },
    });
  }

  // ------------------------------------------------------------- lock control
  //
  // Ported from saic_ismart_client_ng.api.vehicle.locks (SAIC-iSmart-API/saic-python-client-ng,
  // MIT), not from anything hand-derived. rvcReqType "1" locks with no params. rvcReqType "2"
  // unlocks and needs five rvcParams: three unknown-purpose zero bytes (paramId 4-6, present in
  // every observed unlock request in the reference client but never explained), the lock target
  // (paramId 7: 3 for doors, 2 for tailgate), and a four-byte zero terminator (paramId 255).
  // Confirmed working against a real MG4: unlocking actually opens the doors.

  /**
   * POST /vehicle/control is async like status/charging: same event-id retry loop. Queued (see
   * _enqueueControl above) so that two control commands never race the vehicle at once - only
   * one is in flight at a time, and a second tap while one is already running waits its turn
   * instead of timing out.
   */
  vehicleControl(vin: string, { rvcReqType, rvcParams = null }: { rvcReqType: string; rvcParams?: RvcParam[] | null }): Promise<unknown> {
    return this._enqueueControl(async () => {
      try {
        const result = await this.requestWithEventId('POST', '/vehicle/control', {
          jsonBody: { rvcReqType, rvcParams, vin: this._vinHash(vin) },
        }, { isCommand: true });
        this.onControlSettled?.('ok');
        return result;
      } catch (err) {
        this.onControlSettled?.(err instanceof SaicCommandOutcomeUnknown ? 'unknown' : 'failed', err);
        throw err;
      }
    });
  }

  lockVehicle(vin: string): Promise<unknown> {
    return this.vehicleControl(vin, { rvcReqType: '1', rvcParams: null });
  }

  /** lockId: LOCK_ID.DOORS (3, default) or LOCK_ID.TAILGATE (2). */
  unlockVehicle(vin: string, lockId = LOCK_ID.DOORS): Promise<unknown> {
    return this.vehicleControl(vin, {
      rvcReqType: '2',
      rvcParams: [
        { paramId: 4,   paramValue: b64([0]) },
        { paramId: 5,   paramValue: b64([0]) },
        { paramId: 6,   paramValue: b64([0]) },
        { paramId: 7,   paramValue: b64([lockId]) },
        { paramId: 255, paramValue: b64([0, 0, 0, 0]) },
      ],
    });
  }

  openTailgate(vin: string): Promise<unknown> {
    return this.unlockVehicle(vin, LOCK_ID.TAILGATE);
  }

  // -------------------------------------------------------- climate control
  //
  // Ported from saic_ismart_client_ng.api.vehicle.climate. rvcReqType "5" sets heated seat
  // levels for both seats in one request (paramId 17 = left, 18 = right; note the reference
  // client's own docs call these "driver"/"passenger", but the actual status fields returned
  // by /vehicle/status are positional - frontLeftSeatHeatLevel / frontRightSeatHeatLevel - so
  // this client uses left/right throughout to sidestep the LHD/RHD ambiguity of "driver").
  // rvcReqType "32" is the separate rear window defrost command (paramId 23, one byte on/off).
  // Confirmed working against a real MG4 - see the plugin's TESTING.md.

  /** level is 0-3 per the reference client (0 = off); this plugin only ever sends 0 or 3. */
  controlHeatedSeats(vin: string, { leftLevel = 0, rightLevel = 0 }: { leftLevel?: number; rightLevel?: number } = {}): Promise<unknown> {
    return this.vehicleControl(vin, {
      rvcReqType: '5',
      rvcParams: [
        { paramId: 17,  paramValue: b64([leftLevel]) },
        { paramId: 18,  paramValue: b64([rightLevel]) },
        { paramId: 255, paramValue: b64([0, 0, 0, 0]) },
      ],
    });
  }

  controlRearWindowHeat(vin: string, enable: boolean): Promise<unknown> {
    return this.vehicleControl(vin, {
      rvcReqType: '32',
      rvcParams: [
        { paramId: 23,  paramValue: b64([enable ? 1 : 0]) },
        { paramId: 255, paramValue: b64([0, 0, 0, 0]) },
      ],
    });
  }

  // ------------------------------------------------------- climate/preconditioning
  //
  // rvcReqType "6" is climate control. paramId 19 = fan speed (0-5), 20 = temperature index,
  // 22 = AC compressor on/off. Ported from the reference client's own start_ac/stop_ac
  // convenience wrappers rather than the full fan-speed/temperature range. Fan bytes 4 and 5
  // are NOT higher fan speeds — 5 is the dedicated front-defrost trigger (see
  // startFrontDefrost below); 4 is unconfirmed and unused by this client.
  //
  // compressor=false (the reference client default): car heats with the PTC resistive heater,
  //   remoteClimateStatus returns 2 (HEATING). Confirmed working on a real MG4.
  // compressor=true: AC compressor engaged for cooling, remoteClimateStatus expected to return
  //   3 (COOLING). Confirmed NOT to work as documented: a real MG4 test ran the heater at
  //   maximum instead of cooling. See the plugin's TESTING.md/docs/API.md before touching this.

  startClimate(vin: string, temperatureIdx = 8, compressor = false): Promise<unknown> {
    const params: { paramId: number; paramValue: string }[] = [
      { paramId: 19,  paramValue: b64([2]) },
      { paramId: 20,  paramValue: b64([temperatureIdx]) },
    ];
    if (compressor) {
      params.push({ paramId: 22, paramValue: b64([1]) });
    }
    params.push({ paramId: 255, paramValue: b64([0, 0, 0, 0]) });
    return this.vehicleControl(vin, { rvcReqType: '6', rvcParams: params });
  }

  stopClimate(vin: string): Promise<unknown> {
    return this.vehicleControl(vin, {
      rvcReqType: '6',
      rvcParams: [
        { paramId: 19,  paramValue: b64([0]) },
        { paramId: 22,  paramValue: b64([0]) },
        { paramId: 255, paramValue: b64([0, 0, 0, 0]) },
      ],
    });
  }

  /**
   * Front windscreen defrost: same rvcReqType "6" climate command as startClimate, but with
   * fan speed 5 and a fixed 22°C (index 8) instead of the usual fan 2 / chosen temperature.
   * Ported from mg-saic-client's own start_front_defrost (fan_speed=5, ac_on=True,
   * temperature_idx=8), which documents 22°C as always fixed regardless of any user
   * temperature setting - this matches what the iSmart app itself sends. Not yet confirmed
   * against real hardware by this plugin. The car auto-cancels defrost after roughly 10
   * minutes on its own; there's no dedicated stop command, use stopClimate() to end it early.
   */
  startFrontDefrost(vin: string): Promise<unknown> {
    return this.vehicleControl(vin, {
      rvcReqType: '6',
      rvcParams: [
        { paramId: 19,  paramValue: b64([5]) },
        { paramId: 20,  paramValue: b64([8]) },
        { paramId: 22,  paramValue: b64([1]) },
        { paramId: 255, paramValue: b64([0, 0, 0, 0]) },
      ],
    });
  }

  // ---------------------------------------------------------- window control
  //
  // Ported from saic_ismart_client_ng.api.vehicle.windows. rvcReqType "3" names every window in
  // one request (which ones are "requested", paramId 8/9/10/11/12) plus a single open/close flag
  // (paramId 13, 3 = open, 0 = close) that applies to whichever windows were marked requested.
  //
  // Tested against a real MG4 and confirmed NOT to work: the car consistently rejects it with
  // code 8, "Request failed. Please check the vehicle status and try again.", regardless of lock
  // state, an open driver's door, or the car having just been started - tried all three. No
  // HomeKit accessory calls this method for that reason (see accessory.ts). Left here, unused,
  // in case a firmware update or a different vehicle ever behaves differently; if you're
  // resurrecting this, WINDOW_ID.DRIVER is the one confirmed-correct mapping (both the reference
  // client and this project's own /vehicle/status capture call it "driver"), WINDOW_2/3/4 were
  // never confirmed since the base command never worked.

  controlWindow(vin: string, windowId: number, { open }: { open: boolean }): Promise<unknown> {
    const allWindowIds = [WINDOW_ID.SUNROOF, WINDOW_ID.DRIVER, WINDOW_ID.WINDOW_2, WINDOW_ID.WINDOW_3, WINDOW_ID.WINDOW_4];
    const rvcParams = allWindowIds.map((id) => ({ paramId: id, paramValue: b64([id === windowId ? 1 : 0]) }));
    rvcParams.push({ paramId: 13, paramValue: b64([open ? 3 : 0]) });
    return this.vehicleControl(vin, { rvcReqType: '3', rvcParams });
  }
}

export const LOCK_ID: Record<string, number>   = { TAILGATE: 2, DOORS: 3 };
export const WINDOW_ID: Record<string, number> = { SUNROOF: 8, DRIVER: 9, WINDOW_2: 10, WINDOW_3: 11, WINDOW_4: 12 };

function b64(bytes: number[]): string {
  return Buffer.from(bytes).toString('base64');
}
