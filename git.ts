// Git object layer: blob/tree/commit/tag serialisation, SHA-1 ids, tree reads.
// No deltas, no packfiles here yet (those land with the smart-HTTP module); the
// contents API and PR merges only need commits and trees.

import type { GitObject, Store } from './store.ts';

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitData {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Serialise a tree object from sorted entries (git sorts by name, dirs as name+'/'). */
export function serialiseTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(bytes: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < bytes.length) {
    const sp = bytes.indexOf(0x20, i);
    const nul = bytes.indexOf(0, sp);
    const mode = bytes.toString('utf8', i, sp);
    const name = bytes.toString('utf8', sp + 1, nul);
    const oid = bytes.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export function serialiseCommit(c: CommitData): Buffer {
  const lines: string[] = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.author}`, `committer ${c.committer}`, '', c.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function parseCommit(bytes: Buffer): CommitData {
  const text = bytes.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a tree object from a flat path -> blob oid map (nested dirs become subtrees). */
export function buildTreeFromFiles(store: Store, files: Map<string, string>): string {
  // Group by directory: returns the oid of the tree for `prefix`.
  const build = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Map<string, Map<string, string>>();
    for (const [path, oid] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.push({ mode: '100644', name: rest, oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!subdirs.has(dir)) subdirs.set(dir, new Map());
        subdirs.get(dir)!.set(path, oid);
      }
    }
    for (const [dir, sub] of subdirs) {
      entries.push({ mode: '40000', name: dir, oid: build(`${prefix}${dir}/`) });
    }
    return store.putObject('tree', serialiseTree(entries));
  };
  return build('');
}

/** Flatten a tree (at `oid`) into path -> {mode, oid} for one directory level and below. */
export function flattenTree(store: Store, treeOid: string, prefix = ''): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const obj = store.getObject(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.bytes)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') {
      for (const [p, sub] of flattenTree(store, e.oid, path)) out.set(p, sub);
    } else {
      out.set(path, { mode: e.mode, name: e.name, oid: e.oid });
    }
  }
  return out;
}

/** Read one file's blob bytes from a commit's tree, or null. */
export function readFileAtCommit(store: Store, commitOid: string, path: string): Buffer | null {
  const commit = store.getObject(commitOid);
  if (!commit || commit.type !== 'commit') return null;
  const flat = flattenTree(store, parseCommit(commit.bytes).tree);
  const entry = flat.get(path);
  if (!entry) return null;
  const blob = store.getObject(entry.oid);
  return blob && blob.type === 'blob' ? blob.bytes : null;
}

/** Commit timestamp line: `Name <email> epoch +0000`. */
export function ident(login: string, email: string, epochSec: number): string {
  return `${login} <${email}> ${epochSec} +0000`;
}

/** Collect every object oid reachable from a set of tip commits (for pack generation). */
export function collectReachable(store: Store, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = store.getObject(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.bytes);
      stack.push(c.tree, ...c.parents);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.bytes)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      const text = obj.bytes.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(text);
      if (m) stack.push(m[1]);
    }
  }
  return seen;
}

export type { GitObject };
