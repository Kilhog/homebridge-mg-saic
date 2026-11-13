/**
 * A single MG4 exposed as one HomeKit accessory with several services.
 *
 * Field mapping is taken from a live capture against the primary MG4 (see
 * the "Confirmed field mapping" section of mg-saic-homebridge-brief.md):
 *
 *   lockStatus                        1 = locked, 0 = unlocked
 *   driverDoor / passengerDoor /
 *   rearLeftDoor / rearRightDoor      0 = closed, non-zero = open
 *   bootStatus / bonnetStatus         0 = closed, non-zero = open
 *   remoteClimateStatus               0 = off, non-zero = on
 *   bmsPackSOCDsp                     tenths of a percent (680 -> 68.0%)
 *   bmsChrgSts                        0 = not charging, non-zero = charging
 *   ccuOnbdChrgrPlugOn                0 = unplugged, 1 = plugged in
 *
 * Tyre pressure, odometer and trip data are deliberately left out, per the
 * brief: they exist in the API but have no sensible HomeKit home.
 *
 * LockMechanism is writable: setting it in HomeKit sends a real lock/unlock
 * command via /vehicle/control. Confirmed working against a real MG4,
 * unlocking actually opens the doors.
 *
 * interiorTemperature and exteriorTemperature drive two TemperatureSensor
 * services. The API has occasionally been seen to return -128 for fields
 * it can't report (see tyre pressure fields in a live capture), so both
 * readers treat implausible values as a fault rather than trusting them.
 *
 * Heated seats, rear defrost, front defrost and cabin pre-conditioning are writable
 * Switches, same as LockMechanism. Heated seats/rear defrost are confirmed
 * working against real hardware; pre-conditioning is wired to
 * /vehicle/control (rvcReqType "6"), confirmed working in 0.9.4. Note it asks
 * for a fixed 22C with the compressor off, which on an MG4 means heat - see
 * docs/API.md before changing the fan/temperature values.
 * Heated seats/rear defrost are off by default (enableHeatedSeats/
 * enableRearDefrost default to false) until tested. Seat heat is labelled by
 * physical side (left/right) rather than driver/passenger, since the status
 * API uses positional field names
 * (frontLeftSeatHeatLevel) while the reference client's own naming is
 * functional (driver/passenger) - conflating the two would risk labelling
 * the wrong seat depending on market.
 *
 * Rear heated seats (enableRearHeatedSeats, off by default, not yet confirmed against real
 * hardware): two more Switches using the per-seat control_heated_seat (param 25 / 26, on =
 * 3), read from secondRowLeftSeatHeatLevel / secondRowRightSeatHeatLevel. The front seats
 * keep the two-seat command; frontSeatHeatLevel (1-3, default 3) is the level their On
 * sends. See accessory.ts for the fuller version of this comment.
 *
 * Front defrost (enableFrontDefrost, off by default, not yet confirmed against real
 * hardware) reuses the same rvcReqType "6" climate command as pre-conditioning, but with
 * fan speed 5 instead of the usual 2. Its On/Off state is tracked locally rather than
 * read back from the car (see setFrontDefrost), since the car has no confirmed status
 * field for it and auto-cancels after roughly 10 minutes on its own. See accessory.ts
 * for the fuller version of this comment.
 *
 * Pre-conditioning is exposed as two separate HeaterCooler services, "Cabin Heat"
 * and "Cabin Cool", rather than one tile with a mode toggle. Each is locked to a
 * single TargetHeaterCoolerState (HEAT or COOL respectively, via validValues) and
 * carries its own remembered target temperature (_heatTargetTemp/_coolTargetTemp,
 * within climateRange - see climateTemperatureRange below, 17-33 °C on an MG4). Turning Heat's Active on sends startClimate with the compressor off
 * and immediately mirrors Active=INACTIVE onto the other tile, since the car only
 * has one underlying climate system. Cabin Cool's Active toggle is disabled by
 * default - confirmed on real hardware to heat at maximum instead of cooling, see
 * setCoolActive below and TESTING.md. enableExperimentalCabinCool (unconfirmed on any
 * car) re-enables it with the reference client's start_ac instead: the Cabin Heat
 * command (no param 22) with the Cool tile's own target temperature, leaving heat or
 * cool to the car. See accessory.ts for the fuller version of this comment.
 *
 * Heated steering wheel (enableHeatedSteeringWheel, off by default, not yet confirmed
 * against real hardware) is a plain Switch (rvcReqType "8", see saic-client.js), read back
 * from basicVehicleStatus.steeringHeatLevel. A non-zero steeringWheelHeatFailureReason is
 * logged as-is. See accessory.ts for the fuller version of this comment.
 *
 * Power tailgate (enablePowerTailgate, off by default, not yet confirmed against real
 * hardware) is a GarageDoorOpener (a secure accessory class in HomeKit), sending
 * controlTailgate (rvcReqType "9") and reading Open/Closed from bootStatus. See
 * accessory.ts for the fuller version of this comment.
 *
 * When a command's outcome is unknown (SaicCommandOutcomeUnknown) it is not re-sent: the
 * HomeKit write fails, nothing is patched, the lock shows UNKNOWN rather than JAMMED, and the
 * car's state is re-read RECHECK_DELAY_MS later (scheduleStatusRecheck).
 *
 * HomeKit keeps serving the last values while the API is unreachable; once the last good
 * status read is older than staleAfterMs, the contact and temperature sensors show
 * StatusFault. refresh() is single-flight. See accessory.ts for more.
 *
 * useStatusCache (off by default, not yet tried on a real car): routine polls read SAIC's
 * stored status (/vehicle/status/cache, doesn't wake the car); the full status is still read
 * first, after any command, for re-reads and the lock sequence, and whenever the cache lacks
 * a field an enabled service needs. See accessory.ts for more.
 *
 * Window open/close was tried and confirmed NOT to work on an MG4: the car
 * consistently rejects the command with "Request failed. Please check the
 * vehicle status and try again." regardless of lock state, door-open state,
 * or being freshly started. There's no HomeKit switch for it. The
 * low-level request is still in saic-client.js (controlWindow/WINDOW_ID)
 * in case a future firmware update or a different vehicle behaves
 * differently, but nothing in this accessory calls it. See CHANGELOG.md.
 *
 * Window ventilation (enableWindowVentilation, off by default) uses the MG S6 EV's
 * all-four-door-windows form instead (controlDoorWindows): On = ventilate, Off = close
 * all four, full open not exposed. Reads On when any door window is non-zero. See
 * accessory.ts for the fuller version of this comment.
 */

import {
  SaicError, SaicCommandOutcomeUnknown,
  DOOR_WINDOWS_ACTION, HEATED_SEAT, REAR_HEATED_SEAT_ON_LEVEL, TAILGATE_ACTION,
} from './saic-client.js';
import { OutageLog } from './outage.js';

/** 3 x the default 15 minute poll interval. */
export const DEFAULT_STALE_AFTER_MS = 45 * 60_000;

// ------------------------------------------------------- climate temperature

/**
 * Bounds a configured climateMinTemperature/climateMaxTemperature must stay within: 16 °C
 * (saic-python-mqtt-gateway, non-MG4 series) to 33 °C (mg-saic-ha's MG4 profile).
 */
export const CLIMATE_TEMPERATURE_LIMITS = { min: 16, max: 33 };

/**
 * Target temperature range for the Cabin Heat / Cabin Cool sliders, from the vehicle's
 * series code as saic-python-mqtt-gateway's vehicle_info.py does: EH32 (MG4) 17-33 °C
 * (kept at this plugin's historic max, the gateway says 31), MZS3E 16-31 °C, any other
 * series 16-28 °C (MG S6 EV "MIS3E ...", unconfirmed), no series known 17-33 °C. Config
 * overrides replace either bound if the result is whole numbers within
 * CLIMATE_TEMPERATURE_LIMITS with min below max; otherwise `error` says why. See
 * accessory.ts for the fuller version of this comment.
 */
export function climateTemperatureRange(series, overrides = {}) {
  const code = (series ?? '').trim().toUpperCase();
  const base = !code || code.startsWith('EH32') ? { min: 17, max: 33 }
    : code.startsWith('MZS3E') ? { min: 16, max: 31 }
      : { min: 16, max: 28 };
  if (overrides.min === undefined && overrides.max === undefined) return base;

  const min = overrides.min ?? base.min;
  const max = overrides.max ?? base.max;
  const inLimits = (v) => typeof v === 'number' && Number.isInteger(v)
    && v >= CLIMATE_TEMPERATURE_LIMITS.min && v <= CLIMATE_TEMPERATURE_LIMITS.max;
  if (!inLimits(min) || !inLimits(max) || min >= max) {
    return {
      ...base,
      error: `Ignoring climateMinTemperature/climateMaxTemperature (${String(overrides.min)}/${String(overrides.max)}): `
        + `both must be whole numbers from ${CLIMATE_TEMPERATURE_LIMITS.min} to ${CLIMATE_TEMPERATURE_LIMITS.max} °C, `
        + `min below max. Using ${base.min}-${base.max} °C.`,
    };
  }
  return { min, max };
}

/**
 * SAIC climate temperature index: idx = °C - 14. Same formula in mg-saic-ha's MG4 profile
 * (3 + °C - 17) and in saic-python-mqtt-gateway for every series (3 + °C - 17 for EH32,
 * 2 + °C - 16 otherwise).
 */
export function climateTemperatureIndex(celsius) {
  return Math.round(celsius) - 14;
}

// Door field→service-index mapping, used in both setupContactSensors and pushStatusCharacteristics.
const DOOR_FIELDS = [
  ['Driver door', 'driverDoor'],
  ['Passenger door', 'passengerDoor'],
  ['Rear left door', 'rearLeftDoor'],
  ['Rear right door', 'rearRightDoor'],
  ['Boot', 'bootStatus'],
  ['Bonnet', 'bonnetStatus'],
];

// The four door window status fields, the ones the window ventilation switch reads.
const WINDOW_FIELDS = ['driverWindow', 'passengerWindow', 'rearLeftWindow', 'rearRightWindow'];

export class MgSaicAccessory {
  static CHARGING_RECHECK_CYCLES = 4;
  // Delays (ms) between each extra poll once the lock-triggered rapid refresh sequence
  // starts, mirroring mg-saic-ha's post-shutdown refresh sequence: 1, 3, 7, 15, 25
  // minutes cumulative. Exits early as soon as a plug-in is seen.
  static LOCK_REFRESH_SEQUENCE_MS = [60_000, 120_000, 240_000, 480_000, 600_000];
  // Delay before the one-off re-read after a command whose outcome is unknown.
  static RECHECK_DELAY_MS = 30_000;

  /**
   * @param {import('homebridge').PlatformAccessory} accessory
   * @param {import('./saic-client.js').SaicClient} client
   * @param {{ vin: string, log: any, api: any, enablePreconditioning: boolean, enableDoorSensors: boolean, enableTemperatureSensors: boolean, enableHeatedSeats: boolean, enableRearDefrost: boolean, enableFrontDefrost: boolean, enableHeatedSteeringWheel: boolean, enableWindowVentilation: boolean, enableRearHeatedSeats: boolean, frontSeatHeatLevel?: number, enablePowerTailgate: boolean, staleAfterMs?: number, useStatusCache?: boolean, enableExperimentalCabinCool?: boolean, climateRange?: { min: number, max: number } }} opts
   */
  constructor(accessory, client, {
    vin, log, api, enablePreconditioning, enableDoorSensors, enableTemperatureSensors,
    enableHeatedSeats, enableRearDefrost, enableFrontDefrost, enableHeatedSteeringWheel,
    enableWindowVentilation,
    enableRearHeatedSeats,
    frontSeatHeatLevel,
    enablePowerTailgate,
    enableExperimentalCabinCool = false,
    climateRange = climateTemperatureRange(),
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
    useStatusCache = false,
  }) {
    this.accessory = accessory;
    this.client = client;
    this.vin = vin;
    this.log = log;
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.enablePreconditioning = enablePreconditioning;
    this.enableDoorSensors = enableDoorSensors;
    this.enableTemperatureSensors = enableTemperatureSensors;
    this.enableHeatedSeats = enableHeatedSeats;
    this.enableRearDefrost = enableRearDefrost;
    this.enableFrontDefrost = enableFrontDefrost;
    this.enableHeatedSteeringWheel = enableHeatedSteeringWheel;
    this.enableWindowVentilation = enableWindowVentilation;
    this.enableExperimentalCabinCool = enableExperimentalCabinCool;
    // Slider range for Cabin Heat / Cabin Cool, see climateTemperatureRange.
    this.climateRange = { min: climateRange.min, max: climateRange.max };
    this.enableRearHeatedSeats = enableRearHeatedSeats;
    // Level (1-3) a front seat heat switch's On sends; 3 unless configured.
    this.frontSeatHeatLevel = this.validFrontSeatHeatLevel(frontSeatHeatLevel);
    this.enablePowerTailgate = enablePowerTailgate;
    // How old the last good status read may get before sensors show StatusFault.
    this.staleAfterMs = staleAfterMs;
    // When /vehicle/status last succeeded (or, before that, when this accessory was created).
    this._lastStatusAt = Date.now();
    // Why the last status read failed, for the platform's outage log.
    this.lastStatusError = undefined;
    // The refresh currently running, so overlapping callers share it.
    this._refreshInFlight = undefined;
    // The charging endpoint fails on its own sometimes: log its streaks quietly.
    this.chargingOutage = new OutageLog(log, 'Charging status');
    // Routine polls read /vehicle/status/cache (doesn't wake the car). Off by default.
    this.useStatusCache = useStatusCache;
    // The next status read must be the full /vehicle/status (first poll, after a command).
    this._fullStatusNext = true;
    // So the "cache lacks fields" explanation is logged once, not on every poll.
    this._cacheFallbackLogged = false;
    // A command whose outcome is unknown was not re-sent; find out what the car actually did.
    this._recheckTimer = undefined;
    // Any command also means the next status read is the full one (useStatusCache).
    this.client.onControlSettled = (outcome) => {
      this._fullStatusNext = true;
      if (outcome === 'unknown') this.scheduleStatusRecheck();
    };
    // Tracks only what HomeKit last commanded for front defrost, not a value read back
    // from the car - see setFrontDefrost for why.
    this._frontDefrostActive = false;
    // Last steeringWheelHeatFailureReason seen, so a non-zero value is logged once when it
    // appears rather than on every poll while it stays the same.
    this._lastSteeringWheelHeatFailureReason = 0;
    // True after the experimental Cool tile started the climate (see setCoolActive): its
    // command is the same start_ac as Cabin Heat, so the car may report it as
    // remoteClimateStatus 2 like heat. Local only, cleared by any other climate command,
    // by remoteClimateStatus reading anything other than 2 or 3, and by a restart.
    this._coolStartedLocally = false;
    // Last remoteClimateStatus seen, so it's only logged when it changes.
    this._lastRemoteClimateStatus = undefined;

    this.setupInfoService();
    this.setupBatteryService();
    this.setupLockService();
    this.setupOutletService();
    if (this.enablePreconditioning) this.setupPreconditioningHeaterCoolers();
    if (this.enableDoorSensors) this.setupContactSensors();
    if (this.enableTemperatureSensors) this.setupTemperatureSensors();
    if (this.enableHeatedSeats) this.setupHeatedSeatSwitches();
    if (this.enableRearDefrost) this.setupRearDefrostSwitch();
    if (this.enableFrontDefrost) this.setupFrontDefrostSwitch();
    if (this.enableHeatedSteeringWheel) this.setupSteeringWheelHeatSwitch();
    if (this.enableWindowVentilation) this.setupWindowVentilationSwitch();
    if (this.enableRearHeatedSeats) this.setupRearSeatHeatSwitches();
    if (this.enablePowerTailgate) this.setupTailgateOpener();

    // Cached latest reads, so a slow poll of one endpoint doesn't block
    // characteristic reads for data from the other endpoint.
    this._lastStatus = null;
    this._lastCharging = null;
    // Consecutive poll cycles in which the charging query has been skipped because the
    // last successful reading showed the charger unplugged. A real Homebridge log showed
    // /vehicle/charging/mgmtData timing out after a full 60s on every single poll cycle for
    // over 90 minutes straight while /vehicle/status kept succeeding, i.e. the car was awake
    // and reachable, it just had nothing plugged in to report on. Skipping the doomed query
    // saves that 60s, but it's rechecked every CHARGING_RECHECK_CYCLES cycles in case a cable
    // gets plugged in while we're not looking.
    this._chargingSkipStreak = 0;
    // Last observed lockStatus, used to detect the unlocked -> locked transition that
    // kicks off the rapid refresh sequence below. Undefined until the first successful
    // poll, so we never fire on startup before we actually know the previous state.
    this._prevLockStatus = undefined;
    this._lockRefreshTimer = undefined;
    // Stable cache for the last known-good temperature values; named explicitly
    // to avoid hidden-class churn from dynamic property assignment.
    this._lastInteriorTemperature = null;
    this._lastExteriorTemperature = null;
    // User-chosen target temperature in °C (within climateRange) for each pre-conditioning
    // tile. Persists across on/off toggles. Kept separate per tile since Heat and Cool
    // are now independent HeaterCooler services rather than one shared mode.
    this._heatTargetTemp = this.clampClimateTemp(22);
    this._coolTargetTemp = this.clampClimateTemp(22);

    this.logExposedServices();
  }

  /**
   * Says which switches and sensors this run actually put into HomeKit, and which
   * were left out because they're off in config. Every optional service here is
   * behind an enable* flag, and until this existed there was no way to tell from a
   * log whether a missing tile in the Home app meant "disabled in config" or
   * "something went wrong" - the startup log looked identical either way.
   */
  logExposedServices() {
    const exposed = ['Battery', 'Lock', 'Charging outlet'];
    const disabled = [];
    const record = (on, label) => {
      (on ? exposed : disabled).push(label);
    };
    record(this.enablePreconditioning, 'Pre-conditioning (Cabin Heat / Cabin Cool)');
    record(this.enableDoorSensors, 'Door sensors');
    record(this.enableTemperatureSensors, 'Temperature sensors');
    record(this.enableHeatedSeats, 'Heated seats');
    record(this.enableRearDefrost, 'Rear defrost');
    record(this.enableFrontDefrost, 'Front defrost');
    record(this.enableHeatedSteeringWheel, 'Heated steering wheel');
    record(this.enableWindowVentilation, 'Window ventilation');
    record(this.enableRearHeatedSeats, 'Rear heated seats');
    record(this.enablePowerTailgate, 'Power tailgate');

    this.log.info(`HomeKit services exposed: ${exposed.join(', ')}.`);
    if (disabled.length) {
      this.log.info(`Not exposed, disabled in config: ${disabled.join(', ')}.`);
    }
    if (this.enablePreconditioning && this.enableExperimentalCabinCool) {
      this.log.warn(
        'Experimental Cabin Cool is on (enableExperimentalCabinCool): the Cool tile sends the same '
        + 'start command as Cabin Heat (no compressor flag) with its own target temperature, and leaves '
        + 'heating or cooling to the car. Not confirmed on any real car - see README.md.',
      );
    }
  }

  /** frontSeatHeatLevel must be 1, 2 or 3; anything else falls back to 3 with a warning. */
  validFrontSeatHeatLevel(level) {
    if (level === undefined || level === null) return 3;
    if (typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= 3) return level;
    this.log.warn(`Ignoring frontSeatHeatLevel ${String(level)}: it must be 1, 2 or 3. Using 3.`);
    return 3;
  }

  setupInfoService() {
    const info = this.accessory.getService(this.Service.AccessoryInformation)
      ?? this.accessory.addService(this.Service.AccessoryInformation);
    info
      .setCharacteristic(this.Characteristic.Manufacturer, 'MG')
      .setCharacteristic(this.Characteristic.Model, 'MG4')
      .setCharacteristic(this.Characteristic.SerialNumber, this.vin || 'unknown-vin');
  }

  setupBatteryService() {
    this.batteryService = this.accessory.getService(this.Service.Battery)
      ?? this.accessory.addService(this.Service.Battery);

    this.batteryService.getCharacteristic(this.Characteristic.BatteryLevel)
      .onGet(() => this.readSoc());

    this.batteryService.getCharacteristic(this.Characteristic.ChargingState)
      .onGet(() => this.readChargingState());

    this.batteryService.getCharacteristic(this.Characteristic.StatusLowBattery)
      .onGet(() => (this.readSoc() <= 20
        ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL));
  }

  setupLockService() {
    this.lockService = this.accessory.getService(this.Service.LockMechanism)
      ?? this.accessory.addService(this.Service.LockMechanism);

    this.lockService.getCharacteristic(this.Characteristic.LockCurrentState)
      .onGet(() => this.readLockState());

    this.lockService.getCharacteristic(this.Characteristic.LockTargetState)
      .onGet(() => (this.readLockState() === this.Characteristic.LockCurrentState.SECURED
        ? this.Characteristic.LockTargetState.SECURED
        : this.Characteristic.LockTargetState.UNSECURED))
      .onSet((value) => this.setLockTarget(value));
  }

  setupOutletService() {
    this.outletService = this.accessory.getService(this.Service.Outlet)
      ?? this.accessory.addService(this.Service.Outlet);

    this.outletService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readPluggedIn());

    this.outletService.getCharacteristic(this.Characteristic.OutletInUse)
      .onGet(() => this.readCharging());
  }

  setupPreconditioningHeaterCoolers() {
    // "Cabin Heat" — locked to TargetHeaterCoolerState.HEAT. Active on sends
    // startClimate with the compressor off (PTC resistive heater).
    this.heatService = this.accessory.getService('Cabin Heat')
      ?? this.accessory.addService(this.Service.HeaterCooler, 'Cabin Heat', 'preconditionHeat');

    this.heatService.getCharacteristic(this.Characteristic.Active)
      .onGet(() => (this.readHeatActive()
        ? this.Characteristic.Active.ACTIVE
        : this.Characteristic.Active.INACTIVE))
      .onSet((value) => this.setHeatActive(value === this.Characteristic.Active.ACTIVE));

    this.heatService.getCharacteristic(this.Characteristic.CurrentHeaterCoolerState)
      .onGet(() => (this.readHeatActive()
        ? this.Characteristic.CurrentHeaterCoolerState.HEATING
        : this.Characteristic.CurrentHeaterCoolerState.INACTIVE));

    this.heatService.getCharacteristic(this.Characteristic.TargetHeaterCoolerState)
      .setProps({ validValues: [this.Characteristic.TargetHeaterCoolerState.HEAT] })
      .onGet(() => this.Characteristic.TargetHeaterCoolerState.HEAT)
      .onSet(() => { /* no-op: HEAT is the only valid value on this tile */ });

    this.heatService.getCharacteristic(this.Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 80 })
      .onGet(() => this.readInteriorTempForClimate());

    this.heatService.getCharacteristic(this.Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: this.climateRange.min, maxValue: this.climateRange.max, minStep: 1 })
      .onGet(() => this._heatTargetTemp)
      .onSet((value) => this.setHeatTemperature(value));

    // "Cabin Cool" — locked to TargetHeaterCoolerState.COOL. Turning Active on is
    // disabled unless enableExperimentalCabinCool is set; see setCoolActive.
    this.coolService = this.accessory.getService('Cabin Cool')
      ?? this.accessory.addService(this.Service.HeaterCooler, 'Cabin Cool', 'preconditionCool');

    this.coolService.getCharacteristic(this.Characteristic.Active)
      .onGet(() => (this.readCoolActive()
        ? this.Characteristic.Active.ACTIVE
        : this.Characteristic.Active.INACTIVE))
      .onSet((value) => this.setCoolActive(value === this.Characteristic.Active.ACTIVE));

    this.coolService.getCharacteristic(this.Characteristic.CurrentHeaterCoolerState)
      .onGet(() => (this.readCoolActive()
        ? this.Characteristic.CurrentHeaterCoolerState.COOLING
        : this.Characteristic.CurrentHeaterCoolerState.INACTIVE));

    this.coolService.getCharacteristic(this.Characteristic.TargetHeaterCoolerState)
      .setProps({ validValues: [this.Characteristic.TargetHeaterCoolerState.COOL] })
      .onGet(() => this.Characteristic.TargetHeaterCoolerState.COOL)
      .onSet(() => { /* no-op: COOL is the only valid value on this tile */ });

    this.coolService.getCharacteristic(this.Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 80 })
      .onGet(() => this.readInteriorTempForClimate());

    this.coolService.getCharacteristic(this.Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: this.climateRange.min, maxValue: this.climateRange.max, minStep: 1 })
      .onGet(() => this._coolTargetTemp)
      .onSet((value) => this.setCoolTemperature(value));
  }

  setupContactSensors() {
    this.contactServices = DOOR_FIELDS.map(([name, field]) => {
      const subtype = field;
      const service = this.accessory.getService(name)
        ?? this.accessory.addService(this.Service.ContactSensor, name, subtype);
      service.getCharacteristic(this.Characteristic.ContactSensorState)
        .onGet(() => this.readContactState(field));
      service.getCharacteristic(this.Characteristic.StatusFault)
        .onGet(() => this.readStaleFault());
      return service;
    });
  }

  setupTemperatureSensors() {
    this.interiorTempService = this.accessory.getService('Interior temperature')
      ?? this.accessory.addService(this.Service.TemperatureSensor, 'Interior temperature', 'interiorTemperature');
    this.interiorTempService.getCharacteristic(this.Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 80 })
      .onGet(() => this.readTemperature('interiorTemperature'));
    this.interiorTempService.getCharacteristic(this.Characteristic.StatusFault)
      .onGet(() => this.readTemperatureFault('interiorTemperature'));

    this.exteriorTempService = this.accessory.getService('Exterior temperature')
      ?? this.accessory.addService(this.Service.TemperatureSensor, 'Exterior temperature', 'exteriorTemperature');
    this.exteriorTempService.getCharacteristic(this.Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 80 })
      .onGet(() => this.readTemperature('exteriorTemperature'));
    this.exteriorTempService.getCharacteristic(this.Characteristic.StatusFault)
      .onGet(() => this.readTemperatureFault('exteriorTemperature'));
  }

  setupHeatedSeatSwitches() {
    this.leftSeatHeatService = this.accessory.getService('Left seat heat')
      ?? this.accessory.addService(this.Service.Switch, 'Left seat heat', 'leftSeatHeat');
    this.leftSeatHeatService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readSeatHeat('frontLeftSeatHeatLevel'))
      .onSet((value) => this.setSeatHeat('left', value));

    this.rightSeatHeatService = this.accessory.getService('Right seat heat')
      ?? this.accessory.addService(this.Service.Switch, 'Right seat heat', 'rightSeatHeat');
    this.rightSeatHeatService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readSeatHeat('frontRightSeatHeatLevel'))
      .onSet((value) => this.setSeatHeat('right', value));
  }

  setupRearDefrostSwitch() {
    this.rearDefrostService = this.accessory.getService('Rear window defrost')
      ?? this.accessory.addService(this.Service.Switch, 'Rear window defrost', 'rearDefrost');
    this.rearDefrostService.getCharacteristic(this.Characteristic.On)
      .onGet(() => Boolean(this._lastStatus?.basicVehicleStatus?.rmtHtdRrWndSt))
      .onSet((value) => this.setRearDefrost(value));
  }

  setupFrontDefrostSwitch() {
    this.frontDefrostService = this.accessory.getService('Front window defrost')
      ?? this.accessory.addService(this.Service.Switch, 'Front window defrost', 'frontDefrost');
    this.frontDefrostService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this._frontDefrostActive)
      .onSet((value) => this.setFrontDefrost(value));
  }

  setupSteeringWheelHeatSwitch() {
    this.steeringWheelHeatService = this.accessory.getService('Heated steering wheel')
      ?? this.accessory.addService(this.Service.Switch, 'Heated steering wheel', 'steeringWheelHeat');
    this.steeringWheelHeatService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readSteeringWheelHeat())
      .onSet((value) => this.setSteeringWheelHeat(value));
  }

  setupWindowVentilationSwitch() {
    this.windowVentilationService = this.accessory.getService('Window ventilation')
      ?? this.accessory.addService(this.Service.Switch, 'Window ventilation', 'windowVentilation');
    this.windowVentilationService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readWindowsOpen())
      .onSet((value) => this.setWindowVentilation(value));
  }

  setupRearSeatHeatSwitches() {
    this.rearLeftSeatHeatService = this.accessory.getService('Rear left seat heat')
      ?? this.accessory.addService(this.Service.Switch, 'Rear left seat heat', 'rearLeftSeatHeat');
    this.rearLeftSeatHeatService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readSeatHeat('secondRowLeftSeatHeatLevel'))
      .onSet((value) => this.setRearSeatHeat('left', value));

    this.rearRightSeatHeatService = this.accessory.getService('Rear right seat heat')
      ?? this.accessory.addService(this.Service.Switch, 'Rear right seat heat', 'rearRightSeatHeat');
    this.rearRightSeatHeatService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readSeatHeat('secondRowRightSeatHeatLevel'))
      .onSet((value) => this.setRearSeatHeat('right', value));
  }

  setupTailgateOpener() {
    this.tailgateService = this.accessory.getService('Tailgate')
      ?? this.accessory.addService(this.Service.GarageDoorOpener, 'Tailgate', 'powerTailgate');
    this.tailgateService.getCharacteristic(this.Characteristic.CurrentDoorState)
      .onGet(() => this.readTailgateCurrentState());
    this.tailgateService.getCharacteristic(this.Characteristic.TargetDoorState)
      .onGet(() => this.readTailgateTargetState())
      .onSet((value) => this.setTailgateTarget(value === this.Characteristic.TargetDoorState.OPEN));
    // Required by GarageDoorOpener; the car reports nothing like it.
    this.tailgateService.getCharacteristic(this.Characteristic.ObstructionDetected)
      .onGet(() => false);
  }

  // ------------------------------------------------------------- data reads

  readSoc() {
    const soc = this._lastCharging?.chrgMgmtData?.bmsPackSOCDsp;
    if (soc === undefined || soc === null) return 0;
    return Math.max(0, Math.min(100, soc / 10));
  }

  readChargingState() {
    const charging = this._lastCharging?.chrgMgmtData?.bmsChrgSts;
    return charging ? this.Characteristic.ChargingState.CHARGING : this.Characteristic.ChargingState.NOT_CHARGING;
  }

  readPluggedIn() {
    return Boolean(this._lastCharging?.chrgMgmtData?.ccuOnbdChrgrPlugOn);
  }

  readCharging() {
    return Boolean(this._lastCharging?.chrgMgmtData?.bmsChrgSts);
  }

  readLockState() {
    const locked = this._lastStatus?.basicVehicleStatus?.lockStatus;
    return locked ? this.Characteristic.LockCurrentState.SECURED : this.Characteristic.LockCurrentState.UNSECURED;
  }

  /**
   * remoteClimateStatus === 2: the car is running the PTC resistive heater - unless the
   * experimental Cool tile was what started it (see _coolStartedLocally).
   */
  readHeatActive() {
    return this._lastStatus?.basicVehicleStatus?.remoteClimateStatus === 2 && !this._coolStartedLocally;
  }

  /**
   * remoteClimateStatus === 3: the car is running the AC compressor. Also true on 2 when the
   * experimental Cool tile started the climate, since its command is the same start_ac as heat.
   */
  readCoolActive() {
    const status = this._lastStatus?.basicVehicleStatus?.remoteClimateStatus;
    return status === 3 || (status === 2 && this._coolStartedLocally);
  }

  readInteriorTempForClimate() {
    if (this.isTemperatureValid('interiorTemperature')) {
      return this.readTemperature('interiorTemperature');
    }
    return this._lastInteriorTemperature ?? 20;
  }

  readContactState(field) {
    const value = this._lastStatus?.basicVehicleStatus?.[field];
    return value
      ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : this.Characteristic.ContactSensorState.CONTACT_DETECTED;
  }

  /** true when the API returned a plausible temperature rather than an
   * unavailable-field sentinel (-128 has been observed on other fields
   * in the same response, e.g. tyre pressures, when a value isn't ready). */
  isTemperatureValid(field) {
    const value = this._lastStatus?.basicVehicleStatus?.[field];
    return typeof value === 'number' && value > -60 && value < 80;
  }

  readTemperature(field) {
    if (!this.isTemperatureValid(field)) {
      return field === 'interiorTemperature'
        ? (this._lastInteriorTemperature ?? 0)
        : (this._lastExteriorTemperature ?? 0);
    }
    const value = this._lastStatus.basicVehicleStatus[field];
    if (field === 'interiorTemperature') this._lastInteriorTemperature = value;
    else this._lastExteriorTemperature = value;
    return value;
  }

  readTemperatureFault(field) {
    return this.isTemperatureValid(field) && !this.isStatusStale()
      ? this.Characteristic.StatusFault.NO_FAULT
      : this.Characteristic.StatusFault.GENERAL_FAULT;
  }

  /** true once the last successful status read is older than staleAfterMs. */
  isStatusStale() {
    return Date.now() - this._lastStatusAt > this.staleAfterMs;
  }

  /** StatusFault for services whose only problem can be stale data (contact sensors). */
  readStaleFault() {
    return this.isStatusStale()
      ? this.Characteristic.StatusFault.GENERAL_FAULT
      : this.Characteristic.StatusFault.NO_FAULT;
  }

  readSeatHeat(field) {
    return Boolean(this._lastStatus?.basicVehicleStatus?.[field]);
  }

  /** steeringHeatLevel: 0 = off, non-zero = on (the command itself is only ever on/off). */
  readSteeringWheelHeat() {
    return Boolean(this._lastStatus?.basicVehicleStatus?.steeringHeatLevel);
  }

  /**
   * Logs a non-zero steeringWheelHeatFailureReason once, when it first shows up (or changes).
   * Its values are undocumented, so the raw number is logged as-is.
   */
  logSteeringWheelHeatFailure(status) {
    const reason = status?.steeringWheelHeatFailureReason;
    if (typeof reason !== 'number') return;
    if (reason !== 0 && reason !== this._lastSteeringWheelHeatFailureReason) {
      this.log.warn(`The car reported steeringWheelHeatFailureReason=${reason} for the heated steering wheel (meaning undocumented).`);
    }
    this._lastSteeringWheelHeatFailureReason = reason;
  }

  /** true when any door window reads open (ventilated and fully open look the same). */
  readWindowsOpen() {
    const status = this._lastStatus?.basicVehicleStatus;
    return WINDOW_FIELDS.some((field) => Boolean(status?.[field]));
  }

  /** bootStatus: 0 = closed, non-zero = open (however it was opened). */
  readTailgateCurrentState() {
    return this._lastStatus?.basicVehicleStatus?.bootStatus
      ? this.Characteristic.CurrentDoorState.OPEN
      : this.Characteristic.CurrentDoorState.CLOSED;
  }

  /** Target follows the reported state between commands, so the tile always looks settled. */
  readTailgateTargetState() {
    return this._lastStatus?.basicVehicleStatus?.bootStatus
      ? this.Characteristic.TargetDoorState.OPEN
      : this.Characteristic.TargetDoorState.CLOSED;
  }

  // --------------------------------------------------------------- lock write

  /**
   * Handles a HomeKit lock/unlock request. Unverified against real hardware,
   * see TESTING.md: this is the request shape from the reference client, run
   * through the same signing and event-id polling as every read call, but
   * nobody has watched a real MG4 respond to it yet.
   */
  async setLockTarget(value) {
    const wantLocked = value === this.Characteristic.LockTargetState.SECURED;
    this.log.info(`${wantLocked ? 'Locking' : 'Unlocking'} the MG4 via HomeKit...`);

    try {
      const result = wantLocked
        ? await this.client.lockVehicle(this.vin)
        : await this.client.unlockVehicle(this.vin);

      // The control response echoes a fresh basicVehicleStatus with the new
      // lock state when present, so reflect it immediately rather than
      // waiting for the next poll. If it's missing, patch just the lock bit
      // optimistically; the next poll corrects it either way.
      const freshStatus = result?.basicVehicleStatus;
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: freshStatus ?? {
          ...this._lastStatus?.basicVehicleStatus,
          lockStatus: wantLocked ? 1 : 0,
        },
      };
      this.lockService.updateCharacteristic(this.Characteristic.LockCurrentState, this.readLockState());
      this.log.info(`${wantLocked ? 'Lock' : 'Unlock'} command succeeded.`);
    } catch (err) {
      this.log.warn(`${wantLocked ? 'Lock' : 'Unlock'} command failed: ${err.message}`);
      // Unknown outcome: the car may or may not have locked; JAMMED would claim more than we know.
      this.lockService.updateCharacteristic(
        this.Characteristic.LockCurrentState,
        err instanceof SaicCommandOutcomeUnknown
          ? this.Characteristic.LockCurrentState.UNKNOWN
          : this.Characteristic.LockCurrentState.JAMMED,
      );
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // ---------------------------------------------------------------- writes

  /**
   * One HomeKit switch per physical seat, but the API sets both seats in a
   * single request, so this sends the other seat's last known level along
   * with the one actually being changed, rather than clobbering it to off.
   */
  async setSeatHeat(side, value) {
    // "On" is frontSeatHeatLevel (default 3) for both seats, as it was always 3 before.
    const on = this.frontSeatHeatLevel;
    const otherField = side === 'left' ? 'frontRightSeatHeatLevel' : 'frontLeftSeatHeatLevel';
    const otherOn = Boolean(this._lastStatus?.basicVehicleStatus?.[otherField]);
    const leftLevel = side === 'left' ? (value ? on : 0) : (otherOn ? on : 0);
    const rightLevel = side === 'right' ? (value ? on : 0) : (otherOn ? on : 0);
    this.log.info(`Setting seat heat via HomeKit: left=${leftLevel ? 'on' : 'off'} right=${rightLevel ? 'on' : 'off'}`);

    try {
      await this.client.controlHeatedSeats(this.vin, { leftLevel, rightLevel });
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: {
          ...this._lastStatus?.basicVehicleStatus,
          frontLeftSeatHeatLevel: leftLevel,
          frontRightSeatHeatLevel: rightLevel,
        },
      };
      this.log.info('Seat heat command succeeded.');
    } catch (err) {
      this.log.warn(`Seat heat command failed: ${err.message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Handles a rear seat heat switch: one seat per request (param 25 or 26), on = 3 (what the
   * iSmart app sends), off = 0. Optimistic like setSeatHeat.
   */
  async setRearSeatHeat(side, value) {
    const seat = side === 'left' ? HEATED_SEAT.REAR_LEFT : HEATED_SEAT.REAR_RIGHT;
    const field = side === 'left' ? 'secondRowLeftSeatHeatLevel' : 'secondRowRightSeatHeatLevel';
    const level = value ? REAR_HEATED_SEAT_ON_LEVEL : 0;
    this.log.info(`Setting rear ${side} seat heat via HomeKit: ${value ? 'on' : 'off'}`);
    try {
      await this.client.controlHeatedSeat(this.vin, seat, level);
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: { ...this._lastStatus?.basicVehicleStatus, [field]: level },
      };
      this.log.info('Rear seat heat command succeeded.');
    } catch (err) {
      this.log.warn(`Rear seat heat command failed: ${err.message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Handles a HomeKit Active toggle on the "Cabin Heat" tile. Since the car has
   * only one underlying climate system, a successful "on" also mirrors
   * Active=INACTIVE onto the Cool tile immediately rather than waiting for the
   * next poll.
   */
  async setHeatActive(value) {
    this.log.info(`${value ? 'Starting' : 'Stopping'} cabin heat pre-conditioning via HomeKit...`);
    try {
      if (value) {
        const idx = climateTemperatureIndex(this._heatTargetTemp);
        await this.client.startClimate(this.vin, idx, false);
      } else {
        await this.client.stopClimate(this.vin);
      }
      this._coolStartedLocally = false;
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: { ...this._lastStatus?.basicVehicleStatus, remoteClimateStatus: value ? 2 : 0 },
      };
      if (value) {
        this.coolService?.updateCharacteristic(this.Characteristic.Active, this.Characteristic.Active.INACTIVE);
        this._frontDefrostActive = false;
        this.frontDefrostService?.updateCharacteristic(this.Characteristic.On, false);
      }
      this.log.info('Cabin heat command succeeded.');
    } catch (err) {
      this.log.warn(`Cabin heat command failed: ${err.message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Handles a HomeKit Active toggle on the "Cabin Cool" tile. By default turning it ON
   * is refused (the compressor flag was confirmed on a real MG4 to heat at maximum, see
   * TESTING.md); turning it OFF always works. With enableExperimentalCabinCool, ON sends
   * start_ac instead - the Cabin Heat command, no param 22 - with the Cool tile's own
   * target temperature. Unconfirmed on any real car. See accessory.ts for more.
   */
  async setCoolActive(value) {
    if (value && !this.enableExperimentalCabinCool) {
      this.log.warn(
        'Cabin Cool is disabled: the compressor command is confirmed to heat the cabin at maximum '
        + 'instead of cooling it on real hardware. See TESTING.md. enableExperimentalCabinCool '
        + 'tries an unconfirmed alternative, see README.md.',
      );
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.log.info(value
      ? `Starting cabin cool pre-conditioning via HomeKit (experimental, target ${this._coolTargetTemp} °C)...`
      : 'Stopping cabin cool pre-conditioning via HomeKit...');
    try {
      if (value) {
        const idx = climateTemperatureIndex(this._coolTargetTemp);
        await this.client.startClimate(this.vin, idx, false);
      } else {
        await this.client.stopClimate(this.vin);
      }
      this._coolStartedLocally = value;
      // 2 rather than 3 on start: start_ac is the command the MQTT gateway decodes as
      // remoteClimateStatus 2 ("on"); _coolStartedLocally makes it read as Cool.
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: { ...this._lastStatus?.basicVehicleStatus, remoteClimateStatus: value ? 2 : 0 },
      };
      if (value) {
        this.heatService?.updateCharacteristic(this.Characteristic.Active, this.Characteristic.Active.INACTIVE);
        this._frontDefrostActive = false;
        this.frontDefrostService?.updateCharacteristic(this.Characteristic.On, false);
      }
      this.log.info('Cabin cool command succeeded.');
    } catch (err) {
      this.log.warn(`Cabin cool command failed: ${err.message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /** Keeps a target temperature inside climateRange (HomeKit enforces it too, via setProps). */
  clampClimateTemp(temp) {
    return Math.min(this.climateRange.max, Math.max(this.climateRange.min, temp));
  }

  /**
   * Handles a HeatingThresholdTemperature change on the "Cabin Heat" tile.
   * Stores the new target and, if that tile is currently active, re-sends
   * startClimate with the updated index so the car adjusts immediately.
   */
  async setHeatTemperature(value) {
    const temp = this.clampClimateTemp(value);
    this._heatTargetTemp = temp;
    if (this.readHeatActive()) {
      this.log.info(`Adjusting cabin heat target to ${temp} °C...`);
      try {
        const idx = climateTemperatureIndex(temp);
        await this.client.startClimate(this.vin, idx, false);
        this.log.info(`Cabin heat target updated to ${temp} °C.`);
      } catch (err) {
        this.log.warn(`Cabin heat temperature update failed: ${err.message}`);
        throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    }
  }

  /**
   * Handles a CoolingThresholdTemperature change on the "Cabin Cool" tile. Always stores
   * the new target; while the tile is active, re-sends the start command only with
   * enableExperimentalCabinCool, and then without the compressor flag.
   */
  async setCoolTemperature(value) {
    const temp = this.clampClimateTemp(value);
    this._coolTargetTemp = temp;
    if (this.readCoolActive()) {
      if (!this.enableExperimentalCabinCool) {
        this.log.info(`Cabin Cool target set to ${temp} °C (not sent: Cabin Cool is disabled, see TESTING.md).`);
        return;
      }
      this.log.info(`Adjusting cabin cool target to ${temp} °C (experimental)...`);
      try {
        const idx = climateTemperatureIndex(temp);
        await this.client.startClimate(this.vin, idx, false);
        this.log.info(`Cabin cool target updated to ${temp} °C.`);
      } catch (err) {
        this.log.warn(`Cabin cool temperature update failed: ${err.message}`);
        throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    }
  }

  async setRearDefrost(value) {
    this.log.info(`${value ? 'Starting' : 'Stopping'} rear window defrost via HomeKit...`);
    try {
      await this.client.controlRearWindowHeat(this.vin, value);
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: { ...this._lastStatus?.basicVehicleStatus, rmtHtdRrWndSt: value ? 1 : 0 },
      };
      this.log.info('Rear defrost command succeeded.');
    } catch (err) {
      this.log.warn(`Rear defrost command failed: ${err.message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Handles the "Front window defrost" switch. Unlike rear defrost, the car has no
   * dedicated status field for this: remoteClimateStatus is shared with Heat/Cool, and
   * defrost's own value in it isn't confirmed for this vehicle profile (see TESTING.md).
   * So On/Off here tracks only what HomeKit last commanded (_frontDefrostActive), not a
   * value read back from the car - it won't survive a Homebridge restart, which is fine
   * given the car auto-cancels defrost after roughly 10 minutes anyway. Turning on sends
   * the dedicated front-defrost command (fan 5, compressor on, 22 °C - see
   * saic-client.js) and mirrors Active=INACTIVE onto Heat/Cool, since all three share the
   * one climate system. Turning off sends the general stopClimate command, since the car
   * has no separate stop for defrost specifically.
   */
  async setFrontDefrost(value) {
    this.log.info(`${value ? 'Starting' : 'Stopping'} front window defrost via HomeKit...`);
    try {
      if (value) {
        await this.client.startFrontDefrost(this.vin);
      } else {
        await this.client.stopClimate(this.vin);
      }
      this._frontDefrostActive = value;
      this._coolStartedLocally = false;
      if (value) {
        this._lastStatus = {
          ...this._lastStatus,
          basicVehicleStatus: { ...this._lastStatus?.basicVehicleStatus, remoteClimateStatus: 0 },
        };
        this.heatService?.updateCharacteristic(this.Characteristic.Active, this.Characteristic.Active.INACTIVE);
        this.coolService?.updateCharacteristic(this.Characteristic.Active, this.Characteristic.Active.INACTIVE);
      }
      this.log.info('Front defrost command succeeded.');
    } catch (err) {
      this.log.warn(`Front defrost command failed: ${err.message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Handles the "Heated steering wheel" switch. Same optimistic pattern as the seat heat
   * switches; the next poll replaces the patched steeringHeatLevel with what the car reports.
   */
  async setSteeringWheelHeat(value) {
    this.log.info(`${value ? 'Starting' : 'Stopping'} heated steering wheel via HomeKit...`);
    try {
      const result = await this.client.controlHeatedSteeringWheel(this.vin, value);
      this.logSteeringWheelHeatFailure(result?.basicVehicleStatus);
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: { ...this._lastStatus?.basicVehicleStatus, steeringHeatLevel: value ? 1 : 0 },
      };
      this.log.info('Heated steering wheel command succeeded.');
    } catch (err) {
      this.log.warn(`Heated steering wheel command failed: ${err.message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Handles the "Window ventilation" switch: On = VENTILATE, Off = CLOSE, all four door
   * windows. Optimistic like the seat heat switches; the next poll corrects it.
   */
  async setWindowVentilation(value) {
    this.log.info(`${value ? 'Ventilating (opening a few cm)' : 'Closing'} all door windows via HomeKit...`);
    try {
      await this.client.controlDoorWindows(
        this.vin, value ? DOOR_WINDOWS_ACTION.VENTILATE : DOOR_WINDOWS_ACTION.CLOSE,
      );
      const patch = Object.fromEntries(WINDOW_FIELDS.map((field) => [field, value ? 1 : 0]));
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: { ...this._lastStatus?.basicVehicleStatus, ...patch },
      };
      this.log.info('Window ventilation command succeeded.');
    } catch (err) {
      this.log.warn(`Window ventilation command failed: ${err.message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Handles a TargetDoorState change on the "Tailgate" GarageDoorOpener: OPEN (1) or CLOSE (2).
   * OPENING/CLOSING while in flight, bootStatus patched on success, state restored on failure.
   */
  async setTailgateTarget(open) {
    this.log.info(`${open ? 'Opening' : 'Closing'} the power tailgate via HomeKit...`);
    this.tailgateService?.updateCharacteristic(
      this.Characteristic.CurrentDoorState,
      open ? this.Characteristic.CurrentDoorState.OPENING : this.Characteristic.CurrentDoorState.CLOSING,
    );
    try {
      await this.client.controlTailgate(this.vin, open ? TAILGATE_ACTION.OPEN : TAILGATE_ACTION.CLOSE);
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: { ...this._lastStatus?.basicVehicleStatus, bootStatus: open ? 1 : 0 },
      };
      this.tailgateService?.updateCharacteristic(this.Characteristic.CurrentDoorState, this.readTailgateCurrentState());
      this.log.info(`Tailgate ${open ? 'open' : 'close'} command succeeded.`);
    } catch (err) {
      this.log.warn(`Tailgate ${open ? 'open' : 'close'} command failed: ${err.message}`);
      this.tailgateService?.updateCharacteristic(this.Characteristic.CurrentDoorState, this.readTailgateCurrentState());
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // ---------------------------------------------------------------- polling

  /**
   * Called by the platform on its poll interval (and by the lock sequence / post-command
   * re-read). Resolves true when /vehicle/status answered, false otherwise (reason in
   * lastStatusError). Single flight: a call while one is running gets that one's result.
   */
  refresh({ full = false } = {}) {
    if (this._refreshInFlight) {
      this.log.debug('A refresh is already running - sharing its result instead of polling again.');
      return this._refreshInFlight;
    }
    this._refreshInFlight = this.doRefresh(full).finally(() => {
      this._refreshInFlight = undefined;
    });
    return this._refreshInFlight;
  }

  /** The basicVehicleStatus fields the enabled services read; a cached status must have them all. */
  statusFieldsInUse() {
    const fields = ['lockStatus'];
    if (this.enablePreconditioning) fields.push('remoteClimateStatus');
    if (this.enableDoorSensors) fields.push(...DOOR_FIELDS.map(([, field]) => field));
    if (this.enableTemperatureSensors) fields.push('interiorTemperature', 'exteriorTemperature');
    if (this.enableHeatedSeats) fields.push('frontLeftSeatHeatLevel', 'frontRightSeatHeatLevel');
    if (this.enableRearDefrost) fields.push('rmtHtdRrWndSt');
    if (this.enableHeatedSteeringWheel) fields.push('steeringHeatLevel');
    if (this.enableWindowVentilation) fields.push(...WINDOW_FIELDS);
    if (this.enableRearHeatedSeats) fields.push('secondRowLeftSeatHeatLevel', 'secondRowRightSeatHeatLevel');
    if (this.enablePowerTailgate) fields.push('bootStatus');
    return [...new Set(fields)];
  }

  /** Reads the vehicle status: SAIC's cache when useStatusCache allows it, the full one otherwise. */
  async readStatus(forceFull) {
    if (!this.useStatusCache || forceFull || this._fullStatusNext || !this._lastStatus) {
      return { data: await this.client.vehicleStatus(this.vin), full: true };
    }
    let cached;
    try {
      cached = await this.client.vehicleStatusCached(this.vin);
    } catch (err) {
      if (err instanceof SaicError && (err.code === 401 || err.code === 403)) throw err;
      this.log.debug(`Status cache read failed (${err.message}); reading the full status instead.`);
      return { data: await this.client.vehicleStatus(this.vin), full: true };
    }
    const basic = cached?.basicVehicleStatus;
    const missing = this.statusFieldsInUse().filter((f) => basic?.[f] === undefined || basic?.[f] === null);
    if (missing.length) {
      const why = `The status cache lacks ${missing.join(', ')}, needed by enabled services; reading the full status instead (it wakes the car).`;
      if (this._cacheFallbackLogged) this.log.debug(why);
      else this.log.info(why);
      this._cacheFallbackLogged = true;
      return { data: await this.client.vehicleStatus(this.vin), full: true };
    }
    this.log.debug('Status read from the SAIC cache (car not woken).');
    // Keep anything the cache doesn't carry from the last full read.
    return {
      data: { ...this._lastStatus, ...cached, basicVehicleStatus: { ...this._lastStatus?.basicVehicleStatus, ...basic } },
      full: false,
    };
  }

  async doRefresh(forceFullStatus = false) {
    const lastKnownUnplugged = this._lastCharging?.chrgMgmtData?.ccuOnbdChrgrPlugOn === 0;
    const skipCharging = lastKnownUnplugged && this._chargingSkipStreak < MgSaicAccessory.CHARGING_RECHECK_CYCLES;

    const [statusResult, chargingResult] = await Promise.allSettled([
      this.readStatus(forceFullStatus),
      skipCharging ? Promise.resolve(null) : this.client.chargingStatus(this.vin),
    ]);

    // Re-throw auth errors so the platform can clear the token and re-login.
    // Check both results; if either is an auth error, surface it.
    for (const result of [statusResult, chargingResult]) {
      if (result.status === 'rejected') {
        const err = result.reason;
        if (err instanceof SaicError && (err.code === 401 || err.code === 403)) throw err;
      }
    }

    if (statusResult.status === 'fulfilled') {
      this._lastStatus = statusResult.value.data;
      if (statusResult.value.full) this._fullStatusNext = false;
      this._lastStatusAt = Date.now();
      this.lastStatusError = undefined;
      this.detectLockEngaged();
      if (this.enableHeatedSteeringWheel) this.logSteeringWheelHeatFailure(this._lastStatus?.basicVehicleStatus);
      this.trackClimateStatus();
      this.pushStatusCharacteristics();
    } else {
      // Not a warn here: the platform logs outages once, not on every failed poll.
      this.lastStatusError = statusResult.reason.message;
      this.log.debug(`Status refresh failed: ${this.lastStatusError}`);
    }

    if (skipCharging) {
      this._chargingSkipStreak++;
      this.log.debug('Skipping charging refresh: charger was last seen unplugged.');
    } else if (chargingResult.status === 'fulfilled') {
      this._chargingSkipStreak = 0;
      this._lastCharging = chargingResult.value;
      this.chargingOutage.success();
      this.pushChargingCharacteristics();
    } else {
      this._chargingSkipStreak = 0;
      this.chargingOutage.failure(chargingResult.reason.message);
    }

    this.pushStatusFaults();
    return statusResult.status === 'fulfilled';
  }

  /** Pushes StatusFault (stale data) to the sensors that have it, after every refresh. */
  pushStatusFaults() {
    if (this.enableDoorSensors) {
      for (const service of this.contactServices) {
        service.updateCharacteristic(this.Characteristic.StatusFault, this.readStaleFault());
      }
    }
    if (this.enableTemperatureSensors) {
      this.interiorTempService.updateCharacteristic(
        this.Characteristic.StatusFault, this.readTemperatureFault('interiorTemperature'),
      );
      this.exteriorTempService.updateCharacteristic(
        this.Characteristic.StatusFault, this.readTemperatureFault('exteriorTemperature'),
      );
    }
  }

  /**
   * Watches for the lockStatus transition unlocked -> locked - the "just arrived
   * home, about to plug in" moment. If the charger isn't already known to be
   * plugged in, kicks off startLockRefreshSequence() so a plug-in right after
   * locking is caught within a few minutes rather than waiting out the charging
   * skip streak (up to CHARGING_RECHECK_CYCLES polls) or the full poll interval.
   * Ported from mg-saic-ha's lock-engaged post-shutdown refresh trigger.
   */
  detectLockEngaged() {
    const lockStatus = this._lastStatus?.basicVehicleStatus?.lockStatus;
    if (this._prevLockStatus === 0 && lockStatus === 1 && !this.readPluggedIn()) {
      this.startLockRefreshSequence();
    }
    if (lockStatus !== undefined) this._prevLockStatus = lockStatus;
  }

  /**
   * Clears _coolStartedLocally once the car reports the climate as anything other than
   * running (2 or 3), and, while enableExperimentalCabinCool is on, logs every change of the
   * raw remoteClimateStatus.
   */
  trackClimateStatus() {
    const status = this._lastStatus?.basicVehicleStatus?.remoteClimateStatus;
    if (status !== 2 && status !== 3) this._coolStartedLocally = false;
    if (this.enableExperimentalCabinCool && status !== this._lastRemoteClimateStatus) {
      this.log.info(`Car reports remoteClimateStatus=${status ?? 'absent'}`
        + (this._coolStartedLocally ? ' (climate last started by the experimental Cabin Cool tile).' : '.'));
    }
    this._lastRemoteClimateStatus = status;
  }

  /**
   * Re-reads the car's state RECHECK_DELAY_MS from now, once, after a control command whose
   * outcome is unknown. A second unknown outcome while one is pending doesn't add another.
   */
  scheduleStatusRecheck() {
    if (this._recheckTimer) return;
    this.log.info(`The last command's outcome is unknown; re-reading the car's state in ${MgSaicAccessory.RECHECK_DELAY_MS / 1000} s.`);
    this._recheckTimer = setTimeout(() => {
      this._recheckTimer = undefined;
      this.refresh({ full: true }).catch((err) => this.log.debug(`State re-read after an unknown command outcome failed: ${err.message}`));
    }, MgSaicAccessory.RECHECK_DELAY_MS);
  }

  /** Starts the rapid refresh sequence, unless one is already running. */
  startLockRefreshSequence() {
    if (this._lockRefreshTimer) {
      this.log.debug('Lock-triggered refresh sequence already running - not starting a second one.');
      return;
    }
    this.log.debug('Car locked while unplugged - starting rapid refresh sequence to catch plug-in.');
    this.scheduleLockRefreshStep(0);
  }

  scheduleLockRefreshStep(step) {
    if (step >= MgSaicAccessory.LOCK_REFRESH_SEQUENCE_MS.length) {
      this._lockRefreshTimer = undefined;
      return;
    }
    this._lockRefreshTimer = setTimeout(() => {
      void this.runLockRefreshStep(step);
    }, MgSaicAccessory.LOCK_REFRESH_SEQUENCE_MS[step]);
  }

  /** Runs one extra poll, forcing a real charging check regardless of the skip streak. */
  async runLockRefreshStep(step) {
    this._chargingSkipStreak = MgSaicAccessory.CHARGING_RECHECK_CYCLES;
    try {
      await this.refresh({ full: true });
    } catch (err) {
      this.log.debug(`Lock-triggered refresh failed: ${err.message}`);
    }
    if (this.readPluggedIn()) {
      this.log.debug('Plug-in detected - ending rapid refresh sequence.');
      this._lockRefreshTimer = undefined;
      return;
    }
    this.scheduleLockRefreshStep(step + 1);
  }

  pushStatusCharacteristics() {
    this.lockService.updateCharacteristic(this.Characteristic.LockCurrentState, this.readLockState());
    if (this.enablePreconditioning) {
      const interiorTemp = this.readInteriorTempForClimate();
      this.heatService.updateCharacteristic(
        this.Characteristic.Active,
        this.readHeatActive() ? this.Characteristic.Active.ACTIVE : this.Characteristic.Active.INACTIVE,
      );
      this.heatService.updateCharacteristic(
        this.Characteristic.CurrentHeaterCoolerState,
        this.readHeatActive() ? this.Characteristic.CurrentHeaterCoolerState.HEATING : this.Characteristic.CurrentHeaterCoolerState.INACTIVE,
      );
      this.heatService.updateCharacteristic(this.Characteristic.CurrentTemperature, interiorTemp);

      this.coolService.updateCharacteristic(
        this.Characteristic.Active,
        this.readCoolActive() ? this.Characteristic.Active.ACTIVE : this.Characteristic.Active.INACTIVE,
      );
      this.coolService.updateCharacteristic(
        this.Characteristic.CurrentHeaterCoolerState,
        this.readCoolActive() ? this.Characteristic.CurrentHeaterCoolerState.COOLING : this.Characteristic.CurrentHeaterCoolerState.INACTIVE,
      );
      this.coolService.updateCharacteristic(this.Characteristic.CurrentTemperature, interiorTemp);
    }
    if (this.enableDoorSensors) {
      for (const [, field, i] of DOOR_FIELDS.map(([n, f], i) => [n, f, i])) {
        this.contactServices[i].updateCharacteristic(
          this.Characteristic.ContactSensorState, this.readContactState(field),
        );
      }
    }
    if (this.enableTemperatureSensors) {
      this.interiorTempService.updateCharacteristic(
        this.Characteristic.CurrentTemperature, this.readTemperature('interiorTemperature'),
      );
      this.interiorTempService.updateCharacteristic(
        this.Characteristic.StatusFault, this.readTemperatureFault('interiorTemperature'),
      );
      this.exteriorTempService.updateCharacteristic(
        this.Characteristic.CurrentTemperature, this.readTemperature('exteriorTemperature'),
      );
      this.exteriorTempService.updateCharacteristic(
        this.Characteristic.StatusFault, this.readTemperatureFault('exteriorTemperature'),
      );
    }
    if (this.enableHeatedSeats) {
      this.leftSeatHeatService.updateCharacteristic(this.Characteristic.On, this.readSeatHeat('frontLeftSeatHeatLevel'));
      this.rightSeatHeatService.updateCharacteristic(this.Characteristic.On, this.readSeatHeat('frontRightSeatHeatLevel'));
    }
    if (this.enableRearDefrost) {
      this.rearDefrostService.updateCharacteristic(
        this.Characteristic.On, Boolean(this._lastStatus?.basicVehicleStatus?.rmtHtdRrWndSt),
      );
    }
    if (this.enableFrontDefrost) {
      this.frontDefrostService.updateCharacteristic(this.Characteristic.On, this._frontDefrostActive);
    }
    if (this.enableHeatedSteeringWheel) {
      this.steeringWheelHeatService.updateCharacteristic(this.Characteristic.On, this.readSteeringWheelHeat());
    }
    if (this.enableWindowVentilation) {
      this.windowVentilationService.updateCharacteristic(this.Characteristic.On, this.readWindowsOpen());
    }
    if (this.enableRearHeatedSeats) {
      this.rearLeftSeatHeatService.updateCharacteristic(this.Characteristic.On, this.readSeatHeat('secondRowLeftSeatHeatLevel'));
      this.rearRightSeatHeatService.updateCharacteristic(this.Characteristic.On, this.readSeatHeat('secondRowRightSeatHeatLevel'));
    }
    if (this.enablePowerTailgate) {
      this.tailgateService.updateCharacteristic(this.Characteristic.CurrentDoorState, this.readTailgateCurrentState());
      this.tailgateService.updateCharacteristic(this.Characteristic.TargetDoorState, this.readTailgateTargetState());
    }
  }

  pushChargingCharacteristics() {
    const soc = this.readSoc();
    this.batteryService.updateCharacteristic(this.Characteristic.BatteryLevel, soc);
    this.batteryService.updateCharacteristic(this.Characteristic.ChargingState, this.readChargingState());
    this.batteryService.updateCharacteristic(
      this.Characteristic.StatusLowBattery,
      soc <= 20
        ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
    this.outletService.updateCharacteristic(this.Characteristic.On, this.readPluggedIn());
    this.outletService.updateCharacteristic(this.Characteristic.OutletInUse, this.readCharging());
  }
}
