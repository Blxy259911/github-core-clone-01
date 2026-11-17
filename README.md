[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Blxy259911/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Blxy259911/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone-01

A GitHub-compatible git forge for the [make.fun github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01): build a GitHub-compatible git forge.

`main.ts` (Node 22, standard library only) is the whole entry: git smart HTTP (v2/v0, packfile, shallow, receive-pack), REST v3 (repos, issues, pulls, contents, refs), GraphQL v4 (viewer, repository, issues, pull requests, mutations, introspection, node(id:)), and MCP over streamable HTTP (6 tools). No dependencies, no git binary, no network.

Local grading with the official kit, practice trial-0: 961/1000 (feature 600/600, agent 200/200, perf 161/200).

## Run it

```sh
node --experimental-strip-types main.ts
```

## License

MIT
