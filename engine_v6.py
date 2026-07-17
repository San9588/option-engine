#!/usr/bin/env python3
"""
Option Chain Data Engine - v6 (Binary Packet Architecture)

v5 → v6 Changes:
 - Binary packet format (86-byte rows) throughout: WebSocket + SQLite + /query
 - Schema map JSON sent once to UI on connect
 - BYPASS_MARKET_HOURS switch for testing (skip market open/close checks)
 - Internet resilience: detect connectivity loss, retry every 3 min
 - Per-symbol resilience: failed fetch doesn't block others
 - Parallel DB batch write (all symbols in one commit)
 - Proper structured logging with clear prefixes
 - v5 optimizations retained: no numpy, single-pass, list comprehensions
"""

import os

if os.getuid() == 0:
    os.umask(0o000)

import time
import math
import struct
import asyncio
from datetime import datetime, time as datetime_time, timedelta
import signal
import sqlite3
import threading
import orjson
import aiohttp
from aiohttp import web


# ==================== LOGGER ====================
def log(msg: str):
    print(f"[{datetime.now().strftime('%H:%M:%S.%f')[:-3]}] {msg}", flush=True)


# ==================== UVLOOP ====================
try:
    import uvloop
    uvloop.install()
    log("[INIT] uvloop activated")
except ImportError:
    log("[INIT] uvloop not found, using default asyncio")


# ====================================================================
# SECTION 1: BINARY FORMAT CONSTANTS
# ====================================================================
# Per row: 86 bytes (26 fields, little-endian)
ROW_FMT  = "<IffhiHiiffffHHhiiffffHHhfi"
ROW_SIZE = struct.calcsize(ROW_FMT)  # 88

# Per tick header: 22 bytes (7 fields)
HDR_FMT  = "<IffHHIH"
HDR_SIZE = struct.calcsize(HDR_FMT)  # 22

# Per query response header: 8 bytes (3 fields)
QHDR_FMT  = "<IHH"
QHDR_SIZE = struct.calcsize(QHDR_FMT)  # 8


# ====================================================================
# SECTION 2: SCHEMA MAP (sent once to UI)
# ====================================================================
SYMBOL_REGISTRY = {
    1: {"name": "NIFTY",     "step": 50,  "exchange": "NSE"},
    2: {"name": "BANKNIFTY", "step": 100, "exchange": "NSE"},
    3: {"name": "SENSEX",    "step": 100, "exchange": "BSE"},
    4: {"name": "CRUDEOIL",  "step": 50,  "exchange": "MCX"},
}

STEP_MAP  = {k: v["step"] for k, v in SYMBOL_REGISTRY.items()}
NAME_MAP  = {k: v["name"] for k, v in SYMBOL_REGISTRY.items()}
UNIT_SUFFIX = ("", "K", "M", "B")

SCHEMA_MAP = orjson.dumps({
    "version": 1,
    "formats": {
        "tick_header": {"size": HDR_SIZE, "fields": [
            {"name": "timestamp",  "offset": 0,  "type": "uint32", "decode": "seconds_to_time"},
            {"name": "spot_price", "offset": 4,  "type": "float32"},
            {"name": "spot_chng",  "offset": 8,  "type": "float32"},
            {"name": "atm_key",    "offset": 12, "type": "uint16", "decode": "multiply_step"},
            {"name": "lot_size",   "offset": 14, "type": "uint16"},
            {"name": "symbol_id",  "offset": 16, "type": "uint32"},
            {"name": "row_count",  "offset": 20, "type": "uint16"},
        ]},
        "row": {"size": ROW_SIZE, "fields": [
            {"name": "timestamp",   "offset": 0,  "type": "uint32",  "decode": "seconds_to_time"},
            {"name": "spot_price",  "offset": 4,  "type": "float32"},
            {"name": "spot_chng",   "offset": 8,  "type": "float32"},
            {"name": "rel_idx",     "offset": 12, "type": "int16"},
            {"name": "strike",      "offset": 14, "type": "int32"},
            {"name": "lot_size",    "offset": 18, "type": "uint16"},
            {"name": "ce_oi",       "offset": 20, "type": "int32"},
            {"name": "ce_chng",     "offset": 24, "type": "int32"},
            {"name": "ce_vol",      "offset": 28, "type": "float32"},
            {"name": "ce_ltp",      "offset": 32, "type": "float32"},
            {"name": "ce_iv",       "offset": 36, "type": "float32"},
            {"name": "ce_delta",    "offset": 40, "type": "float32"},
            {"name": "ce_vol_pct",  "offset": 44, "type": "uint16", "decode": "divide_10"},
            {"name": "ce_oi_pct",   "offset": 46, "type": "uint16", "decode": "divide_10"},
            {"name": "ce_chng_pct", "offset": 48, "type": "int16",  "decode": "divide_10"},
            {"name": "pe_oi",       "offset": 50, "type": "int32"},
            {"name": "pe_chng",     "offset": 54, "type": "int32"},
            {"name": "pe_vol",      "offset": 58, "type": "float32"},
            {"name": "pe_ltp",      "offset": 62, "type": "float32"},
            {"name": "pe_iv",       "offset": 66, "type": "float32"},
            {"name": "pe_delta",    "offset": 70, "type": "float32"},
            {"name": "pe_vol_pct",  "offset": 74, "type": "uint16", "decode": "divide_10"},
            {"name": "pe_oi_pct",   "offset": 76, "type": "uint16", "decode": "divide_10"},
            {"name": "pe_chng_pct", "offset": 78, "type": "int16",  "decode": "divide_10"},
            {"name": "gamma",       "offset": 80, "type": "float32"},
            {"name": "meta_pack",   "offset": 84, "type": "int32"},
        ]},
        "query_header": {"size": QHDR_SIZE, "fields": [
            {"name": "symbol_id", "offset": 0, "type": "uint32"},
            {"name": "row_count", "offset": 4, "type": "uint16"},
            {"name": "step",      "offset": 6, "type": "uint16"},
        ]},
    },
    "symbols": {str(k): v for k, v in SYMBOL_REGISTRY.items()},
    "decode_rules": {
        "multiply_step":   "value * step  (atm_key in header only)",
        "divide_10":       "value / 10  (853 → 85.3)",
        "seconds_to_time": "HH:MM:SS from seconds since midnight",
        "meta_unpack":     "bitwise: 6 unit_codes (2bit) + 6 ranks (2bit)",
    },
    "meta_pack_layout": {
        "bits_0_1": "ce_oi_unit  (0='',1='K',2='M',3='B')",
        "bits_2_3": "ce_chng_unit", "bits_4_5": "ce_vol_unit",
        "bits_6_7": "pe_oi_unit",   "bits_8_9": "pe_chng_unit",
        "bits_10_11": "pe_vol_unit",
        "bits_12_13": "ce_vol_rank  (0-3)", "bits_14_15": "ce_oi_rank",
        "bits_16_17": "ce_chng_rank", "bits_18_19": "pe_vol_rank",
        "bits_20_21": "pe_oi_rank",   "bits_22_23": "pe_chng_rank",
    },
})


# ====================================================================
# SECTION 3: CONFIGURATION
# ====================================================================
ENABLE_NIFTY      = True
ENABLE_BANKNIFTY  = False
ENABLE_BSE        = False
ENABLE_CRUDEOIL   = True

PROCESS_FROM_IDX = -30
PROCESS_TO_IDX   =  30

# *** MASTER BYPASS SWITCH ***
# True  → Always run, skip market open/close checks (for testing)
# False → Normal behavior, check market hours
BYPASS_MARKET_HOURS = False

# Internet retry interval when connectivity is lost
INTERNET_RETRY_SEC = 180  # 3 minutes

# Market timings (IST)
NSE_OPEN  = datetime_time(9, 15);  NSE_CLOSE = datetime_time(15, 30);  NSE_DAYS = {0,1,2,3,4}
BSE_OPEN  = datetime_time(9, 15);  BSE_CLOSE = datetime_time(15, 30);  BSE_DAYS = {0,1,2,3,4}
MCX_OPEN  = datetime_time(9, 0);   MCX_CLOSE = datetime_time(23, 30);  MCX_DAYS = {0,1,2,3,4}

AUTO_EXIT_WHEN_ALL_CLOSED = False

API_HOST = os.environ.get("apihost", "127.0.0.1")
API_PORT = int(os.environ.get("apiport", 8788))

INTERNAL_DB_DIR = os.environ.get(
    "dbpath_internal",
    os.path.join(os.environ.get("HOME", "/root"), "trading-data")
)

DB_DATE_STR = datetime.now().strftime("%Y-%m-%d")
DB_FILENAME = f"trading_{DB_DATE_STR}.db"
DB_PATH     = os.path.join(INTERNAL_DB_DIR, DB_FILENAME)

URL  = os.environ.get("durl",  "")
FURL = os.environ.get("dfurl", "")

HEADERS: dict = {
    "accept":           "application/json, text/plain, */*",
    "accept-language":  "en-US,en;q=0.9",
    "auth":             os.environ.get("dtoken",   ""),
    "authorisation":    "Token",
    "content-type":     "application/json",
    "origin":           os.environ.get("dorigin",  ""),
    "priority":         "u=1, i",
    "referer":          os.environ.get("dreferer", ""),
    "sec-ch-ua":        '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
    "sec-fetch-dest":   "empty",
    "sec-fetch-mode":   "cors",
    "sec-fetch-site":   "same-site",
    "user-agent":       "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
}

TARGETS_CONFIG: dict = {
    "NIFTY":      {"enabled": ENABLE_NIFTY,     "exchange": "NSE", "seg": 0, "sid": 13,     "step": 50.0,  "ftime": 1, "exp": -1, "scale_div": 1000.0, "sym_id": 1},
    "BANKNIFTY":  {"enabled": ENABLE_BANKNIFTY,  "exchange": "NSE", "seg": 0, "sid": 25,     "step": 100.0, "ftime": 1, "exp": -1, "scale_div": 1000.0, "sym_id": 2},
    "SENSEX":     {"enabled": ENABLE_BSE,        "exchange": "BSE", "seg": 1, "sid": 1,      "step": 100.0, "ftime": 1, "exp": -1, "scale_div": 1000.0, "sym_id": 3},
    "CRUDEOIL":   {"enabled": ENABLE_CRUDEOIL,   "exchange": "MCX", "seg": 5, "sid": 520702, "step": 50.0,  "ftime": 3, "exp": -1, "scale_div": 100.0,  "sym_id": 4},
}

NEXT_FETCH_TIME: dict = {symbol: 0.0 for symbol in TARGETS_CONFIG}


# ====================================================================
# SECTION 4: GLOBAL STATE
# ====================================================================
LATEST_TICKS: dict         = {}   # symbol → binary packet bytes
CLIENT_SUBSCRIPTIONS: dict = {}
DB_CONN: sqlite3.Connection | None = None
DB_LOCK = threading.Lock()

last_batch_time = time.time()
last_batch_rows = 0
_db_initialized = False


# ====================================================================
# SECTION 5: BINARY ENCODING HELPERS
# ====================================================================
def _now_seconds() -> int:
    """Current IST time as seconds since midnight."""
    now = datetime.now()
    return now.hour * 3600 + now.minute * 60 + now.second

def _seconds_to_time_str(s: int) -> str:
    h = s // 3600; m = (s % 3600) // 60; sec = s % 60
    return f"{h:02d}:{m:02d}:{sec:02d}"

def _pack_row(ts, spot, chng, rel_idx, strike, lot,
              ce_oi, ce_chng, ce_vol, ce_ltp, ce_iv, ce_delta,
              ce_vol_pct_x10, ce_oi_pct_x10, ce_chng_pct_x10,
              pe_oi, pe_chng, pe_vol, pe_ltp, pe_iv, pe_delta,
              pe_vol_pct_x10, pe_oi_pct_x10, pe_chng_pct_x10,
              gamma, meta_pack) -> bytes:
    return struct.pack(ROW_FMT,
        ts, spot, chng, rel_idx, strike, lot,
        ce_oi, ce_chng, ce_vol, ce_ltp, ce_iv, ce_delta,
        ce_vol_pct_x10, ce_oi_pct_x10, ce_chng_pct_x10,
        pe_oi, pe_chng, pe_vol, pe_ltp, pe_iv, pe_delta,
        pe_vol_pct_x10, pe_oi_pct_x10, pe_chng_pct_x10,
        gamma, meta_pack)

def _pack_tick_header(ts, spot, chng, atm_key, lot, sym_id, row_count) -> bytes:
    return struct.pack(HDR_FMT, ts, spot, chng, atm_key, lot, sym_id, row_count)

def _pack_query_header(sym_id, row_count, step) -> bytes:
    return struct.pack(QHDR_FMT, sym_id, row_count, step)


# ====================================================================
# SECTION 6: SQLITE (per-row BLOB schema)
# ====================================================================
def _reset_exp_tokens():
    for cfg in TARGETS_CONFIG.values():
        cfg["exp"] = -1

def _build_db_path_for_today() -> str:
    global DB_DATE_STR, DB_FILENAME, DB_PATH
    DB_DATE_STR = datetime.now().strftime("%Y-%m-%d")
    DB_FILENAME = f"trading_{DB_DATE_STR}.db"
    DB_PATH     = os.path.join(INTERNAL_DB_DIR, DB_FILENAME)
    return DB_PATH

def _ensure_v6_schema(conn, table: str):
    """Check if table has the v6 BLOB schema; if not, drop and recreate.
    
    Handles migration from v4/v5 (27-column) to v6 (4-column + BLOB).
    Old data is lost — but it's same-day intraday data, so acceptable.
    """
    cursor = conn.execute(f"PRAGMA table_info({table})")
    existing_cols = {row[1] for row in cursor.fetchall()}  # row[1] = column name
    
    # Table doesn't exist yet (0 cols) — CREATE TABLE IF NOT EXISTS will handle it
    if not existing_cols:
        return
    
    # v6 BLOB schema must have 'strike' and 'payload' columns
    if "strike" in existing_cols and "payload" in existing_cols:
        return  # Already v6 schema, nothing to do
    
    # Old schema detected — drop and recreate
    log(f"[DB MIGRATE] {table}: old schema detected (cols: {len(existing_cols)}), "
        f"recreating with v6 BLOB schema")
    conn.execute(f"DROP TABLE IF EXISTS {table}")


def init_database():
    global DB_CONN, _db_initialized
    _build_db_path_for_today()
    os.makedirs(INTERNAL_DB_DIR, exist_ok=True)

    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-8000")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA mmap_size=33554432")
    conn.execute("PRAGMA wal_autocheckpoint=2000")
    conn.execute("PRAGMA busy_timeout=5000")

    for symbol, cfg in TARGETS_CONFIG.items():
        table = f"{symbol.lower()}_option_chain"
        
        # Migrate from v4/v5 if needed
        _ensure_v6_schema(conn, table)
        
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS {table} (
                timestamp   TEXT    NOT NULL,
                strike      INTEGER NOT NULL,
                rel_idx     INTEGER NOT NULL,
                payload     BLOB    NOT NULL,
                PRIMARY KEY (timestamp, strike)
            ) WITHOUT ROWID
        """)
        conn.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{symbol.lower()}_strike_ts "
            f"ON {table} (strike, timestamp)"
        )
        conn.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{symbol.lower()}_ts_rel "
            f"ON {table} (timestamp, rel_idx)"
        )

    conn.commit()
    with DB_LOCK:
        DB_CONN = conn
    _db_initialized = True
    log(f"[DB] Initialized: {DB_PATH} (BLOB schema, WITHOUT ROWID)")

def _close_database_sync(reason: str = "CLOSE"):
    global DB_CONN, _db_initialized
    with DB_LOCK:
        conn = DB_CONN
        DB_CONN = None
        _db_initialized = False
    if conn is None:
        return
    try:
        conn.execute("PRAGMA optimize")
        result = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        log(f"[{reason}] WAL checkpoint: busy={result[0]}, log={result[1]}, ckpt={result[2]}")
    except Exception as e:
        log(f"[{reason}] WAL checkpoint error: {e}")
    try:
        conn.close()
        log(f"[{reason}] DB closed cleanly")
    except Exception as e:
        log(f"[{reason}] DB close error: {e}")


# ==================== BATCH WRITE ====================
_INSERT_SQL: dict[str, str] = {}

def _insert_sql(symbol: str) -> str:
    if symbol not in _INSERT_SQL:
        table = f"{symbol.lower()}_option_chain"
        _INSERT_SQL[symbol] = f"INSERT OR REPLACE INTO {table} (timestamp, strike, rel_idx, payload) VALUES (?, ?, ?, ?)"
    return _INSERT_SQL[symbol]

def _write_batch_sync(batch: dict, tag: str = "BATCH") -> int:
    global last_batch_time, last_batch_rows
    if not DB_CONN:
        log(f"[{tag}] Skipped - DB not initialized")
        return 0

    total = 0
    symbols = []
    with DB_LOCK:
        try:
            DB_CONN.execute("BEGIN")
            for symbol, rows in batch.items():
                if not rows:
                    continue
                DB_CONN.executemany(_insert_sql(symbol), rows)
                total += len(rows)
                symbols.append(symbol)
            DB_CONN.execute("COMMIT")
        except Exception as e:
            log(f"[{tag} ERROR] Rollback: {e}")
            try:
                DB_CONN.execute("ROLLBACK")
            except Exception as rb_err:
                log(f"[{tag} ROLLBACK ERROR] {rb_err}")
            total = 0

    last_batch_time = time.time()
    last_batch_rows = total
    if total > 0:
        log(f"[{tag}] {total} rows committed across {len(symbols)} symbol(s): {', '.join(symbols)}")
    return total

async def write_batch_to_sqlite(batch: dict) -> int:
    return await asyncio.to_thread(_write_batch_sync, batch, "BATCH")


# ==================== DB ROTATION ====================
async def check_and_rotate_db():
    global DB_DATE_STR
    current_date_str = datetime.now().strftime("%Y-%m-%d")
    if current_date_str == DB_DATE_STR:
        return
    log(f"[DB ROTATE] Date changed {DB_DATE_STR} → {current_date_str}")
    await asyncio.to_thread(_close_database_sync, "DB ROTATE")
    await asyncio.to_thread(init_database)


# ====================================================================
# SECTION 7: MARKET TIME + BYPASS
# ====================================================================
def _exchange_schedule(exchange: str):
    if exchange == "NSE": return NSE_OPEN, NSE_CLOSE, NSE_DAYS
    if exchange == "BSE": return BSE_OPEN, BSE_CLOSE, BSE_DAYS
    if exchange == "MCX": return MCX_OPEN, MCX_CLOSE, MCX_DAYS
    return None, None, set()

def is_market_open(exchange: str) -> bool:
    if BYPASS_MARKET_HOURS:
        return True
    now = datetime.now()
    open_t, close_t, trading_days = _exchange_schedule(exchange)
    if open_t is None:
        return False
    return now.weekday() in trading_days and open_t <= now.time() <= close_t

def any_enabled_market_open() -> bool:
    if BYPASS_MARKET_HOURS:
        return True
    return any(
        cfg["enabled"] and is_market_open(cfg["exchange"])
        for cfg in TARGETS_CONFIG.values()
    )

def seconds_until_next_open() -> float | None:
    if BYPASS_MARKET_HOURS:
        return 0.0
    now = datetime.now()
    exchanges_needed = {cfg["exchange"] for cfg in TARGETS_CONFIG.values() if cfg["enabled"]}
    candidates = []
    for exch in exchanges_needed:
        open_t, close_t, trading_days = _exchange_schedule(exch)
        if open_t is None or not trading_days:
            continue
        for day_offset in range(8):
            candidate_date = (now + timedelta(days=day_offset)).date()
            if candidate_date.weekday() not in trading_days:
                continue
            candidate_open_dt = datetime.combine(candidate_date, open_t)
            if candidate_open_dt > now:
                candidates.append(candidate_open_dt)
                break
    if not candidates:
        return None
    return max(0.0, (min(candidates) - now).total_seconds())

def next_aligned_time(ftime_minutes: int) -> float:
    now = time.time()
    interval = ftime_minutes * 60.0
    return now + (interval - (now % interval))


# ====================================================================
# SECTION 8: PURE PYTHON MATH (no numpy)
# ====================================================================
def _magnitude_unit(value: float) -> int:
    abs_val = abs(value)
    if abs_val < 1000:
        return 0
    return min(int(math.log10(abs_val) // 3) * 3, 9) // 3

def _pack_meta_row(ce_oi_u, ce_chng_u, ce_vol_u, pe_oi_u, pe_chng_u, pe_vol_u,
                   ce_v_rank, ce_o_rank, ce_c_rank, pe_v_rank, pe_o_rank, pe_c_rank) -> int:
    return (
        ce_oi_u | (ce_chng_u << 2) | (ce_vol_u << 4)
        | (pe_oi_u << 6) | (pe_chng_u << 8) | (pe_vol_u << 10)
        | (ce_v_rank << 12) | (ce_o_rank << 14) | (ce_c_rank << 16)
        | (pe_v_rank << 18) | (pe_o_rank << 20) | (pe_c_rank << 22)
    )

def _unpack_meta(pack: int) -> dict:
    return {
        "ce_oi_unit":   UNIT_SUFFIX[pack & 0b11],
        "ce_chng_unit": UNIT_SUFFIX[(pack >> 2) & 0b11],
        "ce_vol_unit":  UNIT_SUFFIX[(pack >> 4) & 0b11],
        "pe_oi_unit":   UNIT_SUFFIX[(pack >> 6) & 0b11],
        "pe_chng_unit": UNIT_SUFFIX[(pack >> 8) & 0b11],
        "pe_vol_unit":  UNIT_SUFFIX[(pack >> 10) & 0b11],
        "ce_vol_rank":  (pack >> 12) & 0b11,
        "ce_oi_rank":   (pack >> 14) & 0b11,
        "ce_chng_rank": (pack >> 16) & 0b11,
        "pe_vol_rank":  (pack >> 18) & 0b11,
        "pe_oi_rank":   (pack >> 20) & 0b11,
        "pe_chng_rank": (pack >> 22) & 0b11,
    }

def short_value(raw: float, unit_code: int) -> str:
    mantissa = round(raw / (1000.0 ** unit_code), 2)
    return f"{mantissa}{UNIT_SUFFIX[unit_code]}"

def calculate_ranks_and_percentages(strikes, vols, ois, chngs, atm_strike, step_size, is_ce):
    n = len(strikes)
    if n == 0:
        empty = []
        return empty, empty, empty, empty, empty, empty

    offsets = [(s - atm_strike) / step_size for s in strikes]
    if is_ce:
        window_mask = [-2 <= o <= 15 for o in offsets]
        deep_itm = [o < -2 for o in offsets]
    else:
        window_mask = [-15 <= o <= 2 for o in offsets]
        deep_itm = [o > 2 for o in offsets]

    def compute_pct(arr):
        max_val = max(arr) if arr else 0
        if max_val <= 0:
            return [0.0] * n, max_val
        inv = 100.0 / max_val
        return [round(v * inv, 1) for v in arr], max_val

    vol_pcts, max_vol = compute_pct(vols)
    oi_pcts, max_oi = compute_pct(ois)
    chng_pcts, max_chng = compute_pct(chngs)

    def compute_ranks(arr, max_val, mask, itm):
        ranks = [0] * n
        if max_val == 0:
            return ranks
        global_max_idx = arr.index(max_val)
        if itm[global_max_idx]:
            ranks[global_max_idx] = 3
        window_items = [(i, arr[i]) for i in range(n) if mask[i] and arr[i] > 0]
        window_items.sort(key=lambda x: x[1], reverse=True)
        rank = 1
        for idx, val in window_items[:3]:
            if ranks[idx] == 0:
                ranks[idx] = rank
                rank += 1
        return ranks

    v_ranks = compute_ranks(vols, max_vol, window_mask, deep_itm)
    o_ranks = compute_ranks(ois, max_oi, window_mask, deep_itm)
    c_ranks = compute_ranks(chngs, max_chng, window_mask, deep_itm)

    return v_ranks, o_ranks, c_ranks, vol_pcts, oi_pcts, chng_pcts


# ====================================================================
# SECTION 9: DATA PROCESSING → BINARY PACKETS (single-pass)
# ====================================================================
def _compute_tick_binary(symbol: str, config: dict, payload_data: dict) -> dict | None:
    """
    Single-pass: API dict → binary rows + tick packet + DB rows.
    Returns None if data is invalid/empty.
    """
    oc_dict = payload_data.get("oc", {})
    if not oc_dict:
        log(f"[DATA] {symbol}: 'oc' empty - tick skipped")
        return None

    if symbol == "CRUDEOIL":
        fl_dict = payload_data.get("fl", {})
        if not fl_dict:
            log(f"[DATA] {symbol}: 'fl' empty - tick skipped")
            return None
        spot_price = float(next(iter(fl_dict.values())).get("ltp", 0.0))
    else:
        spot_price = float(payload_data.get("sltp", 0.0))

    if spot_price <= 0:
        log(f"[DATA] {symbol}: spot_price <= 0 ({spot_price}) - tick skipped")
        return None

    spot_chng  = float(payload_data.get("SChng", 0.0))
    step_size  = config["step"]
    step_int   = int(step_size)
    lot_size   = int(payload_data.get("olot", 0))
    atm_strike = int(round(spot_price / step_size) * step_size)
    sym_id     = config["sym_id"]
    ts_int     = _now_seconds()
    ts_str     = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    atm_key    = atm_strike // step_int

    # ── Single-pass extraction ──
    raw = []
    for strike_str, node in oc_dict.items():
        try:
            strike = int(float(strike_str))
        except (ValueError, TypeError):
            continue
        rel_idx = (strike - atm_strike) // step_int
        if not (PROCESS_FROM_IDX <= rel_idx <= PROCESS_TO_IDX):
            continue

        ce_inner = node.get("ce") or {}
        pe_inner = node.get("pe") or {}
        ce_geeks = ce_inner.get("optgeeks") or {}
        pe_geeks = pe_inner.get("optgeeks") or {}

        ce_vol_raw = ce_inner.get("vol", 0)
        pe_vol_raw = pe_inner.get("vol", 0)
        ce_vol = round((ce_vol_raw if ce_vol_raw >= 0 else ce_vol_raw & 0xFFFFFFFF) / 10000.0, 2)
        pe_vol = round((pe_vol_raw if pe_vol_raw >= 0 else pe_vol_raw & 0xFFFFFFFF) / 10000.0, 2)

        raw.append((
            strike, rel_idx,
            ce_inner.get("OI", 0), ce_inner.get("oichng", 0), ce_vol,
            ce_inner.get("ltp", 0.0), ce_inner.get("iv", 0.0), ce_geeks.get("delta", 0.0),
            pe_inner.get("OI", 0), pe_inner.get("oichng", 0), pe_vol,
            pe_inner.get("ltp", 0.0), pe_inner.get("iv", 0.0), pe_geeks.get("delta", 0.0),
            ce_geeks.get("gamma", 0.0),
        ))

    if not raw:
        log(f"[DATA] {symbol}: no strikes in range - tick skipped")
        return None

    raw.sort()
    n = len(raw)

    (strikes, rel_indices,
     ce_ois, ce_chngs, ce_vols,
     ce_ltps, ce_ivs, ce_deltas,
     pe_ois, pe_chngs, pe_vols,
     pe_ltps, pe_ivs, pe_deltas,
     gammas) = zip(*raw)

    # ── Ranks & Percentages ──
    ce_v_rank, ce_o_rank, ce_c_rank, ce_vol_pct, ce_oi_pct, ce_chng_pct = \
        calculate_ranks_and_percentages(strikes, ce_vols, ce_ois, ce_chngs, atm_strike, step_size, is_ce=True)
    pe_v_rank, pe_o_rank, pe_c_rank, pe_vol_pct, pe_oi_pct, pe_chng_pct = \
        calculate_ranks_and_percentages(strikes, pe_vols, pe_ois, pe_chngs, atm_strike, step_size, is_ce=False)

    # ── Magnitude units ──
    ce_oi_u   = [_magnitude_unit(v) for v in ce_ois]
    ce_chng_u = [_magnitude_unit(v) for v in ce_chngs]
    ce_vol_u  = [_magnitude_unit(v) for v in ce_vols]
    pe_oi_u   = [_magnitude_unit(v) for v in pe_ois]
    pe_chng_u = [_magnitude_unit(v) for v in pe_chngs]
    pe_vol_u  = [_magnitude_unit(v) for v in pe_vols]

    # ── Pack binary rows + build DB rows ──
    binary_rows = []
    db_rows = []
    spot_f = float(spot_price)
    chng_f = float(spot_chng)
    lot_i  = int(lot_size)

    for i in range(n):
        meta = _pack_meta_row(
            ce_oi_u[i], ce_chng_u[i], ce_vol_u[i],
            pe_oi_u[i], pe_chng_u[i], pe_vol_u[i],
            ce_v_rank[i], ce_o_rank[i], ce_c_rank[i],
            pe_v_rank[i], pe_o_rank[i], pe_c_rank[i],
        )
        strike_val = strikes[i]
        # Clamp fields to valid range (defense-in-depth)
        _lot = max(0, min(lot_i, 65535))
        _cvp = max(0, min(int(ce_vol_pct[i]  * 10), 65535))
        _cop = max(0, min(int(ce_oi_pct[i]   * 10), 65535))
        _ccp = max(-32768, min(int(ce_chng_pct[i] * 10), 32767))  # signed int16
        _pvp = max(0, min(int(pe_vol_pct[i]  * 10), 65535))
        _pop = max(0, min(int(pe_oi_pct[i]   * 10), 65535))
        _pcp = max(-32768, min(int(pe_chng_pct[i] * 10), 32767))  # signed int16
        row_bytes = _pack_row(
            ts_int, spot_f, chng_f, rel_indices[i], strike_val, _lot,
            ce_ois[i], ce_chngs[i], ce_vols[i],
            ce_ltps[i], ce_ivs[i], ce_deltas[i],
            _cvp, _cop, _ccp,
            pe_ois[i], pe_chngs[i], pe_vols[i],
            pe_ltps[i], pe_ivs[i], pe_deltas[i],
            _pvp, _pop, _pcp,
            gammas[i], meta,
        )
        binary_rows.append(row_bytes)
        db_rows.append((ts_str, strike_val, rel_indices[i], row_bytes))

    # ── Assemble full tick packet (header + rows) ──
    header = _pack_tick_header(ts_int, spot_f, chng_f, atm_key, lot_i, sym_id, n)
    packet = header + b''.join(binary_rows)

    log(f"[TICK] {symbol}: {n} strikes | Spot: {spot_price} | Clients: {len(CLIENT_SUBSCRIPTIONS)}")

    return {
        "symbol":      symbol,
        "sym_id":      sym_id,
        "timestamp":   ts_str,
        "spot_price":  spot_price,
        "spot_chng":   spot_chng,
        "n_elements":  n,
        "binary_rows": binary_rows,
        "db_rows":     db_rows,
        "packet":      packet,
    }


# ====================================================================
# SECTION 10: WEBSOCKET (binary broadcast + schema map)
# ====================================================================
async def ws_broadcast(symbol: str, packet: bytes):
    if not CLIENT_SUBSCRIPTIONS:
        return
    dead = []
    for ws, sub in list(CLIENT_SUBSCRIPTIONS.items()):
        if symbol not in sub["symbols"]:
            continue
        try:
            await ws.send_bytes(packet)
        except Exception:
            dead.append(ws)
    for ws in dead:
        CLIENT_SUBSCRIPTIONS.pop(ws, None)
        log(f"[WS] Dead client removed. Remaining: {len(CLIENT_SUBSCRIPTIONS)}")


# ── WS Action Handlers ──
async def _ws_subscribe(ws, data, sub):
    symbol = data.get("symbol", "").upper()
    if symbol not in TARGETS_CONFIG:
        return
    sub["symbols"].add(symbol)
    if "from" in data:
        sub["from"] = int(data["from"])
    if "to" in data:
        sub["to"] = int(data["to"])
    await ws.send_str(orjson.dumps({
        "type": "subscribed", "symbol": symbol,
        "range": {"from": sub["from"], "to": sub["to"]},
    }).decode())
    # Send latest cached tick (binary)
    packet = LATEST_TICKS.get(symbol)
    if packet:
        try:
            await ws.send_bytes(packet)
        except Exception:
            pass

async def _ws_unsubscribe(ws, data, sub):
    symbol = data.get("symbol", "").upper()
    sub["symbols"].discard(symbol)
    await ws.send_str(orjson.dumps({"type": "unsubscribed", "symbol": symbol}).decode())

async def _ws_set_range(ws, data, sub):
    sub["from"] = int(data.get("from", PROCESS_FROM_IDX))
    sub["to"]   = int(data.get("to",   PROCESS_TO_IDX))
    await ws.send_str(orjson.dumps({
        "type": "range_updated", "range": {"from": sub["from"], "to": sub["to"]},
    }).decode())

async def _ws_ping(ws, data, sub):
    await ws.send_str(orjson.dumps({"type": "pong"}).decode())

async def _ws_get_schema(ws, data, sub):
    """Send schema map JSON (once, on request from UI)."""
    await ws.send_str(orjson.dumps({
        "type": "schema", "schema": orjson.loads(SCHEMA_MAP),
    }).decode())

_WS_ACTIONS = {
    "subscribe":   _ws_subscribe,
    "unsubscribe": _ws_unsubscribe,
    "set_range":   _ws_set_range,
    "ping":        _ws_ping,
    "get_schema":  _ws_get_schema,
}

async def ws_handler(request):
    ws = web.WebSocketResponse(
        heartbeat=30,  # Built-in PING/PONG — dead clients detected in ~30s
    )
    await ws.prepare(request)
    CLIENT_SUBSCRIPTIONS[ws] = {"symbols": set(), "from": PROCESS_FROM_IDX, "to": PROCESS_TO_IDX}
    log(f"[WS] Client connected. Total: {len(CLIENT_SUBSCRIPTIONS)}")

    try:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                try:
                    data   = orjson.loads(msg.data)
                    action = data.get("action")
                    handler = _WS_ACTIONS.get(action)
                    if handler:
                        await handler(ws, data, CLIENT_SUBSCRIPTIONS[ws])
                    else:
                        await ws.send_str(orjson.dumps({"type": "error", "message": f"Unknown action: {action}"}).decode())
                except Exception as e:
                    await ws.send_str(orjson.dumps({"type": "error", "message": str(e)}).decode())
            elif msg.type == aiohttp.WSMsgType.ERROR:
                break
    finally:
        CLIENT_SUBSCRIPTIONS.pop(ws, None)
        log(f"[WS] Client disconnected. Total: {len(CLIENT_SUBSCRIPTIONS)}")
    return ws


# ====================================================================
# SECTION 11: REST API HANDLERS
# ====================================================================
async def handle_health(request):
    return web.Response(
        body=orjson.dumps({
            "status": "ok",
            "timestamp": datetime.now().isoformat(),
            "clients": len(CLIENT_SUBSCRIPTIONS),
            "last_batch_rows": last_batch_rows,
            "seconds_since_last_batch": round(time.time() - last_batch_time, 1),
            "db_path": DB_PATH,
            "db_initialized": _db_initialized,
            "bypass_market_hours": BYPASS_MARKET_HOURS,
            "process_range": {"from": PROCESS_FROM_IDX, "to": PROCESS_TO_IDX},
        }),
        content_type="application/json",
    )

async def handle_schema(request):
    """HTTP endpoint: returns schema map JSON."""
    return web.Response(body=SCHEMA_MAP, content_type="application/json")

async def handle_latest(request):
    """Returns latest tick as binary packet."""
    symbol = request.match_info.get("symbol", "").upper()
    if symbol not in TARGETS_CONFIG:
        return web.json_response({"error": "Invalid symbol"}, status=400)
    packet = LATEST_TICKS.get(symbol)
    if not packet:
        return web.json_response({"error": "No data available"}, status=404)
    return web.Response(body=packet, content_type="application/octet-stream")


# ====================================================================
# SECTION 12: BINARY QUERY HANDLER (/query → binary response)
# ====================================================================
def is_readonly_sql(sql: str) -> bool:
    if not sql:
        return False
    s = sql.strip().lower()
    if ";" in s:
        return False
    return s.startswith("select") or s.startswith("with")

# Symbol table name → sym_id mapping
_TABLE_SYM_MAP = {f"{v['name'].lower()}_option_chain": k for k, v in SYMBOL_REGISTRY.items()}

async def handle_db_query(request):
    """
    Query endpoint → binary response if option_chain table,
    JSON fallback otherwise.
    """
    if not DB_CONN or not DB_LOCK:
        return web.json_response({"error": "DB not initialized"}, status=503)

    try:
        body = await request.json(loads=orjson.loads)
        sql_query = (body.get("sql") or "").strip()
        params = body.get("params", [])
        fmt = body.get("format", "auto")  # "auto", "binary", "json"

        if not is_readonly_sql(sql_query):
            log(f"[GATEWAY BLOCK] Unauthorized: '{sql_query[:80]}'")
            return web.json_response({"error": "Only SELECT/WITH allowed"}, status=403)

        log(f"[GATEWAY] SQL: {sql_query[:80]} | Params: {params}")

        with DB_LOCK:
            cursor = DB_CONN.execute(sql_query, params)
            columns = [col[0] for col in cursor.description] if cursor.description else []
            rows = cursor.fetchmany(10001)

        truncated = len(rows) > 10000
        if truncated:
            rows = rows[:10000]

        # Auto-detect: if result has 'payload' column → binary response
        is_binary = fmt != "json" and "payload" in columns

        if is_binary:
            # Find symbol_id from table name in SQL
            sym_id = 0
            step = 50
            for tbl, sid in _TABLE_SYM_MAP.items():
                if tbl in sql_query.lower():
                    sym_id = sid
                    step = STEP_MAP[sid]
                    break

            payload_idx = columns.index("payload")
            blobs = [row[payload_idx] for row in rows]

            # Assemble: query_header + row BLOBs
            buf = bytearray(QHDR_SIZE + ROW_SIZE * len(blobs))
            struct.pack_into(QHDR_FMT, buf, 0, sym_id, len(blobs), step)
            for i, blob in enumerate(blobs):
                buf[QHDR_SIZE + i * ROW_SIZE : QHDR_SIZE + (i + 1) * ROW_SIZE] = blob

            log(f"[GATEWAY] Binary response: {len(blobs)} rows, symbol_id={sym_id}")
            return web.Response(body=bytes(buf), content_type="application/octet-stream")
        else:
            log(f"[GATEWAY] JSON response: {len(rows)} rows")
            return web.Response(
                body=orjson.dumps({
                    "db": DB_PATH, "count": len(rows), "truncated": truncated,
                    "columns": columns, "rows": rows,
                }),
                content_type="application/json",
            )

    except orjson.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    except sqlite3.Error as e:
        log(f"[GATEWAY SQL ERROR] {e}")
        return web.json_response({"error": f"SQL error: {e}"}, status=400)
    except Exception as e:
        log(f"[GATEWAY ERROR] {e}")
        return web.json_response({"error": str(e)}, status=500)


# ====================================================================
# SECTION 13: FETCH + INTERNET RESILIENCE
# ====================================================================
async def fetch_raw_payload(session: aiohttp.ClientSession, symbol: str, config: dict):
    """Fetch single symbol. Returns (symbol, data) or (symbol, Exception)."""
    try:
        payload = {"Data": {"Seg": config["seg"], "Sid": config["sid"], "Exp": config["exp"]}}
        async with session.post(URL, json=payload, timeout=aiohttp.ClientTimeout(total=12)) as resp:
            if resp.status == 200:
                raw = orjson.loads(await resp.read())
                return symbol, raw.get("data", {})
            body = (await resp.text())[:200]
            return symbol, Exception(f"HTTP {resp.status}: {body}")
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as e:
        return symbol, e  # Connection error → likely internet issue
    except Exception as e:
        return symbol, e

def _is_connection_error(exc) -> bool:
    """Check if exception indicates internet/connectivity loss."""
    return isinstance(exc, (aiohttp.ClientError, asyncio.TimeoutError, OSError, ConnectionError))

async def _fetch_one_expiry(session: aiohttp.ClientSession, symbol: str, config: dict):
    try:
        payload = {"Data": {"Seg": config["seg"], "Sid": config["sid"]}}
        async with session.post(FURL, json=payload, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status == 200:
                raw_json = orjson.loads(await resp.read())
                opsum = raw_json.get("data", {}).get("opsum", {})
                if opsum:
                    exact_exp = next(iter(opsum.values())).get("exp")
                    if exact_exp:
                        return symbol, int(exact_exp)
        return symbol, -1
    except Exception as e:
        log(f"[EXPIRY ERROR] {symbol}: {e}")
        return symbol, -1

async def fetch_exact_expiry_tokens(session: aiohttp.ClientSession):
    log("[EXPIRY] Fetching in parallel...")
    enabled = [(s, c) for s, c in TARGETS_CONFIG.items() if c["enabled"]]
    if not enabled:
        return
    results = await asyncio.gather(
        *[_fetch_one_expiry(session, s, c) for s, c in enabled],
        return_exceptions=True,
    )
    for result in results:
        if isinstance(result, Exception):
            log(f"[EXPIRY EXCEPTION] {result}")
            continue
        symbol, exp = result
        if exp != -1:
            TARGETS_CONFIG[symbol]["exp"] = exp
            log(f"[EXPIRY] {symbol}: {exp}")
    missing = [s for s, c in TARGETS_CONFIG.items() if c["enabled"] and c["exp"] == -1]
    if missing:
        log(f"[EXPIRY] WARNING - no token: {missing}")


# ====================================================================
# SECTION 14: COLLECTOR LOOP
# ====================================================================
async def _finalize_and_broadcast(symbol: str, result: dict):
    LATEST_TICKS[symbol] = result["packet"]
    await ws_broadcast(symbol, result["packet"])

async def _sleep_until_next_open():
    wait_seconds = seconds_until_next_open()
    if wait_seconds is None:
        log("[SLEEP] No schedule found, retrying in 60s...")
        await asyncio.sleep(60)
        return
    log(f"[SLEEP] Markets closed. Sleeping ~{wait_seconds/60:.0f} min...")
    while wait_seconds > 0:
        chunk = min(wait_seconds, 1800.0)
        await asyncio.sleep(max(0.5, chunk))
        wait_seconds = (seconds_until_next_open() or 0.0)
        if any_enabled_market_open():
            break

async def collector_loop(app):
    async with aiohttp.ClientSession(headers=HEADERS) as session:

        if BYPASS_MARKET_HOURS:
            log("[BYPASS] Market hours check DISABLED - always running mode")

        # ── STARTUP ──
        while not any_enabled_market_open():
            if AUTO_EXIT_WHEN_ALL_CLOSED:
                log("[AUTO-EXIT] All markets closed at startup")
                os.kill(os.getpid(), signal.SIGTERM)
                return
            log("[STARTUP] Markets closed, waiting...")
            await _sleep_until_next_open()

        await asyncio.to_thread(init_database)
        await fetch_exact_expiry_tokens(session)

        # ── MAIN LOOP ──
        consecutive_net_failures = 0

        while True:
            start_time = time.time()
            await check_and_rotate_db()

            # ── Determine due symbols ──
            due = []
            for sym, config in TARGETS_CONFIG.items():
                if not config["enabled"]:
                    continue
                if not is_market_open(config["exchange"]):
                    continue
                if config["exp"] == -1:
                    continue
                if start_time >= NEXT_FETCH_TIME.get(sym, 0) - 0.5:
                    NEXT_FETCH_TIME[sym] = next_aligned_time(config["ftime"])
                    due.append((sym, config))

            if not due:
                if not any_enabled_market_open():
                    log("[MARKET] All markets closed. Checkpointing DB...")
                    await asyncio.to_thread(_close_database_sync, "MARKET CLOSE")
                    if AUTO_EXIT_WHEN_ALL_CLOSED:
                        os.kill(os.getpid(), signal.SIGTERM)
                        return
                    await _sleep_until_next_open()
                    log("[WAKE] Re-initializing...")
                    _reset_exp_tokens()
                    await asyncio.to_thread(init_database)
                    await fetch_exact_expiry_tokens(session)
                    continue
                # All due symbols fetched, just wait
                elapsed = time.time() - start_time
                await asyncio.sleep(max(0.1, 1.0 - elapsed))
                continue

            # ── STAGE 1: Parallel fetch (per-symbol resilient) ──
            fetch_results = await asyncio.gather(
                *[fetch_raw_payload(session, sym, cfg) for sym, cfg in due],
                return_exceptions=True,
            )

            # ── Classify results ──
            fetch_ok = {}      # symbol → payload_data
            fetch_fail = {}    # symbol → exception
            net_error = False  # True if any looks like internet issue

            for result in fetch_results:
                if isinstance(result, Exception):
                    # gather itself failed (shouldn't happen with return_exceptions)
                    log(f"[FETCH] Gather error: {result}")
                    net_error = True
                    continue
                sym, data = result
                if isinstance(data, Exception):
                    fetch_fail[sym] = data
                    if _is_connection_error(data):
                        net_error = True
                    log(f"[FETCH FAIL] {sym}: {type(data).__name__}: {data}")
                elif data is None:
                    fetch_fail[sym] = Exception("Empty response")
                    log(f"[FETCH FAIL] {sym}: Empty response from API")
                else:
                    fetch_ok[sym] = data

            # ── Internet connectivity check ──
            if net_error:
                consecutive_net_failures += 1
                if consecutive_net_failures >= 2:
                    log(f"[INTERNET] ⚠️  Connectivity lost! Waiting {INTERNET_RETRY_SEC}s before retry...")
                    await asyncio.sleep(INTERNET_RETRY_SEC)
                    # Quick test: try one fetch
                    test_sym, test_cfg = due[0]
                    test_result = await fetch_raw_payload(session, test_sym, test_cfg)
                    _, test_data = test_result
                    if isinstance(test_data, Exception):
                        log(f"[INTERNET] ❌ Still no connectivity. Will retry in {INTERNET_RETRY_SEC}s")
                        continue
                    else:
                        log("[INTERNET] ✅ Connectivity restored! Resuming...")
                        consecutive_net_failures = 0
                        # Don't continue, fall through to process this tick's data
                else:
                    log(f"[INTERNET] Network issue detected, will retry next cycle")
            else:
                consecutive_net_failures = 0

            # ── STAGE 2: Parallel compute (thread-pool) ──
            compute_jobs = []
            compute_syms = []
            for sym, cfg in due:
                if sym in fetch_ok:
                    compute_syms.append(sym)
                    compute_jobs.append(asyncio.to_thread(_compute_tick_binary, sym, cfg, fetch_ok[sym]))

            if not compute_jobs:
                log("[COMPUTE] No data to process this cycle")
                elapsed = time.time() - start_time
                await asyncio.sleep(max(0.1, 60.0 - elapsed))
                continue

            compute_results = await asyncio.gather(*compute_jobs, return_exceptions=True)

            # ── STAGE 3: Broadcast + Batch write ──
            batch: dict = {}
            broadcast_coros = []

            for sym, result in zip(compute_syms, compute_results):
                if isinstance(result, Exception):
                    log(f"[COMPUTE ERROR] {sym}: {result}")
                    continue
                if result is None:
                    continue
                batch[sym] = result["db_rows"]
                broadcast_coros.append(_finalize_and_broadcast(sym, result))

            # Broadcast all symbols in parallel
            if broadcast_coros:
                await asyncio.gather(*broadcast_coros)

            # Batch write: ALL symbols in ONE transaction
            if batch:
                await write_batch_to_sqlite(batch)

            # Summary log
            fetched = len(fetch_ok)
            failed = len(fetch_fail)
            computed = len(batch)
            if failed > 0:
                log(f"[CYCLE] fetched={fetched} failed={failed} computed={computed} | "
                    f"failed symbols: {list(fetch_fail.keys())}")
            elif computed > 0:
                log(f"[CYCLE] fetched={fetched} computed={computed} OK")

            # Pad cycle
            elapsed = time.time() - start_time
            await asyncio.sleep(max(0.1, 60.0 - elapsed))


# ====================================================================
# SECTION 15: APP LIFECYCLE
# ====================================================================
async def on_startup(app):
    asyncio.create_task(collector_loop(app))
    log(f"\n{'='*52}")
    log(f"  Option Engine v6 (Binary Packet Architecture)")
    log(f"  API:       http://{API_HOST}:{API_PORT}")
    log(f"  WebSocket: ws://{API_HOST}:{API_PORT}/ws")
    log(f"  Schema:    http://{API_HOST}:{API_PORT}/schema")
    log(f"  DB:        {INTERNAL_DB_DIR}")
    log(f"  Range:     {PROCESS_FROM_IDX} to {PROCESS_TO_IDX}")
    log(f"  BYPASS:    {BYPASS_MARKET_HOURS}")
    log(f"  Binary:    {ROW_SIZE}B/row, {HDR_SIZE}B/header")
    log(f"{'='*52}\n")

async def on_shutdown(app):
    log("[SHUTDOWN] Graceful shutdown...")
    await asyncio.to_thread(_close_database_sync, "SHUTDOWN")
    log("[SHUTDOWN] Done.")

# ====================================================================
# SECTION 15.5: CORS MIDDLEWARE (standalone HTML support)
# ====================================================================
@web.middleware
async def cors_middleware(request, handler):
    """Allow cross-origin requests so standalone file:// HTML can fetch /schema etc."""
    if request.method == "OPTIONS":
        resp = web.Response(status=204)
    else:
        resp = await handler(request)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


async def create_app():
    app = web.Application(middlewares=[cors_middleware])
    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)

    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/schema", handle_schema)
    app.router.add_get("/api/latest/{symbol}", handle_latest)
    app.router.add_get("/api/health", handle_health)
    app.router.add_post("/query", handle_db_query)

    return app


# ====================================================================
# SECTION 16: SIGNAL HANDLERS + MAIN
# ====================================================================
def emergency_cleanup(signum, frame):
    global DB_CONN
    log(f"\n[SIGNAL] {signal.Signals(signum).name} received")
    with DB_LOCK:
        conn = DB_CONN
        DB_CONN = None
    if conn:
        try:
            conn.execute("PRAGMA optimize")
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except Exception:
            pass
        try:
            conn.close()
        except Exception:
            pass
    log("[SIGNAL] Cleanup done. Exiting.")
    os._exit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, emergency_cleanup)
    signal.signal(signal.SIGINT,  emergency_cleanup)

    app = asyncio.run(create_app())

    try:
        web.run_app(app, host=API_HOST, port=API_PORT, print=None)
    except (KeyboardInterrupt, SystemExit):
        log("\n[EXIT] Stopped.")
