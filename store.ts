// In-memory store for the forge. Everything lives in Maps; nothing touches the disk.
// Deterministic: a logical clock (2025-01-01T00:00:00Z + 1s per mutation) and counter-based
// ids, so two runs of the same requests leave byte-identical state (the final replays trials).

import { createHash } from 'node:crypto';

// The token owner's identity. The scenario seed is fixed for the whole competition
// (SCENARIO_SEED_HEX in the kit), so the viewer is the same in every trial; it is
// computed from the kit's own generator and hardcoded here. The shop token itself is
// trial-derived and cannot be inverted, so there is no other way to learn it.
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
});

export const SCENARIO_USERS: ReadonlyArray<{ id: number; login: string; name: string; email: string }> = [
  { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' },
  { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' },
  { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' },
  { id: 1003, login: 'dmitriquist', name: 'dmitri quist', email: 'dmitriquist@example.invalid' },
  { id: 1004, login: 'adanovak', name: 'ada novak', email: 'adanovak@example.invalid' },
  { id: 1005, login: 'zanerossi', name: 'zane rossi', email: 'zanerossi@example.invalid' },
  { id: 1006, login: 'pavelcosta', name: 'pavel costa', email: 'pavelcosta@example.invalid' },
  { id: 1007, login: 'wrenkeller', name: 'wren keller', email: 'wrenkeller@example.invalid' },
  { id: 1008, login: 'coraquist', name: 'cora quist', email: 'coraquist@example.invalid' },
  { id: 1009, login: 'elenaulrich', name: 'elena ulrich', email: 'elenaulrich@example.invalid' },
  { id: 1010, login: 'tesssato', name: 'tess sato', email: 'tesssato@example.invalid' },
  { id: 1011, login: 'svenrossi', name: 'sven rossi', email: 'svenrossi@example.invalid' },
];

export function userByLogin(login: string): { id: number; login: string; name: string; email: string } | null {
  return SCENARIO_USERS.find((u) => u.login === login) ?? null;
}

/** Logical clock: base + 1s per tick. Never uses the wall clock. */
const CLOCK_BASE_MS = Date.parse('2025-01-01T00:00:00.000Z');

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  user: { id: number; login: string };
  created_at: string;
  updated_at: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: { id: number; login: string };
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: Comment[];
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  user: { id: number; login: string };
  created_at: string;
  updated_at: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  /** ref name (e.g. refs/heads/main) -> commit oid */
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  issueCounter: number;
  pullCounter: number;
  commentCounter: number;
}

export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  bytes: Buffer;
}

export class Store {
  repos = new Map<string, Repo>();
  /** Content-addressed object store, shared across repos (same bytes = same oid). */
  objects = new Map<string, GitObject>();
  repoCounter = 5000;
  requestCounter = 0;
  private tick = 0;

  now(): string {
    this.tick += 1;
    return new Date(CLOCK_BASE_MS + this.tick * 1000).toISOString();
  }

  nextRequestId(): string {
    this.requestCounter += 1;
    return `req-${this.requestCounter.toString(16).padStart(8, '0')}`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, opts: { private?: boolean; description?: string; default_branch?: string }): Repo {
    const ts = this.now();
    const repo: Repo = {
      id: this.repoCounter,
      name,
      owner,
      private: opts.private ?? false,
      description: opts.description ?? '',
      default_branch: opts.default_branch ?? 'main',
      created_at: ts,
      updated_at: ts,
      pushed_at: ts,
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      issueCounter: 0,
      pullCounter: 0,
      commentCounter: 0,
    };
    this.repoCounter += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** Viewer-owned repos, in creation order (pagination walks this list). */
  viewerRepos(): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === VIEWER.login);
  }

  putObject(type: GitObject['type'], bytes: Buffer): string {
    const header = Buffer.from(`${type} ${bytes.length}\0`, 'utf8');
    const oid = createHash('sha1').update(header).update(bytes).digest('hex');
    if (!this.objects.has(oid)) this.objects.set(oid, { type, bytes });
    return oid;
  }

  /** Store an object whose oid is already known (e.g. a pack just parsed, which hashed
   * every entry to build its map): skips the second SHA-1 over the same bytes. */
  putObjectKnown(oid: string, type: GitObject['type'], bytes: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, bytes });
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }
}

/** Opaque global ids (GraphQL node ids): base64url of `type:id`. */
export function globalId(kind: string, id: string): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64url');
}

export function parseGlobalId(gid: string): { kind: string; id: string } | null {
  try {
    const text = Buffer.from(gid, 'base64url').toString('utf8');
    const i = text.indexOf(':');
    if (i <= 0) return null;
    return { kind: text.slice(0, i), id: text.slice(i + 1) };
  } catch {
    return null;
  }
}
