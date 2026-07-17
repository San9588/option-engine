/**
 * Option Engine Binary Unpacker (v6)
 *
 * Decodes binary tick packets from the engine into JS objects.
 * Binary format: Header(22B) + N × Row(86B) per tick
 *
 * Schema map is fetched once from the server and cached.
 * All byte offsets/types come from engine_v6.py binary format.
 */

// ==================== CONSTANTS (from schema_map) ====================
const HDR_SIZE = 22;   // tick_header.size
const ROW_SIZE = 86;   // row.size
const QHDR_SIZE = 8;   // query_header.size

// Symbol registry (mirrors engine SYMBOL_REGISTRY)
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

// ==================== UNPACK SINGLE ROW (86 bytes → OptionRow) ====================
function unpackRow(dv: DataView, offset: number, step: number): OptionRow {
  const ts       = dv.getUint32(offset);
  const spot     = dv.getFloat32(offset + 4);
  const chng     = dv.getFloat32(offset + 8);
  const relIdx   = dv.getInt16(offset + 12);
  const strikeKey = dv.getUint16(offset + 14);
  const lot      = dv.getUint16(offset + 16);
  const ceOI     = dv.getInt32(offset + 18);
  const ceChng   = dv.getInt32(offset + 22);
  const ceVol    = dv.getFloat32(offset + 26);
  const ceLtp    = dv.getFloat32(offset + 30);
  const ceIV     = dv.getFloat32(offset + 34);
  const ceDelta  = dv.getFloat32(offset + 38);
  const ceVolPct = dv.getUint16(offset + 42) / 10;
  const ceOIPct  = dv.getUint16(offset + 44) / 10;
  const ceChngPct = dv.getUint16(offset + 46) / 10;
  const peOI     = dv.getInt32(offset + 48);
  const peChng   = dv.getInt32(offset + 52);
  const peVol    = dv.getFloat32(offset + 56);
  const peLtp    = dv.getFloat32(offset + 60);
  const peIV     = dv.getFloat32(offset + 64);
  const peDelta  = dv.getFloat32(offset + 68);
  const peVolPct = dv.getUint16(offset + 72) / 10;
  const peOIPct  = dv.getUint16(offset + 74) / 10;
  const peChngPct = dv.getUint16(offset + 76) / 10;
  const gamma    = dv.getFloat32(offset + 78);
  const meta     = dv.getInt32(offset + 82);

  const m = unpackMeta(meta);
  const strike = strikeKey * step;

  return {
    timestamp: fmtTime(ts),
    spot_price: spot,
    spot_chng: chng,
    relative_idx: relIdx,
    strike,
    lot_size: lot,
    ce_oi: ceOI,
    ce_oi_short: shortValue(ceOI, UNIT_SUFFIX.indexOf(m.ce_oi_unit)),
    ce_oi_unit: m.ce_oi_unit,
    ce_chng: ceChng,
    ce_chng_short: shortValue(ceChng, UNIT_SUFFIX.indexOf(m.ce_chng_unit)),
    ce_chng_unit: m.ce_chng_unit,
    ce_vol: ceVol,
    ce_vol_short: shortValue(ceVol, UNIT_SUFFIX.indexOf(m.ce_vol_unit)),
    ce_vol_unit: m.ce_vol_unit,
    ce_ltp: ceLtp,
    ce_iv: ceIV,
    ce_delta: ceDelta,
    ce_vol_pct: ceVolPct,
    ce_oi_pct: ceOIPct,
    ce_chng_pct: ceChngPct,
    pe_oi: peOI,
    pe_oi_short: shortValue(peOI, UNIT_SUFFIX.indexOf(m.pe_oi_unit)),
    pe_oi_unit: m.pe_oi_unit,
    pe_chng: peChng,
    pe_chng_short: shortValue(peChng, UNIT_SUFFIX.indexOf(m.pe_chng_unit)),
    pe_chng_unit: m.pe_chng_unit,
    pe_vol: peVol,
    pe_vol_short: shortValue(peVol, UNIT_SUFFIX.indexOf(m.pe_vol_unit)),
    pe_vol_unit: m.pe_vol_unit,
    pe_ltp: peLtp,
    pe_iv: peIV,
    pe_delta: peDelta,
    pe_vol_pct: peVolPct,
    pe_oi_pct: peOIPct,
    pe_chng_pct: peChngPct,
    gamma,
    ce_rank: `${m.ce_vol_rank}${m.ce_oi_rank}${m.ce_chng_rank}`,
    pe_rank: `${m.pe_vol_rank}${m.pe_oi_rank}${m.pe_chng_rank}`,
  };
}

// ==================== UNPACK TICK PACKET (WebSocket) ====================
export function unpackTick(buffer: ArrayBuffer): TickData {
  const dv = new DataView(buffer);

  // Header
  const timestamp = dv.getUint32(0);
  const spotPrice = dv.getFloat32(4);
  const spotChng  = dv.getFloat32(8);
  const atmKey    = dv.getUint16(12);
  const lotSize   = dv.getUint16(14);
  const symbolId  = dv.getUint32(16);
  const rowCount  = dv.getUint16(20);
  const step      = STEP_MAP[symbolId] ?? 50;

  // Rows
  const rows: OptionRow[] = new Array(rowCount);
  for (let i = 0; i < rowCount; i++) {
    rows[i] = unpackRow(dv, HDR_SIZE + i * ROW_SIZE, step);
  }

  return {
    symbol: NAME_MAP[symbolId] ?? `ID:${symbolId}`,
    timestamp: fmtTime(timestamp),
    spot: spotPrice,
    chng: spotChng,
    atm: atmKey * step,
    count: rowCount,
    data: rows,
  };
}

// ==================== UNPACK QUERY RESPONSE (HTTP /query) ====================
export function unpackQuery(buffer: ArrayBuffer): TickData {
  const dv = new DataView(buffer);

  const symbolId = dv.getUint32(0);
  const rowCount = dv.getUint16(4);
  const step     = dv.getUint16(6);

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

// ==================== FETCH SCHEMA MAP (once, cache) ====================
let cachedSchema: SchemaMap | null = null;

export async function fetchSchemaMap(baseUrl: string): Promise<SchemaMap> {
  if (cachedSchema) return cachedSchema;
  const fallback: SchemaMap = { version: 1, formats: {}, symbols: {}, decode_rules: {}, meta_pack_layout: {} };
  try {
    const resp = await fetch(`${baseUrl}/schema`);
    const schema: SchemaMap = await resp.json();
    cachedSchema = schema;
    return schema;
  } catch (e) {
    console.warn("[SCHEMA] Failed to fetch, using defaults:", e);
    cachedSchema = fallback;
    return fallback;
  }
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
