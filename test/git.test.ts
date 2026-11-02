import { describe, expect, it } from 'vitest';
import { exec } from '../src/git.js';

describe('exec (programas sin shell)', () => {
  it('devuelve salida y código 0', async () => {
    const r = await exec('git', ['--version'], process.cwd());
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^git version/);
  });
  it('conserva el código de salida distinto de cero con su salida de error', async () => {
    const r = await exec('git', ['rev-parse', '--verify', 'rama-que-no-existe'], process.cwd());
    expect(r.code).not.toBe(0);
    expect(r.stderr.length + r.stdout.length).toBeGreaterThan(0);
  });
  it('un programa inexistente da 127 con el motivo', async () => {
    const r = await exec('programa-que-no-existe-xyz', [], process.cwd());
    expect(r).toMatchObject({ code: 127, stdout: '' });
    expect(r.stderr).toMatch(/ENOENT/);
  });
  it('no interpreta los argumentos como shell', async () => {
    const r = await exec('git', ['rev-parse', '--verify', 'x; echo inyectado'], process.cwd());
    expect(r.stdout).not.toContain('inyectado');
  });
});
