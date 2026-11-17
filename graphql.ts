// GraphQL v4 (mini) for the forge: POST /api/graphql.
// A hand-written parser + executor covering exactly the documents gh / github-mcp-server
// send (see the kit's checks-graphql.ts): viewer, repository, issue(s), pullRequests,
// pullRequest.files, node(id:), __type introspection, the five mutations, batching.
// No GraphQL library, no external dependency; shares the Store with REST / MCP / git.

import { flattenTree, parseCommit } from './git.ts';
import {
  createIssueRecord,
  createPullRecord,
  diffTrees,
  findMergeBase,
  mergePullRecord,
  type Ctx,
  type Reply,
} from './rest.ts';
import { globalId, parseGlobalId, VIEWER, type Issue, type Pull, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

const PUNCT = new Set(['{', '}', '(', ')', '[', ']', ':', '!', '$', ',', '=', '@', '|', '&']);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc === '/' ? '/' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      if (j >= n) throw new Error('unterminated string in GraphQL document');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < n && src[j] >= '0' && src[j] <= '9') j += 1;
      let isFloat = false;
      if (src[j] === '.' && src[j + 1] >= '0' && src[j + 1] <= '9') {
        isFloat = true;
        j += 1;
        while (j < n && src[j] >= '0' && src[j] <= '9') j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < n && src[j] >= '0' && src[j] <= '9') j += 1;
      }
      const text = src.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_') {
      let j = i;
      while (j < n && ((src[j] >= 'A' && src[j] <= 'Z') || (src[j] >= 'a' && src[j] <= 'z') || (src[j] >= '0' && src[j] <= '9') || src[j] === '_')) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------------------
// AST + parser (recursive descent; only the shapes the checks send)
// ---------------------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[] | null;
}

export interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  variables: { name: string }[];
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    this.pos += 1;
    return t;
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
  }

  private expectName(what = 'a name'): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected ${what} in GraphQL document`);
    return t.value;
  }

  parseDocument(): OperationNode[] {
    const ops: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): OperationNode {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '{') {
      return { type, name, variables: [], selections: this.parseSelectionSet() };
    }
    const kw = this.expectName('query or mutation');
    if (kw !== 'query' && kw !== 'mutation') throw new Error(`unsupported operation "${kw}"`);
    type = kw;
    const after = this.peek();
    if (after.kind === 'name') name = this.next().value as string;
    // Variable definitions: ($x: Type, ...) — types are parsed and ignored.
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      const variables: { name: string }[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        this.expectPunct('$');
        variables.push({ name: this.expectName('a variable name') });
        this.expectPunct(':');
        this.parseType();
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '=') {
          this.next();
          this.parseValue();
        }
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ',') this.next();
      }
      this.expectPunct(')');
      return { type, name, variables, selections: this.parseSelectionSet() };
    }
    return { type, name, variables: [], selections: this.parseSelectionSet() };
  }

  private parseType(): void {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type name');
    }
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '!') this.next();
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const sels: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      sels.push(this.parseSelection());
    }
    this.expectPunct('}');
    return sels;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      let typeCondition: string | null = null;
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName('a type condition');
      }
      return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
    }
    const first = this.expectName('a field name');
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = first;
      name = this.expectName('a field name');
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const argName = this.expectName('an argument name');
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ',') this.next();
      }
      this.expectPunct(')');
    }
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName('a variable name') };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        values.push(this.parseValue());
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ',') this.next();
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.expectName('an object field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ',') this.next();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error('unexpected token in GraphQL value');
  }
}

// ---------------------------------------------------------------------------------------------------------
// Schema tables (field lists double as the introspection answers)
// ---------------------------------------------------------------------------------------------------------

/** Object type -> its fields. `__typename` is always valid and is added by the executor. */
const FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'createdAt', 'updatedAt',
  ],
  Ref: ['name', 'id'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'status', 'changeType'],
  Comment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge', 'subject'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const ENUMS: Record<string, readonly string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

const TYPENAME = Symbol('typename');

function tag<T extends object>(typename: string, obj: T): T & { [TYPENAME]: string } {
  (obj as Record<symbol, string>)[TYPENAME] = typename;
  return obj as T & { [TYPENAME]: string };
}

function typeOf(obj: unknown): string | null {
  if (obj !== null && typeof obj === 'object') {
    const t = (obj as Record<symbol, unknown>)[TYPENAME];
    return typeof t === 'string' ? t : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Values, cursors, global ids
// ---------------------------------------------------------------------------------------------------------

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueOf(f.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((a) => a.name === name);
  return arg === undefined ? undefined : valueOf(arg.value, variables);
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', String(repo.id));
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.id}:${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', `${repo.id}:${pull.number}`);
}

function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return globalId('IssueComment', `${repo.id}:${issue.number}:${commentId}`);
}

function issueCursor(repo: Repo, issue: Issue): string {
  return Buffer.from(`cursor:${repo.id}:${issue.number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts[0] !== 'cursor' || parts.length !== 3) return null;
    const n = Number(parts[2]);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function repoByDatabaseId(store: Store, id: number): Repo | null {
  for (const repo of store.repos.values()) {
    if (repo.id === id) return repo;
  }
  return null;
}

function issueStateEnum(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateEnum(pull: Pull): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

// ---------------------------------------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------------------------------------

interface GqlError {
  message: string;
  path?: (string | number)[];
}

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  errors: GqlError[];
}

function resolveSelections(
  ctx: ExecCtx,
  obj: unknown,
  typeName: string,
  selections: SelectionNode[],
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition !== null && sel.typeCondition !== typeName) continue;
      Object.assign(out, resolveSelections(ctx, obj, typeName, sel.selections, path));
      continue;
    }
    const key = sel.alias ?? sel.name;
    const fieldPath = [...path, key];
    const value = resolveField(ctx, obj, typeName, sel, fieldPath);
    out[key] = value;
  }
  return out;
}

function resolveField(
  ctx: ExecCtx,
  obj: unknown,
  typeName: string,
  field: FieldNode,
  path: (string | number)[],
): unknown {
  if (field.name === '__typename') return typeName;
  const allowed = FIELDS[typeName];
  if (!allowed || !allowed.includes(field.name)) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".`, path });
    return null;
  }
  let value: unknown;
  try {
    value = fieldValue(ctx, obj, typeName, field);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.errors.push({ message, path });
    return null;
  }
  if (value === null || value === undefined) return null;
  if (field.selections === null) return value;
  const childType = typeOf(value);
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (entry === null || entry === undefined) return null;
      const t = typeOf(entry);
      if (t === null) return entry;
      return resolveSelections(ctx, entry, t, field.selections as SelectionNode[], path);
    });
  }
  if (childType === null) return value;
  return resolveSelections(ctx, value, childType, field.selections, path);
}

// ---------------------------------------------------------------------------------------------------------
// Field resolvers
// ---------------------------------------------------------------------------------------------------------

function fieldValue(ctx: ExecCtx, obj: unknown, typeName: string, field: FieldNode): unknown {
  const store = ctx.store;
  const vars = ctx.variables;
  switch (typeName) {
    case 'Query':
      return queryField(ctx, field);
    case 'Mutation':
      return mutationField(ctx, field);
    case 'User': {
      const u = obj as { login: string; id?: number; name?: string };
      if (field.name === 'login') return u.login;
      if (field.name === 'id') return u.id ?? null;
      if (field.name === 'name') return u.name ?? u.login;
      return null;
    }
    case 'Repository':
      return repositoryField(ctx, obj as Repo, field);
    case 'Ref': {
      const r = obj as { name: string; id?: string };
      return field.name === 'name' ? r.name : (r.id ?? null);
    }
    case 'Issue': {
      const pair = obj as { repo: Repo; issue: Issue };
      const issue = pair.issue;
      switch (field.name) {
        case 'id':
          return issueGlobalId(pair.repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issueStateEnum(issue);
        case 'author':
          return tag('User', { login: issue.user.login, id: issue.user.id, name: issue.user.login });
        case 'createdAt':
          return issue.created_at;
        case 'updatedAt':
          return issue.updated_at;
        case 'closedAt':
          return issue.closed_at;
        case 'url':
          return `https://${'localhost'}/repos/${pair.repo.owner}/${pair.repo.name}/issues/${issue.number}`;
        default:
          return null;
      }
    }
    case 'IssueConnection': {
      const conn = obj as { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null; total: number };
      if (field.name === 'nodes') return conn.nodes;
      if (field.name === 'pageInfo') {
        return tag('PageInfo', {
          hasNextPage: conn.hasNextPage,
          hasPreviousPage: false,
          startCursor: conn.nodes.length > 0 ? issueCursorFor(conn.nodes[0]) : null,
          endCursor: conn.endCursor,
        });
      }
      if (field.name === 'edges') {
        return conn.nodes.map((node) => tag('IssueEdge', { node, cursor: issueCursorFor(node) }));
      }
      if (field.name === 'totalCount') return conn.total;
      return null;
    }
    case 'IssueEdge': {
      const edge = obj as { node: unknown; cursor: string | null };
      return field.name === 'node' ? edge.node : edge.cursor;
    }
    case 'PageInfo': {
      const p = obj as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      return p[field.name as keyof typeof p] ?? null;
    }
    case 'PullRequest': {
      const pair = obj as { repo: Repo; pull: Pull };
      return pullRequestField(ctx, pair.repo, pair.pull, field);
    }
    case 'PullRequestConnection': {
      const conn = obj as { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null; total: number };
      if (field.name === 'nodes') return conn.nodes;
      if (field.name === 'pageInfo') {
        return tag('PageInfo', { hasNextPage: conn.hasNextPage, hasPreviousPage: false, startCursor: null, endCursor: conn.endCursor });
      }
      if (field.name === 'edges') {
        return conn.nodes.map((node) => tag('PullRequestEdge', { node, cursor: null }));
      }
      if (field.name === 'totalCount') return conn.total;
      return null;
    }
    case 'PullRequestEdge': {
      const edge = obj as { node: unknown; cursor: string | null };
      return field.name === 'node' ? edge.node : edge.cursor;
    }
    case 'PullRequestChangedFile': {
      const f = obj as { path: string; additions: number; deletions: number; status: string };
      if (field.name === 'path') return f.path;
      if (field.name === 'additions') return f.additions;
      if (field.name === 'deletions') return f.deletions;
      if (field.name === 'status') return f.status;
      if (field.name === 'changeType') return f.status;
      return null;
    }
    case 'Comment': {
      const c = obj as { repo: Repo; issue: Issue; id: number; body: string; user: { id: number; login: string }; created_at: string; updated_at: string };
      if (field.name === 'id') return commentGlobalId(c.repo, c.issue, c.id);
      if (field.name === 'body') return c.body;
      if (field.name === 'author') return tag('User', { login: c.user.login, id: c.user.id, name: c.user.login });
      if (field.name === 'createdAt') return c.created_at;
      if (field.name === 'updatedAt') return c.updated_at;
      return null;
    }
    case 'CommentEdge': {
      const edge = obj as { node: unknown; cursor: string | null };
      return field.name === 'node' ? edge.node : edge.cursor;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const p = obj as { issue: unknown };
      return field.name === 'issue' ? p.issue : null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const p = obj as { pullRequest: unknown };
      return field.name === 'pullRequest' ? p.pullRequest : null;
    }
    case 'AddCommentPayload': {
      const p = obj as { commentEdge: unknown; subject: unknown };
      if (field.name === 'commentEdge') return p.commentEdge;
      if (field.name === 'subject') return p.subject ?? null;
      return null;
    }
    case '__Type': {
      const t = obj as { name: string; kind: string; fields: { name: string }[] | null; enumValues: { name: string }[] | null; description: string | null };
      if (field.name === 'name') return t.name;
      if (field.name === 'kind') return t.kind;
      if (field.name === 'fields') return t.fields === null ? null : t.fields.map((f) => tag('__Field', { name: f.name, description: null }));
      if (field.name === 'enumValues') return t.enumValues === null ? null : t.enumValues.map((v) => tag('__EnumValue', { name: v.name, description: null }));
      if (field.name === 'description') return t.description;
      return null;
    }
    case '__Field':
    case '__EnumValue': {
      const f = obj as { name: string; description: string | null };
      return field.name === 'name' ? f.name : (f.description ?? null);
    }
    default:
      return null;
  }
}

function issueCursorFor(node: unknown): string | null {
  const pair = node as { repo?: Repo; issue?: Issue };
  if (pair && pair.repo && pair.issue) return issueCursor(pair.repo, pair.issue);
  return null;
}

function queryField(ctx: ExecCtx, field: FieldNode): unknown {
  const store = ctx.store;
  const vars = ctx.variables;
  if (field.name === 'viewer') {
    return tag('User', { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name });
  }
  if (field.name === 'repository') {
    const owner = String(argValue(field, 'owner', vars) ?? '');
    const name = String(argValue(field, 'name', vars) ?? '');
    const repo = store.getRepo(owner, name);
    return repo ? tag('Repository', repo) : null;
  }
  if (field.name === 'node') {
    const gid = String(argValue(field, 'id', vars) ?? '');
    const parsed = parseGlobalId(gid);
    if (!parsed) return null;
    if (parsed.kind === 'Repository') {
      const repo = repoByDatabaseId(store, Number(parsed.id));
      return repo ? tag('Repository', repo) : null;
    }
    if (parsed.kind === 'Issue') {
      const [repoId, num] = parsed.id.split(':');
      const repo = repoByDatabaseId(store, Number(repoId));
      const issue = repo?.issues.get(Number(num));
      return repo && issue ? tag('Issue', { repo, issue }) : null;
    }
    if (parsed.kind === 'PullRequest') {
      const [repoId, num] = parsed.id.split(':');
      const repo = repoByDatabaseId(store, Number(repoId));
      const pull = repo?.pulls.get(Number(num));
      return repo && pull ? tag('PullRequest', { repo, pull }) : null;
    }
    return null;
  }
  if (field.name === '__type') {
    const name = String(argValue(field, 'name', vars) ?? '');
    if (FIELDS[name]) {
      return tag('__Type', {
        name,
        kind: 'OBJECT',
        fields: FIELDS[name].map((f) => ({ name: f })),
        enumValues: null,
        description: null,
      });
    }
    if (ENUMS[name]) {
      return tag('__Type', {
        name,
        kind: 'ENUM',
        fields: null,
        enumValues: ENUMS[name].map((v) => ({ name: v })),
        description: null,
      });
    }
    return null;
  }
  return null;
}

function repositoryField(ctx: ExecCtx, repo: Repo, field: FieldNode): unknown {
  const store = ctx.store;
  const vars = ctx.variables;
  switch (field.name) {
    case 'id':
      return repoGlobalId(repo);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'owner':
      return tag('User', { login: repo.owner, id: undefined, name: repo.owner });
    case 'defaultBranchRef': {
      const tip = repo.refs.get(`refs/heads/${repo.default_branch}`);
      return tip ? tag('Ref', { name: repo.default_branch, id: tip }) : null;
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'description':
      return repo.description;
    case 'isPrivate':
      return repo.private;
    case 'createdAt':
      return repo.created_at;
    case 'updatedAt':
      return repo.updated_at;
    case 'issue': {
      const number = Number(argValue(field, 'number', vars));
      const issue = repo.issues.get(number);
      return issue ? tag('Issue', { repo, issue }) : null;
    }
    case 'issues': {
      return issuesConnection(ctx, repo, field);
    }
    case 'pullRequests': {
      const first = argValue(field, 'first', vars);
      const open = [...repo.pulls.values()].filter((p) => p.state === 'open').sort((a, b) => a.number - b.number);
      const nodes = (typeof first === 'number' ? open.slice(0, first) : open).map((pull) => tag('PullRequest', { repo, pull }));
      return tag('PullRequestConnection', { nodes, hasNextPage: typeof first === 'number' && open.length > first, endCursor: null, total: open.length });
    }
    case 'pullRequest': {
      const number = Number(argValue(field, 'number', vars));
      const pull = repo.pulls.get(number);
      return pull ? tag('PullRequest', { repo, pull }) : null;
    }
    default:
      return null;
  }
}

/** issues(first, states, orderBy, after) with cursor pagination. */
function issuesConnection(ctx: ExecCtx, repo: Repo, field: FieldNode): unknown {
  const vars = ctx.variables;
  let list = [...repo.issues.values()];
  const states = argValue(field, 'states', vars);
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    list = list.filter((i) => wanted.has(issueStateEnum(i)));
  }
  const orderBy = argValue(field, 'orderBy', vars) as { field?: string; direction?: string } | undefined;
  const orderField = orderBy && typeof orderBy === 'object' ? String(orderBy.field ?? 'CREATED_AT') : 'CREATED_AT';
  const direction = orderBy && typeof orderBy === 'object' ? String(orderBy.direction ?? 'ASC') : 'ASC';
  const keyOf = (i: Issue): string | number => {
    if (orderField === 'UPDATED_AT') return i.updated_at;
    if (orderField === 'COMMENTS') return i.comments.length;
    return i.created_at;
  };
  list.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    const cmp = ka < kb ? -1 : ka > kb ? 1 : a.number - b.number;
    return direction === 'DESC' ? -cmp : cmp;
  });
  const after = cursorNumber(argValue(field, 'after', vars) as string | null | undefined);
  if (after !== null) {
    const idx = list.findIndex((i) => i.number === after);
    list = idx >= 0 ? list.slice(idx + 1) : list;
  }
  const first = argValue(field, 'first', vars);
  const total = list.length;
  const page = typeof first === 'number' ? list.slice(0, first) : list;
  const hasNextPage = page.length < total;
  const nodes = page.map((issue) => tag('Issue', { repo, issue }));
  const endCursor = page.length > 0 ? issueCursor(repo, page[page.length - 1]) : null;
  return tag('IssueConnection', { nodes, hasNextPage, endCursor, total });
}

/** MERGEABLE / CONFLICTING / UNKNOWN for an open pull request (same three-way rule as merge). */
function pullMergeable(store: Store, repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  const baseObj = store.getObject(baseTip);
  const headObj = store.getObject(headTip);
  if (!baseObj || baseObj.type !== 'commit' || !headObj || headObj.type !== 'commit') return 'UNKNOWN';
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
    if (headOid !== baseOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function pullRequestField(ctx: ExecCtx, repo: Repo, pull: Pull, field: FieldNode): unknown {
  const store = ctx.store;
  const vars = ctx.variables;
  switch (field.name) {
    case 'id':
      return pullGlobalId(repo, pull);
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pullStateEnum(pull);
    case 'merged':
      return pull.merged;
    case 'mergeable':
      return pullMergeable(store, repo, pull);
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'headRefOid':
      return pull.headSha;
    case 'baseRefOid':
      return pull.baseSha;
    case 'author':
      return tag('User', { login: pull.user.login, id: pull.user.id, name: pull.user.login });
    case 'createdAt':
      return pull.created_at;
    case 'updatedAt':
      return pull.updated_at;
    case 'mergedAt':
      return pull.merged_at;
    case 'mergeCommit':
      return pull.merge_commit_sha ? tag('Ref', { name: pull.baseRef, id: pull.merge_commit_sha }) : null;
    case 'files': {
      const first = argValue(field, 'first', vars);
      const baseObj = store.getObject(pull.baseSha);
      const headObj = store.getObject(pull.headSha);
      if (!baseObj || baseObj.type !== 'commit' || !headObj || headObj.type !== 'commit') return tag('PullRequestConnection', { nodes: [], hasNextPage: false, endCursor: null, total: 0 });
      const changes = diffTrees(store, parseCommit(baseObj.bytes).tree, parseCommit(headObj.bytes).tree);
      const nodes = (typeof first === 'number' ? changes.slice(0, first) : changes).map((c) =>
        tag('PullRequestChangedFile', { path: c.filename, additions: c.additions, deletions: c.deletions, status: c.status }),
      );
      return tag('PullRequestConnection', { nodes, hasNextPage: typeof first === 'number' && changes.length > first, endCursor: null, total: changes.length });
    }
    default:
      return null;
  }
}

function mutationField(ctx: ExecCtx, field: FieldNode): unknown {
  const store = ctx.store;
  const vars = ctx.variables;
  const input = argValue(field, 'input', vars) as Record<string, unknown> | undefined;
  if (input === undefined || input === null || typeof input !== 'object') {
    throw new Error(`mutation ${field.name} needs an input object`);
  }
  if (field.name === 'createIssue') {
    const gid = String(input.repositoryId ?? '');
    const parsed = parseGlobalId(gid);
    const repo = parsed && parsed.kind === 'Repository' ? repoByDatabaseId(store, Number(parsed.id)) : null;
    if (!repo) throw new Error(`createIssue: unknown repository ${gid}`);
    const created = createIssueRecord(store, repo, String(input.title ?? ''), String(input.body ?? ''), []);
    if ('error' in created) throw new Error(`createIssue: ${String((created.error.json as { message?: string }).message ?? 'failed')}`);
    return tag('CreateIssuePayload', { issue: tag('Issue', { repo, issue: created.issue }) });
  }
  if (field.name === 'closeIssue') {
    const gid = String(input.issueId ?? '');
    const parsed = parseGlobalId(gid);
    if (!parsed || parsed.kind !== 'Issue') throw new Error(`closeIssue: unknown issue ${gid}`);
    const [repoId, num] = parsed.id.split(':');
    const repo = repoByDatabaseId(store, Number(repoId));
    const issue = repo?.issues.get(Number(num));
    if (!repo || !issue) throw new Error(`closeIssue: unknown issue ${gid}`);
    issue.state = 'closed';
    issue.closed_at = store.now();
    issue.updated_at = store.now();
    return tag('CloseIssuePayload', { issue: tag('Issue', { repo, issue }) });
  }
  if (field.name === 'createPullRequest') {
    const gid = String(input.repositoryId ?? '');
    const parsed = parseGlobalId(gid);
    const repo = parsed && parsed.kind === 'Repository' ? repoByDatabaseId(store, Number(parsed.id)) : null;
    if (!repo) throw new Error(`createPullRequest: unknown repository ${gid}`);
    const created = createPullRecord(store, repo, {
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      head: String(input.headRefName ?? ''),
      base: String(input.baseRefName ?? ''),
    });
    if ('error' in created) throw new Error(`createPullRequest: ${String((created.error.json as { message?: string }).message ?? 'failed')}`);
    return tag('CreatePullRequestPayload', { pullRequest: tag('PullRequest', { repo, pull: created.pull }) });
  }
  if (field.name === 'mergePullRequest') {
    const method = String(input.mergeMethod ?? 'MERGE');
    if (method !== 'MERGE' && method !== 'SQUASH' && method !== 'REBASE') {
      throw new Error(`mergePullRequest: unknown merge method ${method}`);
    }
    const gid = String(input.pullRequestId ?? '');
    const parsed = parseGlobalId(gid);
    if (!parsed || parsed.kind !== 'PullRequest') throw new Error(`mergePullRequest: unknown pull request ${gid}`);
    const [repoId, num] = parsed.id.split(':');
    const repo = repoByDatabaseId(store, Number(repoId));
    if (!repo) throw new Error(`mergePullRequest: unknown pull request ${gid}`);
    const merged = mergePullRecord(store, repo, Number(num));
    if ('error' in merged) throw new Error(`mergePullRequest: ${String((merged.error.json as { message?: string }).message ?? 'failed')}`);
    return tag('MergePullRequestPayload', { pullRequest: tag('PullRequest', { repo, pull: merged.pull }) });
  }
  if (field.name === 'addComment') {
    const gid = String(input.subjectId ?? '');
    const parsed = parseGlobalId(gid);
    if (!parsed || parsed.kind !== 'Issue') throw new Error(`addComment: unknown subject ${gid}`);
    const [repoId, num] = parsed.id.split(':');
    const repo = repoByDatabaseId(store, Number(repoId));
    const issue = repo?.issues.get(Number(num));
    if (!repo || !issue) throw new Error(`addComment: unknown subject ${gid}`);
    const body = String(input.body ?? '');
    if (body === '') throw new Error('addComment: body is required');
    const ts = store.now();
    repo.commentCounter += 1;
    const comment = { id: repo.commentCounter, body, user: { id: VIEWER.id, login: VIEWER.login }, created_at: ts, updated_at: ts };
    issue.comments.push(comment);
    issue.updated_at = ts;
    const node = tag('Comment', { repo, issue, ...comment });
    return tag('AddCommentPayload', {
      commentEdge: tag('CommentEdge', { node, cursor: commentGlobalId(repo, issue, comment.id) }),
      subject: tag('Issue', { repo, issue }),
    });
  }
  throw new Error(`unknown mutation ${field.name}`);
}

// ---------------------------------------------------------------------------------------------------------
// Entry point: one operation, or a batched array of operations
// ---------------------------------------------------------------------------------------------------------

function executeOne(store: Store, body: Record<string, unknown>): Record<string, unknown> {
  const query = body.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'GraphQL query is required' }] };
  }
  const variables = (body.variables !== null && typeof body.variables === 'object' && !Array.isArray(body.variables)
    ? (body.variables as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  let operations: OperationNode[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
  const operation = operations.find((o) => o.name === (typeof body.operationName === 'string' ? body.operationName : undefined)) ?? operations[0];
  if (!operation) return { data: null, errors: [{ message: 'no operation in GraphQL document' }] };
  const ctx: ExecCtx = { store, variables, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root = tag(rootType, {});
  const data = resolveSelections(ctx, root, rootType, operation.selections, []);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

/** Handle one POST /api/graphql request (auth already checked by app.ts). */
export function handleGraphql(ctx: Ctx): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.bodyText);
  } catch {
    return { status: 400, json: { message: 'Problems parsing JSON' } };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? executeOne(ctx.store, entry as Record<string, unknown>) : { data: null, errors: [{ message: 'each batched operation must be an object' }] },
    );
    return { status: 200, json: results };
  }
  if (parsed !== null && typeof parsed === 'object') {
    return { status: 200, json: executeOne(ctx.store, parsed as Record<string, unknown>) };
  }
  return { status: 400, json: { message: 'Problems parsing JSON' } };
}
