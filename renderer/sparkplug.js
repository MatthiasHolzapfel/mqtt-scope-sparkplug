// Sparkplug B payload decoding (Eclipse Tahu sparkplug_b.proto), with no
// dependencies so it runs in the renderer and under plain Node for tests.
//
// A payload is turned into plain JSON-able data:
//   { timestamp, seq, uuid?, body?, metrics: [{ name, alias?, timestamp?,
//     datatype, value, is_null?, is_historical?, is_transient?, metadata?,
//     properties? }] }
// Each metric carries a `name`, so plots follow a metric by name
// (`$.metrics[?(@.name=="temperature_C")].value`) even when the order of the
// metrics changes or a message reports only some of them.

// ------------------------------------------------------------------ topics

const NAMESPACE = 'spBv1.0';

// Message types are matched loosely on purpose: besides the spec's
// NBIRTH/DDATA/… some systems publish their own variants with a prefix (for
// example LDDATA). Anything ending in BIRTH, DEATH, DATA or CMD is decoded.
const MESSAGE_TYPE = /^[A-Z]*(BIRTH|DEATH|DATA|CMD)$/;

// { group, type, verb, node, device } for a Sparkplug B topic, else null.
// spBv1.0/STATE/<host> carries a JSON or text state and is not decoded here.
export function parseTopic(topic) {
  if (typeof topic !== 'string' || !topic.startsWith(NAMESPACE + '/')) return null;
  const parts = topic.split('/');
  if (parts.length < 4 || parts.length > 5) return null;
  const [, group, type, node, device] = parts;
  const m = MESSAGE_TYPE.exec(type);
  if (!m || !group || !node) return null;
  return { group, type, verb: m[1], node, device: device ?? null };
}

// The scope aliases are declared in: a node's NBIRTH covers its N* messages,
// a device's DBIRTH covers that device.
export const aliasScope = (t) => `${t.group}/${t.node}${t.device === null ? '' : '/' + t.device}`;

// ------------------------------------------------------------------ data types

export const DATA_TYPES = [
  'Unknown', 'Int8', 'Int16', 'Int32', 'Int64', 'UInt8', 'UInt16', 'UInt32', 'UInt64',
  'Float', 'Double', 'Boolean', 'String', 'DateTime', 'Text', 'UUID', 'DataSet', 'Bytes',
  'File', 'Template', 'PropertySet', 'PropertySetList',
  'Int8Array', 'Int16Array', 'Int32Array', 'Int64Array', 'UInt8Array', 'UInt16Array',
  'UInt32Array', 'UInt64Array', 'FloatArray', 'DoubleArray', 'BooleanArray', 'StringArray',
  'DateTimeArray',
];
const typeName = (t) => DATA_TYPES[t] ?? `Type${t}`;

// ------------------------------------------------------------------ protobuf reader

class Reader {
  constructor(bytes, start = 0, end = bytes.length) {
    this.b = bytes;
    this.pos = start;
    this.end = end;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get done() {
    return this.pos >= this.end;
  }

  byte() {
    if (this.pos >= this.end) throw new Error('truncated');
    return this.b[this.pos++];
  }

  // Unsigned varint as a BigInt (exact up to 64 bits).
  varint() {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      const b = this.byte();
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return BigInt.asUintN(64, result);
      shift += 7n;
    }
    throw new Error('varint too long');
  }

  uint32() {
    return Number(BigInt.asUintN(32, this.varint()));
  }

  fixed32() {
    if (this.pos + 4 > this.end) throw new Error('truncated');
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  fixed64() {
    if (this.pos + 8 > this.end) throw new Error('truncated');
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  // Length-delimited field: returns [start, end) and moves past it.
  span() {
    const len = Number(this.varint());
    const start = this.pos;
    if (len < 0 || start + len > this.end) throw new Error('truncated');
    this.pos += len;
    return [start, start + len];
  }

  bytes() {
    const [s, e] = this.span();
    return this.b.subarray(s, e);
  }

  string() {
    return utf8.decode(this.bytes());
  }

  sub() {
    const [s, e] = this.span();
    return new Reader(this.b, s, e);
  }

  // Next field as [number, wireType]. Groups (3/4) are not used by Sparkplug
  // and are rejected, which also stops a JSON or text payload from passing as
  // protobuf ('{' would be a group start).
  tag() {
    const t = this.uint32();
    const field = t >>> 3;
    const wire = t & 7;
    if (field === 0 || wire === 3 || wire === 4 || wire > 5) throw new Error(`bad tag ${t}`);
    return [field, wire];
  }

  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.need(8);
    else if (wire === 2) this.span();
    else if (wire === 5) this.need(4);
    else throw new Error(`bad wire type ${wire}`);
  }

  need(n) {
    if (this.pos + n > this.end) throw new Error('truncated');
    this.pos += n;
  }

  // Calls fn(field, wire) for each field; fn returns false for fields it did
  // not read, which are skipped (unknown fields and extensions).
  each(fn) {
    while (!this.done) {
      const [field, wire] = this.tag();
      if (fn(field, wire) === false) this.skip(wire);
    }
  }
}

const utf8 = new TextDecoder('utf-8');

// Expect a wire type for a known field; a mismatch means "not Sparkplug".
function want(wire, expected) {
  if (wire !== expected) throw new Error('unexpected wire type');
}

// ------------------------------------------------------------------ value helpers

// A uint64 as a plain number when exact, else as a decimal string (JSON has no
// 64-bit integers; the string stays exact and still plots).
const u64 = (big) => (big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big.toString());
const i64 = (big) => {
  const s = BigInt.asIntN(64, big);
  return s >= BigInt(Number.MIN_SAFE_INTEGER) && s <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(s) : s.toString();
};

// Shortest decimal that is the same float32: 36.1 instead of 36.099998474121094.
export function float32(v) {
  if (!Number.isFinite(v) || Number.isInteger(v)) return v;
  for (let p = 1; p <= 9; p++) {
    const x = Number(v.toPrecision(p));
    if (Math.fround(x) === v) return x;
  }
  return v;
}

// Signed types are sent in the unsigned fields as two's complement.
function signed(type, v) {
  if (type === 1) return ((v & 0xff) << 24) >> 24; // Int8
  if (type === 2) return ((v & 0xffff) << 16) >> 16; // Int16
  if (type === 3) return v | 0; // Int32
  return v;
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');

// Array types travel in bytes_value, little-endian (Sparkplug 3.0).
function decodeArray(type, bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read = (size, get) => {
    if (bytes.length % size) throw new Error('bad array length');
    const out = [];
    for (let i = 0; i < bytes.length; i += size) out.push(get(i));
    return out;
  };
  switch (type) {
    case 22: return read(1, (i) => view.getInt8(i));
    case 23: return read(2, (i) => view.getInt16(i, true));
    case 24: return read(4, (i) => view.getInt32(i, true));
    case 25: return read(8, (i) => i64(view.getBigUint64(i, true)));
    case 26: return read(1, (i) => view.getUint8(i));
    case 27: return read(2, (i) => view.getUint16(i, true));
    case 28: return read(4, (i) => view.getUint32(i, true));
    case 29: return read(8, (i) => u64(view.getBigUint64(i, true)));
    case 30: return read(4, (i) => float32(view.getFloat32(i, true)));
    case 31: return read(8, (i) => view.getFloat64(i, true));
    case 34: return read(8, (i) => i64(view.getBigUint64(i, true)));
    case 32: {
      // 4-byte element count, then the bits, most significant first.
      if (bytes.length < 4) throw new Error('bad boolean array');
      const count = view.getUint32(0, true);
      if (Math.ceil(count / 8) > bytes.length - 4) throw new Error('bad boolean array');
      const out = [];
      for (let i = 0; i < count; i++) out.push(((bytes[4 + (i >> 3)] >> (7 - (i & 7))) & 1) === 1);
      return out;
    }
    case 33: {
      // Null-terminated UTF-8 strings.
      const out = [];
      let start = 0;
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) {
          out.push(utf8.decode(bytes.subarray(start, i)));
          start = i + 1;
        }
      }
      if (start < bytes.length) out.push(utf8.decode(bytes.subarray(start)));
      return out;
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------------ messages

// The oneof value shared by Parameter, DataSetValue and PropertyValue, whose
// field numbers start at `base` (int, long, float, double, bool, string).
function scalarValue(r, field, wire, base, type) {
  switch (field - base) {
    case 0: want(wire, 0); return { value: signed(type, r.uint32()) };
    case 1: want(wire, 0); return { value: type === 4 || type === 13 ? i64(r.varint()) : u64(r.varint()) };
    case 2: want(wire, 5); return { value: float32(r.fixed32()) };
    case 3: want(wire, 1); return { value: r.fixed64() };
    case 4: want(wire, 0); return { value: r.varint() !== 0n };
    case 5: want(wire, 2); return { value: r.string() };
    default: return null;
  }
}

function readPropertySet(r) {
  const keys = [];
  const values = [];
  r.each((f, w) => {
    if (f === 1) { want(w, 2); keys.push(r.string()); }
    else if (f === 2) { want(w, 2); values.push(readPropertyValue(r.sub())); }
    else return false;
  });
  const out = {};
  keys.forEach((k, i) => (out[k] = values[i] ?? null));
  return out;
}

function readPropertyValue(r) {
  let type = 0;
  let isNull = false;
  let value;
  r.each((f, w) => {
    if (f === 1) { want(w, 0); type = r.uint32(); }
    else if (f === 2) { want(w, 0); isNull = r.varint() !== 0n; }
    else if (f >= 3 && f <= 8) value = scalarValue(r, f, w, 3, type).value;
    else if (f === 9) { want(w, 2); value = readPropertySet(r.sub()); }
    else if (f === 10) {
      want(w, 2);
      const list = [];
      const lr = r.sub();
      lr.each((f2, w2) => {
        if (f2 !== 1) return false;
        want(w2, 2);
        list.push(readPropertySet(lr.sub()));
      });
      value = list;
    } else return false;
  });
  return isNull ? null : value ?? null;
}

function readMetaData(r) {
  const out = {};
  r.each((f, w) => {
    switch (f) {
      case 1: want(w, 0); out.is_multi_part = r.varint() !== 0n; break;
      case 2: want(w, 2); out.content_type = r.string(); break;
      case 3: want(w, 0); out.size = u64(r.varint()); break;
      case 4: want(w, 0); out.seq = u64(r.varint()); break;
      case 5: want(w, 2); out.file_name = r.string(); break;
      case 6: want(w, 2); out.file_type = r.string(); break;
      case 7: want(w, 2); out.md5 = r.string(); break;
      case 8: want(w, 2); out.description = r.string(); break;
      default: return false;
    }
  });
  return out;
}

function readDataSet(r) {
  const columns = [];
  const types = [];
  const rows = [];
  r.each((f, w) => {
    if (f === 1) { want(w, 0); r.varint(); }
    else if (f === 2) { want(w, 2); columns.push(r.string()); }
    else if (f === 3) {
      // repeated uint32, packed or not
      if (w === 2) { const p = r.sub(); while (!p.done) types.push(p.uint32()); }
      else { want(w, 0); types.push(r.uint32()); }
    } else if (f === 4) {
      want(w, 2);
      const row = [];
      const rr = r.sub();
      rr.each((f2, w2) => {
        if (f2 !== 1) return false;
        want(w2, 2);
        const er = rr.sub();
        let v = null;
        const col = row.length;
        er.each((f3, w3) => {
          const s = scalarValue(er, f3, w3, 1, types[col] ?? 0);
          if (!s) return false;
          v = s.value;
        });
        row.push(v);
      });
      rows.push(row);
    } else return false;
  });
  return {
    columns: columns.map((name, i) => ({ name, type: typeName(types[i] ?? 0) })),
    rows: rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i] ?? null]))),
  };
}

function readTemplate(r, aliases) {
  const out = { metrics: [] };
  const parameters = [];
  r.each((f, w) => {
    if (f === 1) { want(w, 2); out.version = r.string(); }
    else if (f === 2) { want(w, 2); out.metrics.push(readMetric(r.sub(), aliases)); }
    else if (f === 3) {
      want(w, 2);
      const p = { name: null, type: 'Unknown', value: null };
      let type = 0;
      const pr = r.sub();
      pr.each((f2, w2) => {
        if (f2 === 1) { want(w2, 2); p.name = pr.string(); }
        else if (f2 === 2) { want(w2, 0); type = pr.uint32(); p.type = typeName(type); }
        else {
          const s = scalarValue(pr, f2, w2, 3, type);
          if (!s) return false;
          p.value = s.value;
        }
      });
      parameters.push(p);
    } else if (f === 4) { want(w, 2); out.template_ref = r.string(); }
    else if (f === 5) { want(w, 0); out.is_definition = r.varint() !== 0n; }
    else return false;
  });
  if (parameters.length) out.parameters = parameters;
  return out;
}

function readMetric(r, aliases) {
  const m = {};
  let type = 0;
  let raw; // [field, value] of the oneof, interpreted once the datatype is known
  r.each((f, w) => {
    switch (f) {
      case 1: want(w, 2); m.name = r.string(); break;
      case 2: want(w, 0); m.alias = u64(r.varint()); break;
      case 3: want(w, 0); m.timestamp = u64(r.varint()); break;
      case 4: want(w, 0); type = r.uint32(); break;
      case 5: want(w, 0); m.is_historical = r.varint() !== 0n; break;
      case 6: want(w, 0); m.is_transient = r.varint() !== 0n; break;
      case 7: want(w, 0); m.is_null = r.varint() !== 0n; break;
      case 8: want(w, 2); m.metadata = readMetaData(r.sub()); break;
      case 9: want(w, 2); m.properties = readPropertySet(r.sub()); break;
      case 10: want(w, 0); raw = [f, r.uint32()]; break;
      case 11: want(w, 0); raw = [f, r.varint()]; break;
      case 12: want(w, 5); raw = [f, r.fixed32()]; break;
      case 13: want(w, 1); raw = [f, r.fixed64()]; break;
      case 14: want(w, 0); raw = [f, r.varint() !== 0n]; break;
      case 15: want(w, 2); raw = [f, r.string()]; break;
      case 16: want(w, 2); raw = [f, r.bytes()]; break;
      case 17: want(w, 2); raw = [f, r.sub()]; break;
      case 18: want(w, 2); raw = [f, r.sub()]; break;
      default: return false;
    }
  });

  // Names first: from the message, else from the alias declared in a BIRTH.
  if (m.name === undefined && m.alias !== undefined && aliases) {
    const known = aliases.get(String(m.alias));
    if (known) {
      m.name = known.name;
      if (!type) type = known.type;
    }
  }
  const out = { name: m.name ?? (m.alias !== undefined ? `alias ${m.alias}` : null) };
  if (m.alias !== undefined) out.alias = m.alias;
  if (m.timestamp !== undefined) out.timestamp = m.timestamp;
  out.datatype = typeName(type);
  out.value = metricValue(type, raw);
  if (m.is_null) out.value = null;
  for (const k of ['is_null', 'is_historical', 'is_transient', 'metadata', 'properties']) if (m[k] !== undefined) out[k] = m[k];
  // The numeric type, for the alias table; not enumerable, so not shown.
  Object.defineProperty(out, '_type', { value: type });
  return out;
}

function metricValue(type, raw) {
  if (!raw) return null;
  const [f, v] = raw;
  switch (f) {
    case 10: return signed(type, v);
    case 11: return type === 4 || type === 13 ? i64(v) : u64(v);
    case 12: return float32(v);
    case 13:
    case 14:
    case 15: return v;
    case 16: {
      if (type >= 22 && type <= 34) {
        try {
          const arr = decodeArray(type, v);
          if (arr) return arr;
        } catch {
          // fall through to hex
        }
      }
      return hex(v);
    }
    case 17: return readDataSet(v);
    case 18: return readTemplate(v);
    default: return null;
  }
}

// Decodes a Sparkplug B payload. `aliases` (Map alias -> { name, type }) names
// metrics that a DATA message sends by alias only. Throws when the bytes are
// not a Sparkplug B payload.
export function decodePayload(bytes, aliases = null) {
  const r = new Reader(bytes);
  const out = {};
  const metrics = [];
  let known = 0;
  r.each((f, w) => {
    switch (f) {
      case 1: want(w, 0); out.timestamp = u64(r.varint()); break;
      case 2: want(w, 2); metrics.push(readMetric(r.sub(), aliases)); break;
      case 3: want(w, 0); out.seq = u64(r.varint()); break;
      case 4: want(w, 2); out.uuid = r.string(); break;
      case 5: want(w, 2); out.body = hex(r.bytes()); break;
      default: return false;
    }
    known++;
  });
  // Text that happens to parse as protobuf would only produce unknown fields.
  if (!known) throw new Error('no Sparkplug fields');
  out.metrics = metrics;
  return out;
}

// The alias table a BIRTH declares: alias -> { name, type }.
export function aliasesOf(bytes) {
  const table = new Map();
  const p = decodePayload(bytes);
  for (const m of p.metrics) if (m.alias !== undefined && m.name) table.set(String(m.alias), { name: m.name, type: m._type });
  return table;
}

// Decodes a message's payload when its topic is a Sparkplug B one. Returns
// { topic: parsed topic, value } or null (not Sparkplug, or not decodable).
export function decodeMessage(msg) {
  const t = parseTopic(msg.topic);
  if (!t || !msg.payload || !msg.payload.length) return null;
  try {
    return { topic: t, value: decodePayload(msg.payload, msg.spAliases instanceof Map ? msg.spAliases : null) };
  } catch {
    return null;
  }
}

// A one-line summary for lists: "LDDATA · 12 metrics: a=1, b=2, …".
export function summary(type, value, max = 160) {
  const n = value.metrics.length;
  let s = `${type} · ${n} metric${n === 1 ? '' : 's'}`;
  if (n) {
    s += ': ';
    const parts = [];
    for (const m of value.metrics) {
      const v = m.value;
      const shown = v === null ? 'null' : typeof v === 'object' ? (Array.isArray(v) ? `[${v.length}]` : '{…}') : String(v);
      parts.push(`${m.name}=${shown}`);
      if (s.length + parts.join(', ').length > max) break;
    }
    s += parts.join(', ');
  }
  return s;
}

// ------------------------------------------------------------------ alias registry

// Per connection: remembers the aliases of every node and device from their
// BIRTH messages, and hands each DATA message the table of its scope.
export class AliasRegistry {
  constructor() {
    this.scopes = new Map();
  }

  // Called for every incoming message, in arrival order.
  note(msg) {
    const t = parseTopic(msg.topic);
    if (!t) return;
    const scope = aliasScope(t);
    if (t.verb === 'BIRTH') {
      try {
        const table = aliasesOf(msg.payload);
        if (table.size) this.scopes.set(scope, table);
        else this.scopes.delete(scope);
      } catch {
        // not decodable: leave the previous table
      }
    }
    const table = this.scopes.get(scope);
    if (table) msg.spAliases = table;
  }

  clear() {
    this.scopes.clear();
  }
}
