/**
 * Keeps a run of failures from flooding the log: first failure at warn, the rest at debug,
 * the recovery once at info. See outage.ts for the fuller version of this comment.
 */

export class OutageLog {
  /**
   * @param {{ info: Function, debug: Function, warn: Function }} log
   * @param {string} name
   * @param {() => number} now
   */
  constructor(log, name, now = () => Date.now()) {
    this.log = log;
    this.name = name;
    this.now = now;
    this.failures = 0;
    this.since = 0;
  }

  get consecutiveFailures() {
    return this.failures;
  }

  failure(message) {
    this.failures++;
    if (this.failures === 1) {
      this.since = this.now();
      this.log.warn(`${this.name} unreachable: ${message} (further failures are logged at debug level until it recovers).`);
    } else {
      this.log.debug(`${this.name} still unreachable (${this.failures} failures in a row): ${message}`);
    }
  }

  success() {
    if (this.failures > 0) {
      const minutes = Math.round((this.now() - this.since) / 60_000);
      this.log.info(`${this.name} reachable again after ${this.failures} failed attempt(s) / ${minutes} min.`);
    }
    this.failures = 0;
  }
}
