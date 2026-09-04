import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import type { ToolContext } from '../src/main/mcp/tools.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { initSessionStore } from '../src/main/session/store.js';

interface RawResponse {
  status: number;
  text: string;
}

function rawPost(urlStr: string, body: string): Promise<RawResponse> {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body)
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function decode(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  const datas = [...trimmed.matchAll(/^data:\s*(.*)$/gm)].map((match) => match[1] ?? '');
  const last = datas.at(-1);
  return last === undefined ? trimmed : JSON.parse(last);
}

let nextId = 1;
let endpoint: McpEndpoint;
let base: string;

async function core(method: string, params: unknown = {}): Promise<any> {
  const response = await rawPost(
    endpoint.urls.core,
    JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params })
  );
  return { status: response.status, body: decode(response.text) };
}

const failed = (reply: any): boolean => reply.body?.error !== undefined || reply.body?.result?.isError === true;

const validTasks = [
  {
    taskId: 'T1',
    parentTaskId: null,
    title: 'Implement one unit',
    goal: 'Produce one verified unit of work.',
    allowedScope: ['src/feature.ts'],
    dependencies: [],
    acceptanceCriteria: ['The unit is complete.'],
    expectedVerification: ['Run the focused test.'],
    forbiddenActions: ['Do not deploy.'],
    riskClass: 'normal'
  }
];

beforeAll(async () => {
  base = await makeTempDir('clf-mcp-agent-v3-');
  initSessionStore(base);
  const ctx: ToolContext = {
    roots: [],
    caps: { ...DEFAULT_CAPABILITIES },
    readOnly: true,
    sessionTools: false,
    agentTools: true
  };
  endpoint = await startMcpServer(() => ctx);
});

afterAll(async () => {
  if (endpoint) await endpoint.stop();
  await removeTempDir(base);
});

describe('Agent System 3.0 MCP surface', () => {
  it('extends the existing agents schema without adding another Core tool or model authority input', async () => {
    const listed = await core('tools/list');
    const tools = (listed.body?.result?.tools ?? []) as Array<Record<string, any>>;
    const agents = tools.filter((tool) => tool.name === 'agents');

    expect(agents).toHaveLength(1);
    expect(tools.length).toBeLessThanOrEqual(7);

    const schemaText = JSON.stringify(agents[0]?.inputSchema ?? {});
    for (const action of ['assign_manager', 'plan', 'complete_task', 'review_task', 'review_run', 'advance']) {
      expect(schemaText).toContain(action);
    }
    for (const field of [
      'manager_agent_id', 'plan_id', 'tasks', 'task_id', 'revision', 'changed_files',
      'verification', 'risks', 'notes', 'verdict', 'findings'
    ]) {
      expect(schemaText).toContain(field);
    }
    expect(schemaText).not.toContain('run_id');
  });

  it('rejects run or Manager authority injection on Manager plan calls at the wire schema boundary', async () => {
    const forgedRun = await core('tools/call', {
      name: 'agents',
      arguments: { action: 'plan', plan_id: 'plan-1', tasks: validTasks, run_id: 'forged-run' }
    });
    expect(failed(forgedRun)).toBe(true);

    const forgedManager = await core('tools/call', {
      name: 'agents',
      arguments: { action: 'plan', plan_id: 'plan-1', tasks: validTasks, manager_agent_id: 'worker-999' }
    });
    expect(failed(forgedManager)).toBe(true);
  });

  it('rejects V3 action fields when they are attached to the wrong action', async () => {
    const reviewFieldsOnPlan = await core('tools/call', {
      name: 'agents',
      arguments: { action: 'plan', plan_id: 'plan-1', tasks: validTasks, verdict: 'APPROVED', findings: [] }
    });
    expect(failed(reviewFieldsOnPlan)).toBe(true);

    const completionFieldsOnReview = await core('tools/call', {
      name: 'agents',
      arguments: { action: 'review_task', task_id: 'T1', verdict: 'APPROVED', findings: [], revision: 'a'.repeat(40) }
    });
    expect(failed(completionFieldsOnReview)).toBe(true);

    const taskReviewMissingVerdict = await core('tools/call', {
      name: 'agents',
      arguments: { action: 'review_task', task_id: 'T1', findings: [] }
    });
    expect(failed(taskReviewMissingVerdict)).toBe(true);
  });
});
