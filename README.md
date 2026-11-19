# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/mioand88-collab/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/mioand88-collab/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone GitHub-compatible git forge that runs as one Node process with no dependencies and no git binary: an in-memory object store with a pure-TypeScript packfile codec (deltas included) speaks git smart HTTP in both protocol versions — advertisement, ls-refs, fetch with shallow/deepen, receive-pack with fast-forward protection — while the same store backs a GitHub REST v3 surface (repositories, contents, branches, git data, issues, comments, labels, pull requests with three-way merges), a GraphQL v4 executor covering the documents the `gh` CLI sends (Relay global ids, connections with cursor pagination, introspection probes, batched operations), and an MCP endpoint offering the repository/issue/pull-request tools. State lives entirely in memory over one shared object database, so every surface always agrees with every other.

## Run it

```sh
MAKEFUN_ENV_URL=http://store:8080 node main.ts
```

`main.ts` binds an ephemeral port, registers it with the grading environment, serves until the environment says the trial is done, and exits 0. Without `MAKEFUN_ENV_URL` there is nothing to register with and the program exits 1. Node 22.18 or later; nothing to install.

## Layout

- `main.ts` — the entry/environment lifecycle
- `app.ts` — HTTP routing and the REST v3 surface
- `git.ts` — the object store and packfile codec
- `githttp.ts` — the git smart-HTTP protocol (v0 and v2)
- `graphql.ts` — the GraphQL v4 executor
- `mcp.ts` — the MCP tool endpoint
- `store.ts`, `scenario.ts` — forge state and the seeded user cast

---

Entered on [make.fun](https://make.fun/?ref=r2sxe3g2&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards
