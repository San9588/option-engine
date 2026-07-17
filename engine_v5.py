#!/usr/bin/env python3
"""
Option Chain Data Engine - v5 (Zero-Numpy, Loop-Minimized, Bug-Fixed)

Changes from v4:
 - CRITICAL FIX: ce_vols/pe_vols were NEVER populated from API data (always 0)
 - CRITICAL FIX: ce_vols/pe_vols unsigned conversion was INSIDE the for-loop
   (entire array reprocessed on every iteration, corrupting data)
 - REMOVED: itertools (imported but never used)
 - REMOVED: numpy dependency (~30MB). For ~60 element arrays, pure Python math
   is comparable/faster — numpy's function dispatch overhead exceeds any
   vectorization benefit at this scale.
 - ADDED: math (stdlib, replaces numpy's log10/floor/clip)
 - OPTIMIZED: _compute_tick_rows — single-pass extraction, no intermediate
   numpy arrays, no element-by-element numpy fill loop
 - OPTIMIZED: fetch_exact_expiry_tokens — parallel with asyncio.gather
   (was sequential, 4× slower)
 - OPTIMIZED: calculate_ranks_and_percentages — pure Python with sorted(),
   no numpy argpartition overhead
 - OPTIMIZED: _pack_meta_row — plain Python int bitwise ops (no numpy)
 - OPTIMIZED: magnitude unit computation — per-element math.log10 in
   list comprehension (no numpy array overhead)
 - MERGED: gateway_handlers.py into engine.py (eliminates fragile
   sys.modules['__main__'] hack, direct global access)
 - CLEANUP: ws_handler if-elif → dispatch dict pattern
"""

import os

# Root user permission fix
if os.getuid() == 0:
    os.umask(0o000)

import time
import math
import asyncio
from datetime import datetime, time as datetime_time, timedelta
import signal
import sqlite3
import threading
import orjson
import aiohttp
from aiohttp import web


# ==================== Timestamp Custom Logger ====================
def log(msg: str):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]}] {msg}", flush=True)


# --- DYNAMIC UVLOOP FALLBACK ---
try:
    import uvloop
    uvloop.install()
    log("[INIT] uvloop activated - 2-4x faster async!")
except ImportError:
    log("[INIT] uvloop not found, using default asyncio")


# ==================== CONTROLLER SWITCHES ====================
ENABLE_NIFTY      = True
ENABLE_BANKNIFTY  = False
ENABLE_BSE        = False
ENABLE_CRUDEOIL   = True

# ==================== RELATIVE INDEX WINDOW CONFIG ====================
PROCESS_FROM_IDX = -30
PROCESS_TO_IDX   =  30

# ==================== MARKET TIMINGS (IST) ====================
NSE_OPEN_TIME    = datetime_time(9, 15)
NSE_CLOSE_TIME   = datetime_time(15, 30)
NSE_TRADING_DAYS = {0, 1, 2, 3, 4}

BSE_OPEN_TIME    = datetime_time(9, 15)
BSE_CLOSE_TIME   = datetime_time(15, 30)
BSE_TRADING_DAYS = {0, 1, 2, 3, 4}

MCX_OPEN_TIME    = datetime_time(9, 0)
MCX_CLOSE_TIME   = datetime_time(23, 30)
MCX_TRADING_DAYS = {0, 1, 2, 3, 4}

# ==================== BEHAVIOR SWITCH ====================
AUTO_EXIT_WHEN_ALL_CLOSED = False

# ==================== SERVER CONFIG ====================
API_HOST = os.environ.get("apihost", "127.0.0.1")
API_PORT = int(os.environ.get("apiport", 8788))

# ==================== SQLITE CONFIG ====================
INTERNAL_DB_DIR = os.environ.get(
    "dbpath_internal",
    os.path.join(os.environ.get("HOME", "/root"), "trading-data")
)

DB_DATE_STR = datetime.now().strftime("%Y-%m-%d")
DB_FILENAME  = f"trading_{DB_DATE_STR}.db"
DB_PATH      = os.path.join(INTERNAL_DB_DIR, DB_FILENAME)

# ==================== REQUEST CONFIG ====================
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

# Master config
TARGETS_CONFIG: dict = {
    "NIFTY":      {"enabled": ENABLE_NIFTY,      "exchange": "NSE", "seg": 0, "sid": 13,     "step": 50.0,  "ftime": 1, "exp": -1, "scale_div": 1000.0},
    "BANKNIFTY":  {"enabled": ENABLE_BANKNIFTY,  "exchange": "NSE", "seg": 0, "sid": 25,     "step": 100.0, "ftime": 1, "exp": -1, "scale_div": 1000.0},
    "SENSEX":     {"enabled": ENABLE_BSE,        "exchange": "BSE", "seg": 1, "sid": 1,      "step": 100.0, "ftime": 1, "exp": -1, "scale_div": 1000.0},
    "CRUDEOIL":   {"enabled": ENABLE_CRUDEOIL,   "exchange": "MCX", "seg": 5, "sid": 520702, "step": 50.0,  "ftime": 3, "exp": -1, "scale_div": 100.0},
}

NEXT_FETCH_TIME: dict = {symbol: 0.0 for symbol in TARGETS_CONFIG}

# ==================== COLUMN DEFINITIONS ====================
COLUMNS = (
    "timestamp", "spot_price", "spot_chng", "relative_idx", "strike", "lot_size",
    "ce_oi", "ce_chng", "ce_vol",
    "ce_ltp", "ce_iv", "ce_delta",
    "ce_vol_pct", "ce_oi_pct", "ce_chng_pct",
    "pe_oi", "pe_chng", "pe_vol",
    "pe_ltp", "pe_iv", "pe_delta",
    "pe_vol_pct", "pe_oi_pct", "pe_chng_pct",
    "gamma", "meta_pack",
)
COLUMNS_STR  = ", ".join(COLUMNS)
PLACEHOLDERS = ", ".join(["?"] * len(COLUMNS))

_INSERT_SQL: dict[str, str] = {}

def _insert_sql(symbol: str) -> str:
    if symbol not in _INSERT_SQL:
        table = f"{symbol.lower()}_option_chain"
        _INSERT_SQL[symbol] = f"INSERT INTO {table} ({COLUMNS_STR}) VALUES ({PLACEHOLDERS})"
    return _INSERT_SQL[symbol]


# ==================== GLOBAL STATE ====================
LATEST_TICKS: dict         = {}
CLIENT_SUBSCRIPTIONS: dict = {}
DB_CONN: sqlite3.Connection | None = None
DB_LOCK = threading.Lock()

last_batch_time = time.time()
last_batch_rows = 0
_db_initialized = False


# ==================== SQLITE SETUP ====================
def _reset_exp_tokens():
    for cfg in TARGETS_CONFIG.values():
        cfg["exp"] = -1


def _build_db_path_for_today() -> str:
    global DB_DATE_STR, DB_FILENAME, DB_PATH
    DB_DATE_STR = datetime.now().strftime("%Y-%m-%d")
    DB_FILENAME  = f"trading_{DB_DATE_STR}.db"
    DB_PATH      = os.path.join(INTERNAL_DB_DIR, DB_FILENAME)
    return DB_PATH


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

    for symbol in TARGETS_CONFIG:
        table = f"{symbol.lower()}_option_chain"
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS {table} (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp      TEXT    NOT NULL,
                spot_price     REAL,
                spot_chng      REAL,
                relative_idx   INTEGER,
                strike         INTEGER,
                lot_size       INTEGER,
                ce_oi          INTEGER,
                ce_chng        INTEGER,
                ce_vol         REAL,
                ce_ltp         REAL,
                ce_iv          REAL,
                ce_delta       REAL,
                ce_vol_pct     REAL,
                ce_oi_pct      REAL,
                ce_chng_pct    REAL,
                pe_oi          INTEGER,
                pe_chng        INTEGER,
                pe_vol         REAL,
                pe_ltp         REAL,
                pe_iv          REAL,
                pe_delta       REAL,
                pe_vol_pct     REAL,
                pe_oi_pct      REAL,
                pe_chng_pct    REAL,
                gamma          REAL,
                meta_pack      INTEGER
            )
        """)
        conn.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{symbol.lower()}_ts_rel "
            f"ON {table} (timestamp, relative_idx)"
        )

    conn.commit()

    with DB_LOCK:
        DB_CONN = conn

    _db_initialized = True
    log(f"[DB] SQLite initialized: {DB_PATH} "
        f"(WAL | Sync:NORMAL | Range:{PROCESS_FROM_IDX} to {PROCESS_TO_IDX})")


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
        log(f"[{reason}] WAL checkpoint(TRUNCATE): busy={result[0]}, "
            f"log={result[1]}, checkpointed={result[2]}")
    except Exception as e:
        log(f"[{reason}] WAL checkpoint error: {e}")

    try:
        conn.close()
        log(f"[{reason}] DB connection closed cleanly")
    except Exception as e:
        log(f"[{reason}] DB close error: {e}")


# ==================== BATCH WRITE ====================
def _write_batch_sync(batch: dict, tag: str = "BATCH") -> int:
    global last_batch_time, last_batch_rows
    if not DB_CONN:
        log(f"[{tag}] Skipped - DB_CONN not initialized")
        return 0

    total = 0
    with DB_LOCK:
        try:
            DB_CONN.execute("BEGIN")
            for symbol, rows in batch.items():
                if not rows:
                    continue
                DB_CONN.executemany(_insert_sql(symbol), rows)
                total += len(rows)
            DB_CONN.execute("COMMIT")
        except Exception as e:
            log(f"[{tag} ERROR] Rolling back entire batch: {e}")
            try:
                DB_CONN.execute("ROLLBACK")
            except Exception as rb_err:
                log(f"[{tag} ROLLBACK ERROR] {rb_err}")
            total = 0

    last_batch_time = time.time()
    last_batch_rows = total
    if total > 0:
        log(f"[{tag}] {total} rows committed across {len(batch)} symbol(s)")
    return total


async def write_batch_to_sqlite(batch: dict) -> int:
    return await asyncio.to_thread(_write_batch_sync, batch, "BATCH")


# ==================== DB ROTATION ====================
async def check_and_rotate_db():
    global DB_DATE_STR
    current_date_str = datetime.now().strftime("%Y-%m-%d")
    if current_date_str == DB_DATE_STR:
        return

    log(f"[DB ROTATE] Date changed {DB_DATE_STR} → {current_date_str}. Rotating...")
    await asyncio.to_thread(_close_database_sync, "DB ROTATE")
    await asyncio.to_thread(init_database)
    log(f"[DB ROTATE] New database active: {DB_PATH}")


# ==================== MARKET TIME HELPERS ====================
def _exchange_schedule(exchange: str):
    if exchange == "NSE":
        return NSE_OPEN_TIME, NSE_CLOSE_TIME, NSE_TRADING_DAYS
    if exchange == "BSE":
        return BSE_OPEN_TIME, BSE_CLOSE_TIME, BSE_TRADING_DAYS
    if exchange == "MCX":
        return MCX_OPEN_TIME, MCX_CLOSE_TIME, MCX_TRADING_DAYS
    return None, None, set()


def is_market_open(exchange: str) -> bool:
    now = datetime.now()
    open_t, close_t, trading_days = _exchange_schedule(exchange)
    if open_t is None:
        return False
    return now.weekday() in trading_days and open_t <= now.time() <= close_t


def any_enabled_market_open() -> bool:
    return any(
        cfg["enabled"] and is_market_open(cfg["exchange"])
        for cfg in TARGETS_CONFIG.values()
    )


def seconds_until_next_open() -> float | None:
    now = datetime.now()
    exchanges_needed = {
        cfg["exchange"]
        for cfg in TARGETS_CONFIG.values()
        if cfg["enabled"]
    }
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

    next_open = min(candidates)
    return max(0.0, (next_open - now).total_seconds())


# ==================== DRIFT-FREE SCHEDULING ====================
def next_aligned_time(ftime_minutes: int) -> float:
    now      = time.time()
    interval = ftime_minutes * 60.0
    return now + (interval - (now % interval))


# ==================== COMPACT META PACKING (pure Python) ====================
UNIT_SUFFIX = ("", "K", "M", "B")  # index = unit_code


def _magnitude_unit(value: float) -> int:
    """
    Returns unit_code (0="", 1="K", 2="M", 3="B") for a single value.
    Pure Python — no numpy overhead for ~60 element arrays.
    """
    abs_val = abs(value)
    if abs_val < 1000:
        return 0
    # log10 range: 3-6 → K(1), 6-9 → M(2), 9+ → B(3)
    power = min(int(math.log10(abs_val) // 3) * 3, 9)
    return power // 3


def _pack_meta_row(ce_oi_u, ce_chng_u, ce_vol_u, pe_oi_u, pe_chng_u, pe_vol_u,
                   ce_v_rank, ce_o_rank, ce_c_rank, pe_v_rank, pe_o_rank, pe_c_rank) -> int:
    """
    Bit-pack 6 unit-codes (2 bits each) + 6 sub-ranks (2 bits each) into one int32.
    Pure Python int bitwise ops — no numpy needed.
    """
    return (
        ce_oi_u | (ce_chng_u << 2) | (ce_vol_u << 4)
        | (pe_oi_u << 6) | (pe_chng_u << 8) | (pe_vol_u << 10)
        | (ce_v_rank << 12) | (ce_o_rank << 14) | (ce_c_rank << 16)
        | (pe_v_rank << 18) | (pe_o_rank << 20) | (pe_c_rank << 22)
    )


def _unpack_meta(pack: int) -> dict:
    """Reverse of _pack_meta_row — used at query/frontend time."""
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
    """Reconstructs K/M/B display string from raw value + unit_code."""
    mantissa = round(raw / (1000.0 ** unit_code), 2)
    return f"{mantissa}{UNIT_SUFFIX[unit_code]}"


# ==================== RANKS & PERCENTAGES (pure Python) ====================
def calculate_ranks_and_percentages(
    strikes, vols, ois, chngs, atm_strike, step_size, is_ce
):
    """
    Pure Python replacement for calculate_ranks_and_percentages_numpy.
    For ~60 element arrays, sorted() + list comprehensions are faster
    than numpy's function dispatch overhead.
    """
    n = len(strikes)
    if n == 0:
        empty = []
        return empty, empty, empty, empty, empty, empty

    # Compute offsets and masks as list comprehensions (no loop)
    offsets = [(s - atm_strike) / step_size for s in strikes]
    if is_ce:
        window_mask = [-2 <= o <= 15 for o in offsets]
        deep_itm = [o < -2 for o in offsets]
    else:
        window_mask = [-15 <= o <= 2 for o in offsets]
        deep_itm = [o > 2 for o in offsets]

    # Percentages — list comprehension (no loop)
    def compute_pct(arr):
        max_val = max(arr) if arr else 0
        if max_val <= 0:
            return [0.0] * n, max_val
        inv = 100.0 / max_val
        return [round(v * inv, 1) for v in arr], max_val

    vol_pcts, max_vol = compute_pct(vols)
    oi_pcts, max_oi = compute_pct(ois)
    chng_pcts, max_chng = compute_pct(chngs)

    # Ranks — sorted() replaces numpy argpartition + argsort (cleaner, same perf for n≤60)
    def compute_ranks(arr, max_val, mask, itm):
        ranks = [0] * n
        if max_val == 0:
            return ranks

        # Global max with deep ITM → rank 3
        global_max_idx = arr.index(max_val)
        if itm[global_max_idx]:
            ranks[global_max_idx] = 3

        # Top 3 in window — sorted descending, assign ranks 1, 2, 3
        # Filter: in window + value > 0 + not already ranked
        window_items = [
            (i, arr[i]) for i in range(n) if mask[i] and arr[i] > 0
        ]
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


# ==================== DATA PROCESSING ====================
def _compute_tick_rows(symbol: str, config: dict, payload_data: dict):
    """
    Single-pass data extraction — no numpy arrays, no element-by-element fill loop.

    v4 BUGS FIXED:
    1. ce_vols/pe_vols are now populated from API data (were never set)
    2. Unsigned conversion is done per-element at extraction time (was inside loop,
       reprocessing entire array on every iteration)
    """
    oc_dict = payload_data.get("oc", {})
    if not oc_dict:
        log(f"[DATA EMPTY] {symbol}: 'oc' missing/empty - tick skipped")
        return None

    if symbol == "CRUDEOIL":
        fl_dict = payload_data.get("fl", {})
        if not fl_dict:
            log(f"[DATA EMPTY] {symbol}: 'fl' missing/empty - tick skipped")
            return None
        first_fut_key = next(iter(fl_dict))
        spot_price = float(fl_dict[first_fut_key].get("ltp", 0.0))
    else:
        spot_price = float(payload_data.get("sltp", 0.0))

    if spot_price <= 0:
        log(f"[DATA INVALID] {symbol}: spot_price <= 0 ({spot_price}) - tick skipped")
        return None

    spot_chng  = float(payload_data.get("SChng", 0.0))
    step_size  = config["step"]
    step_int   = int(step_size)
    lot_size   = int(payload_data.get("olot", 0))
    atm_strike = int(round(spot_price / step_size) * step_size)
    timestamp  = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # ── SINGLE-PASS: filter + extract all data into tuple list ──
    # No numpy arrays, no separate fill loop. Everything in one pass.
    raw = []  # list of (strike, rel_idx, ce_tuple, pe_tuple, gamma)
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

        # FIX BUG #1: Actually extract volume from API data
        # FIX BUG #2: Unsigned conversion + division done ONCE per element,
        # not on entire array inside loop
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
        log(f"[DATA EMPTY] {symbol}: no strikes after filter "
            f"(atm={atm_strike}, range={PROCESS_FROM_IDX} to {PROCESS_TO_IDX}) - tick skipped")
        return None

    raw.sort()  # sort by strike (first element of tuple)
    n = len(raw)

    # ── UNZIP: transpose tuple list → parallel lists ──
    # zip(*raw) is O(n) and creates tuples that support indexing — no list conversion needed
    (strikes, rel_indices,
     ce_ois, ce_chngs, ce_vols,
     ce_ltps, ce_ivs, ce_deltas,
     pe_ois, pe_chngs, pe_vols,
     pe_ltps, pe_ivs, pe_deltas,
     gammas) = zip(*raw)

    # ── RANKS & PERCENTAGES ──
    ce_v_rank, ce_o_rank, ce_c_rank, ce_vol_pct, ce_oi_pct, ce_chng_pct = \
        calculate_ranks_and_percentages(strikes, ce_vols, ce_ois, ce_chngs, atm_strike, step_size, is_ce=True)
    pe_v_rank, pe_o_rank, pe_c_rank, pe_vol_pct, pe_oi_pct, pe_chng_pct = \
        calculate_ranks_and_percentages(strikes, pe_vols, pe_ois, pe_chngs, atm_strike, step_size, is_ce=False)

    # ── MAGNITUDE UNITS (pure Python, list comprehension — no numpy) ──
    ce_oi_u   = [_magnitude_unit(v) for v in ce_ois]
    ce_chng_u = [_magnitude_unit(v) for v in ce_chngs]
    ce_vol_u  = [_magnitude_unit(v) for v in ce_vols]
    pe_oi_u   = [_magnitude_unit(v) for v in pe_ois]
    pe_chng_u = [_magnitude_unit(v) for v in pe_chngs]
    pe_vol_u  = [_magnitude_unit(v) for v in pe_vols]

    # ── BUILD ROWS (single list comprehension — no numpy indexing) ──
    ts_val  = timestamp
    sp_val  = float(spot_price)
    sc_val  = float(spot_chng)
    lot_val = int(lot_size)

    rows = [
        (
            ts_val, sp_val, sc_val,
            rel_indices[i], strikes[i], lot_val,
            ce_ois[i], ce_chngs[i], ce_vols[i],
            ce_ltps[i], ce_ivs[i], ce_deltas[i],
            ce_vol_pct[i], ce_oi_pct[i], ce_chng_pct[i],
            pe_ois[i], pe_chngs[i], pe_vols[i],
            pe_ltps[i], pe_ivs[i], pe_deltas[i],
            pe_vol_pct[i], pe_oi_pct[i], pe_chng_pct[i],
            gammas[i],
            _pack_meta_row(
                ce_oi_u[i], ce_chng_u[i], ce_vol_u[i],
                pe_oi_u[i], pe_chng_u[i], pe_vol_u[i],
                ce_v_rank[i], ce_o_rank[i], ce_c_rank[i],
                pe_v_rank[i], pe_o_rank[i], pe_c_rank[i],
            ),
        )
        for i in range(n)
    ]

    return {
        "symbol":      symbol,
        "timestamp":   timestamp,
        "spot_price":  spot_price,
        "spot_chng":   spot_chng,
        "n_elements":  n,
        "rows":        rows,
    }


# ==================== WEBSOCKET MANAGER ====================
async def ws_broadcast(symbol: str, tick_data: dict):
    if not CLIENT_SUBSCRIPTIONS:
        return

    range_cache: dict[tuple, bytes] = {}
    dead_clients = []

    for ws, sub in list(CLIENT_SUBSCRIPTIONS.items()):
        if symbol not in sub.get("symbols", set()):
            continue

        from_idx  = sub.get("from", PROCESS_FROM_IDX)
        to_idx    = sub.get("to",   PROCESS_TO_IDX)
        range_key = (from_idx, to_idx)

        if range_key not in range_cache:
            filtered = [r for r in tick_data["data"] if from_idx <= r[3] <= to_idx]
            packet   = {
                "type":       "tick",
                "symbol":     symbol,
                "timestamp":  tick_data["timestamp"],
                "spot":       tick_data["spot"],
                "spot_chng":  tick_data["spot_chng"],
                "data":       filtered,
            }
            range_cache[range_key] = orjson.dumps(packet, option=orjson.OPT_SERIALIZE_NUMPY)

        try:
            await ws.send_str(range_cache[range_key].decode('utf-8'))
        except Exception:
            dead_clients.append(ws)

    for ws in dead_clients:
        CLIENT_SUBSCRIPTIONS.pop(ws, None)
        log(f"[WS] Dead client removed. Remaining: {len(CLIENT_SUBSCRIPTIONS)}")


# ── WS Action Handlers (dispatch dict pattern) ──
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
        "type":   "subscribed",
        "symbol": symbol,
        "range":  {"from": sub["from"], "to": sub["to"]},
    }).decode('utf-8'))

    latest = LATEST_TICKS.get(symbol)
    if latest:
        filtered = [
            r for r in latest["data"]
            if sub["from"] <= r[3] <= sub["to"]
        ]
        await ws.send_str(orjson.dumps({
            "type":      "tick",
            "symbol":    symbol,
            "timestamp": latest["timestamp"],
            "spot":      latest["spot"],
            "spot_chng": latest["spot_chng"],
            "data":      filtered,
        }, option=orjson.OPT_SERIALIZE_NUMPY).decode('utf-8'))


async def _ws_unsubscribe(ws, data, sub):
    symbol = data.get("symbol", "").upper()
    sub["symbols"].discard(symbol)
    await ws.send_str(orjson.dumps({
        "type": "unsubscribed", "symbol": symbol
    }).decode('utf-8'))


async def _ws_set_range(ws, data, sub):
    sub["from"] = int(data.get("from", PROCESS_FROM_IDX))
    sub["to"]   = int(data.get("to",   PROCESS_TO_IDX))
    await ws.send_str(orjson.dumps({
        "type":  "range_updated",
        "range": {"from": sub["from"], "to": sub["to"]},
    }).decode('utf-8'))


async def _ws_ping(ws, data, sub):
    await ws.send_str(orjson.dumps({"type": "pong"}).decode('utf-8'))


# Dispatch table — replaces if-elif chain
_WS_ACTIONS = {
    "subscribe":   _ws_subscribe,
    "unsubscribe": _ws_unsubscribe,
    "set_range":   _ws_set_range,
    "ping":        _ws_ping,
}


async def ws_handler(request):
    ws = web.WebSocketResponse()
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
                        await ws.send_str(orjson.dumps({
                            "type": "error", "message": f"Unknown action: {action}"
                        }).decode('utf-8'))

                except Exception as e:
                    await ws.send_str(orjson.dumps({
                        "type": "error", "message": str(e)
                    }).decode('utf-8'))

            elif msg.type == aiohttp.WSMsgType.ERROR:
                break
    finally:
        CLIENT_SUBSCRIPTIONS.pop(ws, None)
        log(f"[WS] Client disconnected. Total: {len(CLIENT_SUBSCRIPTIONS)}")
    return ws


# ==================== REST API HANDLERS ====================
async def handle_health(request):
    return web.Response(
        body=orjson.dumps({
            "status":                  "ok",
            "timestamp":               datetime.now().isoformat(),
            "clients":                 len(CLIENT_SUBSCRIPTIONS),
            "last_batch_rows":         last_batch_rows,
            "seconds_since_last_batch": round(time.time() - last_batch_time, 1),
            "db_path":                 DB_PATH,
            "db_initialized":          _db_initialized,
            "process_range":           {"from": PROCESS_FROM_IDX, "to": PROCESS_TO_IDX},
        }),
        content_type="application/json",
    )


async def handle_spot(request):
    symbol = request.match_info.get("symbol", "").upper()
    if symbol not in TARGETS_CONFIG:
        return web.json_response({"error": "Invalid symbol"}, status=400)
    latest = LATEST_TICKS.get(symbol)
    if not latest:
        return web.json_response({"error": "No data available"}, status=404)
    return web.Response(
        body=orjson.dumps({
            "symbol":    symbol,
            "spot":      latest["spot"],
            "spot_chng": latest["spot_chng"],
            "timestamp": latest["timestamp"],
        }),
        content_type="application/json",
    )


async def handle_latest(request):
    symbol = request.match_info.get("symbol", "").upper()
    if symbol not in TARGETS_CONFIG:
        return web.json_response({"error": "Invalid symbol"}, status=400)
    latest = LATEST_TICKS.get(symbol)
    if not latest:
        return web.json_response({"error": "No data available"}, status=404)
    return web.Response(
        body=orjson.dumps({
            "symbol":    symbol,
            "timestamp": latest["timestamp"],
            "spot":      latest["spot"],
            "spot_chng": latest["spot_chng"],
            "count":     len(latest["data"]),
            "data":      latest["data"],
        }, option=orjson.OPT_SERIALIZE_NUMPY),
        content_type="application/json",
    )


# ==================== INTEGRATED GATEWAY (merged from gateway_handlers.py) ====================
def is_readonly_sql(sql: str) -> bool:
    """
    Safety check: only single SELECT or WITH queries allowed.
    All DML/DDL commands (INSERT, UPDATE, DROP, ALTER) are blocked.
    """
    if not sql:
        return False
    s = sql.strip().lower()
    if ";" in s:
        return False
    return s.startswith("select") or s.startswith("with")


async def handle_db_query(request):
    """
    Integrated Gateway Query Handler — merged into engine.py.
    Directly accesses DB_CONN, DB_LOCK, DB_PATH (no sys.modules hack needed).
    """
    if not DB_CONN or not DB_LOCK:
        log("[GATEWAY ERROR] Database connection or lock not yet initialized")
        return web.json_response(
            {"error": "Database connection or lock not yet initialized"}, status=503
        )

    try:
        body = await request.json(loads=orjson.loads)
        sql_query = (body.get("sql") or "").strip()
        params = body.get("params", [])

        if not is_readonly_sql(sql_query):
            log(f"[GATEWAY BLOCK] Unauthorized query attempt: '{sql_query}'")
            return web.json_response(
                {"error": "Security Block: Only single SELECT or WITH queries are allowed"},
                status=403
            )

        log(f"[GATEWAY REQ] Executing SQL: '{sql_query}' | Params: {params}")

        with DB_LOCK:
            cursor = DB_CONN.execute(sql_query, params)
            columns = [col[0] for col in cursor.description] if cursor.description else []
            rows = cursor.fetchmany(10001)

        truncated = len(rows) > 10000
        if truncated:
            rows = rows[:10000]

        log(f"[GATEWAY SUCCESS] Returned {len(rows)} rows | Truncated: {truncated}")

        return web.Response(
            body=orjson.dumps({
                "db":        DB_PATH,
                "count":     len(rows),
                "truncated": truncated,
                "columns":   columns,
                "rows":      rows,
            }),
            content_type="application/json",
        )
    except orjson.JSONDecodeError:
        log("[GATEWAY ERROR] Invalid JSON format received")
        return web.json_response({"error": "Invalid JSON body format"}, status=400)
    except sqlite3.Error as e:
        log(f"[GATEWAY SQL ERROR] {e}")
        return web.json_response({"error": f"Database execution error: {e}"}, status=400)
    except Exception as e:
        log(f"[GATEWAY INTERNAL ERROR] {str(e)}")
        return web.json_response({"error": f"Internal server error: {str(e)}"}, status=500)


# ==================== FETCH ====================
async def fetch_raw_payload(session: aiohttp.ClientSession, symbol: str, config: dict):
    try:
        payload = {"Data": {"Seg": config["seg"], "Sid": config["sid"], "Exp": config["exp"]}}
        async with session.post(URL, json=payload, timeout=aiohttp.ClientTimeout(total=12)) as resp:
            if resp.status == 200:
                raw = orjson.loads(await resp.read())
                return raw.get("data", {})
            body = (await resp.text())[:200]
            log(f"[HTTP ERROR] {symbol}: status={resp.status} body='{body}'")
            return None
    except Exception as e:
        log(f"[FETCH ERROR] {symbol}: {e}")
        return None


# ==================== EXPIRY TOKEN FETCH (PARALLEL) ====================
async def _fetch_one_expiry(session: aiohttp.ClientSession, symbol: str, config: dict):
    """Fetch expiry token for a single symbol. Returns (symbol, exp) or (symbol, -1)."""
    try:
        payload = {"Data": {"Seg": config["seg"], "Sid": config["sid"]}}
        async with session.post(FURL, json=payload, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status == 200:
                raw_json = orjson.loads(await resp.read())
                opsum = raw_json.get("data", {}).get("opsum", {})
                if opsum:
                    first_node = next(iter(opsum.values()))
                    exact_exp = first_node.get("exp")
                    if exact_exp:
                        return symbol, int(exact_exp)
                log(f"[EXPIRY WARNING] {symbol}: no valid exp found")
            else:
                body = (await resp.text())[:200]
                log(f"[EXPIRY HTTP ERROR] {symbol}: status={resp.status} body='{body}'")
    except Exception as e:
        log(f"[EXPIRY ERROR] {symbol}: {e}")
    return symbol, -1


async def fetch_exact_expiry_tokens(session: aiohttp.ClientSession):
    """
    Fetch all expiry tokens IN PARALLEL using asyncio.gather.
    v4 was sequential (for-loop with await) → 4× slower with 4 symbols.
    """
    log("[INIT] Fetching expiry tokens...")

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

    still_missing = [s for s, c in TARGETS_CONFIG.items() if c["enabled"] and c["exp"] == -1]
    if still_missing:
        log(f"[EXPIRY] WARNING - these symbols will be skipped (no expiry token): {still_missing}")


async def _finalize_and_broadcast(symbol: str, result: dict):
    tick_data = {
        "timestamp": result["timestamp"],
        "spot":      result["spot_price"],
        "spot_chng": result["spot_chng"],
        "data":      result["rows"],
    }
    LATEST_TICKS[symbol] = tick_data
    await ws_broadcast(symbol, tick_data)
    log(f"[TICK] {symbol}: {result['n_elements']} strikes | "
        f"Spot: {result['spot_price']} | Clients: {len(CLIENT_SUBSCRIPTIONS)}")


# ==================== SLEEP HELPER ====================
async def _sleep_until_next_open():
    wait_seconds = seconds_until_next_open()
    if wait_seconds is None:
        log("[SLEEP] No next-open found, sleeping 60 s before retrying...")
        await asyncio.sleep(60)
        return

    mins = wait_seconds / 60.0
    log(f"[SLEEP] Markets closed. Sleeping ~{mins:.1f} min until next open...")

    while wait_seconds > 0:
        chunk        = min(wait_seconds, 1800.0)
        await asyncio.sleep(max(0.5, chunk))
        wait_seconds = (seconds_until_next_open() or 0.0)
        if any_enabled_market_open():
            break


# ==================== MAIN COLLECTOR LOOP ====================
async def collector_loop(app):
    """
    State machine (same as v4, no changes needed):

        STARTUP
          ├─ any market open? ──NO──► AUTO_EXIT? ──YES──► EXIT
          │                                      ──NO──► sleep → re-check
          └─ YES → init DB → fetch expiry → RUNNING LOOP
                                                    │
                                              all closed?
                                                    │
                                              checkpoint + close DB
                                                    │
                                          AUTO_EXIT? ──YES──► EXIT
                                                    └──NO──► sleep → re-init DB
                                                                    → re-fetch expiry
                                                                    → RUNNING LOOP
    """
    async with aiohttp.ClientSession(headers=HEADERS) as session:

        # ── STARTUP PHASE ────────────────────────────────────────────────
        while not any_enabled_market_open():
            if AUTO_EXIT_WHEN_ALL_CLOSED:
                log("[AUTO-EXIT] All markets closed at startup. Exiting cleanly (no DB init).")
                os.kill(os.getpid(), signal.SIGTERM)
                return

            log("[STARTUP] All markets closed. Waiting for next open (no DB init yet)...")
            await _sleep_until_next_open()

        # Markets are open — init DB and fetch expiry tokens
        await asyncio.to_thread(init_database)
        await fetch_exact_expiry_tokens(session)

        # ── RUNNING LOOP ─────────────────────────────────────────────────
        while True:
            start_time = time.time()
            await check_and_rotate_db()

            # Build list of symbols that are due for a fetch
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

            if due:
                # ── STAGE 1: Parallel HTTP fetch ──────────────────────────
                fetch_results = await asyncio.gather(
                    *[fetch_raw_payload(session, sym, cfg) for sym, cfg in due],
                    return_exceptions=True,
                )

                # ── STAGE 2: Parallel CPU compute (thread-pool) ───────────
                compute_syms = []
                compute_jobs = []
                for (sym, cfg), payload in zip(due, fetch_results):
                    if payload is None or isinstance(payload, Exception):
                        if isinstance(payload, Exception):
                            log(f"[FETCH EXCEPTION] {sym}: {payload}")
                        continue
                    compute_syms.append(sym)
                    compute_jobs.append(
                        asyncio.to_thread(_compute_tick_rows, sym, cfg, payload)
                    )

                if compute_jobs:
                    compute_results = await asyncio.gather(
                        *compute_jobs, return_exceptions=True
                    )

                    batch: dict = {}
                    broadcast_coros = []
                    for sym, result in zip(compute_syms, compute_results):
                        if isinstance(result, Exception):
                            log(f"[COMPUTE ERROR] {sym}: {result}")
                            continue
                        if result is None:
                            continue
                        batch[sym] = result["rows"]
                        broadcast_coros.append(_finalize_and_broadcast(sym, result))

                    if broadcast_coros:
                        await asyncio.gather(*broadcast_coros)
                    if batch:
                        await write_batch_to_sqlite(batch)

            else:
                # No symbols were due — check if ALL enabled markets are now closed
                if not any_enabled_market_open():
                    log("[MARKET CLOSED] All enabled markets closed. Checkpointing DB...")
                    await asyncio.to_thread(_close_database_sync, "MARKET CLOSE")

                    if AUTO_EXIT_WHEN_ALL_CLOSED:
                        log("[AUTO-EXIT] Exiting process as AUTO_EXIT_WHEN_ALL_CLOSED=True.")
                        os.kill(os.getpid(), signal.SIGTERM)
                        return

                    await _sleep_until_next_open()

                    log("[WAKE] Market(s) reopened. Re-initializing DB and expiry tokens...")
                    _reset_exp_tokens()
                    await asyncio.to_thread(init_database)
                    await fetch_exact_expiry_tokens(session)
                    continue

            # Pad remaining cycle time
            elapsed = time.time() - start_time
            await asyncio.sleep(max(0.1, 60.0 - elapsed))


# ==================== APP LIFECYCLE ====================
async def on_startup(app):
    asyncio.create_task(collector_loop(app))
    log(f"\n{'='*52}")
    log(f"  Option Engine Started (v5 - Zero-Numpy, Bug-Fixed)")
    log(f"  API:       http://{API_HOST}:{API_PORT}")
    log(f"  WebSocket: ws://{API_HOST}:{API_PORT}/ws")
    log(f"  DB dir:    {INTERNAL_DB_DIR}")
    log(f"  Range:     {PROCESS_FROM_IDX} to {PROCESS_TO_IDX}")
    log(f"  AUTO_EXIT: {AUTO_EXIT_WHEN_ALL_CLOSED}")
    log(f"  Deps:      numpy=REMOVED, itertools=REMOVED, orjson=YES")
    log(f"{'='*52}\n")


async def on_shutdown(app):
    log("[SHUTDOWN] Graceful shutdown triggered...")
    await asyncio.to_thread(_close_database_sync, "SHUTDOWN")
    log("[SHUTDOWN] Cleanup complete.")


# ==================== CREATE APP ====================
async def create_app():
    app = web.Application()

    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)

    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/api/latest/{symbol}", handle_latest)
    app.router.add_get("/api/spot/{symbol}", handle_spot)
    app.router.add_post("/query", handle_db_query)  # Integrated gateway

    return app


# ==================== SIGNAL HANDLERS ====================
def emergency_cleanup(signum, frame):
    global DB_CONN
    log(f"\n[SIGNAL] {signal.Signals(signum).name} received. Emergency cleanup...")
    with DB_LOCK:
        conn    = DB_CONN
        DB_CONN = None

    if conn:
        try:
            conn.execute("PRAGMA optimize")
            result = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
            log(f"[SIGNAL] WAL checkpoint(TRUNCATE): busy={result[0]}, "
                f"log={result[1]}, checkpointed={result[2]}")
        except Exception as e:
            log(f"[SIGNAL] WAL checkpoint error: {e}")
        try:
            conn.close()
            log("[SIGNAL] DB connection closed.")
        except Exception as e:
            log(f"[SIGNAL] DB close error: {e}")

    log("[SIGNAL] Cleanup done. Exiting.")
    os._exit(0)


# ==================== MAIN ====================
if __name__ == "__main__":
    signal.signal(signal.SIGTERM, emergency_cleanup)
    signal.signal(signal.SIGINT,  emergency_cleanup)

    loop = asyncio.get_event_loop()
    app = loop.run_until_complete(create_app())

    try:
        web.run_app(app, host=API_HOST, port=API_PORT, print=None)
    except (KeyboardInterrupt, SystemExit):
        log("\n[EXIT] Stopped.")
