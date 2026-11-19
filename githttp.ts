// The git smart-HTTP surface: ref advertisement, protocol v2 ls-refs and
// fetch, protocol v0 fetch, and receive-pack pushes, at
// /{owner}/{repo}.git/... — spoken against the forge's object store exactly
// as git itself speaks it, because the suite's benchmark drives a real git
// client at these endpoints while its conformance client speaks both
// protocol versions packet by packet.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import {
  decodePack,
  encodePack,
  parseCommit,
  parsePktLines,
  parseTree,
  pktLine,
  PKT_FLUSH,
  type ObjectStore,
} from './git.ts';
import { forge } from './app.ts';
import type { RepoRec } from './store.ts';

const ZERO = '0000000000000000000000000000000000000000';
const AGENT = 'forge/1.0';

interface GitRequest {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: Buffer;
  authed: boolean;
}

/** True when the path is a git endpoint this module handled. */
export async function handleGitHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Buffer,
  authed: boolean,
): Promise<boolean> {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(url.pathname);
  if (match === null) return false;
  const owner = decodeURIComponent(match[1] as string);
  const repoName = decodeURIComponent(match[2] as string);
  const tail = match[3] ?? '';
  const ctx: GitRequest = { req, res, url, body, authed };

  const repo = forge.repo(owner, repoName);
  if (tail === '/info/refs') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendPlain(res, 403, 'Forbidden');
      return true;
    }
    if (!gateRepo(ctx, repo)) return true;
    advertise(ctx, repo as RepoRec, service);
    return true;
  }
  if (tail === '/git-upload-pack' && req.method === 'POST') {
    if (!gateRepo(ctx, repo)) return true;
    uploadPack(ctx, repo as RepoRec);
    return true;
  }
  if (tail === '/git-receive-pack' && req.method === 'POST') {
    if (!gateRepo(ctx, repo)) return true;
    receivePack(ctx, repo as RepoRec);
    return true;
  }
  return false;
}

/** Existence and privacy gate shared by every git endpoint. */
function gateRepo(ctx: GitRequest, repo: RepoRec | undefined): boolean {
  if (repo === undefined) {
    sendPlain(ctx.res, 404, 'Not Found');
    return false;
  }
  if (repo.private && !ctx.authed) {
    ctx.res.writeHead(401, {
      'content-type': 'text/plain; charset=utf-8',
      'www-authenticate': 'Basic realm="forge"',
    });
    ctx.res.end('Authentication required');
    return false;
  }
  return true;
}

function sendPlain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendTyped(res: ServerResponse, type: string, body: Buffer): void {
  res.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': 'no-cache, max-age=0, must-revalidate',
    expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
    pragma: 'no-cache',
    'x-github-request-id': '0000:0000:0000:0000',
  });
  res.end(body);
}

// ---------------------------------------------------------------- refs

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
}

/** The repo's advertised refs: HEAD first, then refs in name order, tags peeled. */
function refLines(repo: RepoRec): RefLine[] {
  const lines: RefLine[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef) ?? ZERO;
  lines.push({ oid: headOid, name: 'HEAD', symrefTarget: headRef });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    const obj = forge.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      const target = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (target !== null) line.peeled = target[1];
    }
    lines.push(line);
  }
  return lines;
}

function wantsV2(req: IncomingMessage): boolean {
  const header = req.headers['git-protocol'];
  return typeof header === 'string' && /(^|:)version=2/.test(header);
}

// ---------------------------------------------------------------- advertisement

function advertise(ctx: GitRequest, repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): void {
  const type = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && wantsV2(ctx.req)) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    sendTyped(ctx.res, type, body);
    return;
  }

  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not object-format=sha1 agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
      : `report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta object-format=sha1 agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = refLines(repo);
  if (repo.refs.size === 0) {
    lines.push(pktLine(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const ref of refs) {
      const text = first ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      lines.push(pktLine(text));
      first = false;
      if (ref.peeled !== undefined) lines.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  lines.push(PKT_FLUSH);
  sendTyped(ctx.res, type, Buffer.concat(lines));
}

// ---------------------------------------------------------------- upload-pack

function uploadPack(ctx: GitRequest, repo: RepoRec): void {
  if (wantsV2(ctx.req)) {
    uploadPackV2(ctx, repo);
    return;
  }
  uploadPackV0(ctx, repo);
}

function sideband(pack: Buffer, progress: string | null): Buffer {
  const chunks: Buffer[] = [];
  const SLICE = 32_768;
  for (let offset = 0; offset < pack.length; offset += SLICE) {
    const slice = pack.subarray(offset, offset + SLICE);
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (progress !== null) chunks.push(pktLine(Buffer.concat([Buffer.from([2]), Buffer.from(progress, 'utf8')])));
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

/** The objects a fetch must carry: the wants' closure minus what the haves already cover. */
function fetchPack(store: ObjectStore, wants: string[], haves: string[]): Buffer {
  const wantClosure = store.closure(wants);
  const haveClosure = haves.length > 0 ? store.closure(haves) : new Set<string>();
  const toSend = [...wantClosure].filter((id) => !haveClosure.has(id));
  return encodePack(store, toSend);
}

function uploadPackV0(ctx: GitRequest, repo: RepoRec): void {
  const store = forge.objects;
  const { lines } = parsePktLines(ctx.body);
  const wants: string[] = [];
  const haves: string[] = [];
  let caps = '';
  let done = false;
  let phase: 'want' | 'have' = 'want';
  for (const raw of lines) {
    if (raw === null) {
      if (phase === 'want') phase = 'have';
      continue;
    }
    const line = raw.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const nul = rest.indexOf('\0');
      if (nul === -1) wants.push(rest.trim());
      else {
        wants.push(rest.slice(0, nul).trim());
        caps = rest.slice(nul + 1);
      }
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    } else if (line === 'done') {
      done = true;
    }
  }
  if (!done && haves.length === 0 && wants.length === 0) {
    sendTyped(ctx.res, 'application/x-git-upload-pack-result', PKT_FLUSH);
    return;
  }
  const common = haves.filter((have) => store.has(have));
  const out: Buffer[] = [];
  if (caps.includes('multi_ack_detailed')) {
    for (const have of common) out.push(pktLine(`ACK ${have} common\n`));
    if (done) {
      if (common.length > 0) out.push(pktLine(`ACK ${common[common.length - 1]} ready\n`));
      else out.push(pktLine('NAK\n'));
    }
  } else if (done || haves.length === 0) {
    out.push(pktLine('NAK\n'));
  }
  if (done || haves.length === 0) {
    const pack = fetchPack(store, wants, common);
    if (caps.includes('side-band')) out.push(sideband(pack, null));
    else out.push(pack);
  }
  sendTyped(ctx.res, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

function uploadPackV2(ctx: GitRequest, repo: RepoRec): void {
  const store = forge.objects;
  // Split the request at the delimiter packet: arguments before, fetch lines after.
  const { lines } = parsePktLines(ctx.body);
  const texts: Array<string | 'flush' | 'delim'> = lines.map((raw) => {
    if (raw === null) return 'flush' as const;
    if (raw.length === 0) return 'delim' as const;
    return raw.toString('utf8').replace(/\n$/, '');
  });
  const command = texts.find((t) => typeof t === 'string' && t.startsWith('command='));
  if (command === 'command=ls-refs') {
    lsRefsV2(ctx, repo, texts);
    return;
  }
  if (command === 'command=fetch') {
    fetchV2(ctx, repo, texts);
    return;
  }
  sendTyped(ctx.res, 'application/x-git-upload-pack-result', Buffer.concat([pktLine('error: unknown command\n'), PKT_FLUSH]));
}

function lsRefsV2(ctx: GitRequest, repo: RepoRec, texts: Array<string | 'flush' | 'delim'>): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const t of texts) {
    if (typeof t !== 'string') continue;
    if (t === 'peel') peel = true;
    else if (t === 'symrefs') symrefs = true;
    else if (t === 'unborn') unborn = true;
    else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name === p || name.startsWith(p));
  const out: Buffer[] = [];
  for (const ref of refLines(repo)) {
    if (!keep(ref.name)) continue;
    const attrs: string[] = [];
    if (symrefs && ref.symrefTarget !== undefined) attrs.push(`symref-target:${ref.symrefTarget}`);
    if (peel && ref.peeled !== undefined) attrs.push(`peeled:${ref.peeled}`);
    if (unborn && ref.name === 'HEAD' && ref.oid === ZERO) attrs.push('unborn');
    out.push(pktLine(`${ref.oid} ${ref.name}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}\n`));
  }
  out.push(PKT_FLUSH);
  sendTyped(ctx.res, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

/** Commit distances from the wants, walking parent links (commits only). */
function commitDistances(store: ObjectStore, wants: string[]): Map<string, number> {
  const dist = new Map<string, number>();
  let frontier = wants.filter((id) => store.get(id)?.type === 'commit');
  for (const id of frontier) dist.set(id, 0);
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next: string[] = [];
    for (const id of frontier) {
      const obj = store.get(id);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (!dist.has(parent) && store.get(parent)?.type === 'commit') {
          dist.set(parent, depth);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

interface ShallowPlan {
  /** Object ids the pack must carry. */
  objects: Set<string>;
  /** Commits that become the new shallow boundary. */
  shallow: string[];
  /** Previously shallow commits whose history is now included. */
  unshallow: string[];
}

/**
 * A depth-limited fetch plan: commits within the depth limit ride with their
 * full tree closure; commits at the limit with parents in the store become
 * the shallow boundary and their ancestry stays behind.
 */
function shallowPlan(
  store: ObjectStore,
  wants: string[],
  haves: string[],
  depth: number | null,
  clientShallow: string[],
): ShallowPlan {
  const dist = commitDistances(store, wants);
  let limit: number;
  if (depth !== null && clientShallow.length > 0) {
    // A deepen request is relative to the client's current boundary.
    const boundaryDist = Math.max(0, ...clientShallow.map((id) => dist.get(id) ?? 0));
    limit = boundaryDist + depth;
  } else if (depth !== null) {
    limit = depth;
  } else if (clientShallow.length > 0) {
    limit = Math.max(0, ...clientShallow.map((id) => dist.get(id) ?? 0)) + 1;
  } else {
    limit = Number.POSITIVE_INFINITY;
  }
  const includedCommits = [...dist.entries()].filter(([, d]) => d < limit).map(([id]) => id);
  const includedSet = new Set(includedCommits);
  const objects = new Set<string>();
  const addTree = (treeId: string): void => {
    const stack = [treeId];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (objects.has(id)) continue;
      const obj = store.get(id);
      if (obj === undefined) continue;
      objects.add(id);
      if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.id);
      }
    }
  };
  for (const id of includedCommits) {
    objects.add(id);
    const obj = store.get(id);
    if (obj !== undefined && obj.type === 'commit') addTree(parseCommit(obj.data).tree);
  }
  // What the client already holds: a full have covers its whole closure,
  // but a shallow-boundary have covers only the commit and its tree — its
  // ancestry is exactly what a deepen fetch is asking for.
  const held = new Set<string>();
  for (const have of haves) {
    if (clientShallow.includes(have)) {
      held.add(have);
      const obj = store.get(have);
      if (obj !== undefined && obj.type === 'commit') {
        for (const id of store.closure([parseCommit(obj.data).tree])) held.add(id);
      }
    } else {
      for (const id of store.closure([have])) held.add(id);
    }
  }
  for (const id of held) objects.delete(id);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const id of includedCommits) {
    const obj = store.get(id);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    const cut = parents.some((p) => !includedSet.has(p) && store.has(p));
    if (cut) shallow.push(id);
    else if (clientShallow.includes(id)) unshallow.push(id);
  }
  return { objects, shallow, unshallow };
}

function fetchV2(ctx: GitRequest, repo: RepoRec, texts: Array<string | 'flush' | 'delim'>): void {
  const store = forge.objects;
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let deepen: number | null = null;
  let done = false;
  let noProgress = false;
  let seenDelim = false;
  for (const t of texts) {
    if (t === 'delim') {
      seenDelim = true;
      continue;
    }
    if (typeof t !== 'string' || !seenDelim) continue;
    if (t.startsWith('want ')) wants.push(t.slice(5).trim());
    else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) clientShallow.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) deepen = Number.parseInt(t.slice(7).trim(), 10);
    else if (t === 'done') done = true;
    else if (t === 'no-progress') noProgress = true;
  }
  const common = haves.filter((have) => store.has(have));
  const out: Buffer[] = [];
  if (haves.length > 0) {
    out.push(pktLine('acknowledgments\n'));
    if (common.length > 0) {
      for (const have of common) out.push(pktLine(`ACK ${have}\n`));
      if (!done) out.push(pktLine('ready\n'));
    } else {
      out.push(pktLine('NAK\n'));
    }
    out.push(PKT_FLUSH);
  }
  if (done || haves.length === 0) {
    let pack: Buffer;
    if (deepen !== null || clientShallow.length > 0) {
      const plan = shallowPlan(store, wants, common, deepen, clientShallow);
      if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
        out.push(pktLine('shallow-info\n'));
        for (const id of plan.shallow) out.push(pktLine(`shallow ${id}\n`));
        for (const id of plan.unshallow) out.push(pktLine(`unshallow ${id}\n`));
        out.push(PKT_FLUSH);
      }
      pack = encodePack(store, plan.objects);
    } else {
      pack = fetchPack(store, wants, common);
    }
    out.push(pktLine('packfile\n'));
    out.push(sideband(pack, noProgress ? null : null));
  }
  sendTyped(ctx.res, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

// ---------------------------------------------------------------- receive-pack

function receivePack(ctx: GitRequest, repo: RepoRec): void {
  const store = forge.objects;
  const { lines, next } = parsePktLines(ctx.body);
  interface Update {
    oldId: string;
    newId: string;
    ref: string;
  }
  const updates: Update[] = [];
  let caps = '';
  for (const raw of lines) {
    if (raw === null) break;
    const line = raw.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const main = nul === -1 ? line : line.slice(0, nul);
    if (nul !== -1 && caps === '') caps = line.slice(nul + 1);
    const parts = main.split(' ');
    if (parts.length === 3) {
      updates.push({ oldId: parts[0] as string, newId: parts[1] as string, ref: parts[2] as string });
    }
  }
  const packBytes = ctx.body.subarray(next);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      decodePack(store, packBytes);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  if (unpackError === null) {
    for (const update of updates) {
      const current = repo.refs.get(update.ref) ?? ZERO;
      if (update.oldId !== current) {
        results.push({ ref: update.ref, ok: false, reason: `reference is at ${current} but expected ${update.oldId}` });
        continue;
      }
      if (update.newId === ZERO) {
        repo.refs.delete(update.ref);
        results.push({ ref: update.ref, ok: true });
        continue;
      }
      if (!store.has(update.newId)) {
        results.push({ ref: update.ref, ok: false, reason: 'new object not in pack' });
        continue;
      }
      if (
        update.ref.startsWith('refs/heads/') &&
        update.oldId !== ZERO &&
        store.get(update.newId)?.type === 'commit' &&
        !store.isAncestor(update.oldId, update.newId)
      ) {
        results.push({ ref: update.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(update.ref, update.newId);
      if (update.ref.startsWith('refs/heads/')) {
        repo.pushedAt = Math.floor(Date.now() / 1000);
        repo.updatedAt = repo.pushedAt;
      }
      results.push({ ref: update.ref, ok: true });
    }
  }

  if (!caps.includes('report-status') && !caps.includes('report-status-v2')) {
    sendTyped(ctx.res, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    return;
  }
  const report: Buffer[] = [];
  report.push(pktLine(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`));
  if (unpackError === null) {
    for (const result of results) {
      report.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'rejected'}\n`));
    }
  }
  report.push(PKT_FLUSH);
  const reportBody = Buffer.concat(report);
  if (caps.includes('side-band-64k')) {
    const wrapped = Buffer.concat([
      pktLine(Buffer.concat([Buffer.from([1]), reportBody])),
      PKT_FLUSH,
    ]);
    sendTyped(ctx.res, 'application/x-git-receive-pack-result', wrapped);
  } else {
    sendTyped(ctx.res, 'application/x-git-receive-pack-result', reportBody);
  }
}
