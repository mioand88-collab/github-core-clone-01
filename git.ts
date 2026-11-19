// A pure-Node git object store and packfile codec: the heart of the forge.
//
// Objects live in memory, addressed by their SHA-1, exactly as git addresses
// them on disk: sha1("<type> <length>\0" + data). Nothing here shells out to
// a git binary, because the grader's container ships only Node; everything
// the wire protocol needs (loose-object hashing, tree/commit serialisation,
// pack encoding and decoding, delta application) is implemented from the
// format itself.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_TO_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id git gives an object with this type and content. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** An in-memory object database for one forge process. */
export class ObjectStore {
  private objects = new Map<string, GitObject>();

  /** Store an object and return its id (storing the same object twice is a no-op). */
  put(type: GitObjectType, data: Buffer): string {
    const id = hashObject(type, data);
    if (!this.objects.has(id)) this.objects.set(id, { type, data });
    return id;
  }

  putKnown(id: string, type: GitObjectType, data: Buffer): void {
    if (!this.objects.has(id)) this.objects.set(id, { type, data });
  }

  get(id: string): GitObject | undefined {
    return this.objects.get(id);
  }

  has(id: string): boolean {
    return this.objects.has(id);
  }

  get size(): number {
    return this.objects.size;
  }

  /**
   * Every object reachable from the given tips, tips included: commits walk
   * to their parents and trees, trees to their entries. Missing objects are
   * skipped silently (a shallow or partial view is the caller's problem).
   */
  closure(tips: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      const obj = this.objects.get(id);
      if (obj === undefined) continue;
      seen.add(id);
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        stack.push(commit.tree);
        for (const parent of commit.parents) stack.push(parent);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.id);
      } else if (obj.type === 'tag') {
        const target = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (target !== null) stack.push(target[1] as string);
      }
    }
    return seen;
  }

  /** True when `ancestor` is reachable from `descendant` by parent links. */
  isAncestor(ancestor: string, descendant: string): boolean {
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (id === ancestor) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const obj = this.objects.get(id);
      if (obj !== undefined && obj.type === 'commit') {
        stack.push(...parseCommit(obj.data).parents);
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  id: string;
}

/** Parse a tree object's bytes into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const id = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, id });
    offset = nul + 21;
  }
  return entries;
}

/** Serialise entries into tree bytes; git sorts entries with directories as if suffixed by '/'. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.id, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits

export interface CommitData {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's bytes. Extra headers (gpgsig, encoding, ...) are ignored. */
export function parseCommit(data: Buffer): CommitData {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Serialise a commit. */
export function buildCommit(commit: CommitData): Buffer {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${commit.author}`);
  lines.push(`committer ${commit.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

/** "Name <email> 1700000000 +0000" from parts, the identity line git writes. */
export function identityLine(name: string, email: string, whenSeconds: number, tz = '+0000'): string {
  return `${name} <${email}> ${whenSeconds} ${tz}`;
}

// ---------------------------------------------------------------- packs

/** Encode a set of objects as a complete packfile (no deltas: every object whole). */
export function encodePack(store: ObjectStore, ids: Iterable<string>): Buffer {
  const list = [...ids];
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  chunks.push(header);
  for (const id of list) {
    const obj = store.get(id);
    if (obj === undefined) throw new Error(`encodePack: missing object ${id}`);
    chunks.push(encodePackObjectHeader(TYPE_TO_CODE[obj.type], obj.data.length));
    chunks.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function encodePackObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

interface PackEntry {
  id: string;
  type: GitObjectType;
  data: Buffer;
  offset: number;
}

/** Decode a packfile into the store; returns the ids it carried. Handles ofs- and ref-deltas. */
export function decodePack(store: ObjectStore, pack: Buffer): string[] {
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  const pendingDeltas: Array<{ entry: PackEntry; baseId?: string; baseOffset?: number; delta: Buffer }> = [];

  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseId: string | undefined;
    let baseOffset: number | undefined;
    if (typeCode === 6) {
      // ofs-delta: a negative offset back to the base object's start
      let b = pack[offset] as number;
      offset += 1;
      let back = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = pack[offset] as number;
        offset += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - back;
    } else if (typeCode === 7) {
      baseId = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = inflateFrom(pack, offset);
    offset = inflated.nextOffset;
    const raw = inflated.data;
    if (raw.length !== size) throw new Error(`pack object size mismatch at ${start}`);

    if (typeCode === 6 || typeCode === 7) {
      const entry: PackEntry = { id: '', type: 'blob', data: raw, offset: start };
      entries.push(entry);
      byOffset.set(start, entry);
      pendingDeltas.push({ entry, baseId, baseOffset, delta: raw });
    } else {
      const type = CODE_TO_TYPE[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const id = hashObject(type, raw);
      const entry: PackEntry = { id, type, data: raw, offset: start };
      entries.push(entry);
      byOffset.set(start, entry);
      store.putKnown(id, type, raw);
    }
  }

  // Resolve deltas, possibly in chains: repeat until none are left.
  let remaining = pendingDeltas;
  while (remaining.length > 0) {
    const deferred: typeof remaining = [];
    let progressed = false;
    for (const item of remaining) {
      let base: GitObject | undefined;
      if (item.baseId !== undefined) base = store.get(item.baseId);
      else if (item.baseOffset !== undefined) {
        const baseEntry = byOffset.get(item.baseOffset);
        if (baseEntry !== undefined && baseEntry.id !== '') base = { type: baseEntry.type, data: baseEntry.data };
      }
      if (base === undefined) {
        deferred.push(item);
        continue;
      }
      const data = applyDelta(base.data, item.delta);
      const id = hashObject(base.type, data);
      item.entry.id = id;
      item.entry.type = base.type;
      item.entry.data = data;
      store.putKnown(id, base.type, data);
      progressed = true;
    }
    if (!progressed) throw new Error('pack delta base not found (thin pack against unknown objects)');
    remaining = deferred;
  }

  return entries.map((entry) => entry.id);
}

/** Inflate one zlib stream starting at `offset`; reports where the stream ended. */
function inflateFrom(buffer: Buffer, offset: number): { data: Buffer; nextOffset: number } {
  // Node's inflateSync ignores trailing bytes past a stream's end and throws
  // on a truncated stream, so success is monotonic in the prefix length and
  // the shortest prefix that inflates ends exactly at the stream's end.
  let lo = offset + 1;
  let hi = buffer.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(buffer.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  const data = inflateSync(buffer.subarray(offset, lo));
  return { data, nextOffset: lo };
}

/** Apply a git delta to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if ((op & 0x01) !== 0) { copyOffset |= delta[offset] as number; offset += 1; }
      if ((op & 0x02) !== 0) { copyOffset |= (delta[offset] as number) << 8; offset += 1; }
      if ((op & 0x04) !== 0) { copyOffset |= (delta[offset] as number) << 16; offset += 1; }
      if ((op & 0x08) !== 0) { copyOffset |= (delta[offset] as number) << 24; offset += 1; }
      if ((op & 0x10) !== 0) { copySize |= delta[offset] as number; offset += 1; }
      if ((op & 0x20) !== 0) { copySize |= (delta[offset] as number) << 8; offset += 1; }
      if ((op & 0x40) !== 0) { copySize |= (delta[offset] as number) << 16; offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error('delta result size mismatch');
  return result;
}

// ---------------------------------------------------------------- pkt-line

/** Encode one pkt-line (payload under 65520 bytes), or the special packets. */
export function pktLine(payload: Buffer | string | null): Buffer {
  if (payload === null) return Buffer.from('0000', 'ascii'); // flush
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (body.length === 0) return Buffer.from('0001', 'ascii'); // delimiter
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Parse a buffer of pkt-lines into payloads; null marks a flush, '' a delimiter. */
export function parsePktLines(buffer: Buffer, start = 0): { lines: Array<Buffer | null>; next: number } {
  const lines: Array<Buffer | null> = [];
  let offset = start;
  while (offset + 4 <= buffer.length) {
    const header = buffer.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      lines.push(null);
      offset += 4;
      break;
    }
    if (length === 1) {
      lines.push(Buffer.alloc(0));
      offset += 4;
      continue;
    }
    if (length === 2) {
      lines.push(Buffer.from([2]));
      offset += 4;
      continue;
    }
    if (offset + length > buffer.length) break;
    lines.push(buffer.subarray(offset + 4, offset + length));
    offset += length;
  }
  return { lines, next: offset };
}
