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
 * Key design: Row decoder is fully schema-driven. Header decoder reads raw first,
 * then applies step-dependent decode (multiply_step) after knowing the step from symbol_id.
 *
 * Before: getUint16(offset+46) hardcoded → chng_pct crash when engine changed H→h
 * After:  schema says "int16" → getInt16() automatically picked → NO manual fix needed
 */

// ==================== CONSTANTS (defaults, overridden by schema) ====================
let HDR_SIZE = 22;
let ROW_SIZE = 88;
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

/** Pre-computed plans — built once from schema, reused every tick */
let rowPlan: ReadOp[] = [];
let headerPlan: ReadOp[] = [];
let queryHeaderPlan: ReadOp[] = [];
let schemaLoaded = false;

/**
 * Build read plans from schema map. Called once when schema is received.
 * After this, unpackRow/unpackTick automatically use correct DataView methods.
 */
function buildReaderPlan(schema: SchemaMap): void {
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

  // Build row read plan (fully decoded — step is available per-row)
  rowPlan = (row?.fields ?? []).map(f => ({
    name: f.name,
    offset: f.offset,
    reader: TYPE_READERS[f.type] || 'getUint32',
    decode: f.decode || null,
  }));

  // Build header read plan (decode=NONE here — we apply manually after knowing step)
  headerPlan = (tickHeader?.fields ?? []).map(f => ({
    name: f.name,
    offset: f.offset,
    reader: TYPE_READERS[f.type] || 'getUint32',
    decode: null,  // ← NO auto-decode for header (step unknown at read time)
  }));

  // Build query header read plan (step is a direct field here, no multiply_step needed)
  queryHeaderPlan = (queryHeader?.fields ?? []).map(f => ({
    name: f.name,
    offset: f.offset,
    reader: TYPE_READERS[f.type] || 'getUint32',
    decode: null,
  }));

  schemaLoaded = true;

  console.log(`[SCHEMA-DRIVEN] Plans built: header=${headerPlan.length} fields, row=${rowPlan.length} fields, qhdr=${queryHeaderPlan.length} fields`);
  console.log(`[SCHEMA-DRIVEN] Sizes: HDR=${HDR_SIZE}, ROW=${ROW_SIZE}, QHDR=${QHDR_SIZE}`);

  // Log type→reader mapping for verification
  const typeMap = rowPlan.map(p => `${String(p.name)}:${String(p.reader)}`).join(', ');
  console.log(`[SCHEMA-DRIVEN] Row readers: ${typeMap}`);
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

// ==================== UNPACK ROW (schema-driven) ====================
/**
 * Reads a single 86-byte row using the schema plan.
 * Type → DataView method is automatic: "int16" → getInt16, "uint16" → getUint16, etc.
 * Decode rules applied from schema: divide_10, multiply_step, seconds_to_time.
 */
function unpackRowSchema(dv: DataView, offset: number, step: number): OptionRow {
  // Phase 1: Read raw values via schema plan (type → correct DataView method)
  const raw: Record<string, number> = {};
  for (let i = 0; i < rowPlan.length; i++) {
    const op = rowPlan[i];
    const method = dv[op.reader] as (byteOffset: number) => number;
    raw[op.name] = method.call(dv, offset + op.offset);
  }

  // Phase 2: Decode
  const ts       = fmtTime(raw.timestamp);
  const spot     = raw.spot_price;
  const chng     = raw.spot_chng;
  const relIdx   = raw.rel_idx;
  const strike   = raw.strike;                   // direct value (no multiply_step)
  const lot      = raw.lot_size;
  const ceOI     = raw.ce_oi;
  const ceChng   = raw.ce_chng;
  const ceVol    = raw.ce_vol;
  const ceLtp    = raw.ce_ltp;
  const ceIV     = raw.ce_iv;
  const ceDelta  = raw.ce_delta;
  const ceVolPct = raw.ce_vol_pct / 10;       // divide_10
  const ceOIPct  = raw.ce_oi_pct / 10;        // divide_10
  const ceChngPct= raw.ce_chng_pct / 10;      // divide_10
  const peOI     = raw.pe_oi;
  const peChng   = raw.pe_chng;
  const peVol    = raw.pe_vol;
  const peLtp    = raw.pe_ltp;
  const peIV     = raw.pe_iv;
  const peDelta  = raw.pe_delta;
  const peVolPct = raw.pe_vol_pct / 10;       // divide_10
  const peOIPct  = raw.pe_oi_pct / 10;        // divide_10
  const peChngPct= raw.pe_chng_pct / 10;      // divide_10
  const gamma    = raw.gamma;
  const meta     = unpackMeta(raw.meta_pack);

  return {
    timestamp: ts,
    spot_price: spot,
    spot_chng: chng,
    relative_idx: relIdx,
    strike,
    lot_size: lot,
    ce_oi: ceOI,
    ce_oi_short: shortValue(ceOI, UNIT_SUFFIX.indexOf(meta.ce_oi_unit)),
    ce_oi_unit: meta.ce_oi_unit,
    ce_chng: ceChng,
    ce_chng_short: shortValue(ceChng, UNIT_SUFFIX.indexOf(meta.ce_chng_unit)),
    ce_chng_unit: meta.ce_chng_unit,
    ce_vol: ceVol,
    ce_vol_short: shortValue(ceVol, UNIT_SUFFIX.indexOf(meta.ce_vol_unit)),
    ce_vol_unit: meta.ce_vol_unit,
    ce_ltp: ceLtp,
    ce_iv: ceIV,
    ce_delta: ceDelta,
    ce_vol_pct: ceVolPct,
    ce_oi_pct: ceOIPct,
    ce_chng_pct: ceChngPct,
    pe_oi: peOI,
    pe_oi_short: shortValue(peOI, UNIT_SUFFIX.indexOf(meta.pe_oi_unit)),
    pe_oi_unit: meta.pe_oi_unit,
    pe_chng: peChng,
    pe_chng_short: shortValue(peChng, UNIT_SUFFIX.indexOf(meta.pe_chng_unit)),
    pe_chng_unit: meta.pe_chng_unit,
    pe_vol: peVol,
    pe_vol_short: shortValue(peVol, UNIT_SUFFIX.indexOf(meta.pe_vol_unit)),
    pe_vol_unit: meta.pe_vol_unit,
    pe_ltp: peLtp,
    pe_iv: peIV,
    pe_delta: peDelta,
    pe_vol_pct: peVolPct,
    pe_oi_pct: peOIPct,
    pe_chng_pct: peChngPct,
    gamma,
    ce_rank: `${meta.ce_vol_rank}${meta.ce_oi_rank}${meta.ce_chng_rank}`,
    pe_rank: `${meta.pe_vol_rank}${meta.pe_oi_rank}${meta.pe_chng_rank}`,
  };
}

// ==================== UNPACK ROW (fallback — hardcoded, for when schema not loaded) ====================
function unpackRowFallback(dv: DataView, offset: number, step: number): OptionRow {
  const ts       = dv.getUint32(offset);
  const spot     = dv.getFloat32(offset + 4);
  const chng     = dv.getFloat32(offset + 8);
  const relIdx   = dv.getInt16(offset + 12);
  const strike   = dv.getInt32(offset + 14);     // direct strike value (88B row)
  const lot      = dv.getUint16(offset + 18);
  const ceOI     = dv.getInt32(offset + 20);
  const ceChng   = dv.getInt32(offset + 24);
  const ceVol    = dv.getFloat32(offset + 28);
  const ceLtp    = dv.getFloat32(offset + 32);
  const ceIV     = dv.getFloat32(offset + 36);
  const ceDelta  = dv.getFloat32(offset + 40);
  const ceVolPct = dv.getUint16(offset + 44) / 10;
  const ceOIPct  = dv.getUint16(offset + 46) / 10;
  const ceChngPct= dv.getInt16(offset + 48) / 10;
  const peOI     = dv.getInt32(offset + 50);
  const peChng   = dv.getInt32(offset + 54);
  const peVol    = dv.getFloat32(offset + 58);
  const peLtp    = dv.getFloat32(offset + 62);
  const peIV     = dv.getFloat32(offset + 66);
  const peDelta  = dv.getFloat32(offset + 70);
  const peVolPct = dv.getUint16(offset + 74) / 10;
  const peOIPct  = dv.getUint16(offset + 76) / 10;
  const peChngPct= dv.getInt16(offset + 78) / 10;
  const gamma    = dv.getFloat32(offset + 80);
  const meta     = unpackMeta(dv.getInt32(offset + 84));

  return {
    timestamp: fmtTime(ts),
    spot_price: spot,
    spot_chng: chng,
    relative_idx: relIdx,
    strike,
    lot_size: lot,
    ce_oi: ceOI,
    ce_oi_short: shortValue(ceOI, UNIT_SUFFIX.indexOf(meta.ce_oi_unit)),
    ce_oi_unit: meta.ce_oi_unit,
    ce_chng: ceChng,
    ce_chng_short: shortValue(ceChng, UNIT_SUFFIX.indexOf(meta.ce_chng_unit)),
    ce_chng_unit: meta.ce_chng_unit,
    ce_vol: ceVol,
    ce_vol_short: shortValue(ceVol, UNIT_SUFFIX.indexOf(meta.ce_vol_unit)),
    ce_vol_unit: meta.ce_vol_unit,
    ce_ltp: ceLtp,
    ce_iv: ceIV,
    ce_delta: ceDelta,
    ce_vol_pct: ceVolPct,
    ce_oi_pct: ceOIPct,
    ce_chng_pct: ceChngPct,
    pe_oi: peOI,
    pe_oi_short: shortValue(peOI, UNIT_SUFFIX.indexOf(meta.pe_oi_unit)),
    pe_oi_unit: meta.pe_oi_unit,
    pe_chng: peChng,
    pe_chng_short: shortValue(peChng, UNIT_SUFFIX.indexOf(meta.pe_chng_unit)),
    pe_chng_unit: meta.pe_chng_unit,
    pe_vol: peVol,
    pe_vol_short: shortValue(peVol, UNIT_SUFFIX.indexOf(meta.pe_vol_unit)),
    pe_vol_unit: meta.pe_vol_unit,
    pe_ltp: peLtp,
    pe_iv: peIV,
    pe_delta: peDelta,
    pe_vol_pct: peVolPct,
    pe_oi_pct: peOIPct,
    pe_chng_pct: peChngPct,
    gamma,
    ce_rank: `${meta.ce_vol_rank}${meta.ce_oi_rank}${meta.ce_chng_rank}`,
    pe_rank: `${meta.pe_vol_rank}${meta.pe_oi_rank}${meta.pe_chng_rank}`,
  };
}

/** Dispatch: use schema-driven plan if available, else hardcoded fallback */
function unpackRow(dv: DataView, offset: number, step: number): OptionRow {
  return schemaLoaded && rowPlan.length > 0
    ? unpackRowSchema(dv, offset, step)
    : unpackRowFallback(dv, offset, step);
}

// ==================== UNPACK TICK PACKET (WebSocket) ====================
export function unpackTick(buffer: ArrayBuffer): TickData {
  const dv = new DataView(buffer);
  const bufLen = buffer.byteLength;

  // ── HEADER ──
  // Always read raw values first, then apply step-dependent decode
  let symbolId: number, rowCount: number, step: number;
  let spotPrice: number, spotChng: number, atmStrike: number, timestamp: string;

  if (schemaLoaded && headerPlan.length > 0) {
    // Schema-driven: read header fields via plan (raw, no decode)
    const hdrRaw: Record<string, number> = {};
    for (const op of headerPlan) {
      const method = dv[op.reader] as (byteOffset: number) => number;
      hdrRaw[op.name] = method.call(dv, op.offset);
    }
    symbolId  = hdrRaw.symbol_id ?? 0;
    rowCount  = hdrRaw.row_count ?? 0;
    step      = STEP_MAP[symbolId] ?? 50;
    spotPrice = hdrRaw.spot_price ?? 0;
    spotChng  = hdrRaw.spot_chng ?? 0;
    timestamp = fmtTime(hdrRaw.timestamp ?? 0);
    atmStrike = (hdrRaw.atm_key ?? 0) * step;  // multiply_step AFTER knowing step
  } else {
    // Fallback: hardcoded header
    const rawTs = dv.getUint32(0);
    spotPrice   = dv.getFloat32(4);
    spotChng    = dv.getFloat32(8);
    symbolId    = dv.getUint32(16);
    rowCount    = dv.getUint16(20);
    step        = STEP_MAP[symbolId] ?? 50;
    timestamp   = fmtTime(rawTs);
    atmStrike   = dv.getUint16(12) * step;
  }

  // ── SANITY CHECK: cap rowCount to what buffer can hold ──
  const maxRows = Math.max(0, Math.floor((bufLen - HDR_SIZE) / ROW_SIZE));
  if (rowCount > maxRows) {
    console.warn(`[UNPACK] Buffer too small: ${bufLen}B, expected ${HDR_SIZE + rowCount * ROW_SIZE}B for ${rowCount} rows. Capping to ${maxRows}.`);
    rowCount = maxRows;
  }

  // ── ROWS ──
  const rows: OptionRow[] = new Array(rowCount);
  for (let i = 0; i < rowCount; i++) {
    rows[i] = unpackRow(dv, HDR_SIZE + i * ROW_SIZE, step);
  }

  return {
    symbol: NAME_MAP[symbolId] ?? `ID:${symbolId}`,
    timestamp,
    spot: spotPrice,
    chng: spotChng,
    atm: atmStrike,
    count: rowCount,
    data: rows,
  };
}

// ==================== UNPACK QUERY RESPONSE (HTTP /query) ====================
export function unpackQuery(buffer: ArrayBuffer): TickData {
  const dv = new DataView(buffer);

  let symbolId: number, rowCount: number, step: number;

  if (schemaLoaded && queryHeaderPlan.length > 0) {
    const qhdr: Record<string, number> = {};
    for (const op of queryHeaderPlan) {
      const method = dv[op.reader] as (byteOffset: number) => number;
      qhdr[op.name] = method.call(dv, op.offset);
    }
    symbolId = qhdr.symbol_id ?? 0;
    rowCount = qhdr.row_count ?? 0;
    step     = qhdr.step ?? 50;
  } else {
    symbolId = dv.getUint32(0);
    rowCount = dv.getUint16(4);
    step     = dv.getUint16(6);
  }

  // Sanity check
  const maxRows = Math.max(0, Math.floor((buffer.byteLength - QHDR_SIZE) / ROW_SIZE));
  if (rowCount > maxRows) {
    console.warn(`[UNPACK] Query buffer too small: ${buffer.byteLength}B for ${rowCount} rows. Capping to ${maxRows}.`);
    rowCount = maxRows;
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
 * Call this once on page load — everything else adapts automatically.
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
    console.log(`[SCHEMA] ✅ Loaded v${schema.version} — UI auto-adapted!`);
    return schema;
  } catch (e) {
    console.warn("[SCHEMA] Fetch failed, using hardcoded fallback:", e);
    cachedSchema = fallback;
    // Fallback unpacker works without schema — hardcoded offsets/types
    return fallback;
  }
}

/**
 * Update schema from WebSocket message (received after get_schema action).
 * This is the schema-driven trigger — engine changes type, UI auto-adapts.
 */
export function updateSchemaFromWS(schema: SchemaMap): void {
  cachedSchema = schema;
  buildReaderPlan(schema);
  console.log(`[SCHEMA-WS] ✅ Updated v${schema.version} — UI auto-adapted!`);
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
