import { describe, it, expect, vi } from 'vitest';
import { MgSaicAccessory, climateTemperatureRange, climateTemperatureIndex } from '../src/accessory.js';

// ---------------------------------------------------------------------------
// Minimal stub for api.hap so we can construct MgSaicAccessory without
// a real Homebridge instance.
// ---------------------------------------------------------------------------

const SECURED = 1;
const UNSECURED = 0;
const JAMMED = 3;
const CONTACT_DETECTED = 0;
const CONTACT_NOT_DETECTED = 1;
const CHARGING = 1;
const NOT_CHARGING = 0;
const NO_FAULT = 0;
const GENERAL_FAULT = 1;
const BATTERY_LEVEL_LOW = 1;
const BATTERY_LEVEL_NORMAL = 0;
const INACTIVE = 0;

function makeHap() {
  const Characteristic = {
    LockCurrentState: { SECURED, UNSECURED, JAMMED },
    LockTargetState: { SECURED, UNSECURED },
    ContactSensorState: { CONTACT_DETECTED, CONTACT_NOT_DETECTED },
    ChargingState: { CHARGING, NOT_CHARGING },
    StatusFault: { NO_FAULT, GENERAL_FAULT },
    StatusLowBattery: { BATTERY_LEVEL_LOW, BATTERY_LEVEL_NORMAL },
    BatteryLevel: {},
    On: {},
    OutletInUse: {},
    CurrentTemperature: {},
    Active: { INACTIVE: 0, ACTIVE: 1 },
    CurrentHeaterCoolerState: { INACTIVE: 0, IDLE: 1, HEATING: 2, COOLING: 3 },
    TargetHeaterCoolerState: { AUTO: 0, HEAT: 1, COOL: 2 },
    HeatingThresholdTemperature: {},
    CoolingThresholdTemperature: {},
  };

  const makeService = () => ({
    getCharacteristic: () => ({
      onGet: vi.fn().mockReturnThis(),
      onSet: vi.fn().mockReturnThis(),
      setProps: vi.fn().mockReturnThis(),
    }),
    updateCharacteristic: vi.fn(),
    setCharacteristic: vi.fn().mockReturnThis(),
  });

  const Service = {
    Battery: 'Battery',
    LockMechanism: 'LockMechanism',
    Outlet: 'Outlet',
    AccessoryInformation: 'AccessoryInformation',
    TemperatureSensor: 'TemperatureSensor',
    Switch: 'Switch',
    ContactSensor: 'ContactSensor',
    HeaterCooler: 'HeaterCooler',
  };

  const hap = {
    Characteristic,
    Service,
    uuid: { generate: (s) => s },
    HapStatusError: class HapStatusError extends Error {
      constructor(status) { super('HapStatusError'); this.hapStatus = status; }
    },
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
  };
  return hap;
}

function makeAccessory(overrides = {}) {
  const hap = makeHap();
  const serviceCache = {};

  const platformAccessory = {
    getService: (name) => serviceCache[name] ?? null,
    addService: (type, name) => {
      // One shared characteristic stub per service, so a test can inspect what was set on it
      // (e.g. setProps ranges) through service.getCharacteristic().
      const characteristic = {
        onGet: vi.fn().mockReturnThis(),
        onSet: vi.fn().mockReturnThis(),
        setProps: vi.fn().mockReturnThis(),
      };
      const svc = {
        getCharacteristic: () => characteristic,
        updateCharacteristic: vi.fn(),
        setCharacteristic: vi.fn().mockReturnThis(),
      };
      serviceCache[name ?? type] = svc;
      return svc;
    },
  };

  const client = {
    vehicleStatus: vi.fn(),
    chargingStatus: vi.fn(),
    lockVehicle: vi.fn(),
    unlockVehicle: vi.fn(),
    controlHeatedSeats: vi.fn(),
    controlRearWindowHeat: vi.fn(),
    startClimate: vi.fn(),
    stopClimate: vi.fn(),
    startFrontDefrost: vi.fn(),
  };

  const api = {
    hap,
    platformAccessory,
  };

  const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() };

  const acc = new MgSaicAccessory(platformAccessory, client, {
    vin: 'TESTVIN123',
    log,
    api,
    enablePreconditioning: true,
    enableDoorSensors: true,
    enableTemperatureSensors: true,
    enableHeatedSeats: true,
    enableRearDefrost: true,
    enableFrontDefrost: true,
    enableExperimentalCabinCool: false,
    ...overrides,
  });

  return { acc, client, log };
}

// ---------------------------------------------------------------------------
// readSoc
// ---------------------------------------------------------------------------

describe('readSoc', () => {
  it('returns 0 when no charging data', () => {
    const { acc } = makeAccessory();
    expect(acc.readSoc()).toBe(0);
  });

  it('divides bmsPackSOCDsp by 10', () => {
    const { acc } = makeAccessory();
    acc._lastCharging = { chrgMgmtData: { bmsPackSOCDsp: 680 } };
    expect(acc.readSoc()).toBe(68);
  });

  it('clamps to 0–100', () => {
    const { acc } = makeAccessory();
    acc._lastCharging = { chrgMgmtData: { bmsPackSOCDsp: 1200 } };
    expect(acc.readSoc()).toBe(100);
    acc._lastCharging = { chrgMgmtData: { bmsPackSOCDsp: -50 } };
    expect(acc.readSoc()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// readChargingState
// ---------------------------------------------------------------------------

describe('readChargingState', () => {
  it('returns NOT_CHARGING when no data', () => {
    const { acc } = makeAccessory();
    expect(acc.readChargingState()).toBe(NOT_CHARGING);
  });

  it('returns CHARGING when bmsChrgSts is non-zero', () => {
    const { acc } = makeAccessory();
    acc._lastCharging = { chrgMgmtData: { bmsChrgSts: 1 } };
    expect(acc.readChargingState()).toBe(CHARGING);
  });

  it('returns NOT_CHARGING when bmsChrgSts is 0', () => {
    const { acc } = makeAccessory();
    acc._lastCharging = { chrgMgmtData: { bmsChrgSts: 0 } };
    expect(acc.readChargingState()).toBe(NOT_CHARGING);
  });
});

// ---------------------------------------------------------------------------
// readPluggedIn / readCharging
// ---------------------------------------------------------------------------

describe('readPluggedIn', () => {
  it('returns false when no data', () => {
    const { acc } = makeAccessory();
    expect(acc.readPluggedIn()).toBe(false);
  });

  it('returns true when ccuOnbdChrgrPlugOn is 1', () => {
    const { acc } = makeAccessory();
    acc._lastCharging = { chrgMgmtData: { ccuOnbdChrgrPlugOn: 1 } };
    expect(acc.readPluggedIn()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readLockState
// ---------------------------------------------------------------------------

describe('readLockState', () => {
  it('returns UNSECURED when no data', () => {
    const { acc } = makeAccessory();
    expect(acc.readLockState()).toBe(UNSECURED);
  });

  it('returns SECURED when lockStatus is 1', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { lockStatus: 1 } };
    expect(acc.readLockState()).toBe(SECURED);
  });

  it('returns UNSECURED when lockStatus is 0', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { lockStatus: 0 } };
    expect(acc.readLockState()).toBe(UNSECURED);
  });
});

// ---------------------------------------------------------------------------
// readContactState
// ---------------------------------------------------------------------------

describe('readContactState', () => {
  it('returns CONTACT_DETECTED when door field is 0 (closed)', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { driverDoor: 0 } };
    expect(acc.readContactState('driverDoor')).toBe(CONTACT_DETECTED);
  });

  it('returns CONTACT_NOT_DETECTED when door field is non-zero (open)', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { driverDoor: 1 } };
    expect(acc.readContactState('driverDoor')).toBe(CONTACT_NOT_DETECTED);
  });
});

// ---------------------------------------------------------------------------
// readTemperature and readTemperatureFault
// ---------------------------------------------------------------------------

describe('readTemperature', () => {
  it('returns 0 when no data', () => {
    const { acc } = makeAccessory();
    expect(acc.readTemperature('interiorTemperature')).toBe(0);
    expect(acc.readTemperature('exteriorTemperature')).toBe(0);
  });

  it('returns the temperature value when valid', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { interiorTemperature: 22, exteriorTemperature: 15 } };
    expect(acc.readTemperature('interiorTemperature')).toBe(22);
    expect(acc.readTemperature('exteriorTemperature')).toBe(15);
  });

  it('returns last known good value and does not update cache when value is -128 sentinel', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { interiorTemperature: 20 } };
    acc.readTemperature('interiorTemperature'); // cache 20
    acc._lastStatus = { basicVehicleStatus: { interiorTemperature: -128 } };
    expect(acc.readTemperature('interiorTemperature')).toBe(20);
  });
});

describe('readTemperatureFault', () => {
  it('returns NO_FAULT when temperature is valid', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { interiorTemperature: 21 } };
    expect(acc.readTemperatureFault('interiorTemperature')).toBe(NO_FAULT);
  });

  it('returns GENERAL_FAULT when temperature is invalid (-128)', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { interiorTemperature: -128 } };
    expect(acc.readTemperatureFault('interiorTemperature')).toBe(GENERAL_FAULT);
  });
});

// ---------------------------------------------------------------------------
// readHeatActive / readCoolActive
// ---------------------------------------------------------------------------

describe('readHeatActive / readCoolActive', () => {
  it('are both false when no data', () => {
    const { acc } = makeAccessory();
    expect(acc.readHeatActive()).toBe(false);
    expect(acc.readCoolActive()).toBe(false);
  });

  it('readHeatActive is true and readCoolActive is false when remoteClimateStatus is 2', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 2 } };
    expect(acc.readHeatActive()).toBe(true);
    expect(acc.readCoolActive()).toBe(false);
  });

  it('readCoolActive is true and readHeatActive is false when remoteClimateStatus is 3', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 3 } };
    expect(acc.readHeatActive()).toBe(false);
    expect(acc.readCoolActive()).toBe(true);
  });

  it('are both false when remoteClimateStatus is 4 (fan only)', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 4 } };
    expect(acc.readHeatActive()).toBe(false);
    expect(acc.readCoolActive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readInteriorTempForClimate
// ---------------------------------------------------------------------------

describe('readInteriorTempForClimate', () => {
  it('returns 20 as fallback when no data is available', () => {
    const { acc } = makeAccessory();
    expect(acc.readInteriorTempForClimate()).toBe(20);
  });

  it('returns the last cached interior temperature if current reading is invalid', () => {
    const { acc } = makeAccessory();
    acc._lastInteriorTemperature = 18;
    acc._lastStatus = { basicVehicleStatus: { interiorTemperature: -128 } };
    expect(acc.readInteriorTempForClimate()).toBe(18);
  });

  it('returns the current interior temperature when valid', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { interiorTemperature: 21 } };
    expect(acc.readInteriorTempForClimate()).toBe(21);
  });
});

// ---------------------------------------------------------------------------
// setHeatActive / setCoolActive
// ---------------------------------------------------------------------------

describe('setHeatActive', () => {
  it('calls startClimate with temperature index and compressor=false', async () => {
    const { acc, client } = makeAccessory();
    client.startClimate.mockResolvedValue({});
    await acc.setHeatActive(true);
    // Default target is 22 °C → idx = 3 + (22 - 17) = 8
    expect(client.startClimate).toHaveBeenCalledWith('TESTVIN123', 8, false);
    expect(acc.readHeatActive()).toBe(true);
  });

  it('calls startClimate with a custom temperature index when the target has been changed', async () => {
    const { acc, client } = makeAccessory();
    client.startClimate.mockResolvedValue({});
    acc._heatTargetTemp = 25;
    await acc.setHeatActive(true);
    // 25 °C → idx = 3 + (25 - 17) = 11
    expect(client.startClimate).toHaveBeenCalledWith('TESTVIN123', 11, false);
  });

  it('mirrors Active=INACTIVE onto the Cool tile when turning on', async () => {
    const { acc, client } = makeAccessory();
    client.startClimate.mockResolvedValue({});
    await acc.setHeatActive(true);
    expect(acc.coolService.updateCharacteristic).toHaveBeenCalledWith(acc.Characteristic.Active, INACTIVE);
  });

  it('calls stopClimate and reflects the new state when turning off', async () => {
    const { acc, client } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 2 } };
    client.stopClimate.mockResolvedValue({});
    await acc.setHeatActive(false);
    expect(client.stopClimate).toHaveBeenCalledWith('TESTVIN123');
    expect(acc.readHeatActive()).toBe(false);
  });

  it('throws a HapStatusError and leaves state unchanged when the command fails', async () => {
    const { acc, client } = makeAccessory();
    client.startClimate.mockRejectedValue(new Error('timeout'));
    await expect(acc.setHeatActive(true)).rejects.toThrow('HapStatusError');
    expect(acc.readHeatActive()).toBe(false);
  });
});

describe('setCoolActive', () => {
  // Turning Cool on is disabled: a real MG4 test confirmed the compressor
  // command heats the cabin at maximum instead of cooling it (TESTING.md).
  it('refuses to turn on and never calls startClimate', async () => {
    const { acc, client } = makeAccessory();
    await expect(acc.setCoolActive(true)).rejects.toThrow('HapStatusError');
    expect(client.startClimate).not.toHaveBeenCalled();
    expect(acc.readCoolActive()).toBe(false);
  });

  it('calls stopClimate and reflects the new state when turning off', async () => {
    const { acc, client } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 3 } };
    client.stopClimate.mockResolvedValue({});
    await acc.setCoolActive(false);
    expect(client.stopClimate).toHaveBeenCalledWith('TESTVIN123');
    expect(acc.readCoolActive()).toBe(false);
  });

  it('throws a HapStatusError and leaves state unchanged when the stop command fails', async () => {
    const { acc, client } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 3 } };
    client.stopClimate.mockRejectedValue(new Error('timeout'));
    await expect(acc.setCoolActive(false)).rejects.toThrow('HapStatusError');
    expect(acc.readCoolActive()).toBe(true);
  });
});

describe('setCoolActive - experimental (enableExperimentalCabinCool)', () => {
  it('sends start_ac (no compressor flag) with the Cool tile target temperature', async () => {
    const { acc, client } = makeAccessory({ enableExperimentalCabinCool: true });
    client.startClimate.mockResolvedValue({});
    acc._coolTargetTemp = 18;
    await acc.setCoolActive(true);
    // 18 °C → idx = 3 + (18 - 17) = 4; compressor=false, same bytes as Cabin Heat
    expect(client.startClimate).toHaveBeenCalledWith('TESTVIN123', 4, false);
    expect(acc.readCoolActive()).toBe(true);
    expect(acc.readHeatActive()).toBe(false);
  });

  it('mirrors Active=INACTIVE onto Heat and clears front defrost when turning on', async () => {
    const { acc, client } = makeAccessory({ enableExperimentalCabinCool: true });
    client.startFrontDefrost.mockResolvedValue({});
    await acc.setFrontDefrost(true);
    client.startClimate.mockResolvedValue({});
    await acc.setCoolActive(true);
    expect(acc.heatService.updateCharacteristic).toHaveBeenCalledWith(acc.Characteristic.Active, INACTIVE);
    expect(acc._frontDefrostActive).toBe(false);
  });

  it('keeps showing Cool (not Heat) when the car reports remoteClimateStatus 2 after a Cool start', async () => {
    const { acc, client } = makeAccessory({ enableExperimentalCabinCool: true });
    client.startClimate.mockResolvedValue({});
    await acc.setCoolActive(true);
    client.vehicleStatus.mockResolvedValue({ basicVehicleStatus: { remoteClimateStatus: 2 } });
    client.chargingStatus.mockResolvedValue({ chrgMgmtData: {} });
    await acc.refresh();
    expect(acc.readCoolActive()).toBe(true);
    expect(acc.readHeatActive()).toBe(false);
  });

  it('forgets the Cool origin once the car reports the climate off', async () => {
    const { acc, client } = makeAccessory({ enableExperimentalCabinCool: true });
    client.startClimate.mockResolvedValue({});
    await acc.setCoolActive(true);
    client.chargingStatus.mockResolvedValue({ chrgMgmtData: {} });
    client.vehicleStatus.mockResolvedValueOnce({ basicVehicleStatus: { remoteClimateStatus: 0 } });
    await acc.refresh();
    client.vehicleStatus.mockResolvedValueOnce({ basicVehicleStatus: { remoteClimateStatus: 2 } });
    await acc.refresh();
    expect(acc.readHeatActive()).toBe(true);
    expect(acc.readCoolActive()).toBe(false);
  });

  it('hands the climate back to Heat when Cabin Heat is turned on afterwards', async () => {
    const { acc, client } = makeAccessory({ enableExperimentalCabinCool: true });
    client.startClimate.mockResolvedValue({});
    await acc.setCoolActive(true);
    await acc.setHeatActive(true);
    expect(acc.readHeatActive()).toBe(true);
    expect(acc.readCoolActive()).toBe(false);
  });

  it('throws a HapStatusError and leaves state unchanged when the command fails', async () => {
    const { acc, client } = makeAccessory({ enableExperimentalCabinCool: true });
    client.startClimate.mockRejectedValue(new Error('timeout'));
    await expect(acc.setCoolActive(true)).rejects.toThrow('HapStatusError');
    expect(acc.readCoolActive()).toBe(false);
  });

  it('logs the raw remoteClimateStatus whenever it changes, and only then', async () => {
    const { acc, client, log } = makeAccessory({ enableExperimentalCabinCool: true });
    client.chargingStatus.mockResolvedValue({ chrgMgmtData: {} });
    client.vehicleStatus.mockResolvedValue({ basicVehicleStatus: { remoteClimateStatus: 3 } });
    await acc.refresh();
    await acc.refresh();
    const logged = log.info.mock.calls.filter(([m]) => m.includes('remoteClimateStatus=3'));
    expect(logged).toHaveLength(1);
  });

  it('does not log remoteClimateStatus when the experimental option is off', async () => {
    const { acc, client, log } = makeAccessory();
    client.chargingStatus.mockResolvedValue({ chrgMgmtData: {} });
    client.vehicleStatus.mockResolvedValue({ basicVehicleStatus: { remoteClimateStatus: 3 } });
    await acc.refresh();
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('remoteClimateStatus='));
  });

  it('warns at startup that the experimental mode is on', () => {
    const { log } = makeAccessory({ enableExperimentalCabinCool: true });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Experimental Cabin Cool is on'));
  });
});

describe('setFrontDefrost', () => {
  it('calls startFrontDefrost and reflects the new state when turning on', async () => {
    const { acc, client } = makeAccessory();
    client.startFrontDefrost.mockResolvedValue({});
    await acc.setFrontDefrost(true);
    expect(client.startFrontDefrost).toHaveBeenCalledWith('TESTVIN123');
    expect(acc._frontDefrostActive).toBe(true);
  });

  it('mirrors Active=INACTIVE onto Heat and Cool when turning on', async () => {
    const { acc, client } = makeAccessory();
    client.startFrontDefrost.mockResolvedValue({});
    await acc.setFrontDefrost(true);
    expect(acc.heatService.updateCharacteristic).toHaveBeenCalledWith(acc.Characteristic.Active, INACTIVE);
    expect(acc.coolService.updateCharacteristic).toHaveBeenCalledWith(acc.Characteristic.Active, INACTIVE);
  });

  it('calls stopClimate when turning off', async () => {
    const { acc, client } = makeAccessory();
    client.startFrontDefrost.mockResolvedValue({});
    await acc.setFrontDefrost(true);
    client.stopClimate.mockResolvedValue({});
    await acc.setFrontDefrost(false);
    expect(client.stopClimate).toHaveBeenCalledWith('TESTVIN123');
  });

  it('throws a HapStatusError and leaves state unchanged when the command fails', async () => {
    const { acc, client } = makeAccessory();
    client.startFrontDefrost.mockRejectedValue(new Error('timeout'));
    await expect(acc.setFrontDefrost(true)).rejects.toThrow('HapStatusError');
    expect(acc._frontDefrostActive).toBe(false);
  });
});

describe('setHeatActive clears front defrost', () => {
  it('turns the front defrost switch off (locally) when Heat turns on', async () => {
    const { acc, client } = makeAccessory();
    client.startFrontDefrost.mockResolvedValue({});
    await acc.setFrontDefrost(true);

    client.startClimate.mockResolvedValue({});
    await acc.setHeatActive(true);

    expect(acc._frontDefrostActive).toBe(false);
    expect(acc.frontDefrostService.updateCharacteristic).toHaveBeenCalledWith(acc.Characteristic.On, false);
  });
});

// ---------------------------------------------------------------------------
// setHeatTemperature / setCoolTemperature
// ---------------------------------------------------------------------------

describe('setHeatTemperature', () => {
  it('stores the new target temperature', async () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 0 } };
    await acc.setHeatTemperature(25);
    expect(acc._heatTargetTemp).toBe(25);
  });

  it('does not call startClimate when the Heat tile is off', async () => {
    const { acc, client } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 0 } };
    await acc.setHeatTemperature(25);
    expect(client.startClimate).not.toHaveBeenCalled();
  });

  it('re-sends startClimate with compressor=false when the Heat tile is on', async () => {
    const { acc, client } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 2 } };
    client.startClimate.mockResolvedValue({});
    await acc.setHeatTemperature(30);
    // 30 °C → idx = 3 + (30 - 17) = 16
    expect(client.startClimate).toHaveBeenCalledWith('TESTVIN123', 16, false);
  });

  it('does not re-send when the Cool tile is on instead', async () => {
    const { acc, client } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 3 } };
    await acc.setHeatTemperature(30);
    expect(client.startClimate).not.toHaveBeenCalled();
  });

  it('throws a HapStatusError when the re-send fails', async () => {
    const { acc, client } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 2 } };
    client.startClimate.mockRejectedValue(new Error('timeout'));
    await expect(acc.setHeatTemperature(30)).rejects.toThrow('HapStatusError');
  });
});

describe('setCoolTemperature', () => {
  it('stores the new target temperature', async () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 0 } };
    await acc.setCoolTemperature(24);
    expect(acc._coolTargetTemp).toBe(24);
  });

  it('does not call startClimate when the Cool tile is off', async () => {
    const { acc, client } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 0 } };
    await acc.setCoolTemperature(24);
    expect(client.startClimate).not.toHaveBeenCalled();
  });

  it('never re-sends the compressor command while Cabin Cool is disabled, even if the car is cooling', async () => {
    // Real bug this guards against: the slider used to re-send param 22 = 1, the command
    // confirmed to heat at maximum on a real MG4, whenever remoteClimateStatus read 3.
    const { acc, client } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 3 } };
    await acc.setCoolTemperature(24);
    expect(client.startClimate).not.toHaveBeenCalled();
    expect(acc._coolTargetTemp).toBe(24);
  });

  it('re-sends startClimate WITHOUT the compressor flag when experimental Cool is on and active', async () => {
    const { acc, client } = makeAccessory({ enableExperimentalCabinCool: true });
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 3 } };
    client.startClimate.mockResolvedValue({});
    await acc.setCoolTemperature(24);
    // 24 °C → idx = 3 + (24 - 17) = 10
    expect(client.startClimate).toHaveBeenCalledWith('TESTVIN123', 10, false);
  });

  it('throws a HapStatusError when the re-send fails', async () => {
    const { acc, client } = makeAccessory({ enableExperimentalCabinCool: true });
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 3 } };
    client.startClimate.mockRejectedValue(new Error('timeout'));
    await expect(acc.setCoolTemperature(24)).rejects.toThrow('HapStatusError');
  });
});

// ---------------------------------------------------------------------------
// climate temperature range and index
// ---------------------------------------------------------------------------

describe('climateTemperatureRange', () => {
  it('keeps 17-33 °C for the MG4 (EH32) and for an unknown series', () => {
    expect(climateTemperatureRange('EH32 S')).toEqual({ min: 17, max: 33 });
    expect(climateTemperatureRange(undefined)).toEqual({ min: 17, max: 33 });
    expect(climateTemperatureRange('  ')).toEqual({ min: 17, max: 33 });
  });

  it('uses the MQTT gateway ranges for other series', () => {
    expect(climateTemperatureRange('MZS3E')).toEqual({ min: 16, max: 31 });
    // MG S6 EV: series "MIS3E S" is neither EH32 nor MZS3E -> the gateway default
    expect(climateTemperatureRange('MIS3E S')).toEqual({ min: 16, max: 28 });
    expect(climateTemperatureRange('mis3e s')).toEqual({ min: 16, max: 28 });
  });

  it('applies valid config overrides, either bound on its own', () => {
    expect(climateTemperatureRange('MIS3E S', { min: 17, max: 30 })).toEqual({ min: 17, max: 30 });
    expect(climateTemperatureRange('MIS3E S', { max: 30 })).toEqual({ min: 16, max: 30 });
    expect(climateTemperatureRange('EH32 S', { min: 18 })).toEqual({ min: 18, max: 33 });
  });

  it('ignores invalid overrides, keeps the series range and says why', () => {
    for (const overrides of [{ min: 15 }, { max: 34 }, { min: 20.5 }, { min: '18' }, { min: 25, max: 20 }, { min: 20, max: 20 }]) {
      const range = climateTemperatureRange('MIS3E S', overrides);
      expect(range).toMatchObject({ min: 16, max: 28 });
      expect(range.error).toMatch(/Ignoring climateMinTemperature/);
    }
  });
});

describe('climateTemperatureIndex', () => {
  it('is °C - 14, the same formula as mg-saic-ha (MG4) and the MQTT gateway (all series)', () => {
    expect(climateTemperatureIndex(16)).toBe(2);
    expect(climateTemperatureIndex(17)).toBe(3);
    expect(climateTemperatureIndex(22)).toBe(8);
    expect(climateTemperatureIndex(28)).toBe(14);
    expect(climateTemperatureIndex(33)).toBe(19);
  });
});

describe('climate range on the accessory', () => {
  it('defaults to 17-33 °C when no range is given (unchanged MG4 behaviour)', () => {
    const { acc } = makeAccessory();
    expect(acc.climateRange).toEqual({ min: 17, max: 33 });
    expect(acc.heatService.getCharacteristic().setProps)
      .toHaveBeenCalledWith({ minValue: 17, maxValue: 33, minStep: 1 });
  });

  it('sets both sliders to the given range', () => {
    const { acc } = makeAccessory({ climateRange: { min: 16, max: 28 } });
    expect(acc.heatService.getCharacteristic().setProps)
      .toHaveBeenCalledWith({ minValue: 16, maxValue: 28, minStep: 1 });
    expect(acc.coolService.getCharacteristic().setProps)
      .toHaveBeenCalledWith({ minValue: 16, maxValue: 28, minStep: 1 });
  });

  it('clamps a target outside the range and sends the clamped index', async () => {
    const { acc, client } = makeAccessory({ climateRange: { min: 16, max: 28 } });
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 2 } };
    client.startClimate.mockResolvedValue({});
    await acc.setHeatTemperature(31);
    expect(acc._heatTargetTemp).toBe(28);
    expect(client.startClimate).toHaveBeenCalledWith('TESTVIN123', 14, false);
  });

  it('sends index 2 for 16 °C, the bottom of the non-MG4 range', async () => {
    const { acc, client } = makeAccessory({ climateRange: { min: 16, max: 28 } });
    client.startClimate.mockResolvedValue({});
    acc._heatTargetTemp = 16;
    await acc.setHeatActive(true);
    expect(client.startClimate).toHaveBeenCalledWith('TESTVIN123', 2, false);
  });
});

// ---------------------------------------------------------------------------
// logExposedServices
// ---------------------------------------------------------------------------

describe('logExposedServices', () => {
  const lines = (log) => log.info.mock.calls.map(([m]) => m).join('\n');

  it('lists an enabled optional service as exposed', () => {
    const { log } = makeAccessory({ enablePreconditioning: true });
    expect(lines(log)).toMatch(/HomeKit services exposed:.*Pre-conditioning/);
  });

  it('reports a disabled optional service as disabled in config, not silently', () => {
    // The case this exists for: a missing tile in the Home app used to look
    // identical in the log to a service that was never configured on.
    const { log } = makeAccessory({ enablePreconditioning: false });
    const out = lines(log);
    expect(out).toMatch(/Not exposed, disabled in config:.*Pre-conditioning/);
    expect(out).not.toMatch(/HomeKit services exposed:.*Pre-conditioning/);
  });

  it('always reports the services that are not behind a config flag', () => {
    const { log } = makeAccessory({
      enablePreconditioning: false,
      enableDoorSensors: false,
      enableTemperatureSensors: false,
      enableHeatedSeats: false,
      enableRearDefrost: false,
      enableFrontDefrost: false,
    });
    expect(lines(log)).toMatch(/HomeKit services exposed: Battery, Lock, Charging outlet\./);
  });
});

// ---------------------------------------------------------------------------
// refresh - skipping the charging poll when the charger is known unplugged
// ---------------------------------------------------------------------------

describe('refresh', () => {
  it('polls charging status as normal when the plug state is not yet known', async () => {
    const { acc, client } = makeAccessory();
    client.vehicleStatus.mockResolvedValue({ basicVehicleStatus: {} });
    client.chargingStatus.mockResolvedValue({ chrgMgmtData: { ccuOnbdChrgrPlugOn: 1 } });
    await acc.refresh();
    expect(client.chargingStatus).toHaveBeenCalledTimes(1);
  });

  it('skips the charging poll once the charger was last seen unplugged', async () => {
    const { acc, client } = makeAccessory();
    acc._lastCharging = { chrgMgmtData: { ccuOnbdChrgrPlugOn: 0 } };
    client.vehicleStatus.mockResolvedValue({ basicVehicleStatus: {} });
    await acc.refresh();
    expect(client.chargingStatus).not.toHaveBeenCalled();
  });

  it('re-checks after CHARGING_RECHECK_CYCLES skipped cycles in case a cable was plugged back in', async () => {
    const { acc, client } = makeAccessory();
    acc._lastCharging = { chrgMgmtData: { ccuOnbdChrgrPlugOn: 0 } };
    client.vehicleStatus.mockResolvedValue({ basicVehicleStatus: {} });

    for (let i = 0; i < MgSaicAccessory.CHARGING_RECHECK_CYCLES; i++) {
      await acc.refresh();
    }
    expect(client.chargingStatus).not.toHaveBeenCalled();

    await acc.refresh();
    expect(client.chargingStatus).toHaveBeenCalledTimes(1);
  });

  it('resets the skip streak once a fresh charging reading comes back', async () => {
    const { acc, client } = makeAccessory();
    acc._lastCharging = { chrgMgmtData: { ccuOnbdChrgrPlugOn: 0 } };
    client.vehicleStatus.mockResolvedValue({ basicVehicleStatus: {} });

    for (let i = 0; i < MgSaicAccessory.CHARGING_RECHECK_CYCLES; i++) {
      await acc.refresh();
    }
    client.chargingStatus.mockResolvedValue({ chrgMgmtData: { ccuOnbdChrgrPlugOn: 1 } });
    await acc.refresh();

    client.chargingStatus.mockClear();
    await acc.refresh();
    expect(client.chargingStatus).toHaveBeenCalledTimes(1);
  });

  it('still polls vehicle status while the charging poll is being skipped', async () => {
    const { acc, client } = makeAccessory();
    acc._lastCharging = { chrgMgmtData: { ccuOnbdChrgrPlugOn: 0 } };
    client.vehicleStatus.mockResolvedValue({ basicVehicleStatus: { lockStatus: 1 } });
    await acc.refresh();
    expect(client.vehicleStatus).toHaveBeenCalledTimes(1);
    expect(acc._lastStatus).toEqual({ basicVehicleStatus: { lockStatus: 1 } });
  });
});

// ---------------------------------------------------------------------------
// lock-triggered rapid refresh sequence
// ---------------------------------------------------------------------------

describe('lock-triggered rapid refresh sequence', () => {
  it('starts the sequence when the car locks while unplugged, and forces a real charging check', async () => {
    vi.useFakeTimers();
    try {
      const { acc, client } = makeAccessory();
      client.vehicleStatus
        .mockResolvedValueOnce({ basicVehicleStatus: { lockStatus: 0 } })
        .mockResolvedValue({ basicVehicleStatus: { lockStatus: 1 } });
      client.chargingStatus.mockResolvedValue({ chrgMgmtData: { ccuOnbdChrgrPlugOn: 0 } });

      await acc.refresh(); // establishes the previous lock state (unlocked)
      await acc.refresh(); // lock engages -> starts the sequence

      client.chargingStatus.mockClear();
      await vi.advanceTimersByTimeAsync(60_000); // first step of the sequence

      expect(client.chargingStatus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start a sequence if the charger is already known to be plugged in', async () => {
    vi.useFakeTimers();
    try {
      const { acc, client } = makeAccessory();
      client.vehicleStatus
        .mockResolvedValueOnce({ basicVehicleStatus: { lockStatus: 0 } })
        .mockResolvedValue({ basicVehicleStatus: { lockStatus: 1 } });
      client.chargingStatus.mockResolvedValue({ chrgMgmtData: { ccuOnbdChrgrPlugOn: 1 } });

      await acc.refresh();
      await acc.refresh();

      client.vehicleStatus.mockClear();
      await vi.advanceTimersByTimeAsync(700_000);

      expect(client.vehicleStatus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start a sequence on the very first poll (no known previous lock state)', async () => {
    vi.useFakeTimers();
    try {
      const { acc, client } = makeAccessory();
      client.vehicleStatus.mockResolvedValue({ basicVehicleStatus: { lockStatus: 1 } });
      client.chargingStatus.mockResolvedValue({ chrgMgmtData: { ccuOnbdChrgrPlugOn: 0 } });

      await acc.refresh();

      client.vehicleStatus.mockClear();
      await vi.advanceTimersByTimeAsync(700_000);

      expect(client.vehicleStatus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the sequence as soon as a plug-in is detected', async () => {
    vi.useFakeTimers();
    try {
      const { acc, client } = makeAccessory();
      client.vehicleStatus
        .mockResolvedValueOnce({ basicVehicleStatus: { lockStatus: 0 } })
        .mockResolvedValue({ basicVehicleStatus: { lockStatus: 1 } });
      client.chargingStatus
        .mockResolvedValueOnce({ chrgMgmtData: { ccuOnbdChrgrPlugOn: 0 } })
        .mockResolvedValue({ chrgMgmtData: { ccuOnbdChrgrPlugOn: 1 } });

      await acc.refresh();
      await acc.refresh(); // starts the sequence

      client.chargingStatus.mockClear();
      await vi.advanceTimersByTimeAsync(60_000); // step 1: sees the plug-in, stops
      expect(client.chargingStatus).toHaveBeenCalledTimes(1);

      client.chargingStatus.mockClear();
      await vi.advanceTimersByTimeAsync(900_000); // well past every remaining step
      expect(client.chargingStatus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start a second sequence while one is already running', () => {
    vi.useFakeTimers();
    try {
      const { acc, log } = makeAccessory();
      acc.startLockRefreshSequence();
      const firstTimer = acc._lockRefreshTimer;

      acc.startLockRefreshSequence();

      expect(acc._lockRefreshTimer).toBe(firstTimer);
      expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('already running'));
    } finally {
      vi.useRealTimers();
    }
  });
});
