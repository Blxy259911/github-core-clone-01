// Git smart HTTP, server side: protocol v2 upload-pack (advertise / ls-refs / fetch)
// and protocol v0 receive-pack (advertise / push), plus packfile read/write.
// Wire format mirrors what the kit's git-client.ts speaks; the implementation here
// is written from the protocol spec and the client's observable requests, not copied
// from the kit. Only node:zlib / node:crypto from the standard library. No deltas:
// the server only ever emits plain (non-delta) packs, which the suite accepts.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { parseCommit, parseTree } from './git.ts';
import { checkAuth, type Ctx } from './rest.ts';
import type { GitObject, Repo, Store } from './store.ts';

export const ZERO_OID = '0'.repeat(40);
const AGENT = 'forge/1.0';
/** Largest band-1 payload chunk: pkt-line max 65520 - 4 header - 1 band byte. */
const MAX_SIDEBAND_DATA = 65515;
const HEX40 = /^[0-9a-f]{40}$/;

export interface RawReply {
  status: number;
  contentType: string;
  body: Buffer;
}

const jsonReply = (status: number, message: string): RawReply => ({
  status,
  contentType: 'application/json; charset=utf-8',
  body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8'),
});

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > 65520) throw new Error('pkt-line payload too long');
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Decode pkt-lines from the front of `buf`. Stops at the first flush packet (everything
 * after it is returned as `rest`, e.g. a receive-pack's pack bytes) or at the first bytes
 * that do not parse as a pkt-line header (malformed input: `rest` is the whole remainder).
 */
export function decodePktLines(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.toString('ascii', off, off + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      break;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len < 4 || len > 65520 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: buf.subarray(off) };
}

// ---------------------------------------------------------------------------------------------
// packfile write (plain objects only, no deltas) and read
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Record<GitObject['type'], number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Array<GitObject['type'] | ''> = ['', 'commit', 'tree', 'blob', 'tag'];

function packEntryHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (type << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) b |= 0x80;
  bytes.push(b);
  while (size > 0) {
    b = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

function hashObject(type: GitObject['type'], data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Build a version-2 pack of plain objects, entries sorted by oid (deterministic). */
export function buildPack(objects: ReadonlyArray<{ oid: string; type: GitObject['type']; bytes: Buffer }>): Buffer {
  const sorted = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const o of sorted) {
    parts.push(packEntryHeader(TYPE_CODE[o.type], o.bytes.length));
    parts.push(deflateSync(o.bytes));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Minimal length of the zlib stream starting at `start` (binary search; inflateSync ignores trailing bytes). */
function findZlibEnd(buf: Buffer, start: number): number {
  try {
    inflateSync(buf.subarray(start));
  } catch {
    throw new Error('corrupt zlib stream in pack');
  }
  let lo = 1;
  let hi = buf.length - start;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(start, start + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

function readPackVarint(buf: Buffer, off: number): { type: number; size: number; next: number } {
  let b = buf[off];
  const type = (b >> 4) & 7;
  let size = b & 0x0f;
  let shift = 4;
  let i = off + 1;
  while (b & 0x80) {
    if (i >= buf.length) throw new Error('pack entry size varint is truncated');
    b = buf[i++];
    size += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { type, size, next: i };
}

/** Parse a packfile the client pushed. Delta entries are refused (the client never sends them). */
export function parsePack(buf: Buffer): Map<string, GitObject> {
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  const actual = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest('hex');
  if (trailer !== actual) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  let off = 12;
  for (let n = 0; n < count; n += 1) {
    const { type, size, next } = readPackVarint(buf, off);
    if (type < 1 || type > 4) throw new Error(`unsupported pack entry type ${type}`);
    const typeName = CODE_TYPE[type] as GitObject['type'];
    const zlen = findZlibEnd(buf, next);
    const data = inflateSync(buf.subarray(next, next + zlen));
    if (data.length !== size) throw new Error('pack entry size mismatch');
    objects.set(hashObject(typeName, data), { type: typeName, bytes: data });
    off = next + zlen;
  }
  if (off !== buf.length - 20) throw new Error('pack entries do not end at the trailer');
  return objects;
}

// ---------------------------------------------------------------------------------------------
// refs and object walks
// ---------------------------------------------------------------------------------------------

/** The `object` header of a tag object, or null. */
function tagTarget(bytes: Buffer): string | null {
  const m = /^object ([0-9a-f]{40})$/m.exec(bytes.toString('utf8'));
  return m ? m[1] : null;
}

/** Follow tag objects to their target (a commit, blob or tree oid), or null. */
function peelTag(store: Store, oid: string): string | null {
  let cur = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const obj = store.getObject(cur);
    if (!obj) return null;
    if (obj.type !== 'tag') return cur;
    const target = tagTarget(obj.bytes);
    if (!target) return null;
    cur = target;
  }
}

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
  unborn?: boolean;
  symrefTarget?: string;
}

/** HEAD first, then every ref sorted; annotated tags carry their peeled target. */
function listRefs(store: Store, repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const headTarget = `refs/heads/${repo.default_branch}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid) lines.push({ name: 'HEAD', oid: headOid, symrefTarget: headTarget });
  else lines.push({ name: 'HEAD', oid: ZERO_OID, unborn: true, symrefTarget: headTarget });
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    const obj = store.getObject(oid);
    let peeled: string | undefined;
    if (obj && obj.type === 'tag') peeled = peelTag(store, oid) ?? undefined;
    lines.push({ name, oid, peeled });
  }
  return lines;
}

/**
 * Objects reachable from `roots`. Parents of a commit are followed only when
 * `followParentsOf(oid)` says so — that is how depth cutoffs and shallow boundaries
 * are honoured. Gitlinks are skipped (the repo does not hold them).
 */
function collectReachablePred(
  store: Store,
  roots: Iterable<string>,
  followParentsOf: (oid: string) => boolean,
): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = store.getObject(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.bytes);
      stack.push(c.tree);
      if (followParentsOf(oid)) for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.bytes)) {
        if (e.mode !== '160000') stack.push(e.oid);
      }
    } else if (obj.type === 'tag') {
      const t = tagTarget(obj.bytes);
      if (t) stack.push(t);
    }
  }
  return seen;
}

/** Add an object and its tree/blob/tag closure (never following commit parents). */
function addTreeClosure(store: Store, out: Set<string>, rootOid: string): void {
  const stack = [rootOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = store.getObject(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'tree') {
      for (const e of parseTree(obj.bytes)) {
        if (e.mode !== '160000') stack.push(e.oid);
      }
    } else if (obj.type === 'tag') {
      const t = tagTarget(obj.bytes);
      if (t) stack.push(t);
    }
  }
}
function resolveToCommit(store: Store, oid: string): string | null {
  let cur = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const obj = store.getObject(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      const t = tagTarget(obj.bytes);
      if (!t) return null;
      cur = t;
      continue;
    }
    return null;
  }
}

/** True when `oldCommit` is an ancestor of (or equal to) `newCommit`. */
function isFastForward(store: Store, oldOid: string, newOid: string): boolean {
  const oldCommit = resolveToCommit(store, oldOid);
  const newCommit = resolveToCommit(store, newOid);
  if (!oldCommit || !newCommit) return false;
  const seen = new Set<string>();
  const stack = [newCommit];
  let steps = 0;
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === oldCommit) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (++steps > 1_000_000) return false;
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.bytes).parents) stack.push(p);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  const lines = ['version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'];
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    ...lines.map((l) => pktLine(l)),
    pktFlush(),
  ]);
}

function v0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? `report-status side-band-64k delete-refs symref=HEAD:refs/heads/${repo.default_branch} agent=${AGENT}`
      : `side-band-64k shallow symref=HEAD:refs/heads/${repo.default_branch} agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  if (repo.refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const refs = listRefs(store, repo);
    refs.forEach((r, i) => {
      parts.push(pktLine(`${r.oid} ${r.name}${i === 0 ? `\0${caps}` : ''}\n`));
      if (r.peeled) parts.push(pktLine(`${r.peeled} ${r.name}^{}\n`));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------------------------

function handleLsRefs(store: Store, repo: Repo, body: Buffer): RawReply {
  const { packets } = decodePktLines(body);
  const dataLines = packets.filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data');
  if (dataLines.length === 0 || dataLines[0].payload.toString('utf8').trim() !== 'command=ls-refs') {
    return jsonReply(400, 'expected command=ls-refs');
  }
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !afterDelim) continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const out: Buffer[] = [];
  for (const r of listRefs(store, repo)) {
    if (prefixes.length > 0 && !prefixes.some((p) => r.name.startsWith(p))) continue;
    if (r.unborn) {
      if (unborn) out.push(pktLine(`unborn ${r.name} symref-target:${r.symrefTarget}\n`));
      continue;
    }
    let line = `${r.oid} ${r.name}`;
    if (symrefs && r.symrefTarget) line += ` symref-target:${r.symrefTarget}`;
    if (peel && r.peeled) line += ` peeled:${r.peeled}`;
    out.push(pktLine(`${line}\n`));
  }
  out.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(out) };
}

// ---------------------------------------------------------------------------------------------
// v2 fetch
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  objects: Array<{ oid: string; type: GitObject['type']; bytes: Buffer }>;
  shallow: string[];
  unshallow: string[];
}

/** Plan which objects a fetch delivers, honouring wants / haves / shallow boundary / depth. */
function planFetch(
  store: Store,
  wants: string[],
  haves: string[],
  prevShallow: string[],
  depth: number | null,
): FetchPlan {
  // Resolve wants: tag objects seed the walk at their target commit.
  const seedCommits: string[] = [];
  for (const w of wants) {
    const obj = store.getObject(w);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const peeled = peelTag(store, w);
      if (peeled) seedCommits.push(peeled);
    } else if (obj.type === 'commit') {
      seedCommits.push(w);
    }
  }
  // BFS over commits from the seeds, with the depth cutoff (distance < depth).
  const dist = new Map<string, number>();
  const includedCommits = new Set<string>();
  const queue: string[] = [];
  for (const s of seedCommits) {
    if (!dist.has(s)) {
      dist.set(s, 0);
      queue.push(s);
    }
  }
  while (queue.length > 0) {
    const oid = queue.shift()!;
    const d = dist.get(oid)!;
    if (depth !== null && d >= depth) continue;
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    includedCommits.add(oid);
    for (const p of parseCommit(obj.bytes).parents) {
      if (!dist.has(p)) {
        dist.set(p, d + 1);
        queue.push(p);
      }
    }
  }
  // Candidate objects: the included commits (depth cutoff applied by the BFS above)
  // plus the tree/blob closure of each, plus any tag/blob/tree wants themselves. A parent
  // commit is never pulled in just because its child was: only commits the BFS included
  // (distance < depth) may enter, with their trees.
  const candidates = new Set<string>();
  for (const w of wants) {
    const obj = store.getObject(w);
    if (!obj) continue;
    if (obj.type === 'tag') {
      candidates.add(w);
      const peeled = peelTag(store, w);
      if (peeled) {
        const pobj = store.getObject(peeled);
        if (pobj && pobj.type !== 'commit') addTreeClosure(store, candidates, peeled);
      }
    } else if (obj.type !== 'commit') {
      addTreeClosure(store, candidates, w);
    }
  }
  for (const c of includedCommits) {
    candidates.add(c);
    const obj = store.getObject(c);
    if (obj && obj.type === 'commit') addTreeClosure(store, candidates, parseCommit(obj.bytes).tree);
  }
  // What the client already holds: reachable from its haves, without crossing its shallow boundary.
  const boundary = new Set(prevShallow);
  const held = collectReachablePred(store, haves, (oid) => !boundary.has(oid));
  const deliver = new Set<string>();
  for (const oid of candidates) if (!held.has(oid)) deliver.add(oid);
  const objects: FetchPlan['objects'] = [];
  for (const oid of deliver) {
    const obj = store.getObject(oid);
    if (obj) objects.push({ oid, type: obj.type, bytes: obj.bytes });
  }
  // Shallow-info: the new boundary is the delivered commits at the depth cutoff; a previous
  // boundary whose parents are all available now becomes unshallow.
  const available = new Set([...deliver, ...held]);
  const cutoff =
    depth === null
      ? []
      : [...includedCommits].filter((oid) => dist.get(oid) === depth - 1 && deliver.has(oid));
  const unshallow = prevShallow.filter((oid) => {
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') return false;
    return parseCommit(obj.bytes).parents.every((p) => available.has(p));
  });
  const shallow = [...new Set([...prevShallow.filter((oid) => !unshallow.includes(oid)), ...cutoff])];
  return { objects, shallow, unshallow };
}

function handleUploadPack(store: Store, repo: Repo, body: Buffer, isV2: boolean): RawReply {
  if (!isV2) return jsonReply(400, 'protocol v0 fetch is not supported; request version=2');
  const { packets } = decodePktLines(body);
  const dataLines = packets.filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data');
  const command = dataLines.length > 0 ? dataLines[0].payload.toString('utf8').trim() : '';
  if (command === 'command=ls-refs') return handleLsRefs(store, repo, body);
  if (command !== 'command=fetch') return jsonReply(400, 'expected command=fetch or command=ls-refs');
  return handleFetch(store, repo, body);
}

function handleFetch(store: Store, repo: Repo, body: Buffer): RawReply {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !afterDelim) continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = parseInt(text.slice(7).trim(), 10);
      if (!Number.isInteger(n) || n < 0) return jsonReply(400, 'bad deepen value');
      depth = n;
    }
  }
  for (const oid of [...wants, ...haves, ...shallow]) {
    if (!HEX40.test(oid)) return jsonReply(400, 'bad object id in fetch');
  }
  for (const w of wants) {
    if (!store.getObject(w)) return jsonReply(400, `want names an unknown object ${w}`);
  }
  const plan = planFetch(store, wants, haves, shallow, depth);
  const pack = buildPack(plan.objects);
  const out: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), pktFlush()];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    out.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) out.push(pktLine(`shallow ${s}\n`));
    for (const u of plan.unshallow) out.push(pktLine(`unshallow ${u}\n`));
    out.push(pktFlush());
  }
  out.push(pktLine('packfile\n'));
  for (let i = 0; i < pack.length; i += MAX_SIDEBAND_DATA) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(i, Math.min(pack.length, i + MAX_SIDEBAND_DATA))])));
  }
  out.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(out) };
}

// ---------------------------------------------------------------------------------------------
// v0 receive-pack (push)
// ---------------------------------------------------------------------------------------------

function applyCommand(
  store: Store,
  repo: Repo,
  cmd: { oldOid: string; newOid: string; ref: string },
): { ok: boolean; reason: string } {
  const current = repo.refs.get(cmd.ref);
  if (cmd.newOid === ZERO_OID) {
    if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
    if (current !== cmd.oldOid) return { ok: false, reason: 'old value mismatch' };
    repo.refs.delete(cmd.ref);
    return { ok: true, reason: '' };
  }
  if (cmd.oldOid === ZERO_OID) {
    if (current !== undefined) return { ok: false, reason: 'already exists' };
    if (!store.getObject(cmd.newOid)) return { ok: false, reason: 'missing object' };
    repo.refs.set(cmd.ref, cmd.newOid);
    return { ok: true, reason: '' };
  }
  if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
  if (current !== cmd.oldOid) return { ok: false, reason: 'old value mismatch' };
  if (cmd.newOid === cmd.oldOid) return { ok: true, reason: '' };
  if (!store.getObject(cmd.newOid)) return { ok: false, reason: 'missing object' };
  if (!isFastForward(store, cmd.oldOid, cmd.newOid)) return { ok: false, reason: 'non-fast-forward' };
  repo.refs.set(cmd.ref, cmd.newOid);
  return { ok: true, reason: '' };
}

function handleReceivePack(store: Store, repo: Repo, body: Buffer): RawReply {
  const { packets, rest } = decodePktLines(body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const main = nul >= 0 ? text.slice(0, nul) : text;
    const parts = main.split(' ');
    if (parts.length !== 3 || !HEX40.test(parts[0]) || !HEX40.test(parts[1]) || !parts[2].startsWith('refs/')) {
      return jsonReply(400, 'bad receive-pack command line');
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) return jsonReply(400, 'no receive-pack commands');
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const objects = parsePack(rest);
      for (const obj of objects.values()) store.putObject(obj.type, obj.bytes);
    } catch (e) {
      unpackDetail = `unpacker error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const reportLines: string[] = [`unpack ${unpackDetail}`];
  if (unpackDetail === 'ok') {
    for (const cmd of commands) {
      const verdict = applyCommand(store, repo, cmd);
      reportLines.push(verdict.ok ? `ok ${cmd.ref}` : `ng ${cmd.ref} ${verdict.reason}`);
    }
  } else {
    for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpack failed`);
  }
  const reportStream = Buffer.concat(reportLines.map((l) => pktLine(`${l}\n`)));
  const out: Buffer[] = [];
  for (let i = 0; i < reportStream.length; i += MAX_SIDEBAND_DATA) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), reportStream.subarray(i, Math.min(reportStream.length, i + MAX_SIDEBAND_DATA))])));
  }
  out.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(out) };
}

// ---------------------------------------------------------------------------------------------
// entry point: /{owner}/{repo}.git/...
// ---------------------------------------------------------------------------------------------

export function handleGit(ctx: Ctx, body: Buffer): RawReply | null {
  const segs = ctx.segments;
  if (segs.length < 2 || !segs[1].endsWith('.git')) return null;
  const owner = segs[0];
  const repoName = segs[1].slice(0, -4);
  if (!owner || !repoName) return jsonReply(404, 'Not Found');
  const auth = checkAuth(ctx);
  if (auth) {
    return {
      status: auth.status,
      contentType: 'application/json; charset=utf-8',
      body: Buffer.from(`${JSON.stringify(auth.json)}\n`, 'utf8'),
    };
  }
  const repo = ctx.store.getRepo(owner, repoName);
  const rest = segs.slice(2);
  if (ctx.method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    const service = ctx.query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return jsonReply(404, 'Not Found');
    if (!repo) return jsonReply(404, 'Not Found');
    const isV2 = ctx.headers['git-protocol'] === 'version=2' && service === 'git-upload-pack';
    const adv = isV2 ? v2Advertisement() : v0Advertisement(ctx.store, repo, service);
    return { status: 200, contentType: `application/x-${service}-advertisement`, body: adv };
  }
  if (ctx.method === 'POST' && rest.length === 1 && (rest[0] === 'git-upload-pack' || rest[0] === 'git-receive-pack')) {
    if (!repo) return jsonReply(404, 'Not Found');
    if (rest[0] === 'git-receive-pack') return handleReceivePack(ctx.store, repo, body);
    const isV2 = ctx.headers['git-protocol'] === 'version=2';
    return handleUploadPack(ctx.store, repo, body, isV2);
  }
  return null;
}
