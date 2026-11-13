import { readFileSync, statSync } from 'node:fs';

export interface PasswordSource {
  password: string;
  source: string;
}

interface PasswordFs {
  readFileSync: (path: string, encoding: 'utf8') => string;
  statSync: (path: string) => { mode: number };
}

interface PasswordLog {
  warn: (message: string) => void;
  error: (message: string) => void;
}

/**
 * Where the iSmart password comes from, in this order: `password` in config, the file named by
 * `passwordFile`, then the MG_SAIC_PASSWORD environment variable.
 *
 * The file option is for Docker-based Homebridge installs (e.g. on a NAS): there the process
 * environment can't be changed without recreating the container, and config.json is often
 * readable by every user of the host. Keeping the password in a root-owned file with mode 600
 * avoids both. Only trailing line breaks are stripped, so a password may start or end with
 * spaces. A configured but unreadable or empty file is an error, not a silent fall back to the
 * environment. The password itself is never logged.
 */
export function resolvePassword(
  config: Record<string, unknown>,
  log: PasswordLog,
  env: Record<string, string | undefined> = process.env,
  fs: PasswordFs = { readFileSync, statSync },
): PasswordSource | null {
  const inline = config['password'];
  if (typeof inline === 'string' && inline !== '') {
    return { password: inline, source: 'config.password' };
  }

  const file = config['passwordFile'];
  if (typeof file === 'string' && file.trim() !== '') {
    const path = file.trim();
    let content: string;
    try {
      content = fs.readFileSync(path, 'utf8');
    } catch (err) {
      const code = (err as { code?: string }).code ?? (err as Error).message;
      log.error(`Could not read passwordFile ${path}: ${code}`);
      return null;
    }
    const password = content.replace(/(\r?\n)+$/, '');
    if (!password) {
      log.error(`passwordFile ${path} is empty.`);
      return null;
    }
    try {
      if ((fs.statSync(path).mode & 0o077) !== 0) {
        log.warn(`passwordFile ${path} is readable by other users, restrict it with: chmod 600 ${path}`);
      }
    } catch {
      // The file was just read; the permission check is only advisory.
    }
    return { password, source: `passwordFile ${path}` };
  }

  const fromEnv = env['MG_SAIC_PASSWORD'];
  if (fromEnv) return { password: fromEnv, source: 'the MG_SAIC_PASSWORD environment variable' };
  return null;
}
