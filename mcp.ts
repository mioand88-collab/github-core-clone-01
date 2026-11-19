// The MCP surface: GitHub's tool set over JSON-RPC at /mcp, speaking the
// legacy handshake era (initialize, then tools/list and tools/call) — a
// server/discover probe is answered method-not-found, which is exactly how
// a pre-discover server tells the client to negotiate down. Every tool is a
// thin delegate to the same forge state the REST and GraphQL surfaces use,
// so an issue created here is the issue REST lists.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { forge, flattenTree, issueJson, mergeBase, repoJson } from './app.ts';
import { buildCommit, buildTree, identityLine, parseCommit, parseTree } from './git.ts';
import { repoKey, type RepoRec } from './store.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required: string[];
  run: (args: Record<string, unknown>) => unknown;
}

function mustRepoTool(owner: unknown, repoName: unknown): RepoRec {
  const repo = forge.repo(String(owner ?? ''), String(repoName ?? ''));
  if (repo === undefined) throw new Error(`Repository ${String(owner)}/${String(repoName)} not found`);
  return repo;
}

function pullView(repo: RepoRec, issueId: number): Record<string, unknown> {
  const issue = forge.issues.get(issueId);
  const pull = forge.pulls.get(issueId);
  if (issue === undefined || pull === undefined) throw new Error('Pull request not found');
  return {
    ...issueJson(repo, issue),
    number: issue.number,
    title: issue.title,
    state: pull.merged ? 'merged' : issue.state,
    merged: pull.merged,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
  };
}

/** Merge a pull request the same way the other surfaces do; returns the merge sha. */
function mergePull(repo: RepoRec, pullNumber: number): Record<string, unknown> {
  const issue = forge.issueByNumber(repo, pullNumber);
  if (issue === undefined || !issue.isPull) throw new Error(`Pull request #${pullNumber} not found`);
  const pull = forge.pulls.get(issue.id);
  if (pull === undefined) throw new Error(`Pull request #${pullNumber} not found`);
  if (pull.merged) throw new Error('Pull Request is not mergeable');
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const base = mergeBase(baseSha, headSha);
  if (base === null) throw new Error('Pull Request is not mergeable');
  const treeOf = (sha: string): string => parseCommit(forge.objects.get(sha)?.data as Buffer).tree;
  const baseFiles = flattenTree(treeOf(baseSha));
  const headFiles = flattenTree(treeOf(headSha));
  const ancFiles = flattenTree(treeOf(base));
  const merged = new Map<string, { id: string; mode: string }>();
  for (const path of new Set([...baseFiles.keys(), ...headFiles.keys(), ...ancFiles.keys()])) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    const a = ancFiles.get(path);
    if (h?.id !== a?.id && b?.id !== a?.id && h?.id !== b?.id) {
      throw new Error('Pull Request is not mergeable');
    }
    const chosen = h?.id !== a?.id ? h : b;
    if (chosen !== undefined) merged.set(path, chosen);
  }
  let root: string | null = null;
  const setPath = (rootId: string | null, segments: string[], blobId: string, mode: string): string => {
    const entries: Array<{ mode: string; name: string; id: string }> =
      rootId !== null && forge.objects.get(rootId)?.type === 'tree'
        ? [...parseTree(forge.objects.get(rootId)?.data as Buffer)]
        : [];
    const head = segments[0] as string;
    const index = entries.findIndex((e) => e.name === head);
    if (segments.length === 1) {
      if (index !== -1) entries[index] = { mode, name: head, id: blobId };
      else entries.push({ mode, name: head, id: blobId });
    } else {
      const childRoot = index !== -1 && entries[index]?.mode === '40000' ? (entries[index] as { id: string }).id : null;
      const newChild = setPath(childRoot, segments.slice(1), blobId, mode);
      if (index !== -1) entries[index] = { mode: '40000', name: head, id: newChild };
      else entries.push({ mode: '40000', name: head, id: newChild });
    }
    return forge.objects.put('tree', buildTree(entries));
  };
  for (const [path, entry] of merged) root = setPath(root, path.split('/'), entry.id, entry.mode);
  if (root === null) root = forge.objects.put('tree', buildTree([]));
  const now = Math.floor(Date.now() / 1000);
  const viewer = forge.viewer();
  const ident = identityLine(viewer.name, viewer.email, now);
  const mergeSha = forge.objects.put('commit', buildCommit({
    tree: root,
    parents: [baseSha, headSha],
    author: ident,
    committer: ident,
    message: `Merge pull request #${issue.number} from ${pull.headRef}`,
  }));
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.merged = true;
  pull.mergedAt = now;
  pull.mergeCommitSha = mergeSha;
  issue.state = 'closed';
  issue.closedAt = now;
  issue.updatedAt = now;
  return { sha: mergeSha, merged: true, message: 'Pull Request successfully merged', pull_request: pullView(repo, issue.id) };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name' },
      description: { type: 'string', description: 'A short description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    required: ['name'],
    run: (args) => {
      const name = String(args.name ?? '');
      if (name === '') throw new Error('name is required');
      const owner = forge.viewer().login;
      if (forge.repo(owner, name) !== undefined) throw new Error('Repository already exists');
      const repo = forge.createRepo(owner, name, {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner' },
      repo: { type: 'string', description: 'The repository name' },
    },
    required: ['owner', 'repo'],
    run: (args) => repoJson(mustRepoTool(args.owner, args.repo)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      title: { type: 'string', description: 'The issue title' },
      body: { type: 'string', description: 'The issue body' },
    },
    required: ['owner', 'repo', 'title'],
    run: (args) => {
      const repo = mustRepoTool(args.owner, args.repo);
      const issue = forge.createIssue(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        userLogin: forge.viewer().login,
        labels: [],
        assignees: [],
        isPull: false,
      });
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      state: { type: 'string', description: 'open, closed or all (default open)' },
    },
    required: ['owner', 'repo'],
    run: (args) => {
      const repo = mustRepoTool(args.owner, args.repo);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = forge.issuesOf(repo).filter((i) => !i.isPull);
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      return list.map((i) => issueJson(repo, i));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      title: { type: 'string' },
      head: { type: 'string', description: 'The head branch' },
      base: { type: 'string', description: 'The base branch' },
      body: { type: 'string' },
      draft: { type: 'boolean' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (args) => {
      const repo = mustRepoTool(args.owner, args.repo);
      const headRef = String(args.head ?? '');
      const baseRef = String(args.base ?? '');
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined) throw new Error(`Head branch "${headRef}" does not exist`);
      if (baseSha === undefined) throw new Error(`Base branch "${baseRef}" does not exist`);
      const issue = forge.createIssue(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        userLogin: forge.viewer().login,
        labels: [],
        assignees: [],
        isPull: true,
      });
      forge.pulls.set(issue.id, {
        issueId: issue.id,
        headRepoKey: repoKey(repo.owner, repo.name),
        headRef,
        headSha,
        baseRepoKey: repoKey(repo.owner, repo.name),
        baseRef,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        draft: args.draft === true,
      });
      return pullView(repo, issue.id);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      pull_number: { type: 'number', description: 'The pull request number' },
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (args) => {
      const repo = mustRepoTool(args.owner, args.repo);
      return mergePull(repo, Number(args.pull_number));
    },
  },
];

// ---------------------------------------------------------------- json-rpc

interface RpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function handleRpc(request: RpcRequest, authed: boolean): Record<string, unknown> | null {
  const id = request.id;
  const method = request.method ?? '';
  const isNotification = id === undefined;
  switch (method) {
    case 'initialize': {
      const offered = (request.params?.protocolVersion as string | undefined) ?? '';
      const protocolVersion = LEGACY_REVISIONS.includes(offered) ? offered : '2025-06-18';
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }
    case 'server/discover':
      return rpcError(id, -32601, 'Method not found: server/discover');
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list': {
      const tools = TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
      }));
      return rpcResult(id, { tools });
    }
    case 'tools/call': {
      if (!authed) return rpcError(id, -32001, 'Unauthorized');
      const params = request.params ?? {};
      const name = String(params.name ?? '');
      const tool = TOOLS.find((t) => t.name === name);
      if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        return rpcResult(id, {
          content: [{ type: 'text', text: `Missing required arguments: ${missing.join(', ')}` }],
          isError: true,
        });
      }
      try {
        const value = tool.run(args);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value as Record<string, unknown>,
          isError: false,
        });
      } catch (err) {
        return rpcResult(id, {
          content: [{ type: 'text', text: err instanceof Error ? err.message : 'Tool failed' }],
          isError: true,
        });
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Handle POST /mcp; returns true when the path matched. */
export function handleMCP(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Buffer,
  authed: boolean,
): boolean {
  if (url.pathname !== '/mcp') return false;
  const send = (status: number, payload: unknown): void => {
    if (payload === null) {
      res.writeHead(status);
      res.end();
      return;
    }
    const text = `${JSON.stringify(payload)}\n`;
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  if (req.method !== 'POST') {
    send(405, rpcError(null, -32600, 'Method not allowed'));
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    send(200, rpcError(null, -32700, 'Parse error'));
    return true;
  }
  if (Array.isArray(parsed)) {
    const results = parsed
      .map((item) => handleRpc(item as RpcRequest, authed))
      .filter((item) => item !== null);
    send(200, results);
    return true;
  }
  const request = parsed as RpcRequest;
  // The auth check is an HTTP 401 on tools/call, not a JSON-RPC error.
  if (request.method === 'tools/call' && !authed) {
    send(401, rpcError(request.id, -32001, 'Unauthorized'));
    return true;
  }
  const result = handleRpc(request, authed);
  if (result === null) {
    send(202, null);
    return true;
  }
  send(200, result);
  return true;
}
