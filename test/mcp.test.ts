import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { McpServerConfig } from '../src/config.js';
import { connectMcpServers, expandEnv, needsApproval, toolName, type McpConnections } from '../src/mcp/client.js';
import type { Permissions } from '../src/permissions.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-mcp.mjs', import.meta.url));
const base: McpServerConfig = { command: process.execPath, args: [fixture], env: {}, transport: 'http', headers: {}, autoApprove: ['list_issues'], enabled: true };

const asked: string[] = [];
const perms = (answer: boolean): Permissions => ({
  autoApprove: false,
  allowedCommands: [],
  confirm: async (q) => (asked.push(q), answer),
});

describe('utilidades MCP', () => {
  it('expande variables de entorno', () => {
    expect(expandEnv('Bearer ${T}', { T: 'abc' })).toBe('Bearer abc');
    expect(() => expandEnv('${NOPE}', {})).toThrow(/NOPE/);
  });
  it('nombra y limita las herramientas', () => {
    expect(toolName('my server', 'do.it')).toBe('mcp__my_server__do_it');
    expect(toolName('s', 'x'.repeat(100))).toHaveLength(64);
  });
  it('decide aprobación', () => {
    expect(needsApproval({ ...base, autoApprove: true }, 'x')).toBe(false);
    expect(needsApproval(base, 'list_issues')).toBe(false);
    expect(needsApproval(base, 'add_comment')).toBe(true);
  });
});

describe('servidor MCP real por stdio', () => {
  let conn: McpConnections;
  afterAll(async () => conn?.close());

  it('descubre herramientas y respeta la aprobación', async () => {
    const p = perms(false);
    conn = await connectMcpServers({ tracker: base, roto: { ...base, args: ['/no/existe.mjs'] } }, p, 10_000);
    expect(conn.status.find((s) => s.name === 'tracker')).toMatchObject({ ok: true });
    expect(conn.status.find((s) => s.name === 'roto')?.ok).toBe(false);
    expect(Object.keys(conn.tools).sort()).toEqual(['mcp__tracker__add_comment', 'mcp__tracker__list_issues']);

    const opts = { toolCallId: '1', messages: [] } as never;
    const list = await conn.tools.mcp__tracker__list_issues!.execute!({ state: 'open' } as never, opts);
    expect(JSON.stringify(list)).toContain('PROJ-1');
    expect(asked).toHaveLength(0);

    const denied = await conn.tools.mcp__tracker__add_comment!.execute!({ key: 'PROJ-1', body: 'hola' } as never, opts);
    expect(denied).toBe('DENEGADO por el usuario.');
    expect(asked).toHaveLength(1);
  }, 30_000);
});
