/**
 * Debounced, single-flight commands for the car's HomeKit controls.
 *
 * The car takes 10-25 s to confirm a command, while HAP gives a write handler about 9 s
 * before answering the Home app "no response" on its behalf. Awaiting the car inside the
 * write handler therefore made the Home app show an error and send the write again, or
 * the user tap again: a real log showed one accidental tap on the heated steering wheel
 * turn into 4 "on" and 2 "off" commands in 50 s.
 *
 * So a write is answered at once and only records what the user wants. The command is
 * sent once nothing more has been asked for `delayMs` (2 s by default), with the latest
 * value only. A burst of several writes that ends where it started (on then off within the
 * delay) sends nothing at all. A single write is always sent, even if the car is already
 * known to be in that state: that state can be one poll old, and a "lock" from Siri or an
 * automation must never be skipped on stale data. Each control has at most
 * one command on its way to the car; whatever is asked meanwhile is sent once it's done.
 * While a value waits or is being sent, pending() returns it, so the tile keeps showing
 * what the user asked for instead of jumping back on the next read or poll.
 */

export interface Control<T> {
  /** For the log, e.g. "Heated steering wheel". */
  label: string;
  /** The car's state, in the shape of the requested value (undefined if unknown): what a burst started from. */
  current(): T | undefined;
  /** Sends the command. Rejects on failure, after logging it. */
  send(value: T): Promise<unknown>;
  /** Pushes what the tile should show now to HomeKit (called once a command settles). */
  refresh(): void;
}

interface Entry {
  control: Control<unknown>;
  timer?: NodeJS.Timeout;
  /** Asked for, not sent yet. */
  wanted?: { value: unknown };
  /** On its way to the car. */
  sending?: { value: unknown };
  /** The current burst of writes: what the tile showed before it, and how many writes. */
  burst?: { before: unknown; writes: number };
}

export class CommandQueue {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly delayMs: number,
    private readonly log: { info(m: string): void; debug(m: string): void },
  ) {}

  /** Records the latest value asked for this control and (re)starts its delay. */
  request<T>(key: string, control: Control<T>, value: T): void {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { control: control as Control<unknown> };
      this.entries.set(key, entry);
    }
    entry.control = control as Control<unknown>;
    if (!entry.wanted) entry.burst = { before: entry.sending ? entry.sending.value : control.current(), writes: 0 };
    entry.burst!.writes++;
    entry.wanted = { value };
    if (entry.timer) clearTimeout(entry.timer);
    const delayed = entry;
    delayed.timer = setTimeout(() => {
      delayed.timer = undefined;
      void this.flush(key);
    }, this.delayMs);
  }

  /** The value this control is waiting to send or sending, if any. */
  pending<T>(key: string): { value: T } | undefined {
    const entry = this.entries.get(key);
    return (entry?.wanted ?? entry?.sending) as { value: T } | undefined;
  }

  private async flush(key: string): Promise<void> {
    const entry = this.entries.get(key);
    // Already sending: this value goes out once that command settles.
    if (!entry?.wanted || entry.sending) return;
    const { value } = entry.wanted;
    const burst = entry.burst;
    entry.wanted = undefined;
    entry.burst = undefined;

    if (burst && burst.writes > 1 && burst.before !== undefined && sameValue(value, burst.before)) {
      this.log.info(`${entry.control.label}: changed back within ${this.delayMs / 1000} s, nothing sent.`);
    } else {
      entry.sending = { value };
      try {
        await entry.control.send(value);
      } catch {
        // The send method has logged it; the tile goes back to the car's state below.
      } finally {
        entry.sending = undefined;
      }
      // Asked again while this command was on its way, and that delay is already over.
      if (entry.wanted && !entry.timer) {
        await this.flush(key);
        return;
      }
    }
    entry.control.refresh();
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** commandDelaySeconds from config: 0 to 10 s, default 2; anything else falls back to 2. */
export function commandDelayMs(
  seconds: unknown,
  log?: { warn(m: string): void },
): number {
  if (seconds === undefined || seconds === null) return 2000;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 && seconds <= 10) {
    return Math.round(seconds * 1000);
  }
  log?.warn(`Ignoring commandDelaySeconds ${String(seconds)}: it must be a number from 0 to 10. Using 2.`);
  return 2000;
}
