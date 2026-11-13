import { describe, it, expect, vi } from 'vitest';
import {
  MgSaicAccessory, climateTemperatureRange, climateTemperatureIndex, SERVICE_NAMES, serviceLanguage,
} from '../src/accessory.js';
import { makeStubAccessory } from './accessory-stub.js';

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
    CurrentDoorState: { OPEN: 0, CLOSED: 1, OPENING: 2, CLOSING: 3, STOPPED: 4 },
    TargetDoorState: { OPEN: 0, CLOSED: 1 },
    ObstructionDetected: {},
    Manufacturer: 'Manufacturer',
    Model: 'Model',
    SerialNumber: 'SerialNumber',
    Name: 'Name',
    ConfiguredName: 'ConfiguredName',
  };

  const Service = {
    Battery: 'Battery',
    LockMechanism: 'LockMechanism',
    Outlet: 'Outlet',
    AccessoryInformation: 'AccessoryInformation',
    TemperatureSensor: 'TemperatureSensor',
    Switch: 'Switch',
    ContactSensor: 'ContactSensor',
    HeaterCooler: 'HeaterCooler',
    GarageDoorOpener: 'GarageDoorOpener',
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

/**
 * A MgSaicAccessory with every option on (Cabin Cool experimental off). Pass `platformAccessory`
 * (from makeStubAccessory, pre-filled with services) to start from a cached accessory.
 */
function makeAccessory(overrides = {}, { platformAccessory = makeStubAccessory('Name') } = {}) {
  const hap = makeHap();

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
    controlHeatedSteeringWheel: vi.fn(),
    controlDoorWindows: vi.fn(),
    controlHeatedSeat: vi.fn(),
    controlTailgate: vi.fn(),
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
    enableHeatedSteeringWheel: true,
    enableWindowVentilation: true,
    enableRearHeatedSeats: true,
    enablePowerTailgate: true,
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
    const { acc, client } = makeAccessory({ enableExperimentalCabinCool: true });
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
    const { acc, client } = makeAccessory({ enableExperimentalCabinCool: true });
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
// heated steering wheel
// ---------------------------------------------------------------------------

describe('readSteeringWheelHeat', () => {
  it('is false when no data', () => {
    const { acc } = makeAccessory();
    expect(acc.readSteeringWheelHeat()).toBe(false);
  });

  it('follows steeringHeatLevel (0 = off, non-zero = on)', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { steeringHeatLevel: 1 } };
    expect(acc.readSteeringWheelHeat()).toBe(true);
    acc._lastStatus = { basicVehicleStatus: { steeringHeatLevel: 0 } };
    expect(acc.readSteeringWheelHeat()).toBe(false);
  });
});

describe('setSteeringWheelHeat', () => {
  it('sends the command and reflects the new state optimistically', async () => {
    const { acc, client } = makeAccessory();
    client.controlHeatedSteeringWheel.mockResolvedValue({});
    await acc.setSteeringWheelHeat(true);
    expect(client.controlHeatedSteeringWheel).toHaveBeenCalledWith('TESTVIN123', true);
    expect(acc.readSteeringWheelHeat()).toBe(true);

    await acc.setSteeringWheelHeat(false);
    expect(client.controlHeatedSteeringWheel).toHaveBeenLastCalledWith('TESTVIN123', false);
    expect(acc.readSteeringWheelHeat()).toBe(false);
  });

  it('keeps the rest of the cached status when patching steeringHeatLevel', async () => {
    const { acc, client } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { lockStatus: 1 } };
    client.controlHeatedSteeringWheel.mockResolvedValue({});
    await acc.setSteeringWheelHeat(true);
    expect(acc._lastStatus.basicVehicleStatus).toEqual({ lockStatus: 1, steeringHeatLevel: 1 });
  });

  it('throws a HapStatusError and leaves state unchanged when the command fails', async () => {
    const { acc, client } = makeAccessory();
    client.controlHeatedSteeringWheel.mockRejectedValue(new Error('timeout'));
    await expect(acc.setSteeringWheelHeat(true)).rejects.toThrow('HapStatusError');
    expect(acc.readSteeringWheelHeat()).toBe(false);
  });

  it('logs a non-zero steeringWheelHeatFailureReason echoed by the control response', async () => {
    const { acc, client, log } = makeAccessory();
    client.controlHeatedSteeringWheel.mockResolvedValue({
      basicVehicleStatus: { steeringWheelHeatFailureReason: 2 },
    });
    await acc.setSteeringWheelHeat(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('steeringWheelHeatFailureReason=2'));
  });
});

describe('refresh - steeringWheelHeatFailureReason', () => {
  it('logs a non-zero reason once, not on every poll while it stays the same', async () => {
    const { acc, client, log } = makeAccessory();
    client.vehicleStatus.mockResolvedValue({ basicVehicleStatus: { steeringWheelHeatFailureReason: 5 } });
    client.chargingStatus.mockResolvedValue({ chrgMgmtData: {} });
    await acc.refresh();
    await acc.refresh();
    const warned = log.warn.mock.calls.filter(([m]) => m.includes('steeringWheelHeatFailureReason'));
    expect(warned).toHaveLength(1);
  });

  it('stays quiet when the reason is 0', async () => {
    const { acc, client, log } = makeAccessory();
    client.vehicleStatus.mockResolvedValue({ basicVehicleStatus: { steeringWheelHeatFailureReason: 0 } });
    client.chargingStatus.mockResolvedValue({ chrgMgmtData: {} });
    await acc.refresh();
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('steeringWheelHeatFailureReason'));
  });
});

// ---------------------------------------------------------------------------
// window ventilation (MG S6 EV door windows)
// ---------------------------------------------------------------------------

describe('readWindowsOpen', () => {
  it('is false when no data or every door window reads 0', () => {
    const { acc } = makeAccessory();
    expect(acc.readWindowsOpen()).toBe(false);
    acc._lastStatus = { basicVehicleStatus: { driverWindow: 0, passengerWindow: 0, rearLeftWindow: 0, rearRightWindow: 0 } };
    expect(acc.readWindowsOpen()).toBe(false);
  });

  it('is true as soon as any one door window reads non-zero', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { driverWindow: 0, passengerWindow: 0, rearLeftWindow: 1, rearRightWindow: 0 } };
    expect(acc.readWindowsOpen()).toBe(true);
  });
});

describe('setWindowVentilation', () => {
  it('sends VENTILATE (1) when turned on, never the full-open action', async () => {
    const { acc, client } = makeAccessory();
    client.controlDoorWindows.mockResolvedValue({});
    await acc.setWindowVentilation(true);
    expect(client.controlDoorWindows).toHaveBeenCalledWith('TESTVIN123', 1);
    expect(acc.readWindowsOpen()).toBe(true);
  });

  it('sends CLOSE (0) when turned off and patches all four windows closed', async () => {
    const { acc, client } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { lockStatus: 1, driverWindow: 1, passengerWindow: 1, rearLeftWindow: 1, rearRightWindow: 1 } };
    client.controlDoorWindows.mockResolvedValue({});
    await acc.setWindowVentilation(false);
    expect(client.controlDoorWindows).toHaveBeenCalledWith('TESTVIN123', 0);
    expect(acc._lastStatus.basicVehicleStatus).toEqual({
      lockStatus: 1, driverWindow: 0, passengerWindow: 0, rearLeftWindow: 0, rearRightWindow: 0,
    });
  });

  it('throws a HapStatusError and leaves state unchanged when the command fails', async () => {
    const { acc, client } = makeAccessory();
    client.controlDoorWindows.mockRejectedValue(new Error('Request failed.'));
    await expect(acc.setWindowVentilation(true)).rejects.toThrow('HapStatusError');
    expect(acc.readWindowsOpen()).toBe(false);
  });

  it('is listed in the startup services log', () => {
    const { log } = makeAccessory({ enableWindowVentilation: true });
    expect(log.info.mock.calls.map(([m]) => m).join('\n')).toMatch(/HomeKit services exposed:.*Window ventilation/);
  });
});

// ---------------------------------------------------------------------------
// heated seats: front "on" level and rear seats
// ---------------------------------------------------------------------------

describe('setSeatHeat (front) - on level', () => {
  it('sends 3 for on by default, exactly as before', async () => {
    const { acc, client } = makeAccessory();
    client.controlHeatedSeats.mockResolvedValue({});
    await acc.setSeatHeat('left', true);
    expect(client.controlHeatedSeats).toHaveBeenCalledWith('TESTVIN123', { leftLevel: 3, rightLevel: 0 });
  });

  it('sends the configured frontSeatHeatLevel for on, for the restated other seat too', async () => {
    const { acc, client } = makeAccessory({ frontSeatHeatLevel: 2 });
    client.controlHeatedSeats.mockResolvedValue({});
    await acc.setSeatHeat('right', true);
    expect(client.controlHeatedSeats).toHaveBeenLastCalledWith('TESTVIN123', { leftLevel: 0, rightLevel: 2 });
    await acc.setSeatHeat('left', true);
    expect(client.controlHeatedSeats).toHaveBeenLastCalledWith('TESTVIN123', { leftLevel: 2, rightLevel: 2 });
  });

  it('falls back to 3 with a warning when frontSeatHeatLevel is not 1-3', () => {
    for (const level of [0, 4, 2.5, '2']) {
      const { acc, log } = makeAccessory({ frontSeatHeatLevel: level });
      expect(acc.frontSeatHeatLevel).toBe(3);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('frontSeatHeatLevel'));
    }
  });
});

describe('setRearSeatHeat', () => {
  it('reads each rear seat from its own secondRow field', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { secondRowLeftSeatHeatLevel: 3, secondRowRightSeatHeatLevel: 0 } };
    expect(acc.readSeatHeat('secondRowLeftSeatHeatLevel')).toBe(true);
    expect(acc.readSeatHeat('secondRowRightSeatHeatLevel')).toBe(false);
  });

  it('sends one seat at a time (25 / 26), on = 3, and updates only that seat', async () => {
    const { acc, client } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { secondRowRightSeatHeatLevel: 3 } };
    client.controlHeatedSeat.mockResolvedValue({});
    await acc.setRearSeatHeat('left', true);
    expect(client.controlHeatedSeat).toHaveBeenCalledWith('TESTVIN123', 25, 3);
    expect(acc._lastStatus.basicVehicleStatus)
      .toEqual({ secondRowLeftSeatHeatLevel: 3, secondRowRightSeatHeatLevel: 3 });

    await acc.setRearSeatHeat('right', false);
    expect(client.controlHeatedSeat).toHaveBeenLastCalledWith('TESTVIN123', 26, 0);
    expect(acc.readSeatHeat('secondRowRightSeatHeatLevel')).toBe(false);
    expect(client.controlHeatedSeats).not.toHaveBeenCalled();
  });

  it('throws a HapStatusError and leaves state unchanged when the command fails', async () => {
    const { acc, client } = makeAccessory();
    client.controlHeatedSeat.mockRejectedValue(new Error('timeout'));
    await expect(acc.setRearSeatHeat('left', true)).rejects.toThrow('HapStatusError');
    expect(acc.readSeatHeat('secondRowLeftSeatHeatLevel')).toBe(false);
  });

  it('is listed in the startup services log', () => {
    const { log } = makeAccessory({ enableRearHeatedSeats: true });
    expect(log.info.mock.calls.map(([m]) => m).join('\n')).toMatch(/HomeKit services exposed:.*Rear heated seats/);
  });
});

// ---------------------------------------------------------------------------
// power tailgate (GarageDoorOpener)
// ---------------------------------------------------------------------------

describe('power tailgate', () => {
  it('reads Open/Closed from bootStatus, target following it', () => {
    const { acc } = makeAccessory();
    expect(acc.readTailgateCurrentState()).toBe(1); // CLOSED
    expect(acc.readTailgateTargetState()).toBe(1); // CLOSED
    acc._lastStatus = { basicVehicleStatus: { bootStatus: 1 } };
    expect(acc.readTailgateCurrentState()).toBe(0); // OPEN
    expect(acc.readTailgateTargetState()).toBe(0); // OPEN
  });

  it('opens with action 1, showing OPENING while in flight, then Open', async () => {
    const { acc, client } = makeAccessory();
    client.controlTailgate.mockResolvedValue({});
    await acc.setTailgateTarget(true);
    expect(client.controlTailgate).toHaveBeenCalledWith('TESTVIN123', 1);
    const calls = acc.tailgateService.updateCharacteristic.mock.calls
      .filter(([c]) => c === acc.Characteristic.CurrentDoorState).map(([, v]) => v);
    expect(calls).toEqual([2, 0]); // OPENING, then OPEN
    expect(acc._lastStatus.basicVehicleStatus.bootStatus).toBe(1);
  });

  it('closes with action 2', async () => {
    const { acc, client } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { bootStatus: 1 } };
    client.controlTailgate.mockResolvedValue({});
    await acc.setTailgateTarget(false);
    expect(client.controlTailgate).toHaveBeenCalledWith('TESTVIN123', 2);
    expect(acc.readTailgateCurrentState()).toBe(1); // CLOSED
  });

  it('restores the reported state and throws a HapStatusError when the command fails', async () => {
    const { acc, client } = makeAccessory();
    client.controlTailgate.mockRejectedValue(new Error('Request failed.'));
    await expect(acc.setTailgateTarget(true)).rejects.toThrow('HapStatusError');
    expect(acc.tailgateService.updateCharacteristic)
      .toHaveBeenLastCalledWith(acc.Characteristic.CurrentDoorState, 1); // back to CLOSED
    expect(acc._lastStatus).toBeNull();
  });

  it('sets up the Tailgate service and lists it in the startup log', () => {
    const { acc, log } = makeAccessory({ enablePowerTailgate: true });
    expect(acc.tailgateService).toBeDefined();
    expect(log.info.mock.calls.map(([m]) => m).join('\n')).toMatch(/HomeKit services exposed:.*Power tailgate/);
  });
});

// ---------------------------------------------------------------------------
// useStatusCache: the S6 services' fields count as required too
// ---------------------------------------------------------------------------

describe('statusFieldsInUse with the S6 services', () => {
  it('includes the fields read by the heated steering wheel, windows, rear seats and tailgate', () => {
    const { acc } = makeAccessory();
    expect(acc.statusFieldsInUse()).toEqual(expect.arrayContaining([
      'steeringHeatLevel', 'driverWindow', 'passengerWindow', 'rearLeftWindow', 'rearRightWindow',
      'secondRowLeftSeatHeatLevel', 'secondRowRightSeatHeatLevel', 'bootStatus',
    ]));
    expect(new Set(acc.statusFieldsInUse()).size).toBe(acc.statusFieldsInUse().length);
  });

  it('leaves them out when those services are disabled', () => {
    const { acc } = makeAccessory({
      enableHeatedSteeringWheel: false, enableWindowVentilation: false, enableRearHeatedSeats: false,
      enablePowerTailgate: false, enableDoorSensors: false,
    });
    const fields = acc.statusFieldsInUse();
    for (const f of ['steeringHeatLevel', 'driverWindow', 'secondRowLeftSeatHeatLevel', 'bootStatus']) {
      expect(fields).not.toContain(f);
    }
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
    const { acc } = makeAccessory({ climateRange: { min: 16, max: 28 }, enableExperimentalCabinCool: true });
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

  it('reports the heated steering wheel as exposed or disabled', () => {
    expect(lines(makeAccessory({ enableHeatedSteeringWheel: true }).log))
      .toMatch(/HomeKit services exposed:.*Heated steering wheel/);
    expect(lines(makeAccessory({ enableHeatedSteeringWheel: false }).log))
      .toMatch(/Not exposed, disabled in config:.*Heated steering wheel/);
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
      enableHeatedSteeringWheel: false,
      enableWindowVentilation: false,
      enableRearHeatedSeats: false,
      enablePowerTailgate: false,
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

// ---------------------------------------------------------------------------
// AccessoryInformation model
// ---------------------------------------------------------------------------

describe('AccessoryInformation model', () => {
  it('uses the model name the account reports', () => {
    const { acc } = makeAccessory({ model: 'MGS6 EV' });
    const info = acc.accessory.getService('AccessoryInformation');
    expect(info.setCharacteristic).toHaveBeenCalledWith('Model', 'MGS6 EV');
    expect(acc.model).toBe('MGS6 EV');
  });

  it('falls back to MG4 when the model is unknown or blank', () => {
    expect(makeAccessory().acc.model).toBe('MG4');
    expect(makeAccessory({ model: '  ' }).acc.model).toBe('MG4');
  });
});

// ---------------------------------------------------------------------------
// tile names (Name + ConfiguredName) and unused services
// ---------------------------------------------------------------------------

describe('tile names', () => {
  const named = (acc, type, subtype) => (subtype
    ? acc.accessory.getServiceById(type, subtype)
    : acc.accessory.getService(type));

  it('gives every tile a Name and a ConfiguredName, in English by default', () => {
    const { acc } = makeAccessory();
    for (const [type, subtype, name] of [
      ['Battery', undefined, 'Battery'],
      ['LockMechanism', undefined, 'Lock'],
      ['Outlet', undefined, 'Charging cable'],
      ['HeaterCooler', 'preconditionHeat', 'Cabin Heat'],
      ['ContactSensor', 'driverDoor', 'Driver door'],
      ['Switch', 'leftSeatHeat', 'Left seat heat'],
      ['GarageDoorOpener', 'powerTailgate', 'Tailgate'],
    ]) {
      const service = named(acc, type, subtype);
      expect(service.values.get('Name')).toBe(name);
      expect(service.values.get('ConfiguredName')).toBe(name);
    }
  });

  it('names the tiles in French with language "fr"', () => {
    const { acc } = makeAccessory({ language: 'fr' });
    expect(named(acc, 'Outlet').values.get('ConfiguredName')).toBe('Câble de charge');
    expect(named(acc, 'LockMechanism').values.get('ConfiguredName')).toBe('Verrouillage');
    expect(named(acc, 'HeaterCooler', 'preconditionHeat').values.get('ConfiguredName')).toBe('Chauffage habitacle');
    expect(named(acc, 'Switch', 'rearLeftSeatHeat').values.get('ConfiguredName')).toBe('Siège arrière gauche');
  });

  it('has an English and a French name for every subtype it uses', () => {
    const { acc } = makeAccessory({ enableExperimentalCabinCool: true });
    for (const service of acc.accessory.services) {
      if (!service.subtype) continue;
      expect(SERVICE_NAMES[service.subtype]).toEqual({ en: expect.any(String), fr: expect.any(String) });
    }
  });

  it('renames a cached tile in place, found by subtype, without adding a second one', () => {
    const cached = makeStubAccessory('Name');
    const old = cached.addService('Switch', 'Left seat heat', 'leftSeatHeat');
    const { acc } = makeAccessory({ language: 'fr' }, { platformAccessory: cached });
    expect(acc.accessory.services.filter((s) => s.subtype === 'leftSeatHeat')).toEqual([old]);
    expect(old.displayName).toBe('Siège avant gauche');
    expect(old.values.get('Name')).toBe('Siège avant gauche');
    expect(old.values.get('ConfiguredName')).toBe('Siège avant gauche');
  });

  it('keeps a name chosen in the Home app', () => {
    const cached = makeStubAccessory('Name');
    const seat = cached.addService('Switch', 'Siège avant gauche', 'leftSeatHeat');
    seat.values.set('ConfiguredName', 'Mon siège');
    makeAccessory({ language: 'fr' }, { platformAccessory: cached });
    expect(seat.values.get('ConfiguredName')).toBe('Mon siège');
  });

  it('renames a tile nobody renamed when the language changes', () => {
    const cached = makeStubAccessory('Name');
    const seat = cached.addService('Switch', 'Left seat heat', 'leftSeatHeat');
    seat.values.set('ConfiguredName', 'Left seat heat');
    makeAccessory({ language: 'fr' }, { platformAccessory: cached });
    expect(seat.values.get('ConfiguredName')).toBe('Siège avant gauche');
  });

  it('reads anything but "fr" as English', () => {
    expect(serviceLanguage('fr')).toBe('fr');
    for (const value of [undefined, 'en', 'FR', 'de', 1]) expect(serviceLanguage(value)).toBe('en');
  });
});

describe('unused services', () => {
  it('does not expose Cabin Cool unless enableExperimentalCabinCool is on', () => {
    expect(makeAccessory().acc.coolService).toBeUndefined();
    expect(makeAccessory({ enableExperimentalCabinCool: true }).acc.coolService).toBeDefined();
  });

  it('removes a cached Cabin Cool tile while the experimental option is off', () => {
    const cached = makeStubAccessory('Name');
    cached.addService('HeaterCooler', 'Cabin Cool', 'preconditionCool');
    const { acc, log } = makeAccessory({}, { platformAccessory: cached });
    expect(acc.accessory.getServiceById('HeaterCooler', 'preconditionCool')).toBeNull();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Removing the "Cabin Cool" tile'));
  });

  it('removes a cached tile whose option is now off in config', () => {
    const cached = makeStubAccessory('Name');
    cached.addService('Switch', 'Rear window defrost', 'rearDefrost');
    const { acc } = makeAccessory({ enableRearDefrost: false }, { platformAccessory: cached });
    expect(acc.accessory.getServiceById('Switch', 'rearDefrost')).toBeNull();
  });

  it('never removes AccessoryInformation or a service it does not know', () => {
    const cached = makeStubAccessory('Name');
    const info = cached.addService('AccessoryInformation');
    const foreign = cached.addService('Switch', 'Something else', 'somethingElse');
    makeAccessory({}, { platformAccessory: cached });
    expect(cached.services).toContain(info);
    expect(cached.services).toContain(foreign);
  });

  it('still pushes status without a Cool tile', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 2, interiorTemperature: 20 } };
    expect(() => acc.pushStatusCharacteristics()).not.toThrow();
    expect(acc.heatService.updateCharacteristic).toHaveBeenCalledWith(acc.Characteristic.Active, 1);
  });
});
