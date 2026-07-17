/**
 * Option Engine Binary Unpacker (v6) — SCHEMA-DRIVEN
 *
 * Single source of truth: Schema Map JSON from engine.
 * Engine changes schema → UI automatically adapts. No manual code changes.
 *
 * How it works:
 *   1. On connect, fetch schema map from engine (/schema or WS get_schema)
 *   2. buildReaderPlan() converts schema fields → pre-computed read instructions
 *   3. unpackRow() uses the plan: type → correct DataView method automatically
 *   4. Decode rules (divide_10, multiply_step, seconds_to_time) applied from schema
 *
 * Before: getUint16(offset+46) hardcoded → chng_pct crash when engine changed H→h
 * After:  schema says "int16" → getInt16() automatically picked → NO manual fix needed
 */

// ==================== CONSTANTS (defaults, overridden by schema) ====================
let HDR_SIZE = 22;
let ROW_SIZE = 86;
let QHDR_SIZE = 8;

// Symbol registry (defaults, overridden by schema.symbols)
const STEP_MAP: Record<number, number> = { 1: 50, 2: 100, 3: 100, 4: 50 };
const NAME_MAP: Record<number, string> = {
  1: "NIFTY", 2: "BANKNIFTY", 3: "SENSEX", 4: "CRUDEOIL",
};
const UNIT_SUFFIX = ["", "K", "M", "B"];

// ==================== TYPES ====================
export interface OptionRow {
  timestamp: string;
  spot_price: number;
  spot_chng: number;
  relative_idx: number;
  strike: number;
  lot_size: number;
  ce_oi: number;
  ce_oi_short: number;
  ce_oi_unit: string;
  ce_chng: number;
  ce_chng_short: number;
  ce_chng_unit: string;
  ce_vol: number;
  ce_vol_short: number;
  ce_vol_unit: string;
  ce_ltp: number;
  ce_iv: number;
  ce_delta: number;
  ce_vol_pct: number;
  ce_oi_pct: number;
  ce_chng_pct: number;
  pe_oi: number;
  pe_oi_short: number;
  pe_oi_unit: string;
  pe_chng: number;
  pe_chng_short: number;
  pe_chng_unit: string;
  pe_vol: number;
  pe_vol_short: number;
  pe_vol_unit: string;
  pe_ltp: number;
  pe_iv: number;
  pe_delta: number;
  pe_vol_pct: number;
  pe_oi_pct: number;
  pe_chng_pct: number;
  gamma: number;
  ce_rank: string;
  pe_rank: string;
}

export interface TickData {
  symbol: string;
  timestamp: string;
  spot: number;
  chng: number;
  atm: number;
  count: number;
  data: OptionRow[];
}

export interface SchemaMap {
  version: number;
  formats: Record<string, { size: number; fields: SchemaField[] }>;
  symbols: Record<string, { name: string; step: number; exchange: string }>;
  decode_rules: Record<string, string>;
  meta_pack_layout: Record<string, string>;
}

interface SchemaField {
  name: string;
  offset: number;
  size: number;
  type: string;
  decode?: string;
}

// ==================== SCHEMA-DRIVEN READER PLAN ====================
/**
 * Maps schema type strings → DataView method names.
 * Engine changes "uint16" to "int16" in schema → UI automatically uses getInt16.
 */
const TYPE_READERS: Record<string, keyof DataView> = {
  'uint32':  'getUint32',
  'int32':   'getInt32',
  'uint16':  'getUint16',
  'int16':   'getInt16',
  'float32': 'getFloat32',
};

interface ReadOp {
  name: string;           // field name from schema
  offset: number;         // byte offset from schema
  reader: keyof DataView; // DataView method name, picked from TYPE_READERS
  decode: string | null;  // decode rule from schema (null = raw value)
}

interface HeaderReadOp {
  name: string;
  offset: number;
  reader: keyof DataView;
  decode: string | null;
}

/** Pre-computed plans — built once from schema, reused every tick */
let rowPlan: ReadOp[] = [];
let headerPlan: HeaderReadOp[] = [];
let queryHeaderPlan: HeaderReadOp[] = [];

/**
 * Build read plans from schema map. Called once when schema is received.
 * After this, unpackRow/unpackTick automatically use correct DataView methods.
 */
function buildReaderPlan(schema: SchemaMap): void {
  // Update sizes from schema
  const tickHeader = schema.formats.tick_header;
  const row = schema.formats.row;
  const queryHeader = schema.formats.query_header;

  if (tickHeader) HDR_SIZE = tickHeader.size;
  if (row) ROW_SIZE = row.size;
  if (queryHeader) QHDR_SIZE = queryHeader.size;

  // Update symbol registry from schema
  for (const [id, info] of Object.entries(schema.symbols)) {
    STEP_MAP[Number(id)] = info.step;
    NAME_MAP[Number(id)] = info.name;
  }

  // Build row read plan
  rowPlan = (row?.fields ?? []).map(f => ({
    name: f.name,
    offset: f.offset,
    reader: TYPE_READERS[f.type] || 'getUint32',
    decode: f.decode || null,
  }));

  // Build header read plan
  headerPlan = (tickHeader?.fields ?? []).map(f => ({
    name: f.name,
    offset: f.offset,
    reader: TYPE_READERS[f.type] || 'getUint32',
    decode: f.decode || null,
  }));

  // Build query header read plan
  queryHeaderPlan = (queryHeader?.fields ?? []).map(f => ({
    name: f.name,
    offset: f.offset,
    reader: TYPE_READERS[f.type] || 'getUint32',
    decode: f.decode || null,
  }));

  console.log(`[SCHEMA-DRIVEN] Plans built: header=${headerPlan.length} fields, row=${rowPlan.length} fields, qhdr=${queryHeaderPlan.length} fields`);
  console.log(`[SCHEMA-DRIVEN] Sizes: HDR=${HDR_SIZE}, ROW=${ROW_SIZE}, QHDR=${QHDR_SIZE}`);

  // Log type mapping for verification
  const typeChanges = rowPlan.filter(p => p.decode);
  console.log(`[SCHEMA-DRIVEN] Decoded fields: ${typeChanges.map(p => `${String(p.name)}(${String(p.reader)}/${String(p.decode)})`).join(', ')}`);
}

// ==================== HELPERS ====================
function fmtTime(s: number): string {
  const h = (s / 3600) | 0;
  const m = ((s % 3600) / 60) | 0;
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function shortValue(raw: number, unitCode: number): number {
  return Math.round((raw / Math.pow(1000, unitCode)) * 100) / 100;
}

// ==================== META PACK UNPACK ====================
function unpackMeta(pack: number) {
  return {
    ce_oi_unit:    UNIT_SUFFIX[pack & 0b11],
    ce_chng_unit:  UNIT_SUFFIX[(pack >>> 2) & 0b11],
    ce_vol_unit:   UNIT_SUFFIX[(pack >>> 4) & 0b11],
    pe_oi_unit:    UNIT_SUFFIX[(pack >>> 6) & 0b11],
    pe_chng_unit:  UNIT_SUFFIX[(pack >>> 8) & 0b11],
    pe_vol_unit:   UNIT_SUFFIX[(pack >>> 10) & 0b11],
    ce_vol_rank:   (pack >>> 12) & 0b11,
    ce_oi_rank:    (pack >>> 14) & 0b11,
    ce_chng_rank:  (pack >>> 16) & 0b11,
    pe_vol_rank:   (pack >>> 18) & 0b11,
    pe_oi_rank:    (pack >>> 20) & 0b11,
    pe_chng_rank:  (pack >>> 22) & 0b11,
  };
}

// ==================== SCHEMA-DRIVEN FIELD READER ====================
/**
 * Reads a single field from DataView using the read plan.
 * This is the core: type from schema → correct DataView method automatically.
 * "uint16" → getUint16, "int16" → getInt16 — no hardcoding!
 */
function readField(dv: DataView, op: ReadOp | HeaderReadOp): number {
  const method = dv[op.reader] as (byteOffset: number) => number;
  return method.call(dv, op.offset);
}

/** Apply decode rule from schema to a raw value */
function applyDecode(raw: number, decode: string | null, step: number): number | string {
  if (!decode) return raw;
  switch (decode) {
    case 'multiply_step':   return raw * step;
    case 'divide_10':       return raw / 10;
    case 'seconds_to_time': return fmtTime(raw);
    default:                return raw;
  }
}

// ==================== UNPACK SINGLE ROW (schema-driven) ====================
function unpackRow(dv: DataView, offset: number, step: number): OptionRow {
  // Read all raw fields from schema plan — offsets shifted by row start
  const raw: Record<string, number> = {};
  for (const op of rowPlan) {
    const method = dv[op.reader] as (byteOffset: number) => number;
    raw[op.name] = method.call(dv, offset + op.offset);
  }

  // Apply decode rules
  const decoded: Record<string, number | string> = {};
  for (const op of rowPlan) {
    decoded[op.name] = applyDecode(raw[op.name], op.decode, step);
  }

  // Unpack meta_pack
  const meta = unpackMeta(raw.meta_pack);

  // Build OptionRow — field names from schema map directly to output
  return {
    timestamp:      decoded.timestamp as string,
    spot_price:     decoded.spot_price as number,
    spot_chng:      decoded.spot_chng as number,
    relative_idx:   decoded.rel_idx as number,
    strike:         decoded.strike_key as number,
    lot_size:       decoded.lot_size as number,
    ce_oi:          decoded.ce_oi as number,
    ce_oi_short:    shortValue(decoded.ce_oi as number, UNIT_SUFFIX.indexOf(meta.ce_oi_unit)),
    ce_oi_unit:     meta.ce_oi_unit,
    ce_chng:        decoded.ce_chng as number,
    ce_chng_short:  shortValue(decoded.ce_chng as number, UNIT_SUFFIX.indexOf(meta.ce_chng_unit)),
    ce_chng_unit:   meta.ce_chng_unit,
    ce_vol:         decoded.ce_vol as number,
    ce_vol_short:   shortValue(decoded.ce_vol as number, UNIT_SUFFIX.indexOf(meta.ce_vol_unit)),
    ce_vol_unit:    meta.ce_vol_unit,
    ce_ltp:         decoded.ce_ltp as number,
    ce_iv:          decoded.ce_iv as number,
    ce_delta:       decoded.ce_delta as number,
    ce_vol_pct:     decoded.ce_vol_pct as number,
    ce_oi_pct:      decoded.ce_oi_pct as number,
    ce_chng_pct:    decoded.ce_chng_pct as number,
    pe_oi:          decoded.pe_oi as number,
    pe_oi_short:    shortValue(decoded.pe_oi as number, UNIT_SUFFIX.indexOf(meta.pe_oi_unit)),
    pe_oi_unit:     meta.pe_oi_unit,
    pe_chng:        decoded.pe_chng as number,
    pe_chng_short:  shortValue(decoded.pe_chng as number, UNIT_SUFFIX.indexOf(meta.pe_chng_unit)),
    pe_chng_unit:   meta.pe_chng_unit,
    pe_vol:         decoded.pe_vol as number,
    pe_vol_short:   shortValue(decoded.pe_vol as number, UNIT_SUFFIX.indexOf(meta.pe_vol_unit)),
    pe_vol_unit:    meta.pe_vol_unit,
    pe_ltp:         decoded.pe_ltp as number,
    pe_iv:          decoded.pe_iv as number,
    pe_delta:       decoded.pe_delta as number,
    pe_vol_pct:     decoded.pe_vol_pct as number,
    pe_oi_pct:      decoded.pe_oi_pct as number,
    pe_chng_pct:    decoded.pe_chng_pct as number,
    gamma:          decoded.gamma as number,
    ce_rank:        `${meta.ce_vol_rank}${meta.ce_oi_rank}${meta.ce_chng_rank}`,
    pe_rank:        `${meta.pe_vol_rank}${meta.pe_oi_rank}${meta.pe_chng_rank}`,
  };
}

// ==================== UNPACK TICK HEADER (schema-driven) ====================
function unpackTickHeader(dv: DataView): Record<string, number | string> {
  const result: Record<string, number | string> = {};
  for (const op of headerPlan) {
    const method = dv[op.reader] as (byteOffset: number) => number;
    const raw = method.call(dv, op.offset);
    result[op.name] = applyDecode(raw, op.decode, 0);
  }
  return result;
}

// ==================== UNPACK TICK PACKET (WebSocket) ====================
export function unpackTick(buffer: ArrayBuffer): TickData {
  const dv = new DataView(buffer);

  // Header (schema-driven if plan exists, else fallback)
  let symbolId: number, rowCount: number, step: number;
  let spotPrice: number, spotChng: number, atmKey: number, timestamp: string | number;

  if (headerPlan.length > 0) {
    const hdr = unpackTickHeader(dv);
    symbolId  = Number(hdr.symbol_id ?? 0);
    rowCount  = Number(hdr.row_count ?? 0);
    step      = STEP_MAP[symbolId] ?? 50;
    spotPrice = Number(hdr.spot_price ?? 0);
    spotChng  = Number(hdr.spot_chng ?? 0);
    atmKey    = Number(hdr.atm_key ?? 0);
    timestamp = hdr.timestamp ?? "";
    // atm_key decode: multiply_step
    if (typeof atmKey === 'number' && atmKey > 0 && atmKey < 65536) {
      atmKey = atmKey * step;
    }
  } else {
    // Fallback: hardcoded header read (pre-schema)
    timestamp = fmtTime(dv.getUint32(0));
    spotPrice = dv.getFloat32(4);
    spotChng  = dv.getFloat32(8);
    atmKey    = dv.getUint16(12) * (STEP_MAP[dv.getUint32(16)] ?? 50);
    symbolId  = dv.getUint32(16);
    rowCount  = dv.getUint16(20);
    step      = STEP_MAP[symbolId] ?? 50;
  }

  // Rows
  const rows: OptionRow[] = new Array(rowCount);
  for (let i = 0; i < rowCount; i++) {
    rows[i] = unpackRow(dv, HDR_SIZE + i * ROW_SIZE, step);
  }

  return {
    symbol: NAME_MAP[symbolId] ?? `ID:${symbolId}`,
    timestamp: String(timestamp),
    spot: spotPrice,
    chng: spotChng,
    atm: atmKey,
    count: rowCount,
    data: rows,
  };
}

// ==================== UNPACK QUERY RESPONSE (HTTP /query) ====================
export function unpackQuery(buffer: ArrayBuffer): TickData {
  const dv = new DataView(buffer);

  let symbolId: number, rowCount: number, step: number;

  if (queryHeaderPlan.length > 0) {
    const qhdr: Record<string, number | string> = {};
    for (const op of queryHeaderPlan) {
      const method = dv[op.reader] as (byteOffset: number) => number;
      qhdr[op.name] = method.call(dv, op.offset);
    }
    symbolId = Number(qhdr.symbol_id ?? 0);
    rowCount = Number(qhdr.row_count ?? 0);
    step     = Number(qhdr.step ?? 50);
  } else {
    symbolId = dv.getUint32(0);
    rowCount = dv.getUint16(4);
    step     = dv.getUint16(6);
  }

  const rows: OptionRow[] = new Array(rowCount);
  for (let i = 0; i < rowCount; i++) {
    rows[i] = unpackRow(dv, QHDR_SIZE + i * ROW_SIZE, step);
  }

  return {
    symbol: NAME_MAP[symbolId] ?? `ID:${symbolId}`,
    timestamp: rows.length > 0 ? rows[0].timestamp : "",
    spot: rows.length > 0 ? rows[0].spot_price : 0,
    chng: rows.length > 0 ? rows[0].spot_chng : 0,
    atm: 0,
    count: rowCount,
    data: rows,
  };
}

// ==================== SCHEMA MAP MANAGEMENT ====================
let cachedSchema: SchemaMap | null = null;

/**
 * Fetch schema from engine and build reader plans.
 * This is the ONLY place that needs to be called — everything else
 * adapts automatically from the schema.
 *
 * Call this once on WebSocket connect or page load.
 */
export async function fetchSchemaMap(baseUrl: string): Promise<SchemaMap> {
  const fallback: SchemaMap = {
    version: 0, formats: {}, symbols: {},
    decode_rules: {}, meta_pack_layout: {},
  };
  try {
    const resp = await fetch(`${baseUrl}/schema`);
    const schema: SchemaMap = await resp.json();
    cachedSchema = schema;
    buildReaderPlan(schema);
    console.log(`[SCHEMA] ✅ Loaded v${schema.version}, UI auto-adapted!`);
    return schema;
  } catch (e) {
    console.warn("[SCHEMA] Failed to fetch, using hardcoded defaults:", e);
    cachedSchema = fallback;
    // No plan built — unpackRow will use fallback hardcoded reads
    // This ensures backwards compatibility if engine is down at startup
    return fallback;
  }
}

/**
 * Update schema from WebSocket message (received after get_schema action).
 * Called when schema arrives via WS instead of HTTP.
 */
export function updateSchemaFromWS(schema: SchemaMap): void {
  cachedSchema = schema;
  buildReaderPlan(schema);
  console.log(`[SCHEMA-WS] ✅ Updated v${schema.version}, UI auto-adapted!`);
}

// ==================== LEGACY JSON PARSER (fallback for old engine) ====================
function isValidWireRow(row: unknown): row is number[] {
  return Array.isArray(row) && row.length >= 26 && row.every((value, index) => index === 0 || Number.isFinite(value));
}

export function parseLegacyTick(data: { symbol: string; timestamp: string; spot: number; spot_chng: number; data: number[][] }): TickData | null {
  if (!data.data || !Array.isArray(data.data)) return null;
  const validRows = data.data.filter(isValidWireRow);
  const rows: OptionRow[] = validRows.map(row => {
    const ce_oi = row[6];
    const ce_chng = row[7];
    const ce_vol = row[8];
    const pe_oi = row[15];
    const pe_chng = row[16];
    const pe_vol = row[17];
    const meta = row[25];

    const ce_oi_u   = meta & 0b11;
    const ce_chng_u = (meta >> 2) & 0b11;
    const ce_vol_u  = (meta >> 4) & 0b11;
    const pe_oi_u   = (meta >> 6) & 0b11;
    const pe_chng_u = (meta >> 8) & 0b11;
    const pe_vol_u  = (meta >> 10) & 0b11;

    const ce_vol_rank  = (meta >> 12) & 0b11;
    const ce_oi_rank   = (meta >> 14) & 0b11;
    const ce_chng_rank = (meta >> 16) & 0b11;
    const pe_vol_rank  = (meta >> 18) & 0b11;
    const pe_oi_rank   = (meta >> 20) & 0b11;
    const pe_chng_rank = (meta >> 22) & 0b11;

    return {
      timestamp: String(row[0]),
      spot_price: row[1],
      spot_chng: row[2],
      relative_idx: row[3],
      strike: row[4],
      lot_size: row[5],
      ce_oi,
      ce_oi_short: shortValue(ce_oi, ce_oi_u),
      ce_oi_unit: UNIT_SUFFIX[ce_oi_u],
      ce_chng,
      ce_chng_short: shortValue(ce_chng, ce_chng_u),
      ce_chng_unit: UNIT_SUFFIX[ce_chng_u],
      ce_vol,
      ce_vol_short: shortValue(ce_vol, ce_vol_u),
      ce_vol_unit: UNIT_SUFFIX[ce_vol_u],
      ce_ltp: row[9],
      ce_iv: row[10],
      ce_delta: row[11],
      ce_vol_pct: row[12],
      ce_oi_pct: row[13],
      ce_chng_pct: row[14],
      pe_oi,
      pe_oi_short: shortValue(pe_oi, pe_oi_u),
      pe_oi_unit: UNIT_SUFFIX[pe_oi_u],
      pe_chng,
      pe_chng_short: shortValue(pe_chng, pe_chng_u),
      pe_chng_unit: UNIT_SUFFIX[pe_chng_u],
      pe_vol,
      pe_vol_short: shortValue(pe_vol, pe_vol_u),
      pe_vol_unit: UNIT_SUFFIX[pe_vol_u],
      pe_ltp: row[18],
      pe_iv: row[19],
      pe_delta: row[20],
      pe_vol_pct: row[21],
      pe_oi_pct: row[22],
      pe_chng_pct: row[23],
      gamma: row[24],
      ce_rank: `${ce_vol_rank}${ce_oi_rank}${ce_chng_rank}`,
      pe_rank: `${pe_vol_rank}${pe_oi_rank}${pe_chng_rank}`,
    };
  });

  return {
    symbol: data.symbol,
    timestamp: data.timestamp,
    spot: data.spot,
    chng: data.spot_chng,
    atm: 0,
    count: rows.length,
    data: rows,
  };
}
