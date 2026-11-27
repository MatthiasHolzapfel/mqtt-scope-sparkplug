import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseTopic, decodePayload, decodeMessage, float32, summary, AliasRegistry } from '../../renderer/sparkplug.js';
import { decode, preview, extractNumber, plainMessage } from '../../renderer/payload.js';
import { namedSegs, parsePath } from '../../renderer/jsonPath.js';
import { messageFields, hasNumbers } from '../../renderer/fields.js';
import { TopicTree } from '../../renderer/topicTree.js';

// ------------------------------------------------------------------ a tiny protobuf writer

const te = new TextEncoder();
const varint = (v) => {
  let n = BigInt.asUintN(64, BigInt(v));
  const out = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const tag = (field, wire) => varint((field << 3) | wire);
const cat = (...parts) => Uint8Array.from(parts.flat(Infinity));
const vf = (field, v) => [tag(field, 0), varint(v)];
const sf = (field, s) => { const b = typeof s === 'string' ? te.encode(s) : s; return [tag(field, 2), varint(b.length), Array.from(b)]; };
const mf = (field, bytes) => [tag(field, 2), varint(bytes.length), Array.from(bytes)];
const f32 = (field, v) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return [tag(field, 5), Array.from(b)]; };
const f64 = (field, v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return [tag(field, 1), Array.from(b)]; };

// Metric datatypes used below.
const T = { Int8: 1, Int16: 2, Int32: 3, Int64: 4, UInt64: 8, Float: 9, Double: 10, Boolean: 11, String: 12, DateTime: 13, DataSet: 16, Template: 19, Int32Array: 24, FloatArray: 30, BooleanArray: 32, StringArray: 33 };

const metric = ({ name, alias, ts, type, int, long, float, double, bool, str, bytes, sub, isNull }) =>
  cat(
    name !== undefined ? sf(1, name) : [],
    alias !== undefined ? vf(2, alias) : [],
    ts !== undefined ? vf(3, ts) : [],
    type !== undefined ? vf(4, type) : [],
    isNull ? vf(7, 1) : [],
    int !== undefined ? vf(10, int) : [],
    long !== undefined ? vf(11, long) : [],
    float !== undefined ? f32(12, float) : [],
    double !== undefined ? f64(13, double) : [],
    bool !== undefined ? vf(14, bool ? 1 : 0) : [],
    str !== undefined ? sf(15, str) : [],
    bytes !== undefined ? mf(16, bytes) : [],
    sub !== undefined ? mf(sub[0], sub[1]) : [],
  );
const payload = ({ ts, seq, metrics = [] }) => cat(ts !== undefined ? vf(1, ts) : [], metrics.map((m) => mf(2, m)), seq !== undefined ? vf(3, seq) : []);

// Like the battery message in the screenshot: LDDATA, strings and floats.
const battery = () =>
  payload({
    ts: 1795771840579,
    seq: 3,
    metrics: [
      metric({ name: 'produced_at_utc', type: T.String, str: '2026-11-27T09:30:40.579805336Z' }),
      metric({ name: 'resolution', type: T.String, str: 'single' }),
      metric({ name: 'active_power_total_W', type: T.Float, float: 0 }),
      metric({ name: 'state_of_charge_percent', type: T.Float, float: 10 }),
      metric({ name: 'state_of_health_percent', type: T.Float, float: 100 }),
      metric({ name: 'temperature_C', type: T.Float, float: 36.1 }),
    ],
  });
const BATTERY_TOPIC = 'spBv1.0/DEFAULT/LDDATA/battery/a84f1ca5-6220-5225-bdfe-0abd24135750';

// ------------------------------------------------------------------ topics

describe('parseTopic', () => {
  test('standard and prefixed message types', () => {
    assert.deepEqual(parseTopic('spBv1.0/G/DDATA/node/dev'), { group: 'G', type: 'DDATA', verb: 'DATA', node: 'node', device: 'dev' });
    assert.deepEqual(parseTopic('spBv1.0/G/NBIRTH/node'), { group: 'G', type: 'NBIRTH', verb: 'BIRTH', node: 'node', device: null });
    assert.equal(parseTopic(BATTERY_TOPIC).type, 'LDDATA');
    assert.equal(parseTopic(BATTERY_TOPIC).verb, 'DATA');
  });

  test('not Sparkplug', () => {
    for (const t of ['spBv1.0/STATE/host', 'spBv1.0/G/STATUS/n', 'spAv1.0/G/DDATA/n/d', 'sensors/x', 'spBv1.0/G/DDATA', 'spBv1.0/G/DDATA/n/d/extra', 'spBv1.0/G/ddata/n']) {
      assert.equal(parseTopic(t), null, t);
    }
  });
});

// ------------------------------------------------------------------ payloads

describe('decodePayload', () => {
  test('the battery message: names, types, float32 values shown short', () => {
    const p = decodePayload(battery());
    assert.equal(p.timestamp, 1795771840579);
    assert.equal(p.seq, 3);
    assert.deepEqual(
      p.metrics.map((m) => [m.name, m.datatype, m.value]),
      [
        ['produced_at_utc', 'String', '2026-11-27T09:30:40.579805336Z'],
        ['resolution', 'String', 'single'],
        ['active_power_total_W', 'Float', 0],
        ['state_of_charge_percent', 'Float', 10],
        ['state_of_health_percent', 'Float', 100],
        ['temperature_C', 'Float', 36.1],
      ],
    );
  });

  test('signed and 64-bit integers, doubles, booleans, DateTime', () => {
    const p = decodePayload(
      payload({
        metrics: [
          metric({ name: 'i8', type: T.Int8, int: 0xff }),
          metric({ name: 'i8wide', type: T.Int8, int: 0xffffffff }),
          metric({ name: 'i16', type: T.Int16, int: 0xfffe }),
          metric({ name: 'i32', type: T.Int32, int: 0xfffffffd }),
          metric({ name: 'i64', type: T.Int64, long: -5n }),
          metric({ name: 'u64big', type: T.UInt64, long: 2n ** 63n + 1n }),
          metric({ name: 'd', type: T.Double, double: 0.1 }),
          metric({ name: 'b', type: T.Boolean, bool: true }),
          metric({ name: 'when', type: T.DateTime, long: 1795771840579 }),
        ],
      }),
    );
    const v = Object.fromEntries(p.metrics.map((m) => [m.name, m.value]));
    assert.deepEqual(v, { i8: -1, i8wide: -1, i16: -2, i32: -3, i64: -5, u64big: '9223372036854775809', d: 0.1, b: true, when: 1795771840579 });
  });

  test('is_null wins over a value, metric timestamps are kept', () => {
    const p = decodePayload(payload({ metrics: [metric({ name: 'x', type: T.Float, ts: 42, isNull: true })] }));
    assert.deepEqual(p.metrics[0], { name: 'x', timestamp: 42, datatype: 'Float', value: null, is_null: true });
  });

  test('arrays in bytes_value', () => {
    const i32 = new Uint8Array(8);
    new DataView(i32.buffer).setInt32(0, -7, true);
    new DataView(i32.buffer).setInt32(4, 9, true);
    const fl = new Uint8Array(4);
    new DataView(fl.buffer).setFloat32(0, 1.5, true);
    const p = decodePayload(
      payload({
        metrics: [
          metric({ name: 'ints', type: T.Int32Array, bytes: i32 }),
          metric({ name: 'floats', type: T.FloatArray, bytes: fl }),
          metric({ name: 'bools', type: T.BooleanArray, bytes: Uint8Array.from([3, 0, 0, 0, 0b10100000]) }),
          metric({ name: 'strs', type: T.StringArray, bytes: te.encode('ab\0cd\0') }),
          metric({ name: 'raw', type: 17, bytes: Uint8Array.from([1, 255]) }),
        ],
      }),
    );
    const v = Object.fromEntries(p.metrics.map((m) => [m.name, m.value]));
    assert.deepEqual(v, { ints: [-7, 9], floats: [1.5], bools: [true, false, true], strs: ['ab', 'cd'], raw: '01 ff' });
  });

  test('data sets and templates', () => {
    const dsValue = (fields) => cat(fields);
    const row = (...els) => cat(els.map((e) => mf(1, e)));
    const ds = cat(vf(1, 2), sf(2, 'name'), sf(2, 'temp'), vf(3, T.String), vf(3, T.Float), mf(4, row(dsValue(sf(6, 'a')), dsValue(f32(3, 21.5)))));
    const tpl = cat(sf(1, 'v1'), mf(2, metric({ name: 'inner', type: T.Int32, int: 4 })), sf(4, 'Motor'));
    const p = decodePayload(payload({ metrics: [metric({ name: 'table', type: T.DataSet, sub: [17, ds] }), metric({ name: 'motor', type: T.Template, sub: [18, tpl] })] }));
    assert.deepEqual(p.metrics[0].value, { columns: [{ name: 'name', type: 'String' }, { name: 'temp', type: 'Float' }], rows: [{ name: 'a', temp: 21.5 }] });
    assert.deepEqual(p.metrics[1].value.metrics.map((m) => [m.name, m.value]), [['inner', 4]]);
    assert.equal(p.metrics[1].value.template_ref, 'Motor');
  });

  test('unknown fields (extensions) are skipped', () => {
    const p = decodePayload(cat(vf(1, 5), sf(99, 'ext'), mf(2, metric({ name: 'a', type: T.Int32, int: 1 }))));
    assert.deepEqual(p.metrics.map((m) => m.value), [1]);
  });

  test('rejects text, JSON and truncated bytes', () => {
    for (const bad of [te.encode('{"a":1}'), te.encode('hello world'), te.encode('58.169.129.172'), battery().subarray(0, 20)]) {
      assert.throws(() => decodePayload(bad));
    }
  });

  test('float32 shortest form', () => {
    assert.equal(float32(Math.fround(36.1)), 36.1);
    assert.equal(float32(Math.fround(0.1)), 0.1);
    assert.equal(float32(5), 5);
  });
});

// ------------------------------------------------------------------ aliases

describe('aliases from BIRTH messages', () => {
  const birth = payload({ seq: 0, metrics: [metric({ name: 'temp', alias: 1, type: T.Float, float: 20 }), metric({ name: 'on', alias: 2, type: T.Boolean, bool: false })] });
  const data = payload({ seq: 1, metrics: [metric({ alias: 1, float: 21.5 }), metric({ alias: 2, bool: true })] });

  test('a DATA message gets the names and types its DBIRTH declared', () => {
    const tree = new TopicTree();
    tree.addMessage({ topic: 'spBv1.0/G/DBIRTH/n/d', payload: birth, ts: 1 });
    const msg = { topic: 'spBv1.0/G/DDATA/n/d', payload: data, ts: 2 };
    tree.addMessage(msg);
    const d = decode(msg);
    assert.deepEqual(d.value.metrics, [
      { name: 'temp', alias: 1, datatype: 'Float', value: 21.5 },
      { name: 'on', alias: 2, datatype: 'Boolean', value: true },
    ]);
  });

  test('scopes are separate: another device, and the node, do not share them', () => {
    const reg = new AliasRegistry();
    reg.note({ topic: 'spBv1.0/G/DBIRTH/n/d', payload: birth });
    const other = { topic: 'spBv1.0/G/DDATA/n/other', payload: data };
    const node = { topic: 'spBv1.0/G/NDATA/n', payload: data };
    reg.note(other);
    reg.note(node);
    assert.equal(decode(other).value.metrics[0].name, 'alias 1');
    assert.equal(decode(node).value.metrics[0].name, 'alias 1');
  });

  test('a rebirth replaces the table; plainMessage keeps it for other windows', () => {
    const reg = new AliasRegistry();
    reg.note({ topic: 'spBv1.0/G/DBIRTH/n/d', payload: birth });
    reg.note({ topic: 'spBv1.0/G/DBIRTH/n/d', payload: payload({ metrics: [metric({ name: 'pressure', alias: 1, type: T.Float, float: 1 })] }) });
    const msg = { topic: 'spBv1.0/G/DDATA/n/d', payload: data, ts: 3 };
    reg.note(msg);
    const copy = plainMessage(msg);
    assert.equal(decode(copy).value.metrics[0].name, 'pressure');
  });

  test('a table that did not survive serialisation is ignored, not fatal', () => {
    const msg = { topic: 'spBv1.0/G/DDATA/n/d', payload: data, spAliases: {} };
    assert.equal(decode(msg).value.metrics[0].name, 'alias 1');
  });
});

// ------------------------------------------------------------------ the rest of the app

describe('Sparkplug in the existing views and plots', () => {
  const msg = () => ({ topic: BATTERY_TOPIC, payload: battery(), ts: 0 });

  test('decode: JSON with the message type; Text is pretty JSON', () => {
    const d = decode(msg());
    assert.equal(d.kind, 'json');
    assert.equal(d.sparkplug, 'LDDATA');
    assert.equal(d.size, battery().length);
    assert.deepEqual(JSON.parse(d.text), d.value);
  });

  test('other topics are untouched, and junk on a Sparkplug topic falls back', () => {
    assert.equal(decode({ topic: 'a/b', payload: battery() }).kind, 'binary');
    assert.equal(decode({ topic: 'spBv1.0/STATE/host', payload: te.encode('{"online":true}') }).kind, 'json');
    const junk = decode({ topic: BATTERY_TOPIC, payload: te.encode('58.169.129.172') });
    assert.equal(junk.kind, 'text');
    assert.equal(junk.sparkplug, undefined);
    assert.equal(decode({ topic: 'spBv1.0/G/NDEATH/n', payload: new Uint8Array(0) }).kind, 'empty');
  });

  test('the tree row preview summarises the metrics', () => {
    assert.match(preview(msg()), /^LDDATA · 6 metrics: produced_at_utc=2026-11-27T09:30:40\.579805336Z, resolution=single, active_power_total_W=0/);
    assert.match(summary('DDATA', { metrics: [] }), /^DDATA · 0 metrics$/);
  });

  test('a picked metric is plotted by name, also when the order changes', () => {
    const m = msg();
    assert.equal(hasNumbers(m), true);
    const { rows } = messageFields(m);
    const row = rows.find((r) => r.path === '$.metrics[5].value');
    assert.equal(row.value, 36.1);
    assert.equal(row.plottable, true);
    const segs = namedSegs(decode(m).value, row.segs);
    assert.deepEqual(segs, ['metrics', { field: 'name', equals: 'temperature_C' }, 'value']);
    assert.deepEqual(segs, parsePath('$.metrics[?(@.name=="temperature_C")].value'));

    const reordered = {
      topic: BATTERY_TOPIC,
      ts: 1,
      payload: payload({ metrics: [metric({ name: 'temperature_C', type: T.Float, float: 37.5 }), metric({ name: 'resolution', type: T.String, str: 'single' })] }),
    };
    assert.equal(extractNumber(m, segs), 36.1);
    assert.equal(extractNumber(reordered, segs), 37.5);
    const soc = parsePath('$.metrics[?(@.name=="state_of_charge_percent")].value');
    assert.equal(extractNumber(m, soc), 10);
    assert.equal(extractNumber(reordered, soc), undefined, 'a metric the message does not report leaves a gap');
  });

  test('decodeMessage returns null rather than throwing', () => {
    assert.equal(decodeMessage({ topic: BATTERY_TOPIC, payload: Uint8Array.from([0xff, 0xff]) }), null);
    assert.equal(decodeMessage({ topic: 'x', payload: battery() }), null);
  });
});
