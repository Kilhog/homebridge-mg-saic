import { SaicClient, SaicError } from './saic-client.js';
import { MgSaicAccessory, climateTemperatureRange, serviceLanguage } from './accessory.js';
import { OutageLog } from './outage.js';
import { resolvePassword } from './password.js';

const PLUGIN_NAME = '@kilhog/homebridge-mg-saic';
const PLATFORM_NAME = 'MgSaic';

// After consecutive failed polls the interval doubles (from the 2nd failure on), up to this
// many times the configured interval, and snaps back on the first success.
export const POLL_BACKOFF_MAX_FACTOR = 4;
// Sensors show StatusFault once the last good status read is older than this many intervals.
export const STALE_AFTER_POLL_INTERVALS = 3;

export class MgSaicPlatform {
  /**
   * @param {any} log
   * @param {any} config
   * @param {import('homebridge').API} api
   */
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = [];
    // Set while a poll runs, so a tick that comes due meanwhile is skipped.
    this._pollInFlight = false;
    // First failure of a streak at warn, the rest at debug, the recovery once at info.
    this.outage = new OutageLog(log, 'SAIC API');

    if (!config?.username) {
      this.log.warn('No username configured, MG SAIC platform will not start.');
      return;
    }

    const resolvedPassword = resolvePassword(config, this.log);
    this.password = resolvedPassword?.password;
    if (resolvedPassword) this.log.info(`Using the iSmart password from ${resolvedPassword.source}.`);
    if (!this.password) {
      this.log.warn('No password configured (config.password, config.passwordFile or MG_SAIC_PASSWORD env var), MG SAIC platform will not start.');
      return;
    }

    this.region = config.region || 'Australia';
    this.pollIntervalMs = Math.max(5, config.pollIntervalMinutes ?? 15) * 60 * 1000;
    this.enablePreconditioning = config.enablePreconditioning ?? true;
    this.enableDoorSensors = config.enableDoorSensors ?? true;
    this.enableTemperatureSensors = config.enableTemperatureSensors ?? false;
    // Off by default: writable controls not yet confirmed against real hardware when this
    // was written (unlike lock/unlock). See TESTING.md before turning them on. There is no
    // equivalent enableWindowControls option: window open/close was tried and confirmed not
    // to work on a real MG4, see README.md and CHANGELOG.md, so it was removed entirely.
    // enableWindowVentilation below is a different request, the MG S6 EV's all-four-windows
    // form (controlDoorWindows).
    this.enableHeatedSeats = config.enableHeatedSeats ?? false;
    this.enableRearDefrost = config.enableRearDefrost ?? false;
    this.enableFrontDefrost = config.enableFrontDefrost ?? false;
    // MG S6 EV control ported from the reference client, not yet confirmed by this plugin.
    this.enableHeatedSteeringWheel = config.enableHeatedSteeringWheel ?? false;
    // Off by default and unconfirmed on any real car: lets the Cabin Cool tile send the
    // reference client's start_ac (no compressor flag) instead of being refused.
    this.enableExperimentalCabinCool = config.enableExperimentalCabinCool ?? false;
    this.enableWindowVentilation = config.enableWindowVentilation ?? false;
    // MG S6 EV rear seats via the per-seat command, not yet confirmed by this plugin.
    this.enableRearHeatedSeats = config.enableRearHeatedSeats ?? false;
    // MG S6 EV power tailgate, exposed as a GarageDoorOpener; not yet confirmed by this plugin.
    this.enablePowerTailgate = config.enablePowerTailgate ?? false;
    // Experimental, off by default: routine polls read SAIC's status cache, which doesn't wake
    // the car. See useStatusCache in accessory.ts.
    this.useStatusCache = config.useStatusCache ?? false;
    if (this.useStatusCache) {
      this.log.info('useStatusCache is on (experimental): routine polls read the status SAIC has stored '
        + 'instead of waking the car; the full status is still read after commands and when fields are missing.');
    }
    this.configuredVin = config.vin;

    this.client = new SaicClient(this.region, { log: this.log });

    this.api.on('didFinishLaunching', () => this.didFinishLaunching());
  }

  /** Homebridge calls this once per cached accessory on startup. */
  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  async didFinishLaunching() {
    try {
      await this.client.login(this.config.username, this.password);
      this.log.info('Logged in to the SAIC gateway.');
    } catch (err) {
      this.log.warn(`Login failed, will retry on next poll: ${err.message}`);
    }

    let vin = this.configuredVin;
    let vehicles = [];
    try {
      const list = await this.client.vehicleList();
      vehicles = list.vinList ?? list.vehicles ?? [];
    } catch (err) {
      this.log.warn(`Could not fetch vehicle list, will retry on next poll: ${err.message}`);
      if (!vin) return;
    }

    if (!vin) {
      if (vehicles.length === 0) {
        this.log.warn('No vehicles returned by the account.');
        return;
      }
      if (vehicles.length > 1) {
        this.log.warn(
          `Account returned ${vehicles.length} vehicles; this plugin exposes one only. `
          + 'Set the "vin" option in config to pin a specific vehicle. Using the first one for now.',
        );
      }
      vin = vehicles[0].vin;
    }

    // The vehicle's series code (e.g. "EH32...") pins which climate control behaviour
    // applies - different MG4 sub-variants (e.g. the entry-level "Urban" AH4EM) use a
    // different climate protocol than the standard EH32 this plugin targets, per
    // townsmcp/mg-saic-ha's vehicle profiles. Logged so a report of unexpected
    // pre-conditioning behaviour can be matched against the right profile.
    const matchedVehicle = vehicles.find((v) => v.vin === vin);
    if (matchedVehicle?.series) {
      const name = [matchedVehicle.brandName, matchedVehicle.modelName].filter(Boolean).join(' ');
      this.log.info(`Vehicle series: ${matchedVehicle.series}${name ? ` (${name})` : ''}`);
    }

    // The same series code also picks the Cabin Heat / Cabin Cool slider range, the way
    // saic-python-mqtt-gateway does (see climateTemperatureRange), unless config overrides it.
    // (null, which a cleared form field can leave behind, counts as not set.)
    const minOverride = this.config.climateMinTemperature ?? undefined;
    const maxOverride = this.config.climateMaxTemperature ?? undefined;
    const range = climateTemperatureRange(matchedVehicle?.series, { min: minOverride, max: maxOverride });
    if (range.error) this.log.warn(range.error);
    this.climateRange = { min: range.min, max: range.max };
    if (this.enablePreconditioning) {
      const overridden = !range.error && (minOverride !== undefined || maxOverride !== undefined);
      const source = overridden ? 'from config'
        : matchedVehicle?.series ? `for series ${matchedVehicle.series}`
          : 'default, vehicle series unknown';
      this.log.info(`Climate target temperature range: ${range.min}-${range.max} °C (${source}).`);
    }

    this.registerAccessory(vin, matchedVehicle?.modelName);
    this.startPolling();
  }

  registerAccessory(vin, modelName) {
    const uuid = this.api.hap.uuid.generate(`mg-saic-${vin}`);
    let platformAccessory = this.accessories.find((a) => a.UUID === uuid);

    // Named after the model the account reports (e.g. "MGS6 EV"), or accessoryName from
    // config, instead of a hard-coded "MG4". Only applies when the accessory is created: a
    // cached accessory keeps its name, since renaming it under an existing HomeKit pairing
    // is the Home app's job.
    const model = modelName?.trim() || 'MG4';
    const configuredName = this.config.accessoryName;
    const displayName = (typeof configuredName === 'string' && configuredName.trim()) || model;

    const isNew = !platformAccessory;
    if (!platformAccessory) {
      platformAccessory = new this.api.platformAccessory(displayName, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
      this.accessories.push(platformAccessory);
    }

    this.vehicle = new MgSaicAccessory(platformAccessory, this.client, {
      vin,
      model,
      log: this.log,
      api: this.api,
      enablePreconditioning: this.enablePreconditioning,
      enableDoorSensors: this.enableDoorSensors,
      enableTemperatureSensors: this.enableTemperatureSensors,
      enableHeatedSeats: this.enableHeatedSeats,
      enableRearDefrost: this.enableRearDefrost,
      enableFrontDefrost: this.enableFrontDefrost,
      enableHeatedSteeringWheel: this.enableHeatedSteeringWheel,
      enableExperimentalCabinCool: this.enableExperimentalCabinCool,
      climateRange: this.climateRange,
      enableWindowVentilation: this.enableWindowVentilation,
      enableRearHeatedSeats: this.enableRearHeatedSeats,
      // Validated (1-3, default 3) by the accessory, which logs a warning if it's off.
      frontSeatHeatLevel: this.config.frontSeatHeatLevel,
      enablePowerTailgate: this.enablePowerTailgate,
      staleAfterMs: this.pollIntervalMs * STALE_AFTER_POLL_INTERVALS,
      useStatusCache: this.useStatusCache,
      // Tile names in the Home app: "fr" or English (default, also for anything else).
      language: serviceLanguage(this.config.language),
      // Validated (0-10 s, default 2) by the accessory, which logs a warning if it's off.
      commandDelaySeconds: this.config.commandDelaySeconds,
    });

    // The accessory constructor above adds or reuses services according to the current
    // enable* config. When it came from the cache, those additions only exist in memory
    // until the cached copy on disk is rewritten - Homebridge's API contract is that a
    // plugin mutating a cached accessory calls this itself. Without it the on-disk cache
    // keeps describing whatever set of services the previous run had, which is exactly
    // the kind of drift that makes a newly enabled switch fail to show up in the Home app.
    if (!isNew) {
      this.api.updatePlatformAccessories([platformAccessory]);
    }
  }

  /**
   * One poll: log in again if needed, then refresh the vehicle. Never runs twice at once.
   * Failures go through the outage log and drive the backoff in nextPollDelay().
   */
  async pollOnce() {
    if (!this.vehicle) return;
    if (this._pollInFlight) {
      this.log.debug('Previous poll still running - skipping this one.');
      return;
    }
    this._pollInFlight = true;
    try {
      if (!this.client.isLoggedIn) {
        try {
          await this.client.login(this.config.username, this.password);
          this.log.info('Re-logged in to the SAIC gateway.');
        } catch (err) {
          this.outage.failure(`login failed: ${err.message}`);
          return;
        }
      }

      try {
        const ok = await this.vehicle.refresh();
        if (ok) this.outage.success();
        else this.outage.failure(`status refresh failed: ${this.vehicle.lastStatusError ?? 'unknown error'}`);
      } catch (err) {
        // A 401/403 the client's one renewal didn't fix: clear the token, log in next poll.
        if (err instanceof SaicError && (err.code === 401 || err.code === 403)) {
          this.client.token = '';
          this.outage.failure('session expired during refresh, will log in again on the next poll');
        } else {
          this.outage.failure(err.message);
        }
      }
    } finally {
      this._pollInFlight = false;
    }
  }

  /** The configured interval, doubled per failed poll from the 2nd one on, capped. */
  nextPollDelay() {
    const failures = this.outage.consecutiveFailures;
    if (failures <= 1) return this.pollIntervalMs;
    return Math.min(this.pollIntervalMs * 2 ** (failures - 1), this.pollIntervalMs * POLL_BACKOFF_MAX_FACTOR);
  }

  startPolling() {
    // A chain of timeouts rather than setInterval: the next poll is only scheduled once the
    // previous one has finished, with the backoff applied.
    const loop = async () => {
      await this.pollOnce();
      const delay = this.nextPollDelay();
      if (delay !== this.pollIntervalMs) {
        this.log.debug(`Next poll in ${Math.round(delay / 60_000)} min (backing off after `
          + `${this.outage.consecutiveFailures} failed polls).`);
      }
      this._pollTimer = setTimeout(() => void loop(), delay);
    };
    // First poll shortly after startup, then on the configured interval.
    this._pollTimer = setTimeout(() => void loop(), 10_000);
  }

}
