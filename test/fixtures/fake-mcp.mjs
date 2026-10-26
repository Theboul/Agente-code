import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fake-tracker', version: '1.0.0' });
server.registerTool('list_issues', { description: 'Lista issues', inputSchema: { state: z.string().optional() } }, async ({ state }) => ({
  content: [{ type: 'text', text: JSON.stringify([{ key: 'PROJ-1', title: 'Arreglar login', state: state ?? 'open' }]) }],
}));
server.registerTool('add_comment', { description: 'Comenta', inputSchema: { key: z.string(), body: z.string() } }, async ({ key }) => ({
  content: [{ type: 'text', text: `comentado ${key}` }],
}));
await server.connect(new StdioServerTransport());
