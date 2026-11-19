// The forge's HTTP surface: GitHub's REST v3 under /api/v3, the git smart
// HTTP protocol at /{owner}/{repo}.git, GraphQL at /api/graphql and MCP at
// /mcp, all over the one in-memory store in store.ts. Standard library only.
//
// Layout: this file owns routing and the REST resources; git.ts owns the
// object store and pack codec; githttp.ts owns the wire protocol handlers.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, repoKey, type RepoRec, type UserRec } from './store.ts';
import {
  buildCommit,
  buildTree,
  identityLine,
  parseCommit,
  parseTree,
  type TreeEntry,
} from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

export const forge = new Forge();

// ---------------------------------------------------------------- http help

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** The authenticated user, or null when no usable credential arrived. */
  auth: UserRec | null;
  /** The request body, read once. */
  body: Buffer;
}

let requestCounter = 0;

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  requestCounter += 1;
  const requestId = `${(requestCounter * 7919).toString(16).toUpperCase().padStart(4, '0')}:FORGE:${Date.now().toString(16).toUpperCase()}`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4999',
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    ...headers,
  });
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function jsonBody(ctx: Ctx): Record<string, unknown> | null {
  if (ctx.body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(ctx.body.toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** True when a non-empty body is not JSON at all (GitHub answers 400). */
export function bodyMalformed(ctx: Ctx): boolean {
  if (ctx.body.length === 0) return false;
  try {
    JSON.parse(ctx.body.toString('utf8'));
    return false;
  } catch {
    return true;
  }
}

/** Slice a list by page/per_page and build the GitHub Link header set. */
export function pageSlice<T>(ctx: Ctx, items: T[]): { slice: T[]; headers: Record<string, string> } {
  const perPageRaw = Number.parseInt(ctx.url.searchParams.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const pageRaw = Number.parseInt(ctx.url.searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const base = `http://${ctx.req.headers.host ?? 'localhost'}${ctx.url.pathname}`;
  const link = (p: number, rel: string): string => `<${base}?page=${p}&per_page=${perPage}>; rel="${rel}"`;
  const parts: string[] = [];
  if (page < totalPages) parts.push(link(page + 1, 'next'));
  if (page > 1) parts.push(link(page - 1, 'prev'));
  parts.push(link(1, 'first'));
  parts.push(link(totalPages, 'last'));
  return { slice, headers: parts.length > 0 ? { link: parts.join(', ') } : {} };
}

function authenticate(req: IncomingMessage): UserRec | null {
  const header = req.headers.authorization;
  if (header === undefined) return null;
  if (/^Bearer\s+.+/i.test(header) || /^token\s+.+/i.test(header)) return forge.viewer();
  if (/^Basic\s+.+/i.test(header)) return forge.viewer();
  return null;
}

// ---------------------------------------------------------------- shapes

export function userJson(user: UserRec): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: `U_${user.id}`,
    avatar_url: `https://avatars.example.invalid/u/${user.id}`,
    gravatar_id: '',
    url: `/api/v3/users/${user.login}`,
    html_url: `https://forge.example/${user.login}`,
    type: user.type,
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  const owner = forge.user(repo.owner);
  const iso = (sec: number): string => new Date(sec * 1000).toISOString();
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(owner),
    private: repo.private,
    html_url: `https://forge.example/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: iso(repo.createdAt),
    updated_at: iso(repo.updatedAt),
    pushed_at: iso(repo.pushedAt),
    git_url: `git://forge.example/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@forge.example:${repo.owner}/${repo.name}.git`,
    clone_url: `https://forge.example/${repo.owner}/${repo.name}.git`,
    homepage: repo.homepage,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: forge.issuesOf(repo).filter((i) => i.state === 'open' && !i.isPull).length,
    license: null,
    allow_forking: true,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

// ---------------------------------------------------------------- routing

type Handler = (ctx: Ctx, params: Record<string, string>) => Promise<void> | void;

interface Route {
  method: string;
  pattern: string;
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, pattern: string, handler: Handler): void {
  routes.push({ method, pattern, handler });
}

function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/').filter((s) => s !== '');
  const got = path.split('/').filter((s) => s !== '');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i += 1) {
    const w = want[i] as string;
    const g = decodeURIComponent(got[i] as string);
    if (w.startsWith(':')) params[w.slice(1)] = g;
    else if (w !== g) return null;
  }
  return params;
}

// --- meta routes -----------------------------------------------------------

route('GET', '/healthz', (ctx) => {
  sendJson(ctx.res, 200, { ok: true });
});

route('GET', '/api/v3', (ctx) => {
  sendJson(
    ctx.res,
    200,
    {
      current_user_url: '/api/v3/user',
      current_user_repositories_url: '/api/v3/user/repos',
      organization_repositories_url: '/api/v3/orgs/{org}/repos',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
      rate_limit_url: '/api/v3/rate_limit',
    },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
});

route('GET', '/api/v3/rate_limit', (ctx) => {
  const limit = {
    limit: 5000,
    remaining: 5000,
    reset: Math.floor(Date.now() / 1000) + 3600,
    used: 0,
  };
  sendJson(ctx.res, 200, { resources: { core: limit, search: { ...limit, limit: 30 }, graphql: limit }, rate: limit });
});

// --- users -----------------------------------------------------------------

route('GET', '/api/v3/user', (ctx) => {
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  sendJson(ctx.res, 200, userJson(ctx.auth));
});

route('GET', '/api/v3/users/:login', (ctx, params) => {
  sendJson(ctx.res, 200, userJson(forge.user(params.login as string)));
});

route('GET', '/api/v3/user/repos', (ctx) => {
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  const mine = [...forge.repos.values()].filter((r) => r.owner.toLowerCase() === (ctx.auth as UserRec).login.toLowerCase());
  const { slice, headers } = pageSlice(ctx, mine);
  sendJson(ctx.res, 200, slice.map(repoJson), headers);
});

route('GET', '/api/v3/users/:login/repos', (ctx, params) => {
  const theirs = [...forge.repos.values()].filter(
    (r) => r.owner.toLowerCase() === (params.login as string).toLowerCase() && !r.private,
  );
  const { slice, headers } = pageSlice(ctx, theirs);
  sendJson(ctx.res, 200, slice.map(repoJson), headers);
});

route('GET', '/api/v3/meta', (ctx) => {
  sendJson(ctx.res, 200, {
    verifiable_password_authentication: true,
    ssh_key_fingerprints: { SHA256_RSA: 'forge-rsa-fingerprint', SHA256_ECDSA: 'forge-ecdsa-fingerprint' },
    ssh_keys: [],
    hooks: [],
    web: [],
    api: [],
    git: [],
    packages: [],
    pages: [],
    importer: [],
    actions: [],
    dependabot: [],
    installed_version: '1.0.0',
  });
});

// --- repositories ----------------------------------------------------------

route('POST', '/api/v3/user/repos', (ctx) => {
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  if (bodyMalformed(ctx)) return sendError(ctx.res, 400, 'Problems parsing JSON');
  const body = jsonBody(ctx);
  if (body === null || typeof body.name !== 'string' || body.name === '') {
    return sendError(ctx.res, 422, 'Repository creation failed: name is required');
  }
  const owner = ctx.auth.login;
  if (forge.repo(owner, body.name) !== undefined) {
    return sendError(ctx.res, 422, 'Repository creation failed: name already exists on this account');
  }
  const repo = forge.createRepo(owner, body.name, {
    description: typeof body.description === 'string' ? body.description : '',
    homepage: typeof body.homepage === 'string' ? body.homepage : '',
    private: body.private === true,
    defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : 'main',
  });
  sendJson(ctx.res, 201, repoJson(repo));
});

route('POST', '/api/v3/orgs/:org/repos', (ctx, params) => {
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  const body = jsonBody(ctx);
  if (body === null || typeof body.name !== 'string' || body.name === '') {
    return sendError(ctx.res, 422, 'Repository creation failed: name is required');
  }
  const owner = params.org as string;
  forge.user(owner).type = 'Organization';
  if (forge.repo(owner, body.name) !== undefined) {
    return sendError(ctx.res, 422, 'Repository creation failed: name already exists on this account');
  }
  const repo = forge.createRepo(owner, body.name, {
    description: typeof body.description === 'string' ? body.description : '',
    private: body.private === true,
    defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : 'main',
  });
  sendJson(ctx.res, 201, repoJson(repo));
});

route('GET', '/api/v3/repos/:owner/:repo', (ctx, params) => {
  const repo = forge.repo(params.owner as string, params.repo as string);
  if (repo === undefined) return sendError(ctx.res, 404, 'Not Found');
  if (repo.private && ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  sendJson(ctx.res, 200, repoJson(repo));
});

route('PATCH', '/api/v3/repos/:owner/:repo', (ctx, params) => {
  const repo = forge.repo(params.owner as string, params.repo as string);
  if (repo === undefined) return sendError(ctx.res, 404, 'Not Found');
  const body = jsonBody(ctx) ?? {};
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.homepage === 'string') repo.homepage = body.homepage;
  if (typeof body.private === 'boolean') repo.private = body.private;
  if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
  if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
    forge.repos.delete(`${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`);
    repo.name = body.name;
    forge.repos.set(`${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`, repo);
  }
  repo.updatedAt = Math.floor(Date.now() / 1000);
  sendJson(ctx.res, 200, repoJson(repo));
});

route('DELETE', '/api/v3/repos/:owner/:repo', (ctx, params) => {
  const repo = forge.repo(params.owner as string, params.repo as string);
  if (repo === undefined) return sendError(ctx.res, 404, 'Not Found');
  forge.repos.delete(`${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`);
  ctx.res.writeHead(204);
  ctx.res.end();
});

// --- git data, contents, branches, commits ---------------------------------
//
// These paths carry slashes inside their last segment (file paths, ref
// names, branch names), so they route by regex instead of segment pattern.

interface RegexRoute {
  method: string;
  regex: RegExp;
  handler: (ctx: Ctx, groups: Record<string, string>) => Promise<void> | void;
}

const regexRoutes: RegexRoute[] = [];

function regexRoute(method: string, regex: RegExp, handler: RegexRoute['handler']): void {
  regexRoutes.push({ method, regex, handler });
}

const REPO_CONTENTS = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents(?:\/(.*))?$/;
const REPO_GIT_REF = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs(?:\/(.*))?$/;
const REPO_BRANCH = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/;

function mustRepo(ctx: Ctx, owner: string, name: string): RepoRec | null {
  const repo = forge.repo(owner, name);
  if (repo === undefined) {
    sendError(ctx.res, 404, 'Not Found');
    return null;
  }
  return repo;
}

/** The commit a ref name (branch, tag or sha) resolves to, or null. */
export function resolveCommit(repo: RepoRec, ref: string | null): string | null {
  const name = ref ?? repo.defaultBranch;
  const byBranch = repo.refs.get(`refs/heads/${name}`);
  if (byBranch !== undefined) return derefCommit(byBranch);
  const byTag = repo.refs.get(`refs/tags/${name}`);
  if (byTag !== undefined) return derefCommit(byTag);
  const byRef = repo.refs.get(name);
  if (byRef !== undefined) return derefCommit(byRef);
  if (/^[0-9a-f]{40}$/i.test(name) && forge.objects.get(name)?.type === 'commit') return name;
  return null;
}

function derefCommit(id: string): string | null {
  let current = id;
  for (let i = 0; i < 10; i += 1) {
    const obj = forge.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      const target = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (target === null) return null;
      current = target[1] as string;
      continue;
    }
    return null;
  }
  return null;
}

function commitJson(repo: RepoRec, sha: string): Record<string, unknown> {
  const obj = forge.objects.get(sha);
  const commit = obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const person = (line: string): Record<string, unknown> => {
    const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (m === null) return { name: line, email: '', date: new Date(0).toISOString() };
    return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
  };
  return {
    sha,
    node_id: `C_${sha.slice(0, 12)}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
    html_url: `https://forge.example/${repo.owner}/${repo.name}/commit/${sha}`,
    commit: {
      author: person(commit?.author ?? ''),
      committer: person(commit?.committer ?? ''),
      message: commit?.message ?? '',
      tree: { sha: commit?.tree ?? '', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit?.tree ?? ''}` },
      comment_count: 0,
    },
    author: null,
    committer: null,
    parents: (commit?.parents ?? []).map((parent) => ({
      sha: parent,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${parent}`,
      html_url: `https://forge.example/${repo.owner}/${repo.name}/commit/${parent}`,
    })),
  };
}

/** Walk a tree by path segments; returns the entry found, or null. */
function walkTree(treeId: string, segments: string[]): { entry: TreeEntry; treeId: string } | null {
  let currentTree = treeId;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = forge.objects.get(currentTree);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) return { entry, treeId: currentTree };
    if (entry.mode !== '40000') return null;
    currentTree = entry.id;
  }
  return null;
}

/**
 * Return a new root tree id with `segments` set to `blobId` (or removed when
 * blobId is null), creating intermediate trees. `rootId` may be null (empty).
 */
function updateTree(rootId: string | null, segments: string[], blobId: string | null, mode = '100644'): string {
  const entries: TreeEntry[] =
    rootId !== null && forge.objects.get(rootId)?.type === 'tree' ? [...parseTree(forge.objects.get(rootId)?.data as Buffer)] : [];
  const head = segments[0] as string;
  const existingIndex = entries.findIndex((e) => e.name === head);
  if (segments.length === 1) {
    if (blobId === null) {
      if (existingIndex !== -1) entries.splice(existingIndex, 1);
    } else if (existingIndex !== -1) {
      entries[existingIndex] = { mode, name: head, id: blobId };
    } else {
      entries.push({ mode, name: head, id: blobId });
    }
  } else {
    const childRoot = existingIndex !== -1 && entries[existingIndex]?.mode === '40000' ? (entries[existingIndex] as TreeEntry).id : null;
    const newChild = updateTree(childRoot, segments.slice(1), blobId, mode);
    const childObj = forge.objects.get(newChild);
    const childEmpty = childObj !== undefined && childObj.type === 'tree' && parseTree(childObj.data).length === 0;
    if (childEmpty && existingIndex !== -1) entries.splice(existingIndex, 1);
    else if (existingIndex !== -1) entries[existingIndex] = { mode: '40000', name: head, id: newChild };
    else entries.push({ mode: '40000', name: head, id: newChild });
  }
  return forge.objects.put('tree', buildTree(entries));
}

/** Commit a new root tree on a branch as the viewer; returns the commit sha. */
function commitOnBranch(repo: RepoRec, branch: string, rootTree: string, message: string, parent: string | null): string {
  const viewer = forge.viewer();
  const now = Math.floor(Date.now() / 1000);
  const ident = identityLine(viewer.name, viewer.email, now);
  const sha = forge.objects.put('commit', buildCommit({
    tree: rootTree,
    parents: parent !== null ? [parent] : [],
    author: ident,
    committer: ident,
    message,
  }));
  repo.refs.set(`refs/heads/${branch}`, sha);
  repo.updatedAt = now;
  repo.pushedAt = now;
  return sha;
}

function contentEntryJson(repo: RepoRec, path: string, entry: TreeEntry): Record<string, unknown> {
  const isDir = entry.mode === '40000';
  const base = {
    name: entry.name,
    path,
    sha: entry.id,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://forge.example/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.id}`,
    download_url: isDir ? null : `https://forge.example/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
    type: isDir ? 'dir' : entry.mode === '120000' ? 'symlink' : 'file',
    _links: { self: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}` },
  };
  if (isDir) return { ...base, size: 0 };
  const obj = forge.objects.get(entry.id);
  return { ...base, size: obj?.data.length ?? 0 };
}

regexRoute('GET', REPO_CONTENTS, (ctx, g) => {
  const repo = mustRepo(ctx, g[1] as string, g[2] as string);
  if (repo === null) return;
  const path = (g[3] ?? '').replace(/^\/|\/$/g, '');
  const commitSha = resolveCommit(repo, ctx.url.searchParams.get('ref'));
  if (commitSha === null) {
    if (path === '') return sendJson(ctx.res, 200, []);
    return sendError(ctx.res, 404, 'Not Found');
  }
  const commit = parseCommit(forge.objects.get(commitSha)?.data as Buffer);
  if (path === '') {
    const entries = parseTree(forge.objects.get(commit.tree)?.data as Buffer);
    return sendJson(ctx.res, 200, entries.map((e) => contentEntryJson(repo, e.name, e)));
  }
  const found = walkTree(commit.tree, path.split('/'));
  if (found === null) return sendError(ctx.res, 404, 'Not Found');
  const { entry } = found;
  if (entry.mode === '40000') {
    const entries = parseTree(forge.objects.get(entry.id)?.data as Buffer);
    return sendJson(ctx.res, 200, entries.map((e) => contentEntryJson(repo, `${path}/${e.name}`, e)));
  }
  const obj = forge.objects.get(entry.id);
  const b64 = (obj?.data ?? Buffer.alloc(0)).toString('base64');
  const wrapped = b64.replace(/(.{60})/g, '$1\n');
  sendJson(ctx.res, 200, {
    ...contentEntryJson(repo, path, entry),
    encoding: 'base64',
    content: wrapped.endsWith('\n') || wrapped === '' ? wrapped : `${wrapped}\n`,
  });
});

regexRoute('PUT', REPO_CONTENTS, (ctx, g) => {
  const repo = mustRepo(ctx, g[1] as string, g[2] as string);
  if (repo === null) return;
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  const body = jsonBody(ctx);
  if (body === null || typeof body.message !== 'string' || typeof body.content !== 'string') {
    return sendError(ctx.res, 422, 'Invalid request: message and content are required');
  }
  const path = (g[3] ?? '').replace(/^\/|\/$/g, '');
  if (path === '') return sendError(ctx.res, 422, 'Invalid request: a file path is required');
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
  if (tip === null && repo.refs.size > 0) return sendError(ctx.res, 404, 'Branch not found');
  const tipCommit = tip !== null ? parseCommit(forge.objects.get(tip)?.data as Buffer) : null;
  const existing = tipCommit !== null ? walkTree(tipCommit.tree, path.split('/')) : null;
  const data = Buffer.from(body.content.replace(/\s+/g, ''), 'base64');
  const blobId = forge.objects.put('blob', data);
  if (existing !== null) {
    if (typeof body.sha !== 'string') return sendError(ctx.res, 422, 'Invalid request: sha is required when updating a file');
    if (body.sha !== existing.entry.id) return sendError(ctx.res, 409, `${path} does not match ${body.sha}`);
  }
  const newRoot = updateTree(tipCommit?.tree ?? null, path.split('/'), blobId, existing?.entry.mode ?? '100644');
  const commitSha = commitOnBranch(repo, branch, newRoot, body.message, tip);
  const entry: TreeEntry = { mode: existing?.entry.mode ?? '100644', name: path.split('/').pop() as string, id: blobId };
  const b64 = data.toString('base64').replace(/(.{60})/g, '$1\n');
  sendJson(ctx.res, existing !== null ? 200 : 201, {
    content: {
      ...contentEntryJson(repo, path, entry),
      encoding: 'base64',
      content: b64.endsWith('\n') || b64 === '' ? b64 : `${b64}\n`,
    },
    commit: commitJson(repo, commitSha),
  });
});

regexRoute('DELETE', REPO_CONTENTS, (ctx, g) => {
  const repo = mustRepo(ctx, g[1] as string, g[2] as string);
  if (repo === null) return;
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  const body = jsonBody(ctx);
  if (body === null || typeof body.message !== 'string' || typeof body.sha !== 'string') {
    return sendError(ctx.res, 422, 'Invalid request: message and sha are required');
  }
  const path = (g[3] ?? '').replace(/^\/|\/$/g, '');
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
  if (tip === null) return sendError(ctx.res, 404, 'Branch not found');
  const tipCommit = parseCommit(forge.objects.get(tip)?.data as Buffer);
  const existing = walkTree(tipCommit.tree, path.split('/'));
  if (existing === null) return sendError(ctx.res, 404, 'Not Found');
  if (body.sha !== existing.entry.id) return sendError(ctx.res, 409, `${path} does not match ${body.sha}`);
  const newRoot = updateTree(tipCommit.tree, path.split('/'), null);
  const commitSha = commitOnBranch(repo, branch, newRoot, body.message, tip);
  sendJson(ctx.res, 200, { content: null, commit: commitJson(repo, commitSha) });
});

// --- branches & commits ----------------------------------------------------

route('GET', '/api/v3/repos/:owner/:repo/branches', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  const branches = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, sha]) => ({
      name: ref.slice('refs/heads/'.length),
      commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
      protected: false,
    }));
  const { slice, headers } = pageSlice(ctx, branches);
  sendJson(ctx.res, 200, slice, headers);
});

regexRoute('GET', REPO_BRANCH, (ctx, g) => {
  const repo = mustRepo(ctx, g[1] as string, g[2] as string);
  if (repo === null) return;
  const name = decodeURIComponent(g[3] as string);
  const sha = repo.refs.get(`refs/heads/${name}`);
  if (sha === undefined) return sendError(ctx.res, 404, 'Branch not found');
  sendJson(ctx.res, 200, {
    name,
    commit: commitJson(repo, sha),
    protected: false,
    _links: { self: `/api/v3/repos/${repo.owner}/${repo.name}/branches/${name}` },
  });
});

route('GET', '/api/v3/repos/:owner/:repo/commits', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  const start = resolveCommit(repo, ctx.url.searchParams.get('sha'));
  if (start === null) return sendJson(ctx.res, 200, []);
  const commits: string[] = [];
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    commits.push(sha);
    const obj = forge.objects.get(sha);
    if (obj !== undefined && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
  }
  const { slice, headers } = pageSlice(ctx, commits);
  sendJson(ctx.res, 200, slice.map((sha) => commitJson(repo, sha)), headers);
});

route('GET', '/api/v3/repos/:owner/:repo/commits/:sha', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  const sha = params.sha as string;
  if (forge.objects.get(sha)?.type !== 'commit') return sendError(ctx.res, 404, 'Not Found');
  sendJson(ctx.res, 200, commitJson(repo, sha));
});

// --- git data (refs, blobs, trees, commits) --------------------------------

route('GET', '/api/v3/repos/:owner/:repo/git/refs', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  sendJson(ctx.res, 200, refListJson(repo, ''));
});

function refListJson(repo: RepoRec, prefix: string): Record<string, unknown>[] {
  return [...repo.refs.entries()]
    .filter(([ref]) => prefix === '' || ref === prefix || ref.startsWith(`${prefix}/`))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([ref, sha]) => {
      const obj = forge.objects.get(sha);
      return {
        ref,
        node_id: `REF_${ref}`,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${ref}`,
        object: { sha, type: obj?.type ?? 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${obj?.type ?? 'commit'}s/${sha}` },
      };
    });
}

regexRoute('GET', REPO_GIT_REF, (ctx, g) => {
  const repo = mustRepo(ctx, g[1] as string, g[2] as string);
  if (repo === null) return;
  const tail = decodeURIComponent(g[3] ?? '');
  const full = tail.startsWith('refs/') ? tail : `refs/${tail}`;
  const sha = repo.refs.get(full);
  if (sha !== undefined) {
    const obj = forge.objects.get(sha);
    return sendJson(ctx.res, 200, {
      ref: full,
      node_id: `REF_${full}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${full}`,
      object: { sha, type: obj?.type ?? 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${obj?.type ?? 'commit'}s/${sha}` },
    });
  }
  const list = refListJson(repo, full);
  if (list.length > 0) return sendJson(ctx.res, 200, list);
  sendError(ctx.res, 404, 'Not Found');
});

route('POST', '/api/v3/repos/:owner/:repo/git/refs', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  const body = jsonBody(ctx);
  if (body === null || typeof body.ref !== 'string' || typeof body.sha !== 'string') {
    return sendError(ctx.res, 422, 'Invalid request: ref and sha are required');
  }
  if (!forge.objects.has(body.sha)) return sendError(ctx.res, 422, 'Object does not exist');
  if (repo.refs.has(body.ref)) return sendError(ctx.res, 422, 'Reference already exists');
  repo.refs.set(body.ref, body.sha);
  const obj = forge.objects.get(body.sha);
  sendJson(ctx.res, 201, {
    ref: body.ref,
    node_id: `REF_${body.ref}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${body.ref}`,
    object: { sha: body.sha, type: obj?.type ?? 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${obj?.type ?? 'commit'}s/${body.sha}` },
  });
});

regexRoute('PATCH', REPO_GIT_REF, (ctx, g) => {
  const repo = mustRepo(ctx, g[1] as string, g[2] as string);
  if (repo === null) return;
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  const tail = decodeURIComponent(g[3] ?? '');
  const full = tail.startsWith('refs/') ? tail : `refs/${tail}`;
  const body = jsonBody(ctx);
  if (body === null || typeof body.sha !== 'string') return sendError(ctx.res, 422, 'Invalid request: sha is required');
  const current = repo.refs.get(full);
  if (current === undefined) return sendError(ctx.res, 404, 'Not Found');
  if (body.force !== true && full.startsWith('refs/heads/') && !forge.objects.isAncestor(current, body.sha)) {
    return sendError(ctx.res, 422, 'Update is not a fast-forward');
  }
  repo.refs.set(full, body.sha);
  const obj = forge.objects.get(body.sha);
  sendJson(ctx.res, 200, {
    ref: full,
    node_id: `REF_${full}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${full}`,
    object: { sha: body.sha, type: obj?.type ?? 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${obj?.type ?? 'commit'}s/${body.sha}` },
  });
});

regexRoute('DELETE', REPO_GIT_REF, (ctx, g) => {
  const repo = mustRepo(ctx, g[1] as string, g[2] as string);
  if (repo === null) return;
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  const tail = decodeURIComponent(g[3] ?? '');
  const full = tail.startsWith('refs/') ? tail : `refs/${tail}`;
  if (!repo.refs.has(full)) return sendError(ctx.res, 404, 'Not Found');
  repo.refs.delete(full);
  ctx.res.writeHead(204);
  ctx.res.end();
});

route('GET', '/api/v3/repos/:owner/:repo/git/commits/:sha', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  const sha = params.sha as string;
  const obj = forge.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return sendError(ctx.res, 404, 'Not Found');
  const commit = parseCommit(obj.data);
  const person = (line: string): Record<string, unknown> => {
    const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (m === null) return { name: line, email: '', date: new Date(0).toISOString() };
    return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
  };
  sendJson(ctx.res, 200, {
    sha,
    node_id: `C_${sha.slice(0, 12)}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
    author: person(commit.author),
    committer: person(commit.committer),
    message: commit.message,
    tree: { sha: commit.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
    parents: commit.parents.map((parent) => ({ sha: parent, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${parent}` })),
  });
});

route('POST', '/api/v3/repos/:owner/:repo/git/commits', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  const body = jsonBody(ctx);
  if (body === null || typeof body.message !== 'string' || typeof body.tree !== 'string') {
    return sendError(ctx.res, 422, 'Invalid request: message and tree are required');
  }
  const viewer = forge.viewer();
  const now = Math.floor(Date.now() / 1000);
  const authorObj = (body.author ?? {}) as Record<string, unknown>;
  const name = typeof authorObj.name === 'string' ? authorObj.name : viewer.name;
  const email = typeof authorObj.email === 'string' ? authorObj.email : viewer.email;
  const ident = identityLine(name, email, now);
  const parents = Array.isArray(body.parents) ? body.parents.filter((p): p is string => typeof p === 'string') : [];
  const sha = forge.objects.put('commit', buildCommit({ tree: body.tree, parents, author: ident, committer: ident, message: body.message }));
  sendJson(ctx.res, 201, {
    sha,
    node_id: `C_${sha.slice(0, 12)}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
    author: { name, email, date: new Date(now * 1000).toISOString() },
    committer: { name, email, date: new Date(now * 1000).toISOString() },
    message: body.message,
    tree: { sha: body.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${body.tree}` },
    parents: parents.map((parent) => ({ sha: parent, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${parent}` })),
  });
});

route('GET', '/api/v3/repos/:owner/:repo/git/trees/:sha', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  const sha = params.sha as string;
  const obj = forge.objects.get(sha);
  if (obj === undefined || obj.type !== 'tree') return sendError(ctx.res, 404, 'Not Found');
  const recursive = ctx.url.searchParams.get('recursive') === '1';
  const out: Record<string, unknown>[] = [];
  const walk = (treeId: string, prefix: string): void => {
    const treeObj = forge.objects.get(treeId);
    if (treeObj === undefined || treeObj.type !== 'tree') return;
    for (const entry of parseTree(treeObj.data)) {
      const entryObj = forge.objects.get(entry.id);
      out.push({
        path: prefix + entry.name,
        mode: entry.mode,
        type: entry.mode === '40000' ? 'tree' : entryObj?.type === 'commit' ? 'commit' : 'blob',
        sha: entry.id,
        size: entry.mode === '40000' ? undefined : (entryObj?.data.length ?? 0),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${entry.mode === '40000' ? 'trees' : 'blobs'}/${entry.id}`,
      });
      if (recursive && entry.mode === '40000') walk(entry.id, `${prefix}${entry.name}/`);
    }
  };
  walk(sha, '');
  sendJson(ctx.res, 200, { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${sha}`, tree: out, truncated: false });
});

route('POST', '/api/v3/repos/:owner/:repo/git/trees', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  const body = jsonBody(ctx);
  if (body === null || !Array.isArray(body.tree)) return sendError(ctx.res, 422, 'Invalid request: tree is required');
  let root = typeof body.base_tree === 'string' ? body.base_tree : null;
  for (const item of body.tree as Array<Record<string, unknown>>) {
    if (typeof item.path !== 'string') continue;
    if (item.type === 'tree') continue;
    let blobId: string | null = null;
    if (typeof item.sha === 'string') blobId = item.sha;
    else if (typeof item.content === 'string') blobId = forge.objects.put('blob', Buffer.from(item.content, 'utf8'));
    if (blobId === null && item.content !== null) continue;
    root = updateTree(root, item.path.split('/'), blobId, typeof item.mode === 'string' ? item.mode : '100644');
  }
  if (root === null) root = forge.objects.put('tree', buildTree([]));
  sendJson(ctx.res, 201, { sha: root, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${root}` });
});

route('GET', '/api/v3/repos/:owner/:repo/git/blobs/:sha', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  const sha = params.sha as string;
  const obj = forge.objects.get(sha);
  if (obj === undefined || obj.type !== 'blob') return sendError(ctx.res, 404, 'Not Found');
  sendJson(ctx.res, 200, {
    sha,
    node_id: `B_${sha.slice(0, 12)}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${sha}`,
    size: obj.data.length,
    content: obj.data.toString('base64').replace(/(.{60})/g, '$1\n'),
    encoding: 'base64',
  });
});

route('POST', '/api/v3/repos/:owner/:repo/git/blobs', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  const body = jsonBody(ctx);
  if (body === null || typeof body.content !== 'string') return sendError(ctx.res, 422, 'Invalid request: content is required');
  const data = body.encoding === 'base64' ? Buffer.from(body.content.replace(/\s+/g, ''), 'base64') : Buffer.from(body.content, 'utf8');
  const sha = forge.objects.put('blob', data);
  sendJson(ctx.res, 201, { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${sha}` });
});

route('GET', '/api/v3/repos/:owner/:repo/tags', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  const tags = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/tags/'))
    .map(([ref, sha]) => ({
      name: ref.slice('refs/tags/'.length),
      commit: { sha: derefCommit(sha) ?? sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${derefCommit(sha) ?? sha}` },
      zipball_url: '',
      tarball_url: '',
      node_id: `T_${ref}`,
    }));
  const { slice, headers } = pageSlice(ctx, tags);
  sendJson(ctx.res, 200, slice, headers);
});

// --- labels, issues, comments ----------------------------------------------

import type { CommentRec, IssueRec, LabelRec } from './store.ts';

function labelJson(repo: RepoRec, label: LabelRec): Record<string, unknown> {
  return {
    id: [...label.name].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) + repo.id,
    node_id: `LA_${repo.id}_${label.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

route('GET', '/api/v3/repos/:owner/:repo/labels', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  const labels = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  const { slice, headers } = pageSlice(ctx, labels);
  sendJson(ctx.res, 200, slice.map((l) => labelJson(repo, l)), headers);
});

route('POST', '/api/v3/repos/:owner/:repo/labels', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  const body = jsonBody(ctx);
  if (body === null || typeof body.name !== 'string' || body.name === '') {
    return sendError(ctx.res, 422, 'Invalid request: name is required');
  }
  if (repo.labels.has(body.name.toLowerCase())) {
    return sendError(ctx.res, 422, 'Validation Failed: label already exists');
  }
  const label: LabelRec = {
    name: body.name,
    color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
    description: typeof body.description === 'string' ? body.description : '',
  };
  repo.labels.set(label.name.toLowerCase(), label);
  sendJson(ctx.res, 201, labelJson(repo, label));
});

const REPO_LABEL = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels\/(.+)$/;

regexRoute('GET', REPO_LABEL, (ctx, g) => {
  const repo = mustRepo(ctx, g[1] as string, g[2] as string);
  if (repo === null) return;
  const label = repo.labels.get(decodeURIComponent(g[3] as string).toLowerCase());
  if (label === undefined) return sendError(ctx.res, 404, 'Not Found');
  sendJson(ctx.res, 200, labelJson(repo, label));
});

regexRoute('PATCH', REPO_LABEL, (ctx, g) => {
  const repo = mustRepo(ctx, g[1] as string, g[2] as string);
  if (repo === null) return;
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  const key = decodeURIComponent(g[3] as string).toLowerCase();
  const label = repo.labels.get(key);
  if (label === undefined) return sendError(ctx.res, 404, 'Not Found');
  const body = jsonBody(ctx) ?? {};
  if (typeof body.new_name === 'string' && body.new_name !== '') {
    repo.labels.delete(key);
    label.name = body.new_name;
    repo.labels.set(label.name.toLowerCase(), label);
  }
  if (typeof body.color === 'string') label.color = body.color.replace(/^#/, '');
  if (typeof body.description === 'string') label.description = body.description;
  sendJson(ctx.res, 200, labelJson(repo, label));
});

regexRoute('DELETE', REPO_LABEL, (ctx, g) => {
  const repo = mustRepo(ctx, g[1] as string, g[2] as string);
  if (repo === null) return;
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  const key = decodeURIComponent(g[3] as string).toLowerCase();
  if (!repo.labels.has(key)) return sendError(ctx.res, 404, 'Not Found');
  repo.labels.delete(key);
  ctx.res.writeHead(204);
  ctx.res.end();
});

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const iso = (sec: number | null): string | null => (sec === null ? null : new Date(sec * 1000).toISOString());
  const labels = issue.labels
    .map((name) => repo.labels.get(name.toLowerCase()))
    .filter((l): l is LabelRec => l !== undefined)
    .map((l) => labelJson(repo, l));
  const base: Record<string, unknown> = {
    id: issue.id,
    node_id: `I_${issue.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://forge.example/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(forge.user(issue.userLogin)),
    labels,
    assignee: issue.assignees.length > 0 ? userJson(forge.user(issue.assignees[0] as string)) : null,
    assignees: issue.assignees.map((login) => userJson(forge.user(login))),
    comments: forge.commentsOf(issue).length,
    created_at: iso(issue.createdAt),
    updated_at: iso(issue.updatedAt),
    closed_at: iso(issue.closedAt),
    author_association: 'OWNER',
  };
  if (issue.isPull) {
    base.pull_request = {
      url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${issue.number}`,
      html_url: `https://forge.example/${repo.owner}/${repo.name}/pull/${issue.number}`,
      diff_url: `https://forge.example/${repo.owner}/${repo.name}/pull/${issue.number}.diff`,
      patch_url: `https://forge.example/${repo.owner}/${repo.name}/pull/${issue.number}.patch`,
    };
  }
  return base;
}

/** Validate label names against the repo's labels; returns an error string or null. */
function labelError(repo: RepoRec, names: string[]): string | null {
  for (const name of names) {
    if (!repo.labels.has(name.toLowerCase())) return `Label "${name}" does not exist`;
  }
  return null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

route('POST', '/api/v3/repos/:owner/:repo/issues', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  const body = jsonBody(ctx);
  if (body === null || typeof body.title !== 'string' || body.title === '') {
    return sendError(ctx.res, 422, 'Invalid request: title is required');
  }
  const labels = stringArray(body.labels);
  const bad = labelError(repo, labels);
  if (bad !== null) return sendError(ctx.res, 422, bad);
  const issue = forge.createIssue(repo, {
    title: body.title,
    body: typeof body.body === 'string' ? body.body : '',
    userLogin: ctx.auth.login,
    labels,
    assignees: stringArray(body.assignees),
    isPull: false,
  });
  sendJson(ctx.res, 201, issueJson(repo, issue));
});

route('GET', '/api/v3/repos/:owner/:repo/issues', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  const state = ctx.url.searchParams.get('state') ?? 'open';
  let list = forge.issuesOf(repo);
  if (state === 'open') list = list.filter((i) => i.state === 'open');
  else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
  const labelFilter = ctx.url.searchParams.get('labels');
  if (labelFilter !== null && labelFilter !== '') {
    const wanted = labelFilter.split(',').map((s) => s.toLowerCase());
    list = list.filter((i) => wanted.every((w) => i.labels.some((l) => l.toLowerCase() === w)));
  }
  const direction = ctx.url.searchParams.get('direction') ?? 'desc';
  list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const { slice, headers } = pageSlice(ctx, list);
  sendJson(ctx.res, 200, slice.map((i) => issueJson(repo, i)), headers);
});

route('GET', '/api/v3/repos/:owner/:repo/issues/:number', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  const issue = forge.issueByNumber(repo, Number(params.number));
  if (issue === undefined) return sendError(ctx.res, 404, 'Not Found');
  sendJson(ctx.res, 200, issueJson(repo, issue));
});

route('PATCH', '/api/v3/repos/:owner/:repo/issues/:number', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  const issue = forge.issueByNumber(repo, Number(params.number));
  if (issue === undefined) return sendError(ctx.res, 404, 'Not Found');
  const body = jsonBody(ctx) ?? {};
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (Array.isArray(body.labels)) {
    const labels = stringArray(body.labels);
    const bad = labelError(repo, labels);
    if (bad !== null) return sendError(ctx.res, 422, bad);
    issue.labels = labels;
  }
  if (Array.isArray(body.assignees)) issue.assignees = stringArray(body.assignees);
  if (body.state === 'closed' || body.state === 'open') {
    issue.state = body.state;
    issue.closedAt = body.state === 'closed' ? Math.floor(Date.now() / 1000) : null;
  }
  issue.updatedAt = Math.floor(Date.now() / 1000);
  sendJson(ctx.res, 200, issueJson(repo, issue));
});

function commentJson(repo: RepoRec, comment: CommentRec): Record<string, unknown> {
  const issue = forge.issues.get(comment.issueId);
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://forge.example/${repo.owner}/${repo.name}/issues/${issue?.number ?? 0}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(forge.user(comment.userLogin)),
    created_at: new Date(comment.createdAt * 1000).toISOString(),
    updated_at: new Date(comment.updatedAt * 1000).toISOString(),
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue?.number ?? 0}`,
    author_association: 'OWNER',
  };
}

route('POST', '/api/v3/repos/:owner/:repo/issues/:number/comments', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  const issue = forge.issueByNumber(repo, Number(params.number));
  if (issue === undefined) return sendError(ctx.res, 404, 'Not Found');
  const body = jsonBody(ctx);
  if (body === null || typeof body.body !== 'string' || body.body === '') {
    return sendError(ctx.res, 422, 'Invalid request: body is required');
  }
  const comment = forge.createComment(issue, ctx.auth.login, body.body);
  sendJson(ctx.res, 201, commentJson(repo, comment));
});

route('GET', '/api/v3/repos/:owner/:repo/issues/:number/comments', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  const issue = forge.issueByNumber(repo, Number(params.number));
  if (issue === undefined) return sendError(ctx.res, 404, 'Not Found');
  const comments = forge.commentsOf(issue);
  const { slice, headers } = pageSlice(ctx, comments);
  sendJson(ctx.res, 200, slice.map((c) => commentJson(repo, c)), headers);
});

route('GET', '/api/v3/repos/:owner/:repo/issues/comments/:id', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  const comment = forge.comments.get(Number(params.id));
  if (comment === undefined) return sendError(ctx.res, 404, 'Not Found');
  sendJson(ctx.res, 200, commentJson(repo, comment));
});

route('PATCH', '/api/v3/repos/:owner/:repo/issues/comments/:id', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  const comment = forge.comments.get(Number(params.id));
  if (comment === undefined) return sendError(ctx.res, 404, 'Not Found');
  const body = jsonBody(ctx) ?? {};
  if (typeof body.body === 'string') comment.body = body.body;
  comment.updatedAt = Math.floor(Date.now() / 1000);
  sendJson(ctx.res, 200, commentJson(repo, comment));
});

route('DELETE', '/api/v3/repos/:owner/:repo/issues/comments/:id', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  if (!forge.comments.has(Number(params.id))) return sendError(ctx.res, 404, 'Not Found');
  forge.comments.delete(Number(params.id));
  ctx.res.writeHead(204);
  ctx.res.end();
});

// --- pull requests ---------------------------------------------------------

import type { PullRec } from './store.ts';

/** Flatten a tree into path -> {id, mode}; the shape merges and diffs want. */
export function flattenTree(treeId: string, prefix = ''): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const obj = forge.objects.get(treeId);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000') {
      for (const [path, sub] of flattenTree(entry.id, `${prefix}${entry.name}/`)) out.set(path, sub);
    } else {
      out.set(prefix + entry.name, entry);
    }
  }
  return out;
}

/** Rebuild a root tree id from a flattened path map. */
export function rebuildTree(files: Map<string, TreeEntry>): string {
  let root: string | null = null;
  for (const [path, entry] of files) {
    root = updateTree(root, path.split('/'), entry.id, entry.mode);
  }
  return root ?? forge.objects.put('tree', buildTree([]));
}

/** The best common ancestor of two commits, or null. */
export function mergeBase(a: string, b: string): string | null {
  const ancestorsOf = (tip: string): Map<string, number> => {
    const dist = new Map<string, number>();
    const queue: Array<[string, number]> = [[tip, 0]];
    while (queue.length > 0) {
      const [sha, d] = queue.shift() as [string, number];
      if (dist.has(sha)) continue;
      dist.set(sha, d);
      const obj = forge.objects.get(sha);
      if (obj !== undefined && obj.type === 'commit') {
        for (const parent of parseCommit(obj.data).parents) queue.push([parent, d + 1]);
      }
    }
    return dist;
  };
  const fromA = ancestorsOf(a);
  const fromB = ancestorsOf(b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [sha, d] of fromA) {
    const other = fromB.get(sha);
    if (other !== undefined && d + other < bestScore) {
      bestScore = d + other;
      best = sha;
    }
  }
  return best;
}

interface TreeMerge {
  tree: string | null;
  conflicts: string[];
}

/** Three-way merge of flattened trees; null tree when conflicts exist. */
function mergeTrees(baseTipTree: string, headTree: string, ancestorTree: string): TreeMerge {
  const base = flattenTree(baseTipTree);
  const head = flattenTree(headTree);
  const ancestor = flattenTree(ancestorTree);
  const paths = new Set([...base.keys(), ...head.keys(), ...ancestor.keys()]);
  const out = new Map<string, TreeEntry>();
  const conflicts: string[] = [];
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    const a = ancestor.get(path);
    const sameId = (x?: TreeEntry, y?: TreeEntry): boolean => x?.id === y?.id && x?.mode === y?.mode;
    if (sameId(h, a)) {
      if (b !== undefined) out.set(path, b); // only base moved (or neither)
    } else if (sameId(b, a)) {
      if (h !== undefined) out.set(path, h); // only head moved
    } else if (sameId(b, h)) {
      if (b !== undefined) out.set(path, b); // both moved the same way
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length > 0) return { tree: null, conflicts };
  return { tree: rebuildTree(out), conflicts };
}

/** Line-level diff counts and a unified patch for two text blobs. */
function diffLines(oldText: string, newText: string): { additions: number; deletions: number; patch: string } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // LCS over lines (files here are small).
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? (dp[i + 1][j + 1] as number) + 1 : Math.max(dp[i + 1][j] as number, dp[i][j + 1] as number);
    }
  }
  const ops: Array<{ tag: ' ' | '-' | '+'; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ tag: ' ', line: a[i] as string });
      i += 1;
      j += 1;
    } else if ((dp[i + 1][j] as number) >= (dp[i][j + 1] as number)) {
      ops.push({ tag: '-', line: a[i] as string });
      i += 1;
    } else {
      ops.push({ tag: '+', line: b[j] as string });
      j += 1;
    }
  }
  while (i < m) {
    ops.push({ tag: '-', line: a[i] as string });
    i += 1;
  }
  while (j < n) {
    ops.push({ tag: '+', line: b[j] as string });
    j += 1;
  }
  const additions = ops.filter((o) => o.tag === '+').length;
  const deletions = ops.filter((o) => o.tag === '-').length;
  const patch = ops.map((o) => `${o.tag}${o.line}`).join('\n');
  return { additions, deletions, patch };
}

interface PullSides {
  pull: PullRec;
  issue: IssueRec;
  headRepo: RepoRec;
  baseRepo: RepoRec;
  headSha: string | null;
  baseSha: string | null;
}

function pullSides(repo: RepoRec, issue: IssueRec): PullSides | null {
  const pull = forge.pulls.get(issue.id);
  if (pull === undefined) return null;
  const headRepo = forge.repos.get(pull.headRepoKey) ?? repo;
  const baseRepo = forge.repos.get(pull.baseRepoKey) ?? repo;
  return {
    pull,
    issue,
    headRepo,
    baseRepo,
    headSha: headRepo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha,
    baseSha: baseRepo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha,
  };
}

/** Mergeability + the merged tree, recomputed from current tips. */
function pullMergeState(sides: PullSides): { mergeable: boolean; tree: string | null; base: string | null } {
  if (sides.headSha === null || sides.baseSha === null) return { mergeable: false, tree: null, base: null };
  const base = mergeBase(sides.baseSha, sides.headSha);
  if (base === null) return { mergeable: false, tree: null, base: null };
  const treeOf = (sha: string): string => parseCommit(forge.objects.get(sha)?.data as Buffer).tree;
  const merged = mergeTrees(treeOf(sides.baseSha), treeOf(sides.headSha), treeOf(base));
  return { mergeable: merged.tree !== null, tree: merged.tree, base };
}

function pullJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const sides = pullSides(repo, issue);
  if (sides === null) return issueJson(repo, issue);
  const { pull } = sides;
  const state = pullMergeState(sides);
  const refJson = (r: RepoRec, ref: string, sha: string | null): Record<string, unknown> => ({
    label: `${r.owner}:${ref}`,
    ref,
    sha,
    user: userJson(forge.user(r.owner)),
    repo: repoJson(r),
  });
  // Diff stats against the merge base.
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;
  let commitCount = 0;
  if (sides.headSha !== null && state.base !== null) {
    const baseTree = parseCommit(forge.objects.get(state.base)?.data as Buffer).tree;
    const headTree = parseCommit(forge.objects.get(sides.headSha)?.data as Buffer).tree;
    const before = flattenTree(baseTree);
    const after = flattenTree(headTree);
    const paths = new Set([...before.keys(), ...after.keys()]);
    for (const path of paths) {
      const b = before.get(path);
      const h = after.get(path);
      if (b?.id === h?.id) continue;
      changedFiles += 1;
      const oldText = b !== undefined ? (forge.objects.get(b.id)?.data.toString('utf8') ?? '') : '';
      const newText = h !== undefined ? (forge.objects.get(h.id)?.data.toString('utf8') ?? '') : '';
      const d = diffLines(oldText, newText);
      additions += d.additions;
      deletions += d.deletions;
    }
    const seen = new Set<string>();
    const queue = [sides.headSha];
    const baseAncestors = new Set<string>();
    const stack = [state.base];
    while (stack.length > 0) {
      const s = stack.pop() as string;
      if (baseAncestors.has(s)) continue;
      baseAncestors.add(s);
      const o = forge.objects.get(s);
      if (o !== undefined && o.type === 'commit') stack.push(...parseCommit(o.data).parents);
    }
    while (queue.length > 0) {
      const s = queue.shift() as string;
      if (seen.has(s) || baseAncestors.has(s)) continue;
      seen.add(s);
      commitCount += 1;
      const o = forge.objects.get(s);
      if (o !== undefined && o.type === 'commit') queue.push(...parseCommit(o.data).parents);
    }
  }
  return {
    ...issueJson(repo, issue),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${issue.number}`,
    html_url: `https://forge.example/${repo.owner}/${repo.name}/pull/${issue.number}`,
    diff_url: `https://forge.example/${repo.owner}/${repo.name}/pull/${issue.number}.diff`,
    patch_url: `https://forge.example/${repo.owner}/${repo.name}/pull/${issue.number}.patch`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    merged_at: pull.mergedAt !== null ? new Date(pull.mergedAt * 1000).toISOString() : null,
    merge_commit_sha: pull.mergeCommitSha,
    draft: pull.draft,
    head: refJson(sides.headRepo, pull.headRef, sides.headSha),
    base: refJson(sides.baseRepo, pull.baseRef, sides.baseSha),
    _links: {
      self: { href: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${issue.number}` },
      html: { href: `https://forge.example/${repo.owner}/${repo.name}/pull/${issue.number}` },
      issue: { href: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}` },
      comments: { href: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments` },
      commits: { href: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${issue.number}/commits` },
    },
    merged: pull.merged,
    mergeable: pull.merged ? true : state.mergeable,
    mergeable_state: pull.merged ? 'clean' : state.mergeable ? 'clean' : 'dirty',
    comments: forge.commentsOf(issue).length,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: commitCount,
    additions,
    deletions,
    changed_files: changedFiles,
  };
}

route('POST', '/api/v3/repos/:owner/:repo/pulls', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  const body = jsonBody(ctx);
  if (body === null || typeof body.head !== 'string' || typeof body.base !== 'string') {
    return sendError(ctx.res, 422, 'Invalid request: head and base are required');
  }
  const parseSide = (raw: string, fallbackRepo: RepoRec): { repo: RepoRec; ref: string } => {
    const colon = raw.indexOf(':');
    if (colon === -1) return { repo: fallbackRepo, ref: raw };
    const ownerPart = raw.slice(0, colon);
    const ref = raw.slice(colon + 1);
    const other = forge.repo(ownerPart, fallbackRepo.name);
    return { repo: other ?? fallbackRepo, ref };
  };
  const headSide = parseSide(body.head, repo);
  const baseSide = parseSide(body.base, repo);
  const headSha = headSide.repo.refs.get(`refs/heads/${headSide.ref}`);
  if (headSha === undefined) return sendError(ctx.res, 422, `Head branch "${headSide.ref}" does not exist`);
  const baseSha = baseSide.repo.refs.get(`refs/heads/${baseSide.ref}`);
  if (baseSha === undefined) return sendError(ctx.res, 422, `Base branch "${baseSide.ref}" does not exist`);
  if (headSide.repo === baseSide.repo && headSide.ref === baseSide.ref) {
    return sendError(ctx.res, 422, `No commits between ${baseSide.ref} and ${headSide.ref}`);
  }
  if (forge.objects.isAncestor(headSha, baseSha)) {
    return sendError(ctx.res, 422, `No commits between ${baseSide.ref} and ${headSide.ref}`);
  }
  for (const existing of forge.issuesOf(repo)) {
    if (!existing.isPull || existing.state !== 'open') continue;
    const sides = pullSides(repo, existing);
    if (sides !== null && sides.pull.headRef === headSide.ref && sides.pull.baseRef === baseSide.ref) {
      return sendError(ctx.res, 422, `A pull request already exists for ${headSide.ref} into ${baseSide.ref}`);
    }
  }
  const title = typeof body.title === 'string' ? body.title : '';
  const issueNumberRef = typeof body.issue === 'number' ? body.issue : null;
  let issue: IssueRec;
  if (issueNumberRef !== null) {
    const found = forge.issueByNumber(repo, issueNumberRef);
    if (found === undefined || found.isPull) return sendError(ctx.res, 422, 'Issue not found');
    issue = found;
    issue.isPull = true;
    if (title !== '') issue.title = title;
  } else {
    if (title === '') return sendError(ctx.res, 422, 'Invalid request: title is required');
    issue = forge.createIssue(repo, {
      title,
      body: typeof body.body === 'string' ? body.body : '',
      userLogin: ctx.auth.login,
      labels: [],
      assignees: [],
      isPull: true,
    });
  }
  const pull: PullRec = {
    issueId: issue.id,
    headRepoKey: repoKey(headSide.repo.owner, headSide.repo.name),
    headRef: headSide.ref,
    headSha,
    baseRepoKey: repoKey(baseSide.repo.owner, baseSide.repo.name),
    baseRef: baseSide.ref,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    draft: body.draft === true,
  };
  forge.pulls.set(issue.id, pull);
  sendJson(ctx.res, 201, pullJson(repo, issue));
});

route('GET', '/api/v3/repos/:owner/:repo/pulls', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  const state = ctx.url.searchParams.get('state') ?? 'open';
  let list = forge.issuesOf(repo).filter((i) => i.isPull);
  if (state === 'open') list = list.filter((i) => i.state === 'open');
  else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
  const headFilter = ctx.url.searchParams.get('head');
  if (headFilter !== null) {
    list = list.filter((i) => {
      const sides = pullSides(repo, i);
      return sides !== null && `${sides.headRepo.owner}:${sides.pull.headRef}` === headFilter;
    });
  }
  const baseFilter = ctx.url.searchParams.get('base');
  if (baseFilter !== null) {
    list = list.filter((i) => pullSides(repo, i)?.pull.baseRef === baseFilter);
  }
  list.sort((a, b) => b.number - a.number);
  const { slice, headers } = pageSlice(ctx, list);
  sendJson(ctx.res, 200, slice.map((i) => pullJson(repo, i)), headers);
});

route('GET', '/api/v3/repos/:owner/:repo/pulls/:number', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  const issue = forge.issueByNumber(repo, Number(params.number));
  if (issue === undefined || !issue.isPull) return sendError(ctx.res, 404, 'Not Found');
  sendJson(ctx.res, 200, pullJson(repo, issue));
});

route('PATCH', '/api/v3/repos/:owner/:repo/pulls/:number', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  const issue = forge.issueByNumber(repo, Number(params.number));
  if (issue === undefined || !issue.isPull) return sendError(ctx.res, 404, 'Not Found');
  const body = jsonBody(ctx) ?? {};
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'closed' || body.state === 'open') {
    issue.state = body.state;
    issue.closedAt = body.state === 'closed' ? Math.floor(Date.now() / 1000) : null;
  }
  if (typeof body.base === 'string') {
    const pull = forge.pulls.get(issue.id);
    if (pull !== undefined) {
      pull.baseRef = body.base;
      pull.baseSha = repo.refs.get(`refs/heads/${body.base}`) ?? pull.baseSha;
    }
  }
  issue.updatedAt = Math.floor(Date.now() / 1000);
  sendJson(ctx.res, 200, pullJson(repo, issue));
});

route('GET', '/api/v3/repos/:owner/:repo/pulls/:number/commits', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  const issue = forge.issueByNumber(repo, Number(params.number));
  if (issue === undefined || !issue.isPull) return sendError(ctx.res, 404, 'Not Found');
  const sides = pullSides(repo, issue);
  if (sides === null || sides.headSha === null || sides.baseSha === null) return sendJson(ctx.res, 200, []);
  const base = mergeBase(sides.baseSha, sides.headSha) ?? sides.baseSha;
  const baseAncestors = new Set<string>();
  const stack = [base];
  while (stack.length > 0) {
    const s = stack.pop() as string;
    if (baseAncestors.has(s)) continue;
    baseAncestors.add(s);
    const o = forge.objects.get(s);
    if (o !== undefined && o.type === 'commit') stack.push(...parseCommit(o.data).parents);
  }
  const commits: string[] = [];
  const seen = new Set<string>();
  const queue = [sides.headSha];
  while (queue.length > 0) {
    const s = queue.shift() as string;
    if (seen.has(s) || baseAncestors.has(s)) continue;
    seen.add(s);
    commits.push(s);
    const o = forge.objects.get(s);
    if (o !== undefined && o.type === 'commit') queue.push(...parseCommit(o.data).parents);
  }
  const { slice, headers } = pageSlice(ctx, commits);
  sendJson(ctx.res, 200, slice.map((sha) => commitJson(repo, sha)), headers);
});

route('GET', '/api/v3/repos/:owner/:repo/pulls/:number/files', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  const issue = forge.issueByNumber(repo, Number(params.number));
  if (issue === undefined || !issue.isPull) return sendError(ctx.res, 404, 'Not Found');
  const sides = pullSides(repo, issue);
  if (sides === null || sides.headSha === null || sides.baseSha === null) return sendJson(ctx.res, 200, []);
  const base = mergeBase(sides.baseSha, sides.headSha) ?? sides.baseSha;
  const treeOf = (sha: string): string => parseCommit(forge.objects.get(sha)?.data as Buffer).tree;
  const before = flattenTree(treeOf(base));
  const after = flattenTree(treeOf(sides.headSha));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const files: Record<string, unknown>[] = [];
  for (const path of paths) {
    const b = before.get(path);
    const h = after.get(path);
    if (b?.id === h?.id && b?.mode === h?.mode) continue;
    const oldText = b !== undefined ? (forge.objects.get(b.id)?.data.toString('utf8') ?? '') : '';
    const newText = h !== undefined ? (forge.objects.get(h.id)?.data.toString('utf8') ?? '') : '';
    const d = diffLines(oldText, newText);
    files.push({
      sha: h?.id ?? b?.id ?? '',
      filename: path,
      status: b === undefined ? 'added' : h === undefined ? 'removed' : 'modified',
      additions: d.additions,
      deletions: d.deletions,
      changes: d.additions + d.deletions,
      blob_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${h?.id ?? b?.id ?? ''}`,
      raw_url: `https://forge.example/${repo.owner}/${repo.name}/raw/${sides.pull.headRef}/${path}`,
      contents_url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${sides.pull.headRef}`,
      patch: `--- a/${path}\n+++ b/${path}\n${d.patch}`,
    });
  }
  const { slice, headers } = pageSlice(ctx, files);
  sendJson(ctx.res, 200, slice, headers);
});

route('GET', '/api/v3/repos/:owner/:repo/pulls/:number/merge', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  const issue = forge.issueByNumber(repo, Number(params.number));
  if (issue === undefined || !issue.isPull) return sendError(ctx.res, 404, 'Not Found');
  const pull = forge.pulls.get(issue.id);
  if (pull !== undefined && pull.merged) {
    ctx.res.writeHead(204);
    ctx.res.end();
    return;
  }
  sendError(ctx.res, 404, 'Pull Request is not merged');
});

route('PUT', '/api/v3/repos/:owner/:repo/pulls/:number/merge', (ctx, params) => {
  const repo = mustRepo(ctx, params.owner as string, params.repo as string);
  if (repo === null) return;
  if (ctx.auth === null) return sendError(ctx.res, 401, 'Requires authentication');
  const issue = forge.issueByNumber(repo, Number(params.number));
  if (issue === undefined || !issue.isPull) return sendError(ctx.res, 404, 'Not Found');
  const pull = forge.pulls.get(issue.id);
  if (pull === undefined) return sendError(ctx.res, 404, 'Not Found');
  if (pull.merged) return sendError(ctx.res, 405, 'Pull Request is not mergeable');
  if (issue.state === 'closed') return sendError(ctx.res, 405, 'Pull Request is not mergeable');
  const sides = pullSides(repo, issue);
  if (sides === null || sides.headSha === null || sides.baseSha === null) {
    return sendError(ctx.res, 405, 'Pull Request is not mergeable');
  }
  const state = pullMergeState(sides);
  if (!state.mergeable || state.tree === null) {
    return sendError(ctx.res, 405, 'Pull Request is not mergeable');
  }
  const body = jsonBody(ctx) ?? {};
  const method = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
  const viewer = forge.viewer();
  const now = Math.floor(Date.now() / 1000);
  const ident = identityLine(viewer.name, viewer.email, now);
  let mergeSha: string;
  if (method === 'squash') {
    const message = typeof body.commit_title === 'string'
      ? `${body.commit_title}${typeof body.commit_message === 'string' && body.commit_message !== '' ? `\n\n${body.commit_message}` : ''}`
      : `${issue.title} (#${issue.number})`;
    mergeSha = forge.objects.put('commit', buildCommit({
      tree: state.tree,
      parents: [sides.baseSha],
      author: ident,
      committer: ident,
      message,
    }));
  } else if (method === 'rebase') {
    // Replay the head commits onto the base tip, oldest first.
    const base = state.base ?? sides.baseSha;
    const baseAncestors = new Set<string>();
    const stack = [base];
    while (stack.length > 0) {
      const s = stack.pop() as string;
      if (baseAncestors.has(s)) continue;
      baseAncestors.add(s);
      const o = forge.objects.get(s);
      if (o !== undefined && o.type === 'commit') stack.push(...parseCommit(o.data).parents);
    }
    const chain: string[] = [];
    const seen = new Set<string>();
    const queue = [sides.headSha];
    while (queue.length > 0) {
      const s = queue.shift() as string;
      if (seen.has(s) || baseAncestors.has(s)) continue;
      seen.add(s);
      chain.push(s);
      const o = forge.objects.get(s);
      if (o !== undefined && o.type === 'commit') queue.push(...parseCommit(o.data).parents);
    }
    chain.reverse();
    let current = sides.baseSha;
    let currentTree = parseCommit(forge.objects.get(current)?.data as Buffer).tree;
    for (const oldSha of chain) {
      const old = parseCommit(forge.objects.get(oldSha)?.data as Buffer);
      const parentTree = old.parents.length > 0
        ? parseCommit(forge.objects.get(old.parents[0] as string)?.data as Buffer).tree
        : forge.objects.put('tree', buildTree([]));
      const replay = mergeTrees(currentTree, old.tree, parentTree);
      if (replay.tree === null) return sendError(ctx.res, 409, 'Rebase conflict');
      current = forge.objects.put('commit', buildCommit({
        tree: replay.tree,
        parents: [current],
        author: old.author,
        committer: ident,
        message: old.message,
      }));
      currentTree = replay.tree;
    }
    mergeSha = current;
  } else {
    const title = typeof body.commit_title === 'string' && body.commit_title !== ''
      ? body.commit_title
      : `Merge pull request #${issue.number} from ${sides.headRepo.owner}:${pull.headRef}`;
    const message = typeof body.commit_message === 'string' && body.commit_message !== ''
      ? `${title}\n\n${body.commit_message}`
      : title;
    mergeSha = forge.objects.put('commit', buildCommit({
      tree: state.tree,
      parents: [sides.baseSha, sides.headSha],
      author: ident,
      committer: ident,
      message,
    }));
  }
  sides.baseRepo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  sides.baseRepo.updatedAt = now;
  pull.merged = true;
  pull.mergedAt = now;
  pull.mergeCommitSha = mergeSha;
  issue.state = 'closed';
  issue.closedAt = now;
  issue.updatedAt = now;
  sendJson(ctx.res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
});

// ---------------------------------------------------------------- server

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const body = await readBody(req);
        const ctx: Ctx = { req, res, url, auth: authenticate(req), body };
        const path = url.pathname;
        const method = (req.method ?? 'GET').toUpperCase();

        for (const candidate of routes) {
          if (candidate.method !== method) continue;
          const params = matchPattern(candidate.pattern, path);
          if (params !== null) {
            await candidate.handler(ctx, params);
            return;
          }
        }

        for (const candidate of regexRoutes) {
          if (candidate.method !== method) continue;
          const matched = candidate.regex.exec(path);
          if (matched !== null) {
            const groups: Record<string, string> = {};
            matched.forEach((value, index) => {
              groups[index] = value ?? '';
            });
            await candidate.handler(ctx, groups);
            return;
          }
        }

        // The git wire protocol and the other surfaces register their own
        // handlers through handleSurface (added below this skeleton).
        if (await handleSurface(ctx)) return;

        sendError(res, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        else res.end();
      }
    })();
  });
}

/** The git smart-HTTP surface, GraphQL, and MCP. */
async function handleSurface(ctx: Ctx): Promise<boolean> {
  const { handleGraphQL } = await import('./graphql.ts');
  if (handleGraphQL(ctx.req, ctx.res, ctx.url, ctx.body, ctx.auth !== null)) return true;
  const { handleMCP } = await import('./mcp.ts');
  if (handleMCP(ctx.req, ctx.res, ctx.url, ctx.body, ctx.auth !== null)) return true;
  const { handleGitHttp } = await import('./githttp.ts');
  return handleGitHttp(ctx.req, ctx.res, ctx.url, ctx.body, ctx.auth !== null);
}
