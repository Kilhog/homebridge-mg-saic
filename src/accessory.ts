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
 *   remoteClimateStatus               0 = off, 2 = heat, 3 = cool, 4 = fan only
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
 * Rear heated seats (enableRearHeatedSeats, off by default, not yet confirmed against
 * real hardware) are two more Switches, "Rear left seat heat" / "Rear right seat heat",
 * using the reference client's per-seat control_heated_seat (rvcReqType "5" with a single
 * param, 25 or 26, see saic-client.ts) - so unlike the front pair, one rear seat never has
 * to restate the other's level. Rear seats are on/off only; on is level 3, what the iSmart
 * app sends. State comes from secondRowLeftSeatHeatLevel / secondRowRightSeatHeatLevel.
 * The front seats keep the two-seat command confirmed on an MG4; frontSeatHeatLevel (1-3,
 * default 3 = the only level sent before it existed) picks the level a front switch's On
 * sends, including for the other front seat when it is restated as on.
 *
 * Front defrost (enableFrontDefrost, off by default, not yet confirmed against real
 * hardware) reuses the same rvcReqType "6" climate command as pre-conditioning, but with
 * fan speed 5 instead of the usual 2 - the exact combination the fan-speed comment above
 * warns not to use for ordinary heat/cool, confirmed instead as the dedicated defrost
 * trigger by townsmcp/mg-saic-ha's own reference client. Its On/Off state is tracked
 * locally rather than read back from the car (see setFrontDefrost), since the car has no
 * confirmed status field for it and auto-cancels after roughly 10 minutes on its own.
 *
 * Pre-conditioning is exposed as two separate HeaterCooler services, "Cabin Heat"
 * and "Cabin Cool", rather than one tile with a mode toggle. Each is locked to a
 * single TargetHeaterCoolerState (HEAT or COOL respectively, via validValues) and
 * carries its own remembered target temperature (_heatTargetTemp/_coolTargetTemp,
 * within climateRange - see climateTemperatureRange below, 17-33 °C on an MG4) and its
 * own threshold-temperature characteristic. Turning Heat's
 * Active on sends startClimate with the compressor off, and immediately mirrors
 * Active=INACTIVE onto the Cool tile, since the car only has one underlying
 * climate system - the two tiles can't both be running at once.
 * CurrentHeaterCoolerState per tile is derived from remoteClimateStatus
 * (2=HEATING for the Heat tile, 3=COOLING for the Cool tile, anything else reads
 * as INACTIVE on both). If the target temperature is changed on a tile that's
 * currently active, startClimate is re-sent immediately with the new index so
 * the car adjusts. Two separate tiles (rather than one with a mode icon) make
 * each side independently addressable from Siri and HomeKit Automations, e.g.
 * "turn on Cabin Heat" or a 7am/2pm scheduled switch.
 *
 * Cabin Cool's Active toggle is disabled by default (setCoolActive rejects turning it
 * on): a real MG4 test confirmed sending the compressor flag (see docs/API.md) does
 * not cool the car, it runs the PTC heater at maximum instead - both
 * remoteClimateStatus and the iSmart app agreed. See TESTING.md for the
 * comparison against townsmcp/mg-saic-ha's MG4 profile, which rules out fan
 * speed as the cause but doesn't explain the reversal either. Turning Cool off
 * still works, in case a genuinely cooling car (remoteClimateStatus 3 from some
 * other trigger) needs to be stopped from HomeKit. The compressor flag is never
 * sent from the Cool tile any more, not even when its slider moves.
 *
 * enableExperimentalCabinCool (off by default, NOT confirmed on any real car) turns
 * the Cool tile back on with a different hypothesis: the reference client's own
 * start_ac never sends the compressor flag at all (ac_on=None) - it only sends fan 2
 * and a target temperature index and leaves heating or cooling to the car - and
 * keeps param 22 = 1 for front defrost only. So in that mode the Cool tile sends
 * exactly the Cabin Heat command, just with the Cool tile's own target temperature.
 * Since the car may then report remoteClimateStatus 2 ("on", per
 * saic-python-mqtt-gateway's decode) rather than 3, _coolStartedLocally remembers
 * that it was the Cool tile that asked, so the right tile shows as active; the raw
 * remoteClimateStatus is logged on every change while the option is on, to find
 * out how a given car actually reports it.
 *
 * Window open/close was tried and confirmed NOT to work on an MG4: the car
 * consistently rejects the command with "Request failed. Please check the
 * vehicle status and try again." regardless of lock state, door-open state,
 * or being freshly started. There's no HomeKit switch for it. The
 * low-level request is still in saic-client.ts (controlWindow/WINDOW_ID)
 * in case a future firmware update or a different vehicle behaves
 * differently, but nothing in this accessory calls it. See CHANGELOG.md.
 *
 * Window ventilation (enableWindowVentilation, off by default) is a different request:
 * the MG S6 EV's all-four-door-windows form of the same rvcReqType "3"
 * (controlDoorWindows in saic-client.ts). One Switch: On = ventilate (open every door
 * window a few centimetres), Off = close all four. Fully opening them is deliberately not
 * exposed. The car reports ventilated and fully open windows the same way, so the
 * switch reads On whenever any of driverWindow/passengerWindow/rearLeftWindow/
 * rearRightWindow is non-zero - including a window opened by hand - and turning it Off
 * then closes all four.
 *
 * Heated steering wheel (enableHeatedSteeringWheel, off by default, not yet confirmed
 * against real hardware) is a plain Switch ported from the reference client's
 * control_heated_steering_wheel (rvcReqType "8", see saic-client.ts). Its state is read
 * back from basicVehicleStatus.steeringHeatLevel, and a non-zero
 * steeringWheelHeatFailureReason is logged as-is since its values aren't documented
 * anywhere. The car switches the heater off by itself after about 10 minutes, so the
 * tile can show On until the next poll catches up.
 *
 * Locking the car while it isn't already known to be plugged in triggers a short
 * burst of extra polls (see detectLockEngaged/startLockRefreshSequence), so a
 * plug-in right after arriving home is caught within a few minutes instead of
 * waiting out the charging-skip streak above or the full configured poll interval.
 * Ported from mg-saic-ha's lock-engaged post-shutdown refresh sequence.
 */

import type { API, PlatformAccessory, Service, Characteristic, CharacteristicValue } from 'homebridge';
import { SaicClient, SaicError, DOOR_WINDOWS_ACTION, HEATED_SEAT, REAR_HEATED_SEAT_ON_LEVEL } from './saic-client.js';

// Door field→service-index mapping, used in both setupContactSensors and pushStatusCharacteristics.
const DOOR_FIELDS: [string, string][] = [
  ['Driver door',      'driverDoor'],
  ['Passenger door',   'passengerDoor'],
  ['Rear left door',   'rearLeftDoor'],
  ['Rear right door',  'rearRightDoor'],
  ['Boot',             'bootStatus'],
  ['Bonnet',           'bonnetStatus'],
];

// The four door window status fields, the ones the window ventilation switch reads.
const WINDOW_FIELDS = ['driverWindow', 'passengerWindow', 'rearLeftWindow', 'rearRightWindow'] as const;

export interface AccessoryOpts {
  vin: string;
  log: { info(m: string): void; warn(m: string): void; debug(m: string): void };
  api: API;
  enablePreconditioning: boolean;
  enableDoorSensors: boolean;
  enableTemperatureSensors: boolean;
  enableHeatedSeats: boolean;
  enableRearDefrost: boolean;
  enableFrontDefrost: boolean;
  enableHeatedSteeringWheel: boolean;
  enableWindowVentilation: boolean;
  enableRearHeatedSeats: boolean;
  // Level (1-3) a front seat heat switch's On sends. Defaults to 3; anything else is
  // replaced by 3 with a warning.
  frontSeatHeatLevel?: unknown;
  enableExperimentalCabinCool?: boolean;
  // Slider range for Cabin Heat / Cabin Cool, see climateTemperatureRange. Defaults to the
  // unknown-series range (17-33 °C) when not given.
  climateRange?: ClimateTemperatureRange;
}

// ------------------------------------------------------- climate temperature

export interface ClimateTemperatureRange {
  min: number;
  max: number;
}

/**
 * Bounds a configured climateMinTemperature/climateMaxTemperature must stay within: the
 * widest range any source documents, 16 °C (saic-python-mqtt-gateway, every non-MG4 series)
 * to 33 °C (mg-saic-ha's MG4 profile, this plugin's slider since 0.9.5).
 */
export const CLIMATE_TEMPERATURE_LIMITS: ClimateTemperatureRange = { min: 16, max: 33 };

/**
 * Target temperature range for the Cabin Heat / Cabin Cool sliders, picked from the
 * vehicle's series code (/vehicle/list) the way saic-python-mqtt-gateway's vehicle_info.py
 * picks min_ac_temperature / max_ac_temperature:
 *
 *   EH32... (MG4)         17-33 °C  this plugin's range since 0.9.5 (mg-saic-ha's MG4
 *                                   profile, used on a real MG4). The gateway caps the MG4
 *                                   at 31 °C; kept at 33 so nothing changes for the MG4.
 *   MZS3E... (MG S5)      16-31 °C  as the gateway.
 *   any other series      16-28 °C  the gateway's default. This is where the MG S6 EV
 *                                   (series "MIS3E ...") lands; its real range isn't
 *                                   confirmed anywhere.
 *   no series known       17-33 °C  e.g. the vehicle list failed; unchanged from before.
 *
 * Config overrides (climateMinTemperature / climateMaxTemperature) replace either bound, as
 * long as the result is whole numbers within CLIMATE_TEMPERATURE_LIMITS with min below max.
 * Otherwise they're ignored and `error` says why.
 */
export function climateTemperatureRange(
  series?: string,
  overrides: { min?: unknown; max?: unknown } = {},
): ClimateTemperatureRange & { error?: string } {
  const code = (series ?? '').trim().toUpperCase();
  const base: ClimateTemperatureRange =
    !code || code.startsWith('EH32') ? { min: 17, max: 33 }
      : code.startsWith('MZS3E') ? { min: 16, max: 31 }
        : { min: 16, max: 28 };
  if (overrides.min === undefined && overrides.max === undefined) return base;

  const min = overrides.min ?? base.min;
  const max = overrides.max ?? base.max;
  const inLimits = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
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
 * SAIC climate temperature index for a target in °C: idx = °C - 14. mg-saic-ha's MG4
 * profile writes it 3 + (°C - 17); saic-python-mqtt-gateway's get_ac_temperature_idx writes
 * 3 + °C - 17 for EH32 and 2 + °C - 16 for every other series. All the same formula, so it
 * doesn't depend on the series - only the allowed range does.
 */
export function climateTemperatureIndex(celsius: number): number {
  return Math.round(celsius) - 14;
}

// Loosely typed shapes returned by the SAIC API endpoints.
type StatusData    = Record<string, unknown>;
type ChargingData  = Record<string, unknown>;
type BasicStatus   = Record<string, unknown>;
type ChrgMgmtData  = Record<string, unknown>;

export class MgSaicAccessory {
  private accessory: PlatformAccessory;
  private client: SaicClient;
  vin: string;
  private log: AccessoryOpts['log'];
  private api: API;
  private Service: typeof Service;
  private Characteristic: typeof Characteristic;

  private enablePreconditioning: boolean;
  private enableDoorSensors: boolean;
  private enableTemperatureSensors: boolean;
  private enableHeatedSeats: boolean;
  private enableRearDefrost: boolean;
  private enableFrontDefrost: boolean;
  private enableHeatedSteeringWheel: boolean;
  private enableExperimentalCabinCool: boolean;
  readonly climateRange: ClimateTemperatureRange;
  private enableWindowVentilation: boolean;
  private enableRearHeatedSeats: boolean;
  readonly frontSeatHeatLevel: number;

  private batteryService!: Service;
  private lockService!: Service;
  private outletService!: Service;
  private heatService?: Service;
  private coolService?: Service;
  private contactServices?: Service[];
  private interiorTempService?: Service;
  private exteriorTempService?: Service;
  private leftSeatHeatService?: Service;
  private rightSeatHeatService?: Service;
  private rearDefrostService?: Service;
  private frontDefrostService?: Service;
  private steeringWheelHeatService?: Service;
  private windowVentilationService?: Service;
  private rearLeftSeatHeatService?: Service;
  private rearRightSeatHeatService?: Service;

  private _lastStatus:  StatusData   | null = null;
  private _lastCharging: ChargingData | null = null;
  // Consecutive poll cycles in which the charging query has been skipped because the
  // last successful reading showed the charger unplugged. A real Homebridge log showed
  // /vehicle/charging/mgmtData timing out after a full 60s on every single poll cycle for
  // over 90 minutes straight while /vehicle/status kept succeeding, i.e. the car was awake
  // and reachable, it just had nothing plugged in to report on. Skipping the doomed query
  // saves that 60s, but it's rechecked every CHARGING_RECHECK_CYCLES cycles in case a cable
  // gets plugged in while we're not looking.
  private _chargingSkipStreak = 0;
  private static readonly CHARGING_RECHECK_CYCLES = 4;
  // Last observed lockStatus, used to detect the unlocked -> locked transition that
  // kicks off the rapid refresh sequence below. Undefined until the first successful
  // poll, so we never fire on startup before we actually know the previous state.
  private _prevLockStatus?: number;
  private _lockRefreshTimer?: NodeJS.Timeout;
  // Delays (ms) between each extra poll once the lock-triggered rapid refresh sequence
  // starts, mirroring mg-saic-ha's post-shutdown refresh sequence: 1, 3, 7, 15, 25
  // minutes cumulative. Exits early as soon as a plug-in is seen.
  private static readonly LOCK_REFRESH_SEQUENCE_MS = [60_000, 120_000, 240_000, 480_000, 600_000];
  // Stable cache for the last known-good temperature values; named explicitly
  // to avoid hidden-class churn from dynamic property assignment.
  private _lastInteriorTemperature: number | null = null;
  private _lastExteriorTemperature: number | null = null;
  // User-chosen target temperature in °C (within climateRange) for each pre-conditioning tile.
  // Persists across on/off toggles so turning a tile back on reuses its last-set
  // temperature rather than resetting to 22 °C. Kept separate per tile since Heat
  // and Cool are now independent HeaterCooler services rather than one shared mode.
  private _heatTargetTemp = 22;
  private _coolTargetTemp = 22;
  // Tracks only what HomeKit last commanded for front defrost, not a value read back from
  // the car - see setFrontDefrost for why.
  private _frontDefrostActive = false;
  // Last steeringWheelHeatFailureReason seen, so a non-zero value is logged once when it
  // appears rather than on every poll while it stays the same.
  private _lastSteeringWheelHeatFailureReason = 0;
  // True after the experimental Cool tile started the climate (see setCoolActive). Its
  // command is the same start_ac as Cabin Heat, so the car may report it as
  // remoteClimateStatus 2 like heat; this remembers which tile asked. Local only, like
  // _frontDefrostActive: cleared by any other climate command, by remoteClimateStatus
  // reading anything other than 2 or 3, and by a Homebridge restart.
  private _coolStartedLocally = false;
  // Last remoteClimateStatus seen, so it's only logged when it changes.
  private _lastRemoteClimateStatus?: number;

  constructor(accessory: PlatformAccessory, client: SaicClient, {
    vin, log, api, enablePreconditioning, enableDoorSensors, enableTemperatureSensors,
    enableHeatedSeats, enableRearDefrost, enableFrontDefrost, enableHeatedSteeringWheel,
    enableWindowVentilation,
    enableRearHeatedSeats,
    frontSeatHeatLevel,
    enableExperimentalCabinCool = false,
    climateRange = climateTemperatureRange(),
  }: AccessoryOpts) {
    this.accessory   = accessory;
    this.client      = client;
    this.vin         = vin;
    this.log         = log;
    this.api         = api;
    this.Service         = api.hap.Service;
    this.Characteristic  = api.hap.Characteristic;

    this.enablePreconditioning    = enablePreconditioning;
    this.enableDoorSensors        = enableDoorSensors;
    this.enableTemperatureSensors = enableTemperatureSensors;
    this.enableHeatedSeats        = enableHeatedSeats;
    this.enableRearDefrost        = enableRearDefrost;
    this.enableFrontDefrost       = enableFrontDefrost;
    this.enableHeatedSteeringWheel = enableHeatedSteeringWheel;
    this.enableWindowVentilation  = enableWindowVentilation;
    this.enableExperimentalCabinCool = enableExperimentalCabinCool;
    this.climateRange = { min: climateRange.min, max: climateRange.max };
    this._heatTargetTemp = this.clampClimateTemp(this._heatTargetTemp);
    this._coolTargetTemp = this.clampClimateTemp(this._coolTargetTemp);
    this.enableRearHeatedSeats    = enableRearHeatedSeats;
    this.frontSeatHeatLevel       = this.validFrontSeatHeatLevel(frontSeatHeatLevel);

    this.setupInfoService();
    this.setupBatteryService();
    this.setupLockService();
    this.setupOutletService();
    if (this.enablePreconditioning)    this.setupPreconditioningHeaterCoolers();
    if (this.enableDoorSensors)        this.setupContactSensors();
    if (this.enableTemperatureSensors) this.setupTemperatureSensors();
    if (this.enableHeatedSeats)        this.setupHeatedSeatSwitches();
    if (this.enableRearDefrost)        this.setupRearDefrostSwitch();
    if (this.enableFrontDefrost)       this.setupFrontDefrostSwitch();
    if (this.enableHeatedSteeringWheel) this.setupSteeringWheelHeatSwitch();
    if (this.enableWindowVentilation)  this.setupWindowVentilationSwitch();
    if (this.enableRearHeatedSeats)    this.setupRearSeatHeatSwitches();
    this.logExposedServices();
  }

  /**
   * Says which switches and sensors this run actually put into HomeKit, and which
   * were left out because they're off in config. Every optional service here is
   * behind an enable* flag, and until this existed there was no way to tell from a
   * log whether a missing tile in the Home app meant "disabled in config" or
   * "something went wrong" - the startup log looked identical either way.
   */
  logExposedServices(): void {
    const exposed: string[] = ['Battery', 'Lock', 'Charging outlet'];
    const disabled: string[] = [];
    const record = (on: boolean, label: string): void => {
      (on ? exposed : disabled).push(label);
    };
    record(this.enablePreconditioning,    'Pre-conditioning (Cabin Heat / Cabin Cool)');
    record(this.enableDoorSensors,        'Door sensors');
    record(this.enableTemperatureSensors, 'Temperature sensors');
    record(this.enableHeatedSeats,        'Heated seats');
    record(this.enableRearDefrost,        'Rear defrost');
    record(this.enableFrontDefrost,       'Front defrost');
    record(this.enableHeatedSteeringWheel, 'Heated steering wheel');
    record(this.enableWindowVentilation,  'Window ventilation');
    record(this.enableRearHeatedSeats,    'Rear heated seats');

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
  private validFrontSeatHeatLevel(level: unknown): number {
    if (level === undefined || level === null) return 3;
    if (typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= 3) return level;
    this.log.warn(`Ignoring frontSeatHeatLevel ${String(level)}: it must be 1, 2 or 3. Using 3.`);
    return 3;
  }

  setupInfoService(): void {
    const info = this.accessory.getService(this.Service.AccessoryInformation)
      ?? this.accessory.addService(this.Service.AccessoryInformation);
    info
      .setCharacteristic(this.Characteristic.Manufacturer, 'MG')
      .setCharacteristic(this.Characteristic.Model, 'MG4')
      .setCharacteristic(this.Characteristic.SerialNumber, this.vin || 'unknown-vin');
  }

  setupBatteryService(): void {
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

  setupLockService(): void {
    this.lockService = this.accessory.getService(this.Service.LockMechanism)
      ?? this.accessory.addService(this.Service.LockMechanism);

    this.lockService.getCharacteristic(this.Characteristic.LockCurrentState)
      .onGet(() => this.readLockState());

    this.lockService.getCharacteristic(this.Characteristic.LockTargetState)
      .onGet(() => (this.readLockState() === this.Characteristic.LockCurrentState.SECURED
        ? this.Characteristic.LockTargetState.SECURED
        : this.Characteristic.LockTargetState.UNSECURED))
      .onSet((value) => this.setLockTarget(value as CharacteristicValue));
  }

  setupOutletService(): void {
    this.outletService = this.accessory.getService(this.Service.Outlet)
      ?? this.accessory.addService(this.Service.Outlet);

    this.outletService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readPluggedIn());

    this.outletService.getCharacteristic(this.Characteristic.OutletInUse)
      .onGet(() => this.readCharging());
  }

  setupPreconditioningHeaterCoolers(): void {
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

    // Only one valid value: this tile never offers a mode switch, it IS the heat mode.
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
      .onSet((value) => this.setHeatTemperature(value as number));

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
      .onSet((value) => this.setCoolTemperature(value as number));
  }

  setupContactSensors(): void {
    this.contactServices = DOOR_FIELDS.map(([name, field]) => {
      const subtype = field;
      const service = this.accessory.getService(name)
        ?? this.accessory.addService(this.Service.ContactSensor, name, subtype);
      service.getCharacteristic(this.Characteristic.ContactSensorState)
        .onGet(() => this.readContactState(field));
      return service;
    });
  }

  setupTemperatureSensors(): void {
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

  setupHeatedSeatSwitches(): void {
    this.leftSeatHeatService = this.accessory.getService('Left seat heat')
      ?? this.accessory.addService(this.Service.Switch, 'Left seat heat', 'leftSeatHeat');
    this.leftSeatHeatService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readSeatHeat('frontLeftSeatHeatLevel'))
      .onSet((value) => this.setSeatHeat('left', value as boolean));

    this.rightSeatHeatService = this.accessory.getService('Right seat heat')
      ?? this.accessory.addService(this.Service.Switch, 'Right seat heat', 'rightSeatHeat');
    this.rightSeatHeatService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readSeatHeat('frontRightSeatHeatLevel'))
      .onSet((value) => this.setSeatHeat('right', value as boolean));
  }

  setupRearDefrostSwitch(): void {
    this.rearDefrostService = this.accessory.getService('Rear window defrost')
      ?? this.accessory.addService(this.Service.Switch, 'Rear window defrost', 'rearDefrost');
    this.rearDefrostService.getCharacteristic(this.Characteristic.On)
      .onGet(() => Boolean(this.basicStatus()?.['rmtHtdRrWndSt']))
      .onSet((value) => this.setRearDefrost(value as boolean));
  }

  setupFrontDefrostSwitch(): void {
    this.frontDefrostService = this.accessory.getService('Front window defrost')
      ?? this.accessory.addService(this.Service.Switch, 'Front window defrost', 'frontDefrost');
    this.frontDefrostService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this._frontDefrostActive)
      .onSet((value) => this.setFrontDefrost(value as boolean));
  }

  setupSteeringWheelHeatSwitch(): void {
    this.steeringWheelHeatService = this.accessory.getService('Heated steering wheel')
      ?? this.accessory.addService(this.Service.Switch, 'Heated steering wheel', 'steeringWheelHeat');
    this.steeringWheelHeatService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readSteeringWheelHeat())
      .onSet((value) => this.setSteeringWheelHeat(value as boolean));
  }

  setupWindowVentilationSwitch(): void {
    this.windowVentilationService = this.accessory.getService('Window ventilation')
      ?? this.accessory.addService(this.Service.Switch, 'Window ventilation', 'windowVentilation');
    this.windowVentilationService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readWindowsOpen())
      .onSet((value) => this.setWindowVentilation(value as boolean));
  }

  setupRearSeatHeatSwitches(): void {
    this.rearLeftSeatHeatService = this.accessory.getService('Rear left seat heat')
      ?? this.accessory.addService(this.Service.Switch, 'Rear left seat heat', 'rearLeftSeatHeat');
    this.rearLeftSeatHeatService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readSeatHeat('secondRowLeftSeatHeatLevel'))
      .onSet((value) => this.setRearSeatHeat('left', value as boolean));

    this.rearRightSeatHeatService = this.accessory.getService('Rear right seat heat')
      ?? this.accessory.addService(this.Service.Switch, 'Rear right seat heat', 'rearRightSeatHeat');
    this.rearRightSeatHeatService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readSeatHeat('secondRowRightSeatHeatLevel'))
      .onSet((value) => this.setRearSeatHeat('right', value as boolean));
  }

  // ------------------------------------------------------------- data reads

  private basicStatus(): BasicStatus | undefined {
    return (this._lastStatus as { basicVehicleStatus?: BasicStatus } | null)?.basicVehicleStatus;
  }

  private chrgMgmtData(): ChrgMgmtData | undefined {
    return (this._lastCharging as { chrgMgmtData?: ChrgMgmtData } | null)?.chrgMgmtData;
  }

  readSoc(): number {
    const soc = this.chrgMgmtData()?.['bmsPackSOCDsp'] as number | undefined;
    if (soc === undefined || soc === null) return 0;
    return Math.max(0, Math.min(100, soc / 10));
  }

  readChargingState(): CharacteristicValue {
    const charging = this.chrgMgmtData()?.['bmsChrgSts'];
    return charging
      ? this.Characteristic.ChargingState.CHARGING
      : this.Characteristic.ChargingState.NOT_CHARGING;
  }

  readPluggedIn(): boolean {
    return Boolean(this.chrgMgmtData()?.['ccuOnbdChrgrPlugOn']);
  }

  readCharging(): boolean {
    return Boolean(this.chrgMgmtData()?.['bmsChrgSts']);
  }

  readLockState(): CharacteristicValue {
    const locked = this.basicStatus()?.['lockStatus'];
    return locked
      ? this.Characteristic.LockCurrentState.SECURED
      : this.Characteristic.LockCurrentState.UNSECURED;
  }

  /**
   * remoteClimateStatus === 2: the car is running the PTC resistive heater - unless the
   * experimental Cool tile was what started it (see _coolStartedLocally).
   */
  readHeatActive(): boolean {
    return this.basicStatus()?.['remoteClimateStatus'] === 2 && !this._coolStartedLocally;
  }

  /**
   * remoteClimateStatus === 3: the car is running the AC compressor. Also true on 2 when the
   * experimental Cool tile started the climate, since its command is the same start_ac as heat.
   */
  readCoolActive(): boolean {
    const status = this.basicStatus()?.['remoteClimateStatus'];
    return status === 3 || (status === 2 && this._coolStartedLocally);
  }

  /** Returns the interior temperature for the HeaterCooler CurrentTemperature
   * characteristic. Falls back to 20 °C when no valid reading is cached, so
   * HomeKit always gets a value in range rather than 0 (below the minimum). */
  readInteriorTempForClimate(): number {
    if (this.isTemperatureValid('interiorTemperature')) {
      return this.readTemperature('interiorTemperature');
    }
    return this._lastInteriorTemperature ?? 20;
  }

  readContactState(field: string): CharacteristicValue {
    const value = this.basicStatus()?.[field];
    return value
      ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : this.Characteristic.ContactSensorState.CONTACT_DETECTED;
  }

  /** true when the API returned a plausible temperature rather than an
   * unavailable-field sentinel (-128 has been observed on other fields
   * in the same response, e.g. tyre pressures, when a value isn't ready). */
  isTemperatureValid(field: string): boolean {
    const value = this.basicStatus()?.[field];
    return typeof value === 'number' && value > -60 && value < 80;
  }

  readTemperature(field: string): number {
    if (!this.isTemperatureValid(field)) {
      return field === 'interiorTemperature'
        ? (this._lastInteriorTemperature ?? 0)
        : (this._lastExteriorTemperature ?? 0);
    }
    const value = this.basicStatus()![field] as number;
    if (field === 'interiorTemperature') this._lastInteriorTemperature = value;
    else                                  this._lastExteriorTemperature = value;
    return value;
  }

  readTemperatureFault(field: string): CharacteristicValue {
    return this.isTemperatureValid(field)
      ? this.Characteristic.StatusFault.NO_FAULT
      : this.Characteristic.StatusFault.GENERAL_FAULT;
  }

  readSeatHeat(field: string): boolean {
    return Boolean(this.basicStatus()?.[field]);
  }

  /** steeringHeatLevel: 0 = off, non-zero = on (the command itself is only ever on/off). */
  readSteeringWheelHeat(): boolean {
    return Boolean(this.basicStatus()?.['steeringHeatLevel']);
  }

  /**
   * Logs a non-zero steeringWheelHeatFailureReason once, when it first shows up (or changes),
   * from either a poll or the echo of a control response. Its values aren't documented by the
   * reference client - it only declares the field - so the raw number is logged as-is for
   * whoever ends up decoding it.
   */
  private logSteeringWheelHeatFailure(status: BasicStatus | undefined): void {
    const reason = status?.['steeringWheelHeatFailureReason'];
    if (typeof reason !== 'number') return;
    if (reason !== 0 && reason !== this._lastSteeringWheelHeatFailureReason) {
      this.log.warn(`The car reported steeringWheelHeatFailureReason=${reason} for the heated steering wheel (meaning undocumented).`);
    }
    this._lastSteeringWheelHeatFailureReason = reason;
  }

  /**
   * true when any door window reads open (non-zero). The car reports a ventilated window and a
   * fully open one the same way, so this can't tell them apart.
   */
  readWindowsOpen(): boolean {
    const status = this.basicStatus();
    return WINDOW_FIELDS.some((field) => Boolean(status?.[field]));
  }

  // --------------------------------------------------------------- lock write

  /**
   * Handles a HomeKit lock/unlock request. Confirmed working against real
   * hardware. See CHANGELOG.md for history.
   */
  async setLockTarget(value: CharacteristicValue): Promise<void> {
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
      const freshStatus = (result as StatusData | undefined)?.['basicVehicleStatus'] as BasicStatus | undefined;
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: freshStatus ?? {
          ...this.basicStatus(),
          lockStatus: wantLocked ? 1 : 0,
        },
      };
      this.lockService.updateCharacteristic(this.Characteristic.LockCurrentState, this.readLockState());
      this.log.info(`${wantLocked ? 'Lock' : 'Unlock'} command succeeded.`);
    } catch (err) {
      this.log.warn(`${wantLocked ? 'Lock' : 'Unlock'} command failed: ${(err as Error).message}`);
      this.lockService.updateCharacteristic(
        this.Characteristic.LockCurrentState,
        this.Characteristic.LockCurrentState.JAMMED,
      );
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // ---------------------------------------------------------------- writes

  /**
   * One HomeKit switch per physical seat, but the API sets both seats in a
   * single request, so this sends the other seat's last known level along
   * with the one actually being changed, rather than clobbering it to off.
   * "On" is frontSeatHeatLevel (default 3) for both, as it was always 3 before.
   */
  async setSeatHeat(side: 'left' | 'right', value: boolean): Promise<void> {
    const on         = this.frontSeatHeatLevel;
    const otherField = side === 'left' ? 'frontRightSeatHeatLevel' : 'frontLeftSeatHeatLevel';
    const otherOn    = Boolean(this.basicStatus()?.[otherField]);
    const leftLevel  = side === 'left'  ? (value ? on : 0) : (otherOn ? on : 0);
    const rightLevel = side === 'right' ? (value ? on : 0) : (otherOn ? on : 0);
    this.log.info(`Setting seat heat via HomeKit: left=${leftLevel ? 'on' : 'off'} right=${rightLevel ? 'on' : 'off'}`);

    try {
      await this.client.controlHeatedSeats(this.vin, { leftLevel, rightLevel });
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: {
          ...this.basicStatus(),
          frontLeftSeatHeatLevel:  leftLevel,
          frontRightSeatHeatLevel: rightLevel,
        },
      };
      this.log.info('Seat heat command succeeded.');
    } catch (err) {
      this.log.warn(`Seat heat command failed: ${(err as Error).message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Handles a rear seat heat switch. One seat per request (controlHeatedSeat with param 25 or
   * 26), so the other rear seat is never restated. Rear seats are on/off only: on sends
   * REAR_HEATED_SEAT_ON_LEVEL (3), what the iSmart app sends. Optimistic like setSeatHeat.
   */
  async setRearSeatHeat(side: 'left' | 'right', value: boolean): Promise<void> {
    const seat  = side === 'left' ? HEATED_SEAT.REAR_LEFT : HEATED_SEAT.REAR_RIGHT;
    const field = side === 'left' ? 'secondRowLeftSeatHeatLevel' : 'secondRowRightSeatHeatLevel';
    const level = value ? REAR_HEATED_SEAT_ON_LEVEL : 0;
    this.log.info(`Setting rear ${side} seat heat via HomeKit: ${value ? 'on' : 'off'}`);
    try {
      await this.client.controlHeatedSeat(this.vin, seat, level);
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: { ...this.basicStatus(), [field]: level },
      };
      this.log.info('Rear seat heat command succeeded.');
    } catch (err) {
      this.log.warn(`Rear seat heat command failed: ${(err as Error).message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Handles a HomeKit Active toggle on the "Cabin Heat" tile. Turning on sends
   * startClimate with the compressor off (PTC resistive heater) at _heatTargetTemp.
   * Since the car has only one underlying climate system, a successful "on" also
   * mirrors Active=INACTIVE onto the Cool tile immediately rather than waiting for
   * the next poll.
   */
  async setHeatActive(value: boolean): Promise<void> {
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
        basicVehicleStatus: { ...this.basicStatus(), remoteClimateStatus: value ? 2 : 0 },
      };
      if (value) {
        this.coolService?.updateCharacteristic(this.Characteristic.Active, this.Characteristic.Active.INACTIVE);
        this._frontDefrostActive = false;
        this.frontDefrostService?.updateCharacteristic(this.Characteristic.On, false);
      }
      this.log.info('Cabin heat command succeeded.');
    } catch (err) {
      this.log.warn(`Cabin heat command failed: ${(err as Error).message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Handles a HomeKit Active toggle on the "Cabin Cool" tile. By default turning it
   * ON is refused: sending the AC compressor flag was confirmed on a real MG4 to run
   * the cabin heater at maximum instead of cooling it (see TESTING.md), so this
   * plugin no longer sends that command. Turning it OFF always works, in case
   * remoteClimateStatus reads 3 from some other trigger and needs stopping from HomeKit.
   *
   * With enableExperimentalCabinCool, turning it ON sends the reference client's
   * start_ac instead - fan 2 and the Cool tile's target temperature index, no param 22,
   * i.e. byte for byte the Cabin Heat command - and relies on the car to cool towards
   * a target below the cabin temperature. Unconfirmed on any real car. On success it
   * mirrors Active=INACTIVE onto Cabin Heat and Front Defrost, like Heat does.
   */
  async setCoolActive(value: boolean): Promise<void> {
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
        basicVehicleStatus: { ...this.basicStatus(), remoteClimateStatus: value ? 2 : 0 },
      };
      if (value) {
        this.heatService?.updateCharacteristic(this.Characteristic.Active, this.Characteristic.Active.INACTIVE);
        this._frontDefrostActive = false;
        this.frontDefrostService?.updateCharacteristic(this.Characteristic.On, false);
      }
      this.log.info('Cabin cool command succeeded.');
    } catch (err) {
      this.log.warn(`Cabin cool command failed: ${(err as Error).message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /** Keeps a target temperature inside climateRange (HomeKit enforces it too, via setProps). */
  private clampClimateTemp(temp: number): number {
    return Math.min(this.climateRange.max, Math.max(this.climateRange.min, temp));
  }

  /**
   * Handles a HeatingThresholdTemperature change on the "Cabin Heat" tile.
   * Stores the new target and, if that tile is currently active, re-sends
   * startClimate with the updated index so the car adjusts immediately.
   */
  async setHeatTemperature(value: number): Promise<void> {
    const temp = this.clampClimateTemp(value);
    this._heatTargetTemp = temp;
    if (this.readHeatActive()) {
      this.log.info(`Adjusting cabin heat target to ${temp} °C...`);
      try {
        const idx = climateTemperatureIndex(temp);
        await this.client.startClimate(this.vin, idx, false);
        this.log.info(`Cabin heat target updated to ${temp} °C.`);
      } catch (err) {
        this.log.warn(`Cabin heat temperature update failed: ${(err as Error).message}`);
        throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    }
  }

  /**
   * Handles a CoolingThresholdTemperature change on the "Cabin Cool" tile. Always stores
   * the new target. While the Cool tile is active it re-sends the start command with the
   * new index, but only with enableExperimentalCabinCool - and then without the
   * compressor flag, same as setCoolActive. It used to re-send with the compressor flag,
   * the very command confirmed to heat at maximum on a real MG4.
   */
  async setCoolTemperature(value: number): Promise<void> {
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
        this.log.warn(`Cabin cool temperature update failed: ${(err as Error).message}`);
        throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    }
  }

  async setRearDefrost(value: boolean): Promise<void> {
    this.log.info(`${value ? 'Starting' : 'Stopping'} rear window defrost via HomeKit...`);
    try {
      await this.client.controlRearWindowHeat(this.vin, value);
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: { ...this.basicStatus(), rmtHtdRrWndSt: value ? 1 : 0 },
      };
      this.log.info('Rear defrost command succeeded.');
    } catch (err) {
      this.log.warn(`Rear defrost command failed: ${(err as Error).message}`);
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
   * saic-client.ts) and mirrors Active=INACTIVE onto Heat/Cool, since all three share the
   * one climate system. Turning off sends the general stopClimate command, since the car
   * has no separate stop for defrost specifically.
   */
  async setFrontDefrost(value: boolean): Promise<void> {
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
          basicVehicleStatus: { ...this.basicStatus(), remoteClimateStatus: 0 },
        };
        this.heatService?.updateCharacteristic(this.Characteristic.Active, this.Characteristic.Active.INACTIVE);
        this.coolService?.updateCharacteristic(this.Characteristic.Active, this.Characteristic.Active.INACTIVE);
      }
      this.log.info('Front defrost command succeeded.');
    } catch (err) {
      this.log.warn(`Front defrost command failed: ${(err as Error).message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Handles the "Heated steering wheel" switch. Same optimistic pattern as the seat heat
   * switches: on success, steeringHeatLevel is patched locally (1 or 0) so HomeKit reflects
   * the command right away; the next poll replaces it with what the car actually reports,
   * which also catches the car's own ~10 minute auto-off. If the control response echoes a
   * basicVehicleStatus carrying a non-zero steeringWheelHeatFailureReason, that's logged.
   */
  async setSteeringWheelHeat(value: boolean): Promise<void> {
    this.log.info(`${value ? 'Starting' : 'Stopping'} heated steering wheel via HomeKit...`);
    try {
      const result = await this.client.controlHeatedSteeringWheel(this.vin, value);
      this.logSteeringWheelHeatFailure(
        (result as StatusData | undefined)?.['basicVehicleStatus'] as BasicStatus | undefined,
      );
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: { ...this.basicStatus(), steeringHeatLevel: value ? 1 : 0 },
      };
      this.log.info('Heated steering wheel command succeeded.');
    } catch (err) {
      this.log.warn(`Heated steering wheel command failed: ${(err as Error).message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Handles the "Window ventilation" switch: On sends controlDoorWindows with VENTILATE (all
   * four door windows open a few centimetres), Off sends CLOSE (all four closed). Same
   * optimistic pattern as the seat heat switches: on success the four window fields are
   * patched locally (1 or 0) and the next poll replaces them with what the car reports.
   */
  async setWindowVentilation(value: boolean): Promise<void> {
    this.log.info(`${value ? 'Ventilating (opening a few cm)' : 'Closing'} all door windows via HomeKit...`);
    try {
      await this.client.controlDoorWindows(
        this.vin, value ? DOOR_WINDOWS_ACTION.VENTILATE : DOOR_WINDOWS_ACTION.CLOSE,
      );
      const patch = Object.fromEntries(WINDOW_FIELDS.map((field) => [field, value ? 1 : 0]));
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: { ...this.basicStatus(), ...patch },
      };
      this.log.info('Window ventilation command succeeded.');
    } catch (err) {
      this.log.warn(`Window ventilation command failed: ${(err as Error).message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // ---------------------------------------------------------------- polling

  /** Called by the platform on its poll interval. Pushes fresh values into HomeKit. */
  async refresh(): Promise<void> {
    const lastKnownUnplugged = this.chrgMgmtData()?.['ccuOnbdChrgrPlugOn'] === 0;
    const skipCharging = lastKnownUnplugged && this._chargingSkipStreak < MgSaicAccessory.CHARGING_RECHECK_CYCLES;

    const [statusResult, chargingResult] = await Promise.allSettled([
      this.client.vehicleStatus(this.vin),
      skipCharging ? Promise.resolve(null) : this.client.chargingStatus(this.vin),
    ]);

    // Re-throw auth errors so the platform can clear the token and re-login.
    // Check both results; if either is an auth error, surface it.
    for (const result of [statusResult, chargingResult]) {
      if (result.status === 'rejected') {
        const err = result.reason as Error;
        if (err instanceof SaicError && (err.code === 401 || err.code === 403)) throw err;
      }
    }

    if (statusResult.status === 'fulfilled') {
      this._lastStatus = statusResult.value as StatusData;
      this.detectLockEngaged();
      if (this.enableHeatedSteeringWheel) this.logSteeringWheelHeatFailure(this.basicStatus());
      this.trackClimateStatus();
      this.pushStatusCharacteristics();
    } else {
      this.log.warn(`Status refresh failed: ${(statusResult.reason as Error).message}`);
    }

    if (skipCharging) {
      this._chargingSkipStreak++;
      this.log.debug('Skipping charging refresh: charger was last seen unplugged.');
    } else if (chargingResult.status === 'fulfilled') {
      this._chargingSkipStreak = 0;
      this._lastCharging = chargingResult.value as ChargingData;
      this.pushChargingCharacteristics();
    } else {
      this._chargingSkipStreak = 0;
      this.log.warn(`Charging refresh failed: ${(chargingResult.reason as Error).message}`);
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
  private detectLockEngaged(): void {
    const lockStatus = this.basicStatus()?.['lockStatus'] as number | undefined;
    if (this._prevLockStatus === 0 && lockStatus === 1 && !this.readPluggedIn()) {
      this.startLockRefreshSequence();
    }
    if (lockStatus !== undefined) this._prevLockStatus = lockStatus;
  }

  /**
   * Clears _coolStartedLocally once the car reports the climate as anything other than
   * running (2 or 3), and, while enableExperimentalCabinCool is on, logs every change of the
   * raw remoteClimateStatus - the one signal that tells whether that mode heats or cools.
   */
  private trackClimateStatus(): void {
    const status = this.basicStatus()?.['remoteClimateStatus'] as number | undefined;
    if (status !== 2 && status !== 3) this._coolStartedLocally = false;
    if (this.enableExperimentalCabinCool && status !== this._lastRemoteClimateStatus) {
      this.log.info(`Car reports remoteClimateStatus=${status ?? 'absent'}`
        + (this._coolStartedLocally ? ' (climate last started by the experimental Cabin Cool tile).' : '.'));
    }
    this._lastRemoteClimateStatus = status;
  }

  /** Starts the rapid refresh sequence, unless one is already running. */
  private startLockRefreshSequence(): void {
    if (this._lockRefreshTimer) {
      this.log.debug('Lock-triggered refresh sequence already running - not starting a second one.');
      return;
    }
    this.log.debug('Car locked while unplugged - starting rapid refresh sequence to catch plug-in.');
    this.scheduleLockRefreshStep(0);
  }

  private scheduleLockRefreshStep(step: number): void {
    if (step >= MgSaicAccessory.LOCK_REFRESH_SEQUENCE_MS.length) {
      this._lockRefreshTimer = undefined;
      return;
    }
    this._lockRefreshTimer = setTimeout(() => {
      void this.runLockRefreshStep(step);
    }, MgSaicAccessory.LOCK_REFRESH_SEQUENCE_MS[step]);
  }

  /** Runs one extra poll, forcing a real charging check regardless of the skip streak. */
  private async runLockRefreshStep(step: number): Promise<void> {
    this._chargingSkipStreak = MgSaicAccessory.CHARGING_RECHECK_CYCLES;
    try {
      await this.refresh();
    } catch (err) {
      this.log.debug(`Lock-triggered refresh failed: ${(err as Error).message}`);
    }
    if (this.readPluggedIn()) {
      this.log.debug('Plug-in detected - ending rapid refresh sequence.');
      this._lockRefreshTimer = undefined;
      return;
    }
    this.scheduleLockRefreshStep(step + 1);
  }

  pushStatusCharacteristics(): void {
    this.lockService.updateCharacteristic(this.Characteristic.LockCurrentState, this.readLockState());
    if (this.enablePreconditioning && this.heatService && this.coolService) {
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
    if (this.enableDoorSensors && this.contactServices) {
      for (const [[, field], i] of DOOR_FIELDS.map((entry, idx) => [entry, idx] as const)) {
        this.contactServices[i].updateCharacteristic(
          this.Characteristic.ContactSensorState, this.readContactState(field),
        );
      }
    }
    if (this.enableTemperatureSensors && this.interiorTempService && this.exteriorTempService) {
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
    if (this.enableHeatedSeats && this.leftSeatHeatService && this.rightSeatHeatService) {
      this.leftSeatHeatService.updateCharacteristic(this.Characteristic.On, this.readSeatHeat('frontLeftSeatHeatLevel'));
      this.rightSeatHeatService.updateCharacteristic(this.Characteristic.On, this.readSeatHeat('frontRightSeatHeatLevel'));
    }
    if (this.enableRearDefrost && this.rearDefrostService) {
      this.rearDefrostService.updateCharacteristic(
        this.Characteristic.On, Boolean(this.basicStatus()?.['rmtHtdRrWndSt']),
      );
    }
    if (this.enableFrontDefrost && this.frontDefrostService) {
      this.frontDefrostService.updateCharacteristic(this.Characteristic.On, this._frontDefrostActive);
    }
    if (this.enableHeatedSteeringWheel && this.steeringWheelHeatService) {
      this.steeringWheelHeatService.updateCharacteristic(this.Characteristic.On, this.readSteeringWheelHeat());
    }
    if (this.enableWindowVentilation && this.windowVentilationService) {
      this.windowVentilationService.updateCharacteristic(this.Characteristic.On, this.readWindowsOpen());
    }
    if (this.enableRearHeatedSeats && this.rearLeftSeatHeatService && this.rearRightSeatHeatService) {
      this.rearLeftSeatHeatService.updateCharacteristic(this.Characteristic.On, this.readSeatHeat('secondRowLeftSeatHeatLevel'));
      this.rearRightSeatHeatService.updateCharacteristic(this.Characteristic.On, this.readSeatHeat('secondRowRightSeatHeatLevel'));
    }
  }

  pushChargingCharacteristics(): void {
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
