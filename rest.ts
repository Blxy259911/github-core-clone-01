// REST v3 handlers. One shared Store; the same data backs GraphQL, MCP and git.
// Shapes follow what the kit's checks assert (checks-rest.ts); extra fields are harmless.

import type { IncomingMessage } from 'node:http';
import { buildTreeFromFiles, flattenTree, ident, parseCommit, readFileAtCommit, serialiseCommit } from './git.ts';
import { VIEWER, globalId, userByLogin, type Issue, type Pull, type Repo, type Store } from './store.ts';

export interface Ctx {
  store: Store;
  method: string;
  segments: string[];
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  host: string;
  bodyText: string;
}

export interface Reply {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

const noContent = (status: number): Reply => ({ status, json: null });

export function err(status: number, message: string): Reply {
  return { status, json: { message } };
}

export function ok(status: number, json: unknown, headers: Record<string, string> = {}): Reply {
  return { status, json, headers };
}

/** Bearer check: missing or wrong token is 401. /healthz never reaches here. */
export function checkAuth(ctx: Ctx): Reply | null {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const auth = ctx.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ') || auth.slice(7).length === 0) {
    return err(401, 'Requires authentication');
  }
  if (expected !== '' && auth.slice(7) !== expected) {
    return err(401, 'Bad credentials');
  }
  return null;
}

export function parseBody(ctx: Ctx): { value: Record<string, unknown> } | { error: Reply } {
  if (ctx.bodyText === '') return { value: {} };
  try {
    const v: unknown = JSON.parse(ctx.bodyText);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return { error: err(400, 'Problems parsing JSON') };
    }
    return { value: v as Record<string, unknown> };
  } catch {
    return { error: err(400, 'Problems parsing JSON') };
  }
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = userByLogin(repo.owner) ?? VIEWER;
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: owner.login, id: owner.id, type: 'User', avatar_url: '', html_url: '' },
    private: repo.private,
    description: repo.description,
    fork: false,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: '',
    git_url: '',
    ssh_url: '',
    homepage: '',
    language: null,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.user.login, id: issue.user.id, type: 'User' },
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color, id: 0, node_id: '', url: '', default: false, description: '' })),
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

function commentJson(repo: Repo, issue: Issue, c: { id: number; body: string; user: { id: number; login: string }; created_at: string; updated_at: string }): Record<string, unknown> {
  return {
    id: c.id,
    node_id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}:${c.id}`),
    body: c.body,
    user: { login: c.user.login, id: c.user.id, type: 'User' },
    created_at: c.created_at,
    updated_at: c.updated_at,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${c.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** Resolve /repos/{owner}/{name} from segments; 404 when missing or not the viewer's. */
function resolveRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Create a commit on `branch` that sets `path` to `content` (null = delete). */
export function commitFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { sha: string; tree: string } {
  const tip = branchTip(repo, branch);
  const files = new Map<string, string>();
  if (tip) {
    const commit = store.getObject(tip);
    if (commit && commit.type === 'commit') {
      const flat = flattenTree(store, parseCommit(commit.bytes).tree);
      for (const [p, e] of flat) files.set(p, e.oid);
    }
  }
  if (content === null) {
    files.delete(path);
  } else {
    files.set(path, store.putObject('blob', content));
  }
  const tree = buildTreeFromFiles(store, files);
  const epoch = 1735689600 + Math.floor(Date.parse(repo.created_at) / 1000 - 1735689600);
  const author = ident(VIEWER.login, VIEWER.email, 1735689600 + store.requestCounter);
  const parents = tip ? [tip] : [];
  const sha = store.putObject('commit', serialiseCommit({ tree, parents, author, committer: author, message }));
  repo.refs.set(`refs/heads/${branch}`, sha);
  repo.updated_at = store.now();
  repo.pushed_at = repo.updated_at;
  return { sha, tree };
}

/** Walk a branch's history newest-first (follows first parents only). */
export function listCommits(store: Store, repo: Repo, branch: string): string[] {
  const out: string[] = [];
  let tip = branchTip(repo, branch);
  const seen = new Set<string>();
  while (tip && !seen.has(tip)) {
    seen.add(tip);
    out.push(tip);
    const obj = store.getObject(tip);
    if (!obj || obj.type !== 'commit') break;
    tip = parseCommit(obj.bytes).parents[0] ?? null;
  }
  return out;
}

function commitJson(store: Store, sha: string): Record<string, unknown> {
  const obj = store.getObject(sha);
  const c = obj && obj.type === 'commit' ? parseCommit(obj.bytes) : { tree: '', parents: [] as string[], author: '', committer: '', message: '' };
  const authorName = c.author.split(' <')[0] || VIEWER.login;
  return {
    sha,
    node_id: globalId('Commit', sha),
    commit: {
      message: c.message,
      author: { name: authorName, email: VIEWER.email, date: '' },
      committer: { name: authorName, email: VIEWER.email, date: '' },
      tree: { sha: c.tree },
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: c.parents.map((p) => ({ sha: p })),
    html_url: '',
    url: '',
  };
}

/** All ancestors of a commit tip (following every parent). */
export function ancestorsOf(store: Store, tip: string | null): Set<string> {
  const out = new Set<string>();
  const stack = tip ? [tip] : [];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.add(oid);
    stack.push(...parseCommit(obj.bytes).parents);
  }
  return out;
}

/** First common ancestor of two tips (walk a's ancestors, then b's first-parent line). */
export function findMergeBase(store: Store, a: string | null, b: string | null): string | null {
  if (!a || !b) return null;
  const aAnc = ancestorsOf(store, a);
  let tip: string | null = b;
  const seen = new Set<string>();
  while (tip && !seen.has(tip)) {
    seen.add(tip);
    if (aAnc.has(tip)) return tip;
    const obj = store.getObject(tip);
    if (!obj || obj.type !== 'commit') break;
    tip = parseCommit(obj.bytes).parents[0] ?? null;
  }
  return null;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Multiset line diff: lines gained vs lines lost. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldCount = new Map<string, number>();
  for (const l of countLines(oldText)) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of countLines(newText)) {
    const left = oldCount.get(l) ?? 0;
    if (left > 0) oldCount.set(l, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCount.values()) deletions += left;
  return { additions, deletions };
}

function blobText(store: Store, oid: string): string {
  const blob = store.getObject(oid);
  return blob && blob.type === 'blob' ? blob.bytes.toString('utf8') : '';
}

/** Diff two trees (by oid): flat path list with line counts. */
export function diffTrees(store: Store, baseTree: string, headTree: string): FileChange[] {
  const base = flattenTree(store, baseTree);
  const head = flattenTree(store, headTree);
  const out: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const deletions = countLines(blobText(store, b.oid)).length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!b && h) {
      const additions = countLines(blobText(store, h.oid)).length;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && h && b.oid !== h.oid) {
      const { additions, deletions } = lineDiff(blobText(store, b.oid), blobText(store, h.oid));
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** The GitHub pull-request JSON shape (head/base sha read live from the refs). */
export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: repo.id * 100000 + 50000 + pull.number,
    node_id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: { login: pull.user.login, id: pull.user.id, type: 'User' },
    head: {
      ref: pull.headRef,
      sha: headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    },
    base: {
      ref: pull.baseRef,
      sha: baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    },
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    draft: false,
    mergeable: pull.state === 'open',
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.state === 'closed' ? pull.updated_at : null,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** Create an issue record (shared by REST and MCP). Labels must already exist on the repo. */
export function createIssueRecord(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  labelNames: string[],
): { issue: Issue } | { error: Reply } {
  if (title === '') return { error: err(422, 'title is required') };
  const labels: { name: string; color: string }[] = [];
  for (const ln of labelNames) {
    const found = repo.labels.get(ln);
    if (!found) return { error: err(422, `Label does not exist: ${ln}`) };
    labels.push(found);
  }
  const ts = store.now();
  repo.issueCounter += 1;
  const issue: Issue = {
    number: repo.issueCounter,
    title,
    body,
    state: 'open',
    labels,
    user: { id: VIEWER.id, login: VIEWER.login },
    created_at: ts,
    updated_at: ts,
    closed_at: null,
    comments: [],
  };
  repo.issues.set(issue.number, issue);
  return { issue };
}

/** Create a pull request record (shared by REST and MCP). */
export function createPullRecord(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; head: string; base: string },
): { pull: Pull } | { error: Reply } {
  if (input.title === '') return { error: err(422, 'title is required') };
  const headSha = repo.refs.get(`refs/heads/${input.head}`);
  const baseSha = repo.refs.get(`refs/heads/${input.base}`);
  if (!headSha) return { error: err(422, `Head branch does not exist: ${input.head}`) };
  if (!baseSha) return { error: err(422, `Base branch does not exist: ${input.base}`) };
  const ts = store.now();
  repo.pullCounter += 1;
  const pull: Pull = {
    number: repo.pullCounter,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    headRef: input.head,
    headSha,
    baseRef: input.base,
    baseSha,
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    user: { id: VIEWER.id, login: VIEWER.login },
    created_at: ts,
    updated_at: ts,
  };
  repo.pulls.set(pull.number, pull);
  return { pull };
}

/** Create a commit with an explicit tree and parents on `branch`. */
function createCommitOn(store: Store, repo: Repo, branch: string, tree: string, parents: string[], message: string): string {
  const author = ident(VIEWER.login, VIEWER.email, 1735689600 + store.requestCounter);
  const sha = store.putObject('commit', serialiseCommit({ tree, parents, author, committer: author, message }));
  repo.refs.set(`refs/heads/${branch}`, sha);
  repo.updated_at = store.now();
  repo.pushed_at = repo.updated_at;
  return sha;
}

/**
 * Squash-merge a pull request (shared by REST and MCP). Three-way conflict check:
 * a path changed on both sides of the merge-base with different results conflicts (405).
 * On success the merge commit's tree is the base tree with the head's changes applied,
 * its parents are [base tip, head tip], and the base ref moves to it.
 */
export function mergePullRecord(
  store: Store,
  repo: Repo,
  number: number,
  commitMessage?: string,
): { sha: string; pull: Pull } | { error: Reply } {
  const pull = repo.pulls.get(number);
  if (!pull) return { error: err(404, 'Not Found') };
  if (pull.merged && pull.merge_commit_sha) return { sha: pull.merge_commit_sha, pull };
  if (pull.state !== 'open') return { error: err(405, 'Pull request is closed') };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return { error: err(422, 'Head or base branch is missing') };
  const baseObj = store.getObject(baseTip);
  const headObj = store.getObject(headTip);
  if (!baseObj || baseObj.type !== 'commit' || !headObj || headObj.type !== 'commit') {
    return { error: err(422, 'Head or base commit is missing') };
  }
  const baseTree = parseCommit(baseObj.bytes).tree;
  const headTree = parseCommit(headObj.bytes).tree;
  const mergeBase = findMergeBase(store, baseTip, headTip);
  const mergeBaseTree = mergeBase ? parseCommit(store.getObject(mergeBase)!.bytes).tree : '';
  const baseChanges = diffTrees(store, mergeBaseTree, baseTree);
  const headChanges = diffTrees(store, mergeBaseTree, headTree);
  const baseChanged = new Set(baseChanges.map((c) => c.filename));
  const headFlat = flattenTree(store, headTree);
  const baseFlat = flattenTree(store, baseTree);
  for (const hc of headChanges) {
    if (!baseChanged.has(hc.filename)) continue;
    const headOid = headFlat.get(hc.filename)?.oid ?? null;
    const baseOid = baseFlat.get(hc.filename)?.oid ?? null;
    if (headOid !== baseOid) return { error: err(405, 'Merge conflict') };
  }
  const merged = new Map<string, string>();
  for (const [p, e] of baseFlat) merged.set(p, e.oid);
  for (const hc of headChanges) {
    if (hc.status === 'removed') merged.delete(hc.filename);
    else {
      const oid = headFlat.get(hc.filename)?.oid;
      if (oid) merged.set(hc.filename, oid);
    }
  }
  const tree = buildTreeFromFiles(store, merged);
  const message = commitMessage && commitMessage !== '' ? commitMessage : `Merge pull request #${pull.number}`;
  const sha = createCommitOn(store, repo, pull.baseRef, tree, [baseTip, headTip], message);
  const ts = store.now();
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = ts;
  pull.merge_commit_sha = sha;
  pull.updated_at = ts;
  return { sha, pull };
}

/** Pagination Link header (GitHub format, absolute URLs). */
function pageLinks(ctx: Ctx, basePath: string, page: number, perPage: number, total: number): string {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const url = (p: number): string => `http://${ctx.host}${basePath}?page=${p}&per_page=${perPage}`;
  const parts: string[] = [];
  if (page < lastPage) {
    parts.push(`<${url(page + 1)}>; rel="next"`, `<${url(lastPage)}>; rel="last"`);
  }
  if (page > 1) {
    parts.push(`<${url(1)}>; rel="first"`, `<${url(page - 1)}>; rel="prev"`);
  }
  return parts.join(', ');
}

/** Dispatch one /api/v3 request. Returns null when the path is not a REST route. */
export function handleRest(ctx: Ctx): Reply | null {
  const s = ctx.segments; // after /api/v3
  const m = ctx.method;

  // GET /api/v3/ (root) — starter behaviour, plus auth already checked by app.ts.
  if ((s.length === 0 || (s.length === 1 && s[0] === '')) && m === 'GET') {
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (s.length === 1 && s[0] === 'meta' && m === 'GET') {
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // GET /api/v3/user
  if (s.length === 1 && s[0] === 'user' && m === 'GET') {
    return ok(200, { login: VIEWER.login, id: VIEWER.id, type: 'User', name: VIEWER.name, email: VIEWER.email, avatar_url: '', html_url: '' });
  }

  // POST /api/v3/user/repos
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos' && m === 'POST') {
    const parsed = parseBody(ctx);
    if ('error' in parsed) return parsed.error;
    const name = str(parsed.value.name);
    if (name === '') return err(422, 'name is required');
    if (ctx.store.getRepo(VIEWER.login, name)) return err(422, 'name already exists on this account');
    const repo = ctx.store.createRepo(VIEWER.login, name, {
      private: bool(parsed.value.private, false),
      description: str(parsed.value.description),
      default_branch: str(parsed.value.default_branch, 'main') || 'main',
    });
    return ok(201, repoJson(ctx.store, repo));
  }

  // GET /api/v3/user/repos (paginated)
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos' && m === 'GET') {
    const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? '30') || 30));
    const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
    const all = ctx.store.viewerRepos();
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    const links = pageLinks(ctx, '/api/v3/user/repos', page, perPage, all.length);
    if (links !== '') headers.link = links;
    return ok(200, slice.map((r) => repoJson(ctx.store, r)), headers);
  }

  // /api/v3/repos/{owner}/{name}/...
  if (s.length >= 3 && s[0] === 'repos') {
    const [, owner, name, ...rest] = s;
    const repo = resolveRepo(ctx, owner, name);

    // GET /repos/{o}/{r}
    if (rest.length === 0 && m === 'GET') {
      if (!repo) return err(404, 'Not Found');
      return ok(200, repoJson(ctx.store, repo));
    }
    // PATCH /repos/{o}/{r}
    if (rest.length === 0 && m === 'PATCH') {
      if (!repo) return err(404, 'Not Found');
      const parsed = parseBody(ctx);
      if ('error' in parsed) return parsed.error;
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.default_branch === 'string' && parsed.value.default_branch !== '') repo.default_branch = parsed.value.default_branch;
      repo.updated_at = ctx.store.now();
      return ok(200, repoJson(ctx.store, repo));
    }
    // DELETE /repos/{o}/{r}
    if (rest.length === 0 && m === 'DELETE') {
      if (!repo) return err(404, 'Not Found');
      ctx.store.deleteRepo(owner, name);
      return noContent(204);
    }
    if (!repo) return err(404, 'Not Found');

    // GET /repos/{o}/{r}/branches
    if (rest.length === 1 && rest[0] === 'branches' && m === 'GET') {
      const out = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha, url: `/api/v3/repos/${owner}/${name}/commits/${sha}` },
          protected: false,
        }));
      return ok(200, out);
    }

    // GET /repos/{o}/{r}/commits
    if (rest.length === 1 && rest[0] === 'commits' && m === 'GET') {
      const branch = ctx.query.get('sha') ?? repo.default_branch;
      const shas = listCommits(ctx.store, repo, branch);
      return ok(200, shas.map((sha) => commitJson(ctx.store, sha)));
    }

    // POST /repos/{o}/{r}/git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && m === 'POST') {
      const parsed = parseBody(ctx);
      if ('error' in parsed) return parsed.error;
      const ref = str(parsed.value.ref);
      const sha = str(parsed.value.sha);
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return err(422, 'Invalid ref or sha');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      if (!ctx.store.getObject(sha)) return err(422, 'Object does not exist');
      repo.refs.set(ref, sha);
      return ok(201, {
        ref,
        node_id: globalId('Ref', `${owner}/${name}:${ref}`),
        url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.slice(5)}`,
        object: { sha, type: 'commit', url: '' },
      });
    }

    // GET /repos/{o}/{r}/git/refs[/...]
    if (rest.length >= 2 && rest[0] === 'git' && rest[1] === 'refs' && m === 'GET') {
      const wanted = rest.length > 2 ? `refs/${rest.slice(2).join('/')}` : '';
      const matches = [...repo.refs.entries()].filter(([ref]) => wanted === '' || ref === wanted || ref.startsWith(`${wanted}/`));
      if (matches.length === 0) return err(404, 'Not Found');
      const toJson = ([ref, sha]: [string, string]): Record<string, unknown> => ({
        ref,
        node_id: globalId('Ref', `${owner}/${name}:${ref}`),
        url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.slice(5)}`,
        object: { sha, type: 'commit', url: '' },
      });
      if (wanted !== '' && matches.length === 1) return ok(200, toJson(matches[0]));
      return ok(200, matches.map(toJson));
    }

    // Labels
    if (rest.length === 1 && rest[0] === 'labels' && m === 'GET') {
      return ok(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, id: 0, node_id: '', url: '', default: false, description: '' })));
    }
    if (rest.length === 1 && rest[0] === 'labels' && m === 'POST') {
      const parsed = parseBody(ctx);
      if ('error' in parsed) return parsed.error;
      const labelName = str(parsed.value.name);
      if (labelName === '') return err(422, 'name is required');
      const label = { name: labelName, color: str(parsed.value.color, 'ededed') };
      repo.labels.set(labelName, label);
      return ok(201, { name: label.name, color: label.color, id: 0, node_id: '', url: '', default: false, description: '' });
    }

    // Issues
    if (rest.length === 1 && rest[0] === 'issues' && m === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      return ok(200, list.map((i) => issueJson(repo, i)));
    }
    if (rest.length === 1 && rest[0] === 'issues' && m === 'POST') {
      const parsed = parseBody(ctx);
      if ('error' in parsed) return parsed.error;
      const labelNames: string[] = Array.isArray(parsed.value.labels)
        ? (parsed.value.labels as unknown[]).map((l) => (typeof l === 'string' ? l : str((l as Record<string, unknown>).name)))
        : [];
      const created = createIssueRecord(ctx.store, repo, str(parsed.value.title), str(parsed.value.body), labelNames);
      if ('error' in created) return created.error;
      return ok(201, issueJson(repo, created.issue));
    }

    // GET/PATCH /repos/{o}/{r}/issues/{n}
    if (rest.length === 2 && rest[0] === 'issues' && /^\d+$/.test(rest[1])) {
      const n = Number(rest[1]);
      const issue = repo.issues.get(n);
      if (!issue) return err(404, 'Not Found');
      if (m === 'GET') return ok(200, issueJson(repo, issue));
      if (m === 'PATCH') {
        const parsed = parseBody(ctx);
        if ('error' in parsed) return parsed.error;
        if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
        if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
        if (parsed.value.state === 'open' || parsed.value.state === 'closed') {
          issue.state = parsed.value.state;
          issue.closed_at = parsed.value.state === 'closed' ? ctx.store.now() : null;
        }
        issue.updated_at = ctx.store.now();
        return ok(200, issueJson(repo, issue));
      }
    }

    // Issue comments
    if (rest.length === 3 && rest[0] === 'issues' && /^\d+$/.test(rest[1]) && rest[2] === 'comments') {
      const issue = repo.issues.get(Number(rest[1]));
      if (!issue) return err(404, 'Not Found');
      if (m === 'GET') return ok(200, issue.comments.map((c) => commentJson(repo, issue, c)));
      if (m === 'POST') {
        const parsed = parseBody(ctx);
        if ('error' in parsed) return parsed.error;
        const body = str(parsed.value.body);
        if (body === '') return err(422, 'body is required');
        const ts = ctx.store.now();
        repo.commentCounter += 1;
        const comment = { id: repo.commentCounter, body, user: { id: VIEWER.id, login: VIEWER.login }, created_at: ts, updated_at: ts };
        issue.comments.push(comment);
        issue.updated_at = ts;
        return ok(201, commentJson(repo, issue, comment));
      }
    }

    // Pulls
    if (rest.length === 1 && rest[0] === 'pulls' && m === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      return ok(200, list.map((p) => pullJson(ctx.store, repo, p)));
    }
    if (rest.length === 1 && rest[0] === 'pulls' && m === 'POST') {
      const parsed = parseBody(ctx);
      if ('error' in parsed) return parsed.error;
      const created = createPullRecord(ctx.store, repo, {
        title: str(parsed.value.title),
        body: str(parsed.value.body),
        head: str(parsed.value.head),
        base: str(parsed.value.base),
      });
      if ('error' in created) return created.error;
      return ok(201, pullJson(ctx.store, repo, created.pull));
    }
    if (rest.length === 2 && rest[0] === 'pulls' && /^\d+$/.test(rest[1]) && m === 'GET') {
      const pull = repo.pulls.get(Number(rest[1]));
      if (!pull) return err(404, 'Not Found');
      return ok(200, pullJson(ctx.store, repo, pull));
    }
    if (rest.length === 3 && rest[0] === 'pulls' && /^\d+$/.test(rest[1]) && rest[2] === 'files' && m === 'GET') {
      const pull = repo.pulls.get(Number(rest[1]));
      if (!pull) return err(404, 'Not Found');
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
      if (!baseTip || !headTip) return err(422, 'Head or base branch is missing');
      const mergeBase = findMergeBase(ctx.store, baseTip, headTip);
      const baseObj = mergeBase ? ctx.store.getObject(mergeBase) : ctx.store.getObject(baseTip);
      const headObj = ctx.store.getObject(headTip);
      if (!baseObj || baseObj.type !== 'commit' || !headObj || headObj.type !== 'commit') {
        return err(422, 'Head or base commit is missing');
      }
      const files = diffTrees(ctx.store, parseCommit(baseObj.bytes).tree, parseCommit(headObj.bytes).tree);
      return ok(200, files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes })));
    }
    if (rest.length === 3 && rest[0] === 'pulls' && /^\d+$/.test(rest[1]) && rest[2] === 'merge' && m === 'PUT') {
      const parsed = parseBody(ctx);
      if ('error' in parsed) return parsed.error;
      const merged = mergePullRecord(ctx.store, repo, Number(rest[1]), str(parsed.value.commit_message));
      if ('error' in merged) return merged.error;
      return ok(200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
    }

    // Contents: /repos/{o}/{r}/contents/{path...}
    if (rest.length >= 2 && rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      const branch = ctx.query.get('ref') ?? repo.default_branch;
      if (m === 'GET') {
        const tip = branchTip(repo, branch);
        if (!tip) return err(404, 'Not Found');
        const flat = flattenTree(ctx.store, parseCommit(ctx.store.getObject(tip)!.bytes).tree);
        const exact = flat.get(filePath);
        if (exact) {
          const blob = ctx.store.getObject(exact.oid);
          const bytes = blob ? blob.bytes : Buffer.alloc(0);
          return ok(200, {
            name: filePath.split('/').pop(),
            path: filePath,
            sha: exact.oid,
            size: bytes.length,
            type: 'file',
            content: bytes.toString('base64'),
            encoding: 'base64',
          });
        }
        // Directory listing
        const prefix = `${filePath}/`;
        const entries = [...flat.entries()]
          .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
          .map(([p, e]) => ({ name: p.slice(prefix.length), path: p, sha: e.oid, size: 0, type: 'file' }));
        const dirs = new Set<string>();
        for (const [p] of flat) {
          if (p.startsWith(prefix)) {
            const restPath = p.slice(prefix.length);
            const slash = restPath.indexOf('/');
            if (slash !== -1) dirs.add(restPath.slice(0, slash));
          }
        }
        for (const d of dirs) entries.push({ name: d, path: `${filePath}/${d}`, sha: '', size: 0, type: 'dir' });
        if (entries.length === 0) return err(404, 'Not Found');
        return ok(200, entries);
      }
      if (m === 'PUT') {
        const parsed = parseBody(ctx);
        if ('error' in parsed) return parsed.error;
        const message = str(parsed.value.message, 'Update file');
        const contentB64 = str(parsed.value.content);
        if (contentB64 === '') return err(422, 'content is required');
        const bodyBranch = typeof parsed.value.branch === 'string' && parsed.value.branch !== '' ? parsed.value.branch : branch;
        const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : '';
        const tip = branchTip(repo, bodyBranch);
        const current = tip ? readFileAtCommit(ctx.store, tip, filePath) : null;
        const currentOid = tip ? (flattenTree(ctx.store, parseCommit(ctx.store.getObject(tip)!.bytes).tree).get(filePath)?.oid ?? '') : '';
        const exists = current !== null;
        if (exists && sha === '') return err(422, 'sha is required to update a file');
        if (exists && sha !== '' && sha !== currentOid) return err(409, 'sha does not match');
        if (!exists && sha !== '') return err(422, 'file does not exist');
        const bytes = Buffer.from(contentB64, 'base64');
        const { sha: commitSha } = commitFile(ctx.store, repo, bodyBranch, filePath, bytes, message);
        const blobOid = ctx.store.putObject('blob', bytes);
        return ok(exists ? 200 : 201, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: bytes.length, type: 'file', content: contentB64, encoding: 'base64' },
          commit: { sha: commitSha, message },
        });
      }
      if (m === 'DELETE') {
        const parsed = parseBody(ctx);
        if ('error' in parsed) return parsed.error;
        const sha = str(parsed.value.sha);
        const bodyBranch = typeof parsed.value.branch === 'string' && parsed.value.branch !== '' ? parsed.value.branch : branch;
        const tip = branchTip(repo, bodyBranch);
        if (!tip) return err(404, 'Not Found');
        const currentOid = flattenTree(ctx.store, parseCommit(ctx.store.getObject(tip)!.bytes).tree).get(filePath)?.oid ?? '';
        if (currentOid === '') return err(404, 'Not Found');
        if (sha !== '' && sha !== currentOid) return err(409, 'sha does not match');
        const { sha: commitSha } = commitFile(ctx.store, repo, bodyBranch, filePath, null, str(parsed.value.message, 'Delete file'));
        return ok(200, { commit: { sha: commitSha, message: str(parsed.value.message, 'Delete file') } });
      }
    }
  }

  return null;
}
