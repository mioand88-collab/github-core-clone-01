// A small GraphQL executor for the forge: enough of the language (operations,
// variables, aliases, arguments, inline fragments, batching) and enough of
// GitHub's v4 schema (viewer, repository, issues, pull requests, the gh CLI's
// mutations, Relay node ids and introspection probes) to serve the clients
// that speak it. No library: the document grammar the clients send is small,
// and the schema is the surface this forge actually has.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { forge, flattenTree, mergeBase } from './app.ts';
import { parseCommit } from './git.ts';
import { repoKey, type IssueRec, type RepoRec } from './store.ts';

// ---------------------------------------------------------------- parsing

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface Selection {
  alias: string | null;
  name: string | null; // null for fragments
  args: Map<string, Value>;
  selectionSet: Selection[] | null;
  fragmentType: string | null; // inline fragment condition
  spread: string | null; // fragment spread name
}

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: Selection[];
}

class GqlSyntaxError extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new GqlSyntaxError('unterminated block string');
        tokens.push(`"${source.slice(i + 3, end)}"`);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          out += source[j + 1] === 'n' ? '\n' : source[j + 1] === 't' ? '\t' : source[j + 1];
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new GqlSyntaxError('unterminated string');
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    if ('{}()[]:!$=@.'.includes(ch)) {
      if (source.startsWith('...', i)) {
        tokens.push('...');
        i += 3;
      } else {
        tokens.push(ch);
        i += 1;
      }
      continue;
    }
    const nameMatch = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
    if (nameMatch !== null) {
      tokens.push(nameMatch[0]);
      i += nameMatch[0].length;
      continue;
    }
    const numMatch = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
    if (numMatch !== null) {
      tokens.push(numMatch[0]);
      i += numMatch[0].length;
      continue;
    }
    throw new GqlSyntaxError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new GqlSyntaxError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new GqlSyntaxError(`expected ${token}, got ${got}`);
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, Selection[]> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, Selection[]>();
    while (this.pos < this.tokens.length) {
      const head = this.peek();
      if (head === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation') {
        const type = this.next() as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.next();
        if (this.peek() === '(') this.skipVariableDefinitions();
        if (this.peek() === '@') this.skipDirectives();
        operations.push({ type, name, selectionSet: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        this.next(); // type condition
        if (this.peek() === '@') this.skipDirectives();
        fragments.set(fragName, this.parseSelectionSet());
      } else {
        throw new GqlSyntaxError(`unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }

  private skipVariableDefinitions(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token === '(' || token === '[' || token === '{') depth += 1;
      else if (token === ')' || token === ']' || token === '}') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek() === '(') this.skipVariableDefinitions();
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const typeName = this.next();
        if (this.peek() === '@') this.skipDirectives();
        return { alias: null, name: null, args: new Map(), selectionSet: this.parseSelectionSet(), fragmentType: typeName, spread: null };
      }
      const spreadName = this.next();
      return { alias: null, name: null, args: new Map(), selectionSet: null, fragmentType: null, spread: spreadName };
    }
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args = new Map<string, Value>();
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.expect(')');
    }
    if (this.peek() === '@') this.skipDirectives();
    const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { alias, name, args, selectionSet, fragmentType: null, spread: null };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.next() };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields = new Map<string, Value>();
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields.set(key, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d*\.\d+/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

// ---------------------------------------------------------------- values

interface ExecCtx {
  variables: Record<string, unknown>;
  fragments: Map<string, Selection[]>;
  errors: Array<{ message: string }>;
}

function valueOf(value: Value, ctx: ExecCtx): unknown {
  switch (value.kind) {
    case 'var':
      return ctx.variables[value.name] ?? null;
    case 'string':
    case 'enum':
      return value.value;
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => valueOf(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.fields) out[key] = valueOf(item, ctx);
      return out;
    }
  }
}

function argsOf(selection: Selection, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of selection.args) out[key] = valueOf(value, ctx);
  return out;
}

// ---------------------------------------------------------------- objects

/** A typed value in the graph: a typename plus the record it wraps. */
class GObj {
  readonly type: string;
  readonly data: Record<string, unknown>;

  constructor(type: string, data: Record<string, unknown>) {
    this.type = type;
    this.data = data;
  }
}

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const repoGid = (repo: RepoRec): string => b64(`04:Repository${repo.id}`);
const issueGid = (issue: IssueRec): string => b64(`05:Issue${issue.id}`);
const pullGid = (issue: IssueRec): string => b64(`06:PullRequest${issue.id}`);
const commentGid = (id: number): string => b64(`07:IssueComment${id}`);
const userGid = (id: number): string => b64(`03:User${id}`);
const labelGid = (repo: RepoRec, name: string): string => b64(`08:Label${repo.id}:${name}`);

function decodeGid(gid: string): { kind: string; id: string } | null {
  try {
    const text = Buffer.from(gid, 'base64').toString('utf8');
    const match = /^\d+:([A-Za-z]+)(.+)$/.exec(text);
    if (match === null) return null;
    return { kind: match[1] as string, id: match[2] as string };
  } catch {
    return null;
  }
}

const iso = (sec: number | null): string | null => (sec === null ? null : new Date(sec * 1000).toISOString());

function userObj(login: string): GObj {
  const user = forge.user(login);
  return new GObj(user.type === 'Organization' ? 'Organization' : 'User', {
    login: user.login,
    id: userGid(user.id),
    databaseId: user.id,
    name: user.name,
    email: user.email,
    url: `https://forge.example/${user.login}`,
    avatarUrl: `https://avatars.example.invalid/u/${user.id}`,
  });
}

function repoObj(repo: RepoRec): GObj {
  return new GObj('Repository', {
    repo,
    id: repoGid(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.private,
    isFork: false,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    hasProjectsEnabled: true,
    hasWikiEnabled: true,
    createdAt: iso(repo.createdAt),
    updatedAt: iso(repo.updatedAt),
    pushedAt: iso(repo.pushedAt),
    url: `https://forge.example/${repo.owner}/${repo.name}`,
    sshUrl: `git@forge.example:${repo.owner}/${repo.name}.git`,
    stargazerCount: 0,
    forkCount: 0,
  });
}

function issueState(issue: IssueRec): string {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function issueObj(repo: RepoRec, issue: IssueRec): GObj {
  return new GObj('Issue', {
    repo,
    issue,
    id: issueGid(issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issueState(issue),
    closed: issue.state === 'closed',
    createdAt: iso(issue.createdAt),
    updatedAt: iso(issue.updatedAt),
    closedAt: iso(issue.closedAt),
    url: `https://forge.example/${repo.owner}/${repo.name}/issues/${issue.number}`,
  });
}

function pullObj(repo: RepoRec, issue: IssueRec): GObj {
  const pull = forge.pulls.get(issue.id);
  return new GObj('PullRequest', {
    repo,
    issue,
    pull,
    id: pullGid(issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: pull?.merged === true ? 'MERGED' : issueState(issue),
    merged: pull?.merged ?? false,
    closed: issue.state === 'closed',
    isDraft: pull?.draft ?? false,
    createdAt: iso(issue.createdAt),
    updatedAt: iso(issue.updatedAt),
    closedAt: iso(issue.closedAt),
    mergedAt: iso(pull?.mergedAt ?? null),
    mergeCommitOid: pull?.mergeCommitSha ?? null,
    headRefName: pull?.headRef ?? '',
    baseRefName: pull?.baseRef ?? '',
    url: `https://forge.example/${repo.owner}/${repo.name}/pull/${issue.number}`,
  });
}

// ---------------------------------------------------------------- connections

interface Connection {
  items: GObj[];
}

function connection(items: GObj[], args: Record<string, unknown> = {}): GObj {
  return new GObj('Connection', { items, args } satisfies Record<string, unknown>);
}

const cursorOf = (index: number): string => b64(`cursor:${index}`);

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number.parseInt(match[1] as string, 10);
  } catch {
    return -1;
  }
}

interface Slice {
  start: number;
  end: number;
  items: GObj[];
}

function sliceConnection(items: GObj[], args: Record<string, unknown>): Slice {
  let start = 0;
  if (typeof args.after === 'string') start = decodeCursor(args.after) + 1;
  let end = items.length;
  if (typeof args.first === 'number') end = Math.min(end, start + Math.max(0, args.first));
  if (typeof args.last === 'number') {
    end = items.length;
    start = Math.max(start, end - Math.max(0, args.last));
  }
  return { start, end, items: items.slice(start, end) };
}

// ---------------------------------------------------------------- schema fields for introspection

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'bodyText', 'state', 'closed', 'closedAt', 'createdAt',
    'updatedAt', 'author', 'editor', 'labels', 'comments', 'repository', 'url', 'assignees', 'participants',
    'milestone', 'reactions', 'viewerCanReact', 'authorAssociation', 'locked', 'activeLockReason',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'closed', 'merged', 'mergedAt', 'mergeable',
    'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'headRepository', 'baseRepository', 'files',
    'commits', 'comments', 'reviews', 'author', 'labels', 'repository', 'url', 'createdAt', 'updatedAt',
    'closedAt', 'isDraft', 'additions', 'deletions', 'changedFiles', 'mergeCommit', 'mergedBy', 'assignees',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'isFork', 'parent',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'labels', 'label', 'createdAt', 'updatedAt', 'pushedAt',
    'url', 'sshUrl', 'stargazerCount', 'forkCount', 'refs', 'ref', 'collaborators', 'mentionableUsers',
  ],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl', 'repositories', 'issues', 'pullRequests', 'createdAt', 'updatedAt'],
  Organization: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl', 'repositories', 'createdAt', 'updatedAt'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

// ---------------------------------------------------------------- resolvers

type Resolver = (source: GObj, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

const resolvers: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userObj(forge.viewer().login),
    repository: (_s, args) => {
      const repo = forge.repo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoObj(repo);
    },
    user: (_s, args) => userObj(String(args.login ?? '')),
    organization: (_s, args) => userObj(String(args.login ?? '')),
    node: (_s, args) => {
      const decoded = decodeGid(String(args.id ?? ''));
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = [...forge.repos.values()].find((r) => r.id === Number(decoded.id));
        return repo === undefined ? null : repoObj(repo);
      }
      if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
        const issue = forge.issues.get(Number(decoded.id));
        if (issue === undefined) return null;
        const repo = forge.repos.get(issue.repoKey);
        if (repo === undefined) return null;
        return decoded.kind === 'Issue' ? issueObj(repo, issue) : pullObj(repo, issue);
      }
      if (decoded.kind === 'User') {
        const user = [...forge.users.values()].find((u) => u.id === Number(decoded.id));
        return user === undefined ? null : userObj(user.login);
      }
      return null;
    },
    __type: (_s, args) => {
      const name = String(args.name ?? '');
      if (TYPE_FIELDS[name] !== undefined || TYPE_ENUMS[name] !== undefined) {
        return new GObj('__Type', { name, kind: TYPE_ENUMS[name] !== undefined ? 'ENUM' : 'OBJECT' });
      }
      return null;
    },
    rateLimit: () => new GObj('RateLimit', { limit: 5000, remaining: 5000, used: 0, resetAt: iso(Math.floor(Date.now() / 1000) + 3600) }),
  },
  __Type: {
    name: (s) => s.data.name,
    kind: (s) => s.data.kind,
    fields: (s) => (TYPE_FIELDS[s.data.name as string] ?? []).map((name) => new GObj('__Field', { name })),
    enumValues: (s) => (TYPE_ENUMS[s.data.name as string] ?? []).map((name) => new GObj('__EnumValue', { name })),
  },
  __Field: { name: (s) => s.data.name },
  __EnumValue: { name: (s) => s.data.name },
  User: {
    login: (s) => s.data.login,
    id: (s) => s.data.id,
    databaseId: (s) => s.data.databaseId,
    name: (s) => s.data.name,
    email: (s) => s.data.email,
    url: (s) => s.data.url,
    avatarUrl: (s) => s.data.avatarUrl,
  },
  Organization: {
    login: (s) => s.data.login,
    id: (s) => s.data.id,
    databaseId: (s) => s.data.databaseId,
    name: (s) => s.data.name,
    email: (s) => s.data.email,
    url: (s) => s.data.url,
    avatarUrl: (s) => s.data.avatarUrl,
  },
  Repository: {
    id: (s) => s.data.id,
    databaseId: (s) => s.data.databaseId,
    name: (s) => s.data.name,
    nameWithOwner: (s) => s.data.nameWithOwner,
    description: (s) => s.data.description,
    isPrivate: (s) => s.data.isPrivate,
    isFork: (s) => s.data.isFork,
    viewerPermission: (s) => s.data.viewerPermission,
    hasIssuesEnabled: (s) => s.data.hasIssuesEnabled,
    hasProjectsEnabled: (s) => s.data.hasProjectsEnabled,
    hasWikiEnabled: (s) => s.data.hasWikiEnabled,
    createdAt: (s) => s.data.createdAt,
    updatedAt: (s) => s.data.updatedAt,
    pushedAt: (s) => s.data.pushedAt,
    url: (s) => s.data.url,
    sshUrl: (s) => s.data.sshUrl,
    stargazerCount: (s) => s.data.stargazerCount,
    forkCount: (s) => s.data.forkCount,
    parent: () => null,
    owner: (s) => userObj((s.data.repo as RepoRec).owner),
    defaultBranchRef: (s) => {
      const repo = s.data.repo as RepoRec;
      const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
      return new GObj('Ref', { name: repo.defaultBranch, prefix: 'refs/heads/', targetOid: oid });
    },
    issue: (s, args) => {
      const repo = s.data.repo as RepoRec;
      const issue = forge.issueByNumber(repo, Number(args.number));
      return issue === undefined ? null : issueObj(repo, issue);
    },
    issues: (s, args) => {
      const repo = s.data.repo as RepoRec;
      let list = forge.issuesOf(repo).filter((i) => !i.isPull);
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        list = list.filter((i) => states.includes(i.state === 'closed' ? 'CLOSED' : 'OPEN'));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      const desc = orderBy?.direction !== 'ASC';
      list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
      return connection(list.map((i) => issueObj(repo, i)), args);
    },
    pullRequest: (s, args) => {
      const repo = s.data.repo as RepoRec;
      const issue = forge.issueByNumber(repo, Number(args.number));
      return issue === undefined || !issue.isPull ? null : pullObj(repo, issue);
    },
    pullRequests: (s, args) => {
      const repo = s.data.repo as RepoRec;
      let list = forge.issuesOf(repo).filter((i) => i.isPull);
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        list = list.filter((i) => {
          const pull = forge.pulls.get(i.id);
          const state = pull?.merged === true ? 'MERGED' : i.state === 'closed' ? 'CLOSED' : 'OPEN';
          return states.includes(state);
        });
      }
      list.sort((a, b) => b.number - a.number);
      return connection(list.map((i) => pullObj(repo, i)), args);
    },
    labels: (s, args) => {
      const repo = s.data.repo as RepoRec;
      const items = [...repo.labels.values()].map(
        (label) =>
          new GObj('Label', {
            id: labelGid(repo, label.name),
            name: label.name,
            color: label.color,
            description: label.description,
            url: `https://forge.example/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
          }),
      );
      return connection(items, args);
    },
  },
  Ref: {
    name: (s) => s.data.name,
    prefix: (s) => s.data.prefix,
    target: (s) =>
      s.data.targetOid === null || s.data.targetOid === undefined
        ? null
        : new GObj('Commit', { oid: s.data.targetOid, id: b64(`01:Commit${s.data.targetOid}`) }),
  },
  Commit: {
    oid: (s) => s.data.oid,
    id: (s) => s.data.id,
  },
  Label: {
    id: (s) => s.data.id,
    name: (s) => s.data.name,
    color: (s) => s.data.color,
    description: (s) => s.data.description,
    url: (s) => s.data.url,
  },
  Issue: {
    id: (s) => s.data.id,
    databaseId: (s) => (s.data.issue as IssueRec).id,
    number: (s) => s.data.number,
    title: (s) => s.data.title,
    body: (s) => s.data.body,
    bodyText: (s) => s.data.body,
    state: (s) => s.data.state,
    closed: (s) => s.data.closed,
    createdAt: (s) => s.data.createdAt,
    updatedAt: (s) => s.data.updatedAt,
    closedAt: (s) => s.data.closedAt,
    url: (s) => s.data.url,
    author: (s) => userObj((s.data.issue as IssueRec).userLogin),
    repository: (s) => repoObj(s.data.repo as RepoRec),
    labels: (s, args) => {
      const repo = s.data.repo as RepoRec;
      const issue = s.data.issue as IssueRec;
      const items = issue.labels
        .map((name) => repo.labels.get(name.toLowerCase()))
        .filter((l) => l !== undefined)
        .map(
          (label) =>
            new GObj('Label', {
              id: labelGid(repo, (label as { name: string }).name),
              name: (label as { name: string }).name,
              color: (label as { color: string }).color,
              description: (label as { description: string }).description,
              url: '',
            }),
        );
      return connection(items as GObj[], args);
    },
    comments: (s, args) => {
      const repo = s.data.repo as RepoRec;
      const issue = s.data.issue as IssueRec;
      const items = forge.commentsOf(issue).map(
        (comment) =>
          new GObj('IssueComment', {
            id: commentGid(comment.id),
            databaseId: comment.id,
            body: comment.body,
            createdAt: iso(comment.createdAt),
            updatedAt: iso(comment.updatedAt),
            authorLogin: comment.userLogin,
            repo,
          }),
      );
      return connection(items, args);
    },
    assignees: (s, args) => connection((s.data.issue as IssueRec).assignees.map((login) => userObj(login)), args),
  },
  IssueComment: {
    id: (s) => s.data.id,
    databaseId: (s) => s.data.databaseId,
    body: (s) => s.data.body,
    createdAt: (s) => s.data.createdAt,
    updatedAt: (s) => s.data.updatedAt,
    author: (s) => userObj(s.data.authorLogin as string),
    url: (s) => `https://forge.example/x#issuecomment-${s.data.databaseId}`,
  },
  PullRequest: {
    id: (s) => s.data.id,
    databaseId: (s) => (s.data.issue as IssueRec).id,
    number: (s) => s.data.number,
    title: (s) => s.data.title,
    body: (s) => s.data.body,
    bodyText: (s) => s.data.body,
    state: (s) => s.data.state,
    merged: (s) => s.data.merged,
    closed: (s) => s.data.closed,
    isDraft: (s) => s.data.isDraft,
    createdAt: (s) => s.data.createdAt,
    updatedAt: (s) => s.data.updatedAt,
    closedAt: (s) => s.data.closedAt,
    mergedAt: (s) => s.data.mergedAt,
    url: (s) => s.data.url,
    headRefName: (s) => s.data.headRefName,
    baseRefName: (s) => s.data.baseRefName,
    author: (s) => userObj((s.data.issue as IssueRec).userLogin),
    repository: (s) => repoObj(s.data.repo as RepoRec),
    mergeable: (s) => {
      const repo = s.data.repo as RepoRec;
      const issue = s.data.issue as IssueRec;
      const pull = forge.pulls.get(issue.id);
      if (pull === undefined) return 'UNKNOWN';
      if (pull.merged) return 'MERGEABLE';
      const headSha = pull.headSha;
      const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
      const base = mergeBase(baseSha, headSha);
      if (base === null) return 'UNKNOWN';
      const treeOf = (sha: string): string => parseCommit(forge.objects.get(sha)?.data as Buffer).tree;
      const baseFiles = flattenTree(treeOf(baseSha));
      const headFiles = flattenTree(treeOf(headSha));
      const ancFiles = flattenTree(treeOf(base));
      for (const path of new Set([...baseFiles.keys(), ...headFiles.keys(), ...ancFiles.keys()])) {
        const b = baseFiles.get(path);
        const h = headFiles.get(path);
        const a = ancFiles.get(path);
        const headMoved = h?.id !== a?.id;
        const baseMoved = b?.id !== a?.id;
        if (headMoved && baseMoved && h?.id !== b?.id) return 'CONFLICTING';
      }
      return 'MERGEABLE';
    },
    files: (s, args) => {
      const repo = s.data.repo as RepoRec;
      const issue = s.data.issue as IssueRec;
      const pull = forge.pulls.get(issue.id);
      if (pull === undefined) return connection([], args);
      const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
      const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
      const base = mergeBase(baseSha, headSha) ?? baseSha;
      const treeOf = (sha: string): string => parseCommit(forge.objects.get(sha)?.data as Buffer).tree;
      const before = flattenTree(treeOf(base));
      const after = flattenTree(treeOf(headSha));
      const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
      const items: GObj[] = [];
      for (const path of paths) {
        const b = before.get(path);
        const h = after.get(path);
        if (b?.id === h?.id) continue;
        const oldText = b !== undefined ? (forge.objects.get(b.id)?.data.toString('utf8') ?? '') : '';
        const newText = h !== undefined ? (forge.objects.get(h.id)?.data.toString('utf8') ?? '') : '';
        const oldLines = oldText === '' ? 0 : oldText.split('\n').length;
        const newLines = newText === '' ? 0 : newText.split('\n').length;
        items.push(
          new GObj('PullRequestChangedFile', {
            path,
            additions: Math.max(0, newLines - oldLines),
            deletions: Math.max(0, oldLines - newLines),
            changeType: b === undefined ? 'ADDED' : h === undefined ? 'DELETED' : 'MODIFIED',
          }),
        );
      }
      return connection(items, args);
    },
    labels: (s, args) => {
      const repo = s.data.repo as RepoRec;
      const issue = s.data.issue as IssueRec;
      const items = issue.labels
        .map((name) => repo.labels.get(name.toLowerCase()))
        .filter((l) => l !== undefined)
        .map(
          (label) =>
            new GObj('Label', {
              id: labelGid(repo, (label as { name: string }).name),
              name: (label as { name: string }).name,
              color: (label as { color: string }).color,
              description: (label as { description: string }).description,
              url: '',
            }),
        );
      return connection(items as GObj[], args);
    },
    comments: (s, args) => {
      const repo = s.data.repo as RepoRec;
      const issue = s.data.issue as IssueRec;
      const items = forge.commentsOf(issue).map(
        (comment) =>
          new GObj('IssueComment', {
            id: commentGid(comment.id),
            databaseId: comment.id,
            body: comment.body,
            createdAt: iso(comment.createdAt),
            updatedAt: iso(comment.updatedAt),
            authorLogin: comment.userLogin,
            repo,
          }),
      );
      return connection(items, args);
    },
  },
  PullRequestChangedFile: {
    path: (s) => s.data.path,
    additions: (s) => s.data.additions,
    deletions: (s) => s.data.deletions,
    changeType: (s) => s.data.changeType,
  },
  Connection: {
    nodes: (s) => sliceConnection((s.data as { items: GObj[] }).items, (s.data as { args: Record<string, unknown> }).args).items,
    edges: (s) => {
      const items = (s.data as { items: GObj[] }).items;
      const slice = sliceConnection(items, (s.data as { args: Record<string, unknown> }).args);
      return slice.items.map(
        (node, i) => new GObj('Edge', { node, cursor: cursorOf(slice.start + i) }),
      );
    },
    pageInfo: (s) => {
      const items = (s.data as { items: GObj[] }).items;
      const slice = sliceConnection(items, (s.data as { args: Record<string, unknown> }).args);
      return new GObj('PageInfo', {
        hasNextPage: slice.end < items.length,
        hasPreviousPage: slice.start > 0,
        startCursor: slice.items.length > 0 ? cursorOf(slice.start) : null,
        endCursor: slice.items.length > 0 ? cursorOf(slice.end - 1) : null,
      });
    },
    totalCount: (s) => (s.data as { items: GObj[] }).items.length,
  },
  Edge: {
    node: (s) => s.data.node,
    cursor: (s) => s.data.cursor,
  },
  PageInfo: {
    hasNextPage: (s) => s.data.hasNextPage,
    hasPreviousPage: (s) => s.data.hasPreviousPage,
    startCursor: (s) => s.data.startCursor,
    endCursor: (s) => s.data.endCursor,
  },
  RateLimit: {
    limit: (s) => s.data.limit,
    remaining: (s) => s.data.remaining,
    used: (s) => s.data.used,
    resetAt: (s) => s.data.resetAt,
  },
};

// ---------------------------------------------------------------- mutations

const mutationResolvers: Record<string, Resolver> = {
  createIssue: (_s, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGid(String(input.repositoryId ?? ''));
    const repo = decoded !== null ? [...forge.repos.values()].find((r) => r.id === Number(decoded.id)) : undefined;
    if (repo === undefined) {
      ctx.errors.push({ message: 'Repository not found' });
      return null;
    }
    const issue = forge.createIssue(repo, {
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      userLogin: forge.viewer().login,
      labels: [],
      assignees: [],
      isPull: false,
    });
    return new GObj('CreateIssuePayload', { issue: issueObj(repo, issue), clientMutationId: input.clientMutationId ?? null });
  },
  closeIssue: (_s, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGid(String(input.issueId ?? ''));
    const issue = decoded !== null ? forge.issues.get(Number(decoded.id)) : undefined;
    if (issue === undefined) {
      ctx.errors.push({ message: 'Issue not found' });
      return null;
    }
    const repo = forge.repos.get(issue.repoKey) as RepoRec;
    issue.state = 'closed';
    issue.closedAt = Math.floor(Date.now() / 1000);
    issue.updatedAt = issue.closedAt;
    return new GObj('CloseIssuePayload', { issue: issueObj(repo, issue), clientMutationId: input.clientMutationId ?? null });
  },
  reopenIssue: (_s, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGid(String(input.issueId ?? ''));
    const issue = decoded !== null ? forge.issues.get(Number(decoded.id)) : undefined;
    if (issue === undefined) {
      ctx.errors.push({ message: 'Issue not found' });
      return null;
    }
    const repo = forge.repos.get(issue.repoKey) as RepoRec;
    issue.state = 'open';
    issue.closedAt = null;
    issue.updatedAt = Math.floor(Date.now() / 1000);
    return new GObj('ReopenIssuePayload', { issue: issueObj(repo, issue), clientMutationId: input.clientMutationId ?? null });
  },
  createPullRequest: (_s, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGid(String(input.repositoryId ?? ''));
    const repo = decoded !== null ? [...forge.repos.values()].find((r) => r.id === Number(decoded.id)) : undefined;
    if (repo === undefined) {
      ctx.errors.push({ message: 'Repository not found' });
      return null;
    }
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined || baseSha === undefined) {
      ctx.errors.push({ message: 'Head or base branch does not exist' });
      return null;
    }
    const issue = forge.createIssue(repo, {
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
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
      draft: input.draft === true,
    });
    return new GObj('CreatePullRequestPayload', { pullRequest: pullObj(repo, issue), clientMutationId: input.clientMutationId ?? null });
  },
  mergePullRequest: (_s, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGid(String(input.pullRequestId ?? ''));
    const issue = decoded !== null ? forge.issues.get(Number(decoded.id)) : undefined;
    const pull = issue !== undefined ? forge.pulls.get(issue.id) : undefined;
    if (issue === undefined || pull === undefined) {
      ctx.errors.push({ message: 'Pull request not found' });
      return null;
    }
    const repo = forge.repos.get(issue.repoKey) as RepoRec;
    // Delegate the merge itself to the same tree-merge the REST path uses.
    const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const base = mergeBase(baseSha, headSha);
    if (base === null) {
      ctx.errors.push({ message: 'Pull Request is not mergeable' });
      return null;
    }
    const treeOf = (sha: string): string => parseCommit(forge.objects.get(sha)?.data as Buffer).tree;
    const baseFiles = flattenTree(treeOf(baseSha));
    const headFiles = flattenTree(treeOf(headSha));
    const ancFiles = flattenTree(treeOf(base));
    const mergedFiles = new Map<string, { id: string; mode: string; name: string }>();
    let conflict = false;
    for (const path of new Set([...baseFiles.keys(), ...headFiles.keys(), ...ancFiles.keys()])) {
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      const a = ancFiles.get(path);
      if (h?.id !== a?.id && b?.id !== a?.id && h?.id !== b?.id) conflict = true;
      const chosen = h?.id !== a?.id ? h : b;
      if (chosen !== undefined) mergedFiles.set(path, chosen);
    }
    if (conflict) {
      ctx.errors.push({ message: 'Pull Request is not mergeable' });
      return null;
    }
    let treeRoot: string | null = null;
    for (const [path, entry] of mergedFiles) {
      treeRoot = setPathImpl(treeRoot, path.split('/'), entry.id, entry.mode);
    }
    if (treeRoot === null) treeRoot = forge.objects.put('tree', buildTreeImpl([]));
    const now = Math.floor(Date.now() / 1000);
    const viewer = forge.viewer();
    const ident = `${viewer.name} <${viewer.email}> ${now} +0000`;
    const mergeSha = forge.objects.put('commit', buildCommitImpl({
      tree: treeRoot,
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
    return new GObj('MergePullRequestPayload', { pullRequest: pullObj(repo, issue), clientMutationId: input.clientMutationId ?? null });
  },
  addComment: (_s, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGid(String(input.subjectId ?? ''));
    const issue = decoded !== null ? forge.issues.get(Number(decoded.id)) : undefined;
    if (issue === undefined) {
      ctx.errors.push({ message: 'Subject not found' });
      return null;
    }
    const repo = forge.repos.get(issue.repoKey) as RepoRec;
    const comment = forge.createComment(issue, forge.viewer().login, String(input.body ?? ''));
    const node = new GObj('IssueComment', {
      id: commentGid(comment.id),
      databaseId: comment.id,
      body: comment.body,
      createdAt: iso(comment.createdAt),
      updatedAt: iso(comment.updatedAt),
      authorLogin: comment.userLogin,
      repo,
    });
    return new GObj('AddCommentPayload', {
      commentEdge: new GObj('IssueCommentEdge', { node, cursor: cursorOf(0) }),
      subject: issue.isPull ? pullObj(repo, issue) : issueObj(repo, issue),
      clientMutationId: input.clientMutationId ?? null,
    });
  },
};

// Tree rebuilding over git.ts primitives (the same walk app.ts's updateTree
// performs, kept local so this module's imports stay one-way).
import { buildTree as buildTreeImpl, buildCommit as buildCommitImpl, parseTree as parseTreeImpl } from './git.ts';

function setPathImpl(rootId: string | null, segments: string[], blobId: string, mode: string): string {
  const entries: Array<{ mode: string; name: string; id: string }> =
    rootId !== null && forge.objects.get(rootId)?.type === 'tree'
      ? [...parseTreeImpl(forge.objects.get(rootId)?.data as Buffer)]
      : [];
  const head = segments[0] as string;
  const index = entries.findIndex((e) => e.name === head);
  if (segments.length === 1) {
    if (index !== -1) entries[index] = { mode, name: head, id: blobId };
    else entries.push({ mode, name: head, id: blobId });
  } else {
    const childRoot = index !== -1 && entries[index]?.mode === '40000' ? (entries[index] as { id: string }).id : null;
    const newChild = setPathImpl(childRoot, segments.slice(1), blobId, mode);
    if (index !== -1) entries[index] = { mode: '40000', name: head, id: newChild };
    else entries.push({ mode: '40000', name: head, id: newChild });
  }
  return forge.objects.put('tree', buildTreeImpl(entries));
}

const payloadResolvers: Record<string, Record<string, Resolver>> = {
  CreateIssuePayload: { issue: (s) => s.data.issue, clientMutationId: (s) => s.data.clientMutationId },
  CloseIssuePayload: { issue: (s) => s.data.issue, clientMutationId: (s) => s.data.clientMutationId },
  ReopenIssuePayload: { issue: (s) => s.data.issue, clientMutationId: (s) => s.data.clientMutationId },
  CreatePullRequestPayload: { pullRequest: (s) => s.data.pullRequest, clientMutationId: (s) => s.data.clientMutationId },
  MergePullRequestPayload: { pullRequest: (s) => s.data.pullRequest, clientMutationId: (s) => s.data.clientMutationId },
  AddCommentPayload: {
    commentEdge: (s) => s.data.commentEdge,
    subject: (s) => s.data.subject,
    clientMutationId: (s) => s.data.clientMutationId,
  },
  IssueCommentEdge: { node: (s) => s.data.node, cursor: (s) => s.data.cursor },
};

Object.assign(resolvers, payloadResolvers);
resolvers.Mutation = mutationResolvers;
resolvers.Query = { ...resolvers.Query };

// ---------------------------------------------------------------- execution

function executeSelectionSet(
  typeName: string,
  source: GObj,
  selections: Selection[],
  ctx: ExecCtx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.spread !== null) {
      const fragment = ctx.fragments.get(selection.spread);
      if (fragment !== undefined) Object.assign(out, executeSelectionSet(typeName, source, fragment, ctx));
      continue;
    }
    if (selection.name === null) {
      // Inline fragment: apply when the type matches (or no condition).
      if (selection.fragmentType === null || selection.fragmentType === typeName) {
        Object.assign(out, executeSelectionSet(typeName, source, selection.selectionSet ?? [], ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const typeResolvers = resolvers[typeName];
    const resolver = typeResolvers?.[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args = argsOf(selection, ctx);
    const value = resolver(source, args, ctx);
    out[key] = completeValue(value, selection, ctx);
  }
  return out;
}

function completeValue(value: unknown, selection: Selection, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, selection, ctx));
  if (value instanceof GObj) {
    if (selection.selectionSet === null) return value.data.id ?? null;
    return executeSelectionSet(value.type, value, selection.selectionSet, ctx);
  }
  return value;
}

export function executeGraphQL(
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const ctx: ExecCtx = { variables, fragments: new Map(), errors: [] };
  try {
    const parser = new Parser(tokenize(query));
    const doc = parser.parseDocument();
    ctx.fragments = doc.fragments;
    const operation =
      doc.operations.find((op) => operationName === undefined || op.name === operationName) ?? doc.operations[0];
    if (operation === undefined) return { data: null, errors: [{ message: 'No operation in document' }] };
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const root = new GObj(rootType, {});
    const data = executeSelectionSet(rootType, root, operation.selectionSet, ctx);
    const result: { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } = { data };
    if (ctx.errors.length > 0) result.errors = ctx.errors;
    return result;
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
}

// ---------------------------------------------------------------- http

/** Handle POST /api/graphql; returns true when the path matched. */
export function handleGraphQL(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Buffer,
  authed: boolean,
): boolean {
  if (url.pathname !== '/api/graphql' || req.method !== 'POST') return false;
  const send = (status: number, payload: unknown): void => {
    const text = `${JSON.stringify(payload)}\n`;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  if (!authed) {
    send(401, { message: 'Requires authentication' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    send(400, { errors: [{ message: 'Problems parsing JSON' }] });
    return true;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((op) => {
      const operation = op as { query?: string; variables?: Record<string, unknown>; operationName?: string };
      return executeGraphQL(String(operation.query ?? ''), operation.variables ?? {}, operation.operationName);
    });
    send(200, results);
    return true;
  }
  const operation = parsed as { query?: string; variables?: Record<string, unknown>; operationName?: string };
  const result = executeGraphQL(String(operation.query ?? ''), operation.variables ?? {}, operation.operationName);
  send(200, result);
  return true;
}
