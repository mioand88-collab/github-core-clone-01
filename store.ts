// The forge's state: users, repositories, issues and pull requests, held in
// memory over one shared git object store. A trial is one process lifetime,
// so nothing persists to disk; every repository's refs live beside its
// record, and every object ever pushed or created through the API lands in
// the same store the git wire protocol reads from.

import { ObjectStore } from './git.ts';
import { SCENARIO_ORG, SCENARIO_USERS, SCENARIO_VIEWER } from './scenario.ts';

export interface UserRec {
  id: number;
  login: string;
  name: string;
  email: string;
  type: 'User' | 'Organization';
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  homepage: string;
  private: boolean;
  defaultBranch: string;
  createdAt: number;
  updatedAt: number;
  pushedAt: number;
  /** Full ref name (refs/heads/main, refs/tags/v1) -> object id. */
  refs: Map<string, string>;
  nextIssueNumber: number;
  /** Label name (lowercased key) -> label. */
  labels: Map<string, LabelRec>;
}

export interface IssueRec {
  id: number;
  repoKey: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  userLogin: string;
  labels: string[];
  assignees: string[];
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  isPull: boolean;
}

export interface PullRec {
  issueId: number;
  headRepoKey: string;
  headRef: string;
  headSha: string;
  baseRepoKey: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  draft: boolean;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  id: number;
  issueId: number;
  body: string;
  userLogin: string;
  createdAt: number;
  updatedAt: number;
}

export function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export class Forge {
  readonly objects = new ObjectStore();
  readonly users = new Map<string, UserRec>();
  readonly repos = new Map<string, RepoRec>();
  readonly issues = new Map<number, IssueRec>();
  readonly pulls = new Map<number, PullRec>();
  readonly comments = new Map<number, CommentRec>();
  private nextUserId = 1000;
  private nextRepoId = 5000;
  private nextIssueId = 1;
  private nextCommentId = 1;

  createComment(issue: IssueRec, userLogin: string, body: string): CommentRec {
    const now = Math.floor(Date.now() / 1000);
    const comment: CommentRec = {
      id: this.nextCommentId,
      issueId: issue.id,
      body,
      userLogin,
      createdAt: now,
      updatedAt: now,
    };
    this.nextCommentId += 1;
    this.comments.set(comment.id, comment);
    return comment;
  }

  commentsOf(issue: IssueRec): CommentRec[] {
    return [...this.comments.values()]
      .filter((c) => c.issueId === issue.id)
      .sort((a, b) => a.id - b.id);
  }

  constructor() {
    // The seeded cast exists from the start: the viewer, their teammates and
    // strangers, and the scenario organisation, with their seeded ids.
    for (const seeded of SCENARIO_USERS) {
      this.users.set(seeded.login.toLowerCase(), { ...seeded, type: 'User' });
    }
    const org: UserRec = {
      id: 900,
      login: SCENARIO_ORG,
      name: SCENARIO_ORG,
      email: `${SCENARIO_ORG}@example.invalid`,
      type: 'Organization',
    };
    this.users.set(SCENARIO_ORG.toLowerCase(), org);
    this.nextUserId = 1000 + SCENARIO_USERS.length;
  }

  /** The user a login names, created on first sight (logins are case-insensitive). */
  user(login: string): UserRec {
    const key = login.toLowerCase();
    let user = this.users.get(key);
    if (user === undefined) {
      user = {
        id: this.nextUserId,
        login,
        name: login,
        email: `${login}@example.invalid`,
        type: 'User',
      };
      this.nextUserId += 1;
      this.users.set(key, user);
    }
    return user;
  }

  /** The user a bearer token authenticates as: the scenario viewer. */
  viewer(): UserRec {
    return this.user(SCENARIO_VIEWER.login);
  }

  createRepo(owner: string, name: string, init: Partial<RepoRec>): RepoRec {
    const now = Math.floor(Date.now() / 1000);
    const repo: RepoRec = {
      id: this.nextRepoId,
      owner,
      name,
      description: init.description ?? '',
      homepage: init.homepage ?? '',
      private: init.private ?? false,
      defaultBranch: init.defaultBranch ?? 'main',
      createdAt: now,
      updatedAt: now,
      pushedAt: now,
      refs: new Map(),
      nextIssueNumber: 1,
      labels: new Map(),
    };
    this.nextRepoId += 1;
    this.repos.set(repoKey(owner, name), repo);
    return repo;
  }

  repo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  createIssue(repo: RepoRec, init: Partial<IssueRec> & { isPull: boolean }): IssueRec {
    const now = Math.floor(Date.now() / 1000);
    const issue: IssueRec = {
      id: this.nextIssueId,
      repoKey: repoKey(repo.owner, repo.name),
      number: repo.nextIssueNumber,
      title: init.title ?? '',
      body: init.body ?? '',
      state: 'open',
      userLogin: init.userLogin ?? FORGE_VIEWER_LOGIN,
      labels: init.labels ?? [],
      assignees: init.assignees ?? [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      isPull: init.isPull,
    };
    this.nextIssueId += 1;
    repo.nextIssueNumber += 1;
    this.issues.set(issue.id, issue);
    return issue;
  }

  issueByNumber(repo: RepoRec, number: number): IssueRec | undefined {
    for (const issue of this.issues.values()) {
      if (issue.repoKey === repoKey(repo.owner, repo.name) && issue.number === number) return issue;
    }
    return undefined;
  }

  issuesOf(repo: RepoRec): IssueRec[] {
    return [...this.issues.values()]
      .filter((issue) => issue.repoKey === repoKey(repo.owner, repo.name))
      .sort((a, b) => a.number - b.number);
  }
}

/** The login every bearer token authenticates as in this forge. */
export const FORGE_VIEWER_LOGIN = SCENARIO_VIEWER.login;
