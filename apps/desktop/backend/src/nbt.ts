import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * Minimal NBT parser for reading Minecraft world metadata from level.dat.
 * Supports the subset of the NBT format used in level.dat (named compounds,
 * strings, ints, longs, bytes, lists, compounds). Unknown tag types are
 * skipped by size when possible; unknown compounds are skipped by parsing.
 */

interface NbtContext {
  data: Buffer;
  offset: number;
}

const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_SHORT = 2;
const TAG_INT = 3;
const TAG_LONG = 4;
const TAG_FLOAT = 5;
const TAG_DOUBLE = 6;
const TAG_BYTE_ARRAY = 7;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const TAG_INT_ARRAY = 11;
const TAG_LONG_ARRAY = 12;

export interface WorldMetadata {
  displayName: string;
  gameMode: string;
  lastPlayedVersion: string;
  lastPlayed: number;
}

const GAMEMODE_LABELS: Record<number, string> = {
  0: 'survival',
  1: 'creative',
  2: 'adventure',
  3: 'spectator',
};

/**
 * Read and parse a level.dat (gzip-compressed NBT). Returns extracted
 * metadata, or null if the file is missing/corrupt.
 */
export function readWorldMetadata(levelDatPath: string): WorldMetadata | null {
  if (!fs.existsSync(levelDatPath)) return null;
  try {
    const raw = fs.readFileSync(levelDatPath);
    // level.dat is gzip-compressed.
    const buf = zlib.gunzipSync(raw);
    const ctx: NbtContext = { data: buf, offset: 0 };
    const root = readNamedTag(ctx);
    if (!root || root.type !== TAG_COMPOUND) return null;
    const dataTag = (root as NbtCompound).value.get('Data');
    if (!dataTag || dataTag.type !== TAG_COMPOUND) return null;
    const fields = (dataTag as NbtCompound).value;

    const displayName = stringValue(fields, 'LevelName') ?? '';
    const gameMode = GAMEMODE_LABELS[numberValue(fields, 'GameType') ?? 0] ?? 'survival';
    const lastPlayedVersion = stringValue(fields, 'Version') ?? '';
    const lastPlayed = numberValue(fields, 'LastPlayed') ?? 0;

    return { displayName, gameMode, lastPlayedVersion, lastPlayed };
  } catch {
    return null;
  }
}

function stringValue(map: Map<string, NbtTag>, key: string): string | null {
  const tag = map.get(key);
  return tag && tag.type === TAG_STRING ? (tag as NbtString).value : null;
}

function numberValue(map: Map<string, NbtTag>, key: string): number | null {
  const tag = map.get(key);
  if (!tag) return null;
  if (tag.type === TAG_INT) return (tag as NbtInt).value;
  if (tag.type === TAG_LONG) return Number((tag as NbtLong).value);
  if (tag.type === TAG_BYTE) return (tag as NbtByte).value;
  if (tag.type === TAG_SHORT) return (tag as NbtShort).value;
  return null;
}

interface NbtTag {
  type: number;
}

interface NbtString extends NbtTag {
  type: 8;
  value: string;
}
interface NbtInt extends NbtTag {
  type: 3;
  value: number;
}
interface NbtLong extends NbtTag {
  type: 4;
  value: bigint;
}
interface NbtByte extends NbtTag {
  type: 1;
  value: number;
}
interface NbtShort extends NbtTag {
  type: 2;
  value: number;
}
interface NbtCompound extends NbtTag {
  type: 10;
  value: Map<string, NbtTag>;
}

function readNamedTag(ctx: NbtContext): NbtTag | null {
  // Named tags: type byte + name string.
  const type = readU8(ctx);
  if (type === TAG_END) return { type };
  readString(ctx); // name
  return readTag(ctx, type);
}

function readTag(ctx: NbtContext, type: number): NbtTag {
  switch (type) {
    case TAG_BYTE:
      return { type, value: readU8(ctx) } as NbtTag;
    case TAG_SHORT:
      return { type, value: readI16(ctx) } as NbtTag;
    case TAG_INT:
      return { type, value: readI32(ctx) } as NbtTag;
    case TAG_LONG:
      return { type, value: readI64(ctx) } as NbtTag;
    case TAG_FLOAT:
      return { type, value: readF32(ctx) } as NbtTag;
    case TAG_DOUBLE:
      return { type, value: readF64(ctx) } as NbtTag;
    case TAG_BYTE_ARRAY: {
      const len = readI32(ctx);
      ctx.offset += len;
      return { type } as NbtTag;
    }
    case TAG_STRING:
      return { type, value: readString(ctx) } as NbtTag;
    case TAG_LIST: {
      const elemType = readU8(ctx);
      const len = readI32(ctx);
      for (let i = 0; i < len; i++) readTag(ctx, elemType);
      return { type } as NbtTag;
    }
    case TAG_COMPOUND: {
      const map = new Map<string, NbtTag>();
      for (;;) {
        const childType = readU8(ctx);
        if (childType === TAG_END) break;
        const name = readString(ctx);
        map.set(name, readTag(ctx, childType));
      }
      return { type, value: map } as NbtTag;
    }
    case TAG_INT_ARRAY: {
      const len = readI32(ctx);
      ctx.offset += len * 4;
      return { type } as NbtTag;
    }
    case TAG_LONG_ARRAY: {
      const len = readI32(ctx);
      ctx.offset += len * 8;
      return { type } as NbtTag;
    }
    default:
      // Unknown tag: cannot skip safely; bail by returning an end tag.
      throw new Error(`Unknown NBT tag type ${type}`);
  }
}

function readU8(ctx: NbtContext): number {
  const v = ctx.data.readUInt8(ctx.offset);
  ctx.offset += 1;
  return v;
}

function readI16(ctx: NbtContext): number {
  const v = ctx.data.readInt16BE(ctx.offset);
  ctx.offset += 2;
  return v;
}

function readI32(ctx: NbtContext): number {
  const v = ctx.data.readInt32BE(ctx.offset);
  ctx.offset += 4;
  return v;
}

function readI64(ctx: NbtContext): bigint {
  const v = ctx.data.readBigInt64BE(ctx.offset);
  ctx.offset += 8;
  return v;
}

function readF32(ctx: NbtContext): number {
  const v = ctx.data.readFloatBE(ctx.offset);
  ctx.offset += 4;
  return v;
}

function readF64(ctx: NbtContext): number {
  const v = ctx.data.readDoubleBE(ctx.offset);
  ctx.offset += 8;
  return v;
}

function readString(ctx: NbtContext): string {
  const len = readI16(ctx);
  const v = ctx.data.toString('utf8', ctx.offset, ctx.offset + len);
  ctx.offset += len;
  return v;
}
