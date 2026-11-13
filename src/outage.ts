/**
 * Keeps a run of failures from flooding the log: the first failure of a streak is logged at
 * warn level, the following ones at debug, and the recovery once at info with how many
 * attempts failed and for how long. Used for the platform's polls (the SAIC API as a whole)
 * and for the charging endpoint, which can fail on its own while status works.
 */

import type { Logger } from './saic-client.js';

export class OutageLog {
  private failures = 0;
  private since = 0;

  constructor(
    private readonly log: Logger,
    private readonly name: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get consecutiveFailures(): number {
    return this.failures;
  }

  failure(message: string): void {
    this.failures++;
    if (this.failures === 1) {
      this.since = this.now();
      this.log.warn(`${this.name} unreachable: ${message} (further failures are logged at debug level until it recovers).`);
    } else {
      this.log.debug(`${this.name} still unreachable (${this.failures} failures in a row): ${message}`);
    }
  }

  success(): void {
    if (this.failures > 0) {
      const minutes = Math.round((this.now() - this.since) / 60_000);
      this.log.info(`${this.name} reachable again after ${this.failures} failed attempt(s) / ${minutes} min.`);
    }
    this.failures = 0;
  }
}
