import { vi } from 'vitest';

/**
 * A stub PlatformAccessory that keeps its services the way Homebridge does: found by type
 * (getService), by type + subtype (getServiceById) or by display name, removable, and each
 * holding its characteristic values so tile names can be checked. A new service gets its
 * display name as Name, like a real HAP service.
 *
 * Every characteristic of one service shares the same onGet/onSet/setProps mocks, so a test
 * can inspect what the accessory set through service.getCharacteristic().
 *
 * `Name` is the Characteristic.Name constant of the HAP stub in use.
 */
export function makeStubAccessory(Name) {
  const services = [];

  const makeService = (type, displayName, subtype) => {
    const handlers = {
      onGet: vi.fn().mockReturnThis(),
      onSet: vi.fn().mockReturnThis(),
      setProps: vi.fn().mockReturnThis(),
    };
    const values = new Map();
    const service = {
      type,
      displayName,
      subtype,
      values,
      getCharacteristic: (c) => Object.assign(Object.create(handlers), { value: values.get(c) }),
      testCharacteristic: (c) => values.has(c),
      addOptionalCharacteristic: vi.fn((c) => { if (!values.has(c)) values.set(c, ''); }),
      updateCharacteristic: vi.fn(),
      setCharacteristic: vi.fn((c, v) => { values.set(c, v); return service; }),
    };
    if (displayName) values.set(Name, displayName);
    return service;
  };

  const accessory = {
    services,
    getService: (typeOrName) => services.find((s) => s.type === typeOrName || s.displayName === typeOrName) ?? null,
    getServiceById: (type, subtype) => services.find((s) => s.type === type && s.subtype === subtype) ?? null,
    addService: (type, displayName, subtype) => {
      const service = makeService(type, displayName, subtype);
      services.push(service);
      return service;
    },
    removeService: vi.fn((service) => {
      const i = services.indexOf(service);
      if (i >= 0) services.splice(i, 1);
    }),
  };

  return accessory;
}
