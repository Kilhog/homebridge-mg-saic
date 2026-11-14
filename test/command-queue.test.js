import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandQueue, commandDelayMs } from '../src/command-queue.js';

/** A control whose car state is `state.current` and whose send resolves when told to. */
function makeControl(state = { current: false }) {
  const sends = [];
  const control = {
    label: 'Heated steering wheel',
    current: () => state.current,
    send: vi.fn((value) => new Promise((resolve, reject) => sends.push({ value, resolve, reject }))),
    refresh: vi.fn(),
  };
  return { control, sends, state };
}

const log = () => ({ info: vi.fn(), debug: vi.fn() });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('CommandQueue', () => {
  it('sends nothing before the delay, then the latest value once', async () => {
    const queue = new CommandQueue(2000, log());
    const { control, sends } = makeControl();
    queue.request('wheel', control, true);
    await vi.advanceTimersByTimeAsync(1999);
    expect(control.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(control.send).toHaveBeenCalledTimes(1);
    expect(control.send).toHaveBeenCalledWith(true);
    sends[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(control.refresh).toHaveBeenCalledTimes(1);
  });

  it('sends nothing at all when a burst ends where it started (on, then off)', async () => {
    const l = log();
    const queue = new CommandQueue(2000, l);
    const { control } = makeControl({ current: false });
    queue.request('wheel', control, true);
    await vi.advanceTimersByTimeAsync(1500);
    queue.request('wheel', control, false);
    expect(queue.pending('wheel')).toEqual({ value: false });
    await vi.advanceTimersByTimeAsync(5000);
    expect(control.send).not.toHaveBeenCalled();
    expect(l.info).toHaveBeenCalledWith('Heated steering wheel: changed back within 2 s, nothing sent.');
    expect(control.refresh).toHaveBeenCalledTimes(1);
    expect(queue.pending('wheel')).toBeUndefined();
  });

  it('restarts the delay on every write and sends only the last value', async () => {
    const queue = new CommandQueue(2000, log());
    const { control } = makeControl({ current: false });
    queue.request('wheel', control, true);
    await vi.advanceTimersByTimeAsync(1500);
    queue.request('wheel', control, false);
    await vi.advanceTimersByTimeAsync(1500);
    queue.request('wheel', control, true);
    await vi.advanceTimersByTimeAsync(1999);
    expect(control.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(control.send).toHaveBeenCalledTimes(1);
    expect(control.send).toHaveBeenCalledWith(true);
  });

  it('always sends a single write, even if the car is already known to be in that state', async () => {
    // The known state can be a poll old: a lone "lock" from Siri must never be skipped.
    const queue = new CommandQueue(2000, log());
    const { control } = makeControl({ current: true });
    queue.request('lock', control, true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(control.send).toHaveBeenCalledWith(true);
  });

  it('keeps one command on its way at a time and sends what was asked meanwhile afterwards', async () => {
    const queue = new CommandQueue(2000, log());
    const { control, sends } = makeControl({ current: false });
    queue.request('wheel', control, true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(queue.pending('wheel')).toEqual({ value: true });

    queue.request('wheel', control, false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(control.send).toHaveBeenCalledTimes(1);
    expect(queue.pending('wheel')).toEqual({ value: false });

    sends[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(control.send).toHaveBeenCalledTimes(2);
    expect(control.send).toHaveBeenLastCalledWith(false);
    sends[1].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.pending('wheel')).toBeUndefined();
    expect(control.refresh).toHaveBeenCalledTimes(1);
  });

  it('drops a change made and undone while a command was on its way', async () => {
    const queue = new CommandQueue(2000, log());
    const { control, sends } = makeControl({ current: false });
    queue.request('wheel', control, true);
    await vi.advanceTimersByTimeAsync(2000);
    queue.request('wheel', control, false);
    queue.request('wheel', control, true);
    await vi.advanceTimersByTimeAsync(2000);
    sends[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(control.send).toHaveBeenCalledTimes(1);
  });

  it('refreshes the tile after a failed command so it shows the car again', async () => {
    const queue = new CommandQueue(2000, log());
    const { control, sends } = makeControl({ current: false });
    queue.request('wheel', control, true);
    await vi.advanceTimersByTimeAsync(2000);
    sends[0].reject(new Error('HapStatusError'));
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.pending('wheel')).toBeUndefined();
    expect(control.refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps controls apart', async () => {
    const queue = new CommandQueue(2000, log());
    const wheel = makeControl({ current: false });
    const seat = makeControl({ current: false });
    queue.request('wheel', wheel.control, true);
    queue.request('seat', seat.control, true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(wheel.control.send).toHaveBeenCalledTimes(1);
    expect(seat.control.send).toHaveBeenCalledTimes(1);
  });
});

describe('commandDelayMs', () => {
  it('defaults to 2 s and accepts 0 to 10 s', () => {
    expect(commandDelayMs(undefined)).toBe(2000);
    expect(commandDelayMs(0)).toBe(0);
    expect(commandDelayMs(1.5)).toBe(1500);
    expect(commandDelayMs(10)).toBe(10_000);
  });

  it('falls back to 2 s with a warning on anything else', () => {
    const l = { warn: vi.fn() };
    for (const bad of [-1, 11, '3', Number.NaN]) expect(commandDelayMs(bad, l)).toBe(2000);
    expect(l.warn).toHaveBeenCalledTimes(4);
  });
});
