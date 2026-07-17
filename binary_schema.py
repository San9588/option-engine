#!/usr/bin/env python3
"""
Binary Packet Schema Map Generator + JS Unpacker Builder (v6)
=============================================================
Yeh script 2 cheezein generate karta hai:
1. schema_map.json  → UI ko ek baar bhejenge, UI cache karega
2. unpacker.js      → UI-side binary decoder (auto-generated from schema)

Flow:
  Engine ──[schema_map.json]──► UI (once, on connect)
  Engine ──[binary packet]───► UI (per tick / per query)
  UI uses cached schema_map to decode binary packets

Same 88-byte row format used EVERYWHERE:
  - WebSocket broadcast
  - SQLite BLOB storage
  - HTTP query response

v6 changes from v5 (86B → 88B):
  - strike_key(H,2B) → strike(i,4B) — real strike value directly
  - All offsets after strike shifted by +2 bytes
"""

import struct
import json
import orjson

# ==================== BINARY FORMAT CONSTANTS ====================

# Per-row: 88 bytes (26 fields)
# v6: strike_key(H,2B) replaced with strike(i,4B) — real strike value, no multiply_step
ROW_FMT = "<IffhiHiiffffHHhiiffffHHhfi"
ROW_SIZE = struct.calcsize(ROW_FMT)  # 88

# Per-tick header: 22 bytes (7 fields)
HEADER_FMT = "<IffHHIH"
HEADER_SIZE = struct.calcsize(HEADER_FMT)  # 22

# Per-query response header: 8 bytes (3 fields)
QUERY_HDR_FMT = "<IHH"
QUERY_HDR_SIZE = struct.calcsize(QUERY_HDR_FMT)  # 8

# ==================== SYMBOL REGISTRY ====================

SYMBOL_REGISTRY = {
    1: {"name": "NIFTY",     "step": 50,  "exchange": "NSE", "enabled": True},
    2: {"name": "BANKNIFTY", "step": 100, "exchange": "NSE", "enabled": False},
    3: {"name": "SENSEX",    "step": 100, "exchange": "BSE", "enabled": False},
    4: {"name": "CRUDEOIL",  "step": 50,  "exchange": "MCX", "enabled": True},
}

# ==================== SCHEMA MAP ====================

SCHEMA_MAP = {
    "version": 2,
    "formats": {
        "tick_header": {
            "size": HEADER_SIZE,
            "byte_order": "little",
            "fields": [
                {"name": "timestamp",  "offset": 0,  "size": 4, "type": "uint32",
                 "unit": "seconds_since_midnight", "decode": "seconds_to_time"},
                {"name": "spot_price", "offset": 4,  "size": 4, "type": "float32"},
                {"name": "spot_chng",  "offset": 8,  "size": 4, "type": "float32"},
                {"name": "atm_key",    "offset": 12, "size": 2, "type": "uint16",
                 "decode": "multiply_step"},
                {"name": "lot_size",   "offset": 14, "size": 2, "type": "uint16"},
                {"name": "symbol_id",  "offset": 16, "size": 4, "type": "uint32"},
                {"name": "row_count",  "offset": 20, "size": 2, "type": "uint16"},
            ]
        },
        "row": {
            "size": ROW_SIZE,
            "byte_order": "little",
            "fields": [
                # ── Common (repeated per row for standalone DB query rows) ──
                {"name": "timestamp",    "offset": 0,  "size": 4, "type": "uint32",
                 "unit": "seconds_since_midnight", "decode": "seconds_to_time"},
                {"name": "spot_price",   "offset": 4,  "size": 4, "type": "float32"},
                {"name": "spot_chng",    "offset": 8,  "size": 4, "type": "float32"},
                {"name": "rel_idx",      "offset": 12, "size": 2, "type": "int16"},
                {"name": "strike",       "offset": 14, "size": 4, "type": "int32"},
                {"name": "lot_size",     "offset": 18, "size": 2, "type": "uint16"},
                # ── Call Option ──
                {"name": "ce_oi",        "offset": 20, "size": 4, "type": "int32"},
                {"name": "ce_chng",      "offset": 24, "size": 4, "type": "int32"},
                {"name": "ce_vol",       "offset": 28, "size": 4, "type": "float32"},
                {"name": "ce_ltp",       "offset": 32, "size": 4, "type": "float32"},
                {"name": "ce_iv",        "offset": 36, "size": 4, "type": "float32"},
                {"name": "ce_delta",     "offset": 40, "size": 4, "type": "float32"},
                {"name": "ce_vol_pct",   "offset": 44, "size": 2, "type": "uint16",
                 "decode": "divide_10"},
                {"name": "ce_oi_pct",    "offset": 46, "size": 2, "type": "uint16",
                 "decode": "divide_10"},
                {"name": "ce_chng_pct",  "offset": 48, "size": 2, "type": "int16",
                 "decode": "divide_10"},
                # ── Put Option ──
                {"name": "pe_oi",        "offset": 50, "size": 4, "type": "int32"},
                {"name": "pe_chng",      "offset": 54, "size": 4, "type": "int32"},
                {"name": "pe_vol",       "offset": 58, "size": 4, "type": "float32"},
                {"name": "pe_ltp",       "offset": 62, "size": 4, "type": "float32"},
                {"name": "pe_iv",        "offset": 66, "size": 4, "type": "float32"},
                {"name": "pe_delta",     "offset": 70, "size": 4, "type": "float32"},
                {"name": "pe_vol_pct",   "offset": 74, "size": 2, "type": "uint16",
                 "decode": "divide_10"},
                {"name": "pe_oi_pct",    "offset": 76, "size": 2, "type": "uint16",
                 "decode": "divide_10"},
                {"name": "pe_chng_pct",  "offset": 78, "size": 2, "type": "int16",
                 "decode": "divide_10"},
                # ── Greeks / Meta ──
                {"name": "gamma",        "offset": 80, "size": 4, "type": "float32"},
                {"name": "meta_pack",    "offset": 84, "size": 4, "type": "int32"},
            ]
        },
        "query_header": {
            "size": QUERY_HDR_SIZE,
            "byte_order": "little",
            "fields": [
                {"name": "symbol_id",  "offset": 0, "size": 4, "type": "uint32"},
                {"name": "row_count",  "offset": 4, "size": 2, "type": "uint16"},
                {"name": "step",       "offset": 6, "size": 2, "type": "uint16"},
            ]
        }
    },
    "symbols": {
        str(k): {"name": v["name"], "step": v["step"], "exchange": v["exchange"]}
        for k, v in SYMBOL_REGISTRY.items()
    },
    "decode_rules": {
        "multiply_step":       "value * step  (step from symbol_id or query_header)",
        "divide_10":           "value / 10    (e.g. 853 → 85.3)",
        "seconds_to_time":     "HH:MM:SS from seconds since midnight",
        "meta_unpack":         "bitwise: 6 unit_codes (2bit each) + 6 ranks (2bit each)",
    },
    "meta_pack_layout": {
        "bits_0_1":   "ce_oi_unit     (0='', 1='K', 2='M', 3='B')",
        "bits_2_3":   "ce_chng_unit",
        "bits_4_5":   "ce_vol_unit",
        "bits_6_7":   "pe_oi_unit",
        "bits_8_9":   "pe_chng_unit",
        "bits_10_11": "pe_vol_unit",
        "bits_12_13": "ce_vol_rank    (0-3)",
        "bits_14_15": "ce_oi_rank",
        "bits_16_17": "ce_chng_rank",
        "bits_18_19": "pe_vol_rank",
        "bits_20_21": "pe_oi_rank",
        "bits_22_23": "pe_chng_rank",
    }
}


def generate_schema_map() -> bytes:
    """Compact JSON schema map — sent once to UI on WebSocket connect."""
    return orjson.dumps(SCHEMA_MAP)


def generate_js_unpacker() -> str:
    """Auto-generated JavaScript unpacker from schema map."""
    return '''/**
 * Option Engine Binary Unpacker (auto-generated from schema_map v1)
 * 
 * PACKET TYPES:
 *   1. TICK  = header(22B) + N × row(86B)  → WebSocket broadcast
 *   2. QUERY = query_header(8B) + N × row(86B) → HTTP query response
 *   3. DB_ROW = row(86B) standalone → inside SQLite BLOB
 * 
 * SCHEMA MAP (received once on connect):
 *   ws.send(JSON.stringify({action: "get_schema"}))
 *   → server responds with schema_map JSON → cache it
 */

// ============================================================
// SYMBOL REGISTRY (from schema_map.symbols)
// ============================================================
const STEP_MAP  = {1: 50, 2: 100, 3: 100, 4: 50};
const NAME_MAP  = {1: "NIFTY", 2: "BANKNIFTY", 3: "SENSEX", 4: "CRUDEOIL"};
const UNIT_MAP  = ["", "K", "M", "B"];  // meta_pack unit codes

// ============================================================
// CONSTANTS (from schema_map.formats)
// ============================================================
const HDR_SIZE = 22;   // tick_header.size
const ROW_SIZE = 88;   // row.size (v6: real strike int32 = +2 bytes)
const QHDR_SIZE = 8;   // query_header.size

// ============================================================
// META_PACK UNPACK (bits → unit codes + ranks)
// ============================================================
function unpackMeta(pack) {
    return {
        ce_oi_unit:   UNIT_MAP[pack & 0b11],
        ce_chng_unit: UNIT_MAP[(pack >>> 2) & 0b11],
        ce_vol_unit:  UNIT_MAP[(pack >>> 4) & 0b11],
        pe_oi_unit:   UNIT_MAP[(pack >>> 6) & 0b11],
        pe_chng_unit: UNIT_MAP[(pack >>> 8) & 0b11],
        pe_vol_unit:  UNIT_MAP[(pack >>> 10) & 0b11],
        ce_vol_rank:  (pack >>> 12) & 0b11,
        ce_oi_rank:   (pack >>> 14) & 0b11,
        ce_chng_rank: (pack >>> 16) & 0b11,
        pe_vol_rank:  (pack >>> 18) & 0b11,
        pe_oi_rank:   (pack >>> 20) & 0b11,
        pe_chng_rank: (pack >>> 22) & 0b11,
    };
}

// ============================================================
// TIMESTAMP: seconds_since_midnight → "HH:MM:SS"
// ============================================================
function fmtTime(s) {
    const h = (s / 3600) | 0;
    const m = ((s % 3600) / 60) | 0;
    const sec = s % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

// ============================================================
// UNPACK SINGLE ROW (86 bytes → JS object)
// Used by: unpackTick(), unpackQuery(), standalone DB row decode
// ============================================================
function unpackRow(dv, offset, step) {
    return {
        ts:         fmtTime(dv.getUint32(offset)),
        spot:       dv.getFloat32(offset + 4),
        chng:       dv.getFloat32(offset + 8),
        relIdx:     dv.getInt16(offset + 12),
        strike:     dv.getInt32(offset + 14),              // v6: real strike value (int32, no multiply_step)
        lot:        dv.getUint16(offset + 18),
        ceOI:       dv.getInt32(offset + 20),
        ceChng:     dv.getInt32(offset + 24),
        ceVol:      dv.getFloat32(offset + 28),
        ceLtp:      dv.getFloat32(offset + 32),
        ceIV:       dv.getFloat32(offset + 36),
        ceDelta:    dv.getFloat32(offset + 40),
        ceVolPct:   dv.getUint16(offset + 44) / 10,
        ceOIPct:    dv.getUint16(offset + 46) / 10,
        ceChngPct:  dv.getInt16(offset + 48) / 10,  // int16 (signed) for negative chng%
        peOI:       dv.getInt32(offset + 50),
        peChng:     dv.getInt32(offset + 54),
        peVol:      dv.getFloat32(offset + 58),
        peLtp:      dv.getFloat32(offset + 62),
        peIV:       dv.getFloat32(offset + 66),
        peDelta:    dv.getFloat32(offset + 70),
        peVolPct:   dv.getUint16(offset + 74) / 10,
        peOIPct:    dv.getUint16(offset + 76) / 10,
        peChngPct:  dv.getInt16(offset + 78) / 10,  // int16 (signed) for negative chng%
        gamma:      dv.getFloat32(offset + 80),
        meta:       unpackMeta(dv.getInt32(offset + 84)),
    };
}

// ============================================================
// UNPACK TICK PACKET (WebSocket broadcast)
// Format: header(22B) + N × row(86B)
// ============================================================
function unpackTick(buffer) {
    const dv = new DataView(buffer);
    
    // Header
    const timestamp = dv.getUint32(0);
    const spotPrice = dv.getFloat32(4);
    const spotChng  = dv.getFloat32(8);
    const atmKey    = dv.getUint16(12);
    const lotSize   = dv.getUint16(14);
    const symbolId  = dv.getUint32(16);
    const rowCount  = dv.getUint16(20);
    const step      = STEP_MAP[symbolId];
    
    // Rows
    const rows = new Array(rowCount);
    for (let i = 0; i < rowCount; i++) {
        rows[i] = unpackRow(dv, HDR_SIZE + i * ROW_SIZE, step);
    }
    
    return {
        type: "tick",
        symbol:    NAME_MAP[symbolId],
        timestamp: fmtTime(timestamp),
        spot:      spotPrice,
        chng:      spotChng,
        atm:       atmKey * step,
        count:     rowCount,
        data:      rows,
    };
}

// ============================================================
// UNPACK QUERY RESPONSE (HTTP /query endpoint)
// Format: query_header(8B) + N × row(86B)
// ============================================================
function unpackQuery(buffer) {
    const dv = new DataView(buffer);
    
    // Query header
    const symbolId = dv.getUint32(0);
    const rowCount = dv.getUint16(4);
    const step     = dv.getUint16(6);
    
    // Rows
    const rows = new Array(rowCount);
    for (let i = 0; i < rowCount; i++) {
        rows[i] = unpackRow(dv, QHDR_SIZE + i * ROW_SIZE, step);
    }
    
    return {
        symbol: NAME_MAP[symbolId] || `ID:${symbolId}`,
        step:   step,
        count:  rowCount,
        data:   rows,
    };
}

// ============================================================
// WEBSOCKET HANDLER (binary mode)
// ============================================================
let cachedSchema = null;

const ws = new WebSocket(`ws://${location.host}/ws`);
ws.binaryType = 'arraybuffer';  // ← CRITICAL: receive binary, not text

ws.onopen = () => {
    // Request schema map (once)
    ws.send(JSON.stringify({action: "get_schema"}));
    
    // Subscribe to symbols
    ws.send(JSON.stringify({action: "subscribe", symbol: "NIFTY", from: -30, to: 30}));
};

ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
        // JSON message (schema map, subscription confirmations, etc.)
        const msg = JSON.parse(event.data);
        if (msg.type === 'schema') {
            cachedSchema = msg.schema;  // Cache it!
            console.log('Schema map cached:', cachedSchema.version);
        }
        return;
    }
    
    // Binary message (tick data)
    const buffer = event.data;  // ArrayBuffer
    const tick = unpackTick(buffer);
    
    // Update UI
    updateOptionChain(tick);
};

// ============================================================
// HTTP QUERY (binary response)
// ============================================================
async function queryDB(sql, params = []) {
    const resp = await fetch('/query', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({sql, params}),
    });
    
    const buffer = await resp.arrayBuffer();
    return unpackQuery(buffer);
}

// Example: "25000 strike ka last 4 hours ka data"
async function getStrikeHistory(symbolId, strike, fromTime) {
    const tableName = NAME_MAP[symbolId].toLowerCase() + '_option_chain';
    const sql = `SELECT timestamp, strike, rel_idx, payload FROM ${tableName} 
                 WHERE strike = ? AND timestamp >= ? 
                 ORDER BY timestamp`;
    const result = await queryDB(sql, [strike, fromTime]);
    return result.data;
}

// Usage: getStrikeHistory(1, 25000, '2026-07-17 11:30:00')
// v6: strike stored as real integer (e.g. 25000), no step multiplication needed
'''


# ==================== EXPORT ====================
if __name__ == "__main__":
    schema = generate_schema_map()
    
    with open("schema_map.json", "wb") as f:
        f.write(orjson.dumps(SCHEMA_MAP, option=orjson.OPT_INDENT_2))
    print(f"✅ schema_map.json written ({len(orjson.dumps(SCHEMA_MAP))} bytes compact)")
    
    with open("unpacker.js", "w") as f:
        f.write(generate_js_unpacker())
    print(f"✅ unpacker.js written ({len(generate_js_unpacker())} bytes)")
    
    # Verify binary format sizes
    print(f"\n📐 Binary Format Sizes (v6):")
    print(f"   Tick Header:  {HEADER_SIZE} bytes")
    print(f"   Row:          {ROW_SIZE} bytes")
    print(f"   Query Header: {QUERY_HDR_SIZE} bytes")
    print(f"   Tick (61 rows): {HEADER_SIZE + ROW_SIZE * 61} bytes")
    print(f"   Tick (140 rows): {HEADER_SIZE + ROW_SIZE * 140} bytes")
    
    # Size comparison
    print(f"\n📦 Schema Map: {len(schema)} bytes → sent ONCE, cached on UI")
