/**
 * Debounced, single-flight commands for the car's HomeKit controls: a write is answered at
 * once, the command is sent once nothing more has been asked for `delayMs` (latest value
 * only, nothing if it's back to the car's state), one command at a time per control. See
 * command-queue.ts for the fuller version of this comment.
 */

export class CommandQueue {
  /**
   * @param {number} delayMs
   * @param {{ info: Function, debug: Function }} log
   */
  constructor(delayMs, log) {
    this.delayMs = delayMs;
    this.log = log;
    this.entries = new Map();
  }

  /** Records the latest value asked for this control and (re)starts its delay. */
  request(key, control, value) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { control };
      this.entries.set(key, entry);
    }
    entry.control = control;
    if (!entry.wanted) entry.burst = { before: entry.sending ? entry.sending.value : control.current(), writes: 0 };
    entry.burst.writes++;
    entry.wanted = { value };
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.flush(key);
    }, this.delayMs);
  }

  /** The value this control is waiting to send or sending, if any. */
  pending(key) {
    const entry = this.entries.get(key);
    return entry?.wanted ?? entry?.sending;
  }

  async flush(key) {
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

function sameValue(a, b) {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** commandDelaySeconds from config: 0 to 10 s, default 2; anything else falls back to 2. */
export function commandDelayMs(seconds, log) {
  if (seconds === undefined || seconds === null) return 2000;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 && seconds <= 10) {
    return Math.round(seconds * 1000);
  }
  log?.warn(`Ignoring commandDelaySeconds ${String(seconds)}: it must be a number from 0 to 10. Using 2.`);
  return 2000;
}
