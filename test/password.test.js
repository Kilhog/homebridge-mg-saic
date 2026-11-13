import { describe, it, expect, vi } from 'vitest';
import { resolvePassword } from '../src/password.js';

function makeLog() {
  return { warn: vi.fn(), error: vi.fn() };
}

function makeFs(files) {
  return {
    readFileSync: vi.fn((path) => {
      if (!(path in files)) {
        const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return files[path].content;
    }),
    statSync: vi.fn((path) => ({ mode: files[path]?.mode ?? 0o100600 })),
  };
}

describe('resolvePassword', () => {
  it('prefers config.password over the file and the environment', () => {
    const fs = makeFs({ '/pw': { content: 'from-file\n' } });
    const result = resolvePassword(
      { password: 'inline', passwordFile: '/pw' }, makeLog(), { MG_SAIC_PASSWORD: 'env' }, fs,
    );
    expect(result).toEqual({ password: 'inline', source: 'config.password' });
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('reads passwordFile when config.password is blank, stripping only trailing line breaks', () => {
    const log = makeLog();
    const fs = makeFs({ '/pw': { content: ' pass word \r\n\n' } });
    const result = resolvePassword(
      { password: '', passwordFile: ' /pw ' }, log, { MG_SAIC_PASSWORD: 'env' }, fs,
    );
    expect(result).toEqual({ password: ' pass word ', source: 'passwordFile /pw' });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('warns when the file is readable by other users, without logging the password', () => {
    const log = makeLog();
    const fs = makeFs({ '/pw': { content: 'secret\n', mode: 0o100644 } });
    expect(resolvePassword({ passwordFile: '/pw' }, log, {}, fs)?.password).toBe('secret');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain('chmod 600 /pw');
    expect(log.warn.mock.calls[0][0]).not.toContain('secret');
  });

  it('fails without falling back to the environment when the file is missing', () => {
    const log = makeLog();
    const result = resolvePassword(
      { passwordFile: '/missing' }, log, { MG_SAIC_PASSWORD: 'env' }, makeFs({}),
    );
    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalledWith('Could not read passwordFile /missing: ENOENT');
  });

  it('fails when the file is empty', () => {
    const log = makeLog();
    const result = resolvePassword(
      { passwordFile: '/pw' }, log, { MG_SAIC_PASSWORD: 'env' }, makeFs({ '/pw': { content: '\n' } }),
    );
    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalledWith('passwordFile /pw is empty.');
  });

  it('keeps the password when the permission check itself fails', () => {
    const log = makeLog();
    const fs = makeFs({ '/pw': { content: 'secret' } });
    fs.statSync.mockImplementation(() => { throw new Error('EACCES'); });
    expect(resolvePassword({ passwordFile: '/pw' }, log, {}, fs)?.password).toBe('secret');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('falls back to MG_SAIC_PASSWORD when neither password nor passwordFile is set', () => {
    expect(resolvePassword({}, makeLog(), { MG_SAIC_PASSWORD: 'env' }, makeFs({}))).toEqual({
      password: 'env', source: 'the MG_SAIC_PASSWORD environment variable',
    });
  });

  it('returns null when nothing is configured', () => {
    expect(resolvePassword({ passwordFile: '  ' }, makeLog(), {}, makeFs({}))).toBeNull();
  });
});
