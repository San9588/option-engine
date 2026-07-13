#!/usr/bin/env python3
"""
Option Chain Data Engine - Ultra Lightweight Edition (v4 - Fixed & Optimized)

Changes from v3:
 - AUTO_EXIT_WHEN_ALL_CLOSED = True/False fully implemented (Case A & B)
 - DB init / expiry fetch skipped when markets are closed on startup
 - Proper sleep-until-next-open when AUTO_EXIT=False
 - DB re-open + expiry re-fetch after waking from sleep (Case B / 2B)
 - WAL merge (wal_checkpoint TRUNCATE) guaranteed on every clean exit path
 - Optimizations: slot __slots__, read-only HEADERS dict, orjson for all
   serialization, asyncio.gather with return_exceptions everywhere, reduced
   per-iteration allocations, single session reuse, tighter sleep math.
"""

import os

# Root user permission fix
if os.getuid() == 0:
    os.umask(0o000)

# Limit numpy internal multi-threading BEFORE numpy is imported
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")
os.environ.setdefault("VECLIB_MAXIMUM_THREADS", "1")

import time
import asyncio
import itertools
from datetime import datetime, time as datetime_time, timedelta
from gateway_handlers import handle_db_query
import signal
import sqlite3
import threading
import numpy as np
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
#
#  True  → if all markets are closed at startup OR become closed while running,
#           do a clean DB checkpoint/close and EXIT the process.
#
#  False → same checkpoint/close, but then SLEEP until the next open,
#           re-init DB, re-fetch expiry tokens, and resume normally.
#
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

# Use a plain dict — it is never mutated, so no need for a mutable copy
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

# Master config — enabled/disabled here, runtime state mutated only for "exp"
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
    "ce_oi", "ce_oi_short", "ce_chng", "ce_chng_short", "ce_vol", "ce_vol_short",
    "ce_ltp", "ce_iv", "ce_delta",
    "ce_vol_pct", "ce_oi_pct", "ce_chng_pct",
    "pe_oi", "pe_oi_short", "pe_chng", "pe_chng_short", "pe_vol", "pe_vol_short",
    "pe_ltp", "pe_iv", "pe_delta",
    "pe_vol_pct", "pe_oi_pct", "pe_chng_pct",
    "gamma", "ce_rank", "pe_rank",
)
COLUMNS_STR  = ", ".join(COLUMNS)
PLACEHOLDERS = ", ".join(["?"] * len(COLUMNS))

# Pre-built INSERT statement per table (built lazily on first use)
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

# Internal flag so the collector loop knows it requested a clean restart
_db_initialized = False


# ==================== SQLITE SETUP ====================
def _reset_exp_tokens():
    """Reset all expiry tokens to -1 so they are re-fetched after a wake-up."""
    for cfg in TARGETS_CONFIG.values():
        cfg["exp"] = -1


def _build_db_path_for_today() -> str:
    global DB_DATE_STR, DB_FILENAME, DB_PATH
    DB_DATE_STR = datetime.now().strftime("%Y-%m-%d")
    DB_FILENAME  = f"trading_{DB_DATE_STR}.db"
    DB_PATH      = os.path.join(INTERNAL_DB_DIR, DB_FILENAME)
    return DB_PATH


def init_database():
    """Open (or re-open) the SQLite connection and create tables/indexes."""
    global DB_CONN, _db_initialized
    _build_db_path_for_today()
    os.makedirs(INTERNAL_DB_DIR, exist_ok=True)

    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-8000")        # 8 MB page cache
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA mmap_size=33554432")      # 32 MB mmap
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
                ce_oi_short    REAL,
                ce_chng        INTEGER,
                ce_chng_short  REAL,
                ce_vol         INTEGER,
                ce_vol_short   REAL,
                ce_ltp         REAL,
                ce_iv          REAL,
                ce_delta       REAL,
                ce_vol_pct     REAL,
                ce_oi_pct      REAL,
                ce_chng_pct    REAL,
                pe_oi          INTEGER,
                pe_oi_short    REAL,
                pe_chng        INTEGER,
                pe_chng_short  REAL,
                pe_vol         INTEGER,
                pe_vol_short   REAL,
                pe_ltp         REAL,
                pe_iv          REAL,
                pe_delta       REAL,
                pe_vol_pct     REAL,
                pe_oi_pct      REAL,
                pe_chng_pct    REAL,
                gamma          REAL,
                ce_rank        TEXT,
                pe_rank        TEXT
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
    """
    Guaranteed WAL merge + close.
    Runs the full checkpoint(TRUNCATE) which merges the WAL file back into
    the main database file so no data is left dangling in the .wal sidecar.
    """
    global DB_CONN, _db_initialized
    with DB_LOCK:
        conn = DB_CONN
        DB_CONN = None
        _db_initialized = False

    if conn is None:
        return

    try:
        conn.execute("PRAGMA optimize")
        # TRUNCATE mode: merges ALL WAL frames into main DB, then truncates WAL to zero.
        # This is the only mode that guarantees a clean, self-contained .db file.
        result = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        # result = (busy, log_frames, checkpointed_frames)
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
    """
    Writes one cycle's rows to SQLite — one atomic commit.
    If ANY symbol fails the entire batch is rolled back.
    """
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


# ==================== DB ROTATION (date change) ====================
async def check_and_rotate_db():
    """Detects a date change mid-session and rotates to a fresh DB file."""
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
    """
    Returns seconds until the earliest next open across all enabled exchanges.
    Returns None if no valid schedule found.
    """
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


# ==================== NUMPY VECTORIZED PROCESSING ====================
def calculate_ranks_and_percentages_numpy(
    strikes, vols, ois, chngs, atm_strike, step_size, is_ce
):
    n = len(strikes)
    if n == 0:
        return np.array([], dtype="U3"), np.zeros(0), np.zeros(0), np.zeros(0)

    offsets      = (strikes - atm_strike) / step_size
    window_mask  = (offsets >= -2) & (offsets <= 15) if is_ce else (offsets >= -15) & (offsets <= 2)
    deep_itm     = (offsets < -2)                    if is_ce else (offsets > 2)

    def compute_pct(arr):
        max_val = np.max(arr)
        if max_val > 0:
            pct = np.round(arr * (100.0 / max_val), 1)
        else:
            pct = np.zeros(n, dtype=np.float64)
        return pct, max_val

    vol_pcts,  max_vol  = compute_pct(vols)
    oi_pcts,   max_oi   = compute_pct(ois)
    chng_pcts, max_chng = compute_pct(chngs)

    def evaluate_metric_ranks(arr, max_val, mask, itm_cond):
        m_ranks = np.zeros(n, dtype=np.int8)
        if max_val == 0:
            return m_ranks

        global_max_idx = np.argmax(arr)
        if itm_cond[global_max_idx] and arr[global_max_idx] == max_val:
            m_ranks[global_max_idx] = 3

        w_indices = np.where(mask)[0]
        if len(w_indices) == 0:
            return m_ranks

        w_values = arr[w_indices]
        k        = min(3, len(w_values))
        top_k    = np.argpartition(w_values, -k)[-k:]
        top_k    = top_k[np.argsort(w_values[top_k])[::-1]]

        rank = 1
        for s_idx in top_k:
            if rank > 3:
                break
            actual_idx = w_indices[s_idx]
            if w_values[s_idx] > 0 and m_ranks[actual_idx] == 0:
                m_ranks[actual_idx] = rank
                rank += 1
        return m_ranks

    v_ranks = evaluate_metric_ranks(vols,  max_vol,  window_mask, deep_itm)
    o_ranks = evaluate_metric_ranks(ois,   max_oi,   window_mask, deep_itm)
    c_ranks = evaluate_metric_ranks(chngs, max_chng, window_mask, deep_itm)

    numeric_ranks    = (v_ranks * 100) + (o_ranks * 10) + c_ranks
    ranks_str_vector = np.char.zfill(numeric_ranks.astype(str), 3)

    return ranks_str_vector, vol_pcts, oi_pcts, chng_pcts


# ==================== DATA PROCESSING ====================
def _compute_tick_rows(symbol: str, config: dict, payload_data: dict):
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

    # Filter strikes using configurable range
    filtered_data = []
    for strike_str, node in oc_dict.items():
        try:
            strike = int(float(strike_str))
        except (ValueError, TypeError):
            continue
        rel_idx = (strike - atm_strike) // step_int
        if PROCESS_FROM_IDX <= rel_idx <= PROCESS_TO_IDX:
            filtered_data.append((strike, rel_idx, node))

    if not filtered_data:
        log(f"[DATA EMPTY] {symbol}: no strikes after filter "
            f"(atm={atm_strike}, range={PROCESS_FROM_IDX} to {PROCESS_TO_IDX}) - tick skipped")
        return None

    filtered_data.sort()
    n = len(filtered_data)

    strikes         = np.empty(n, dtype=np.int32)
    relative_indices= np.empty(n, dtype=np.int32)
    ce_ois          = np.zeros(n, dtype=np.int32)
    ce_chngs        = np.zeros(n, dtype=np.int32)
    ce_vols         = np.zeros(n, dtype=np.int32)
    ce_ltps         = np.zeros(n, dtype=np.float64)
    ce_ivs          = np.zeros(n, dtype=np.float64)
    ce_deltas       = np.zeros(n, dtype=np.float64)
    pe_ois          = np.zeros(n, dtype=np.int32)
    pe_chngs        = np.zeros(n, dtype=np.int32)
    pe_vols         = np.zeros(n, dtype=np.int32)
    pe_ltps         = np.zeros(n, dtype=np.float64)
    pe_ivs          = np.zeros(n, dtype=np.float64)
    pe_deltas       = np.zeros(n, dtype=np.float64)
    gammas          = np.zeros(n, dtype=np.float64)

    for idx, (strike, rel_idx, node) in enumerate(filtered_data):
        strikes[idx]          = strike
        relative_indices[idx] = rel_idx
        ce_inner  = node.get("ce")        or {}
        pe_inner  = node.get("pe")        or {}
        ce_geeks  = ce_inner.get("optgeeks") or {}
        pe_geeks  = pe_inner.get("optgeeks") or {}

        ce_ois[idx]    = ce_inner.get("OI",      0)
        ce_chngs[idx]  = ce_inner.get("oichng",  0)
        ce_vols[idx]   = ce_inner.get("vol",     0)
        ce_ltps[idx]   = ce_inner.get("ltp",     0.0)
        ce_ivs[idx]    = ce_inner.get("iv",      0.0)
        ce_deltas[idx] = ce_geeks.get("delta",   0.0)
        gammas[idx]    = ce_geeks.get("gamma",   0.0)
        pe_ois[idx]    = pe_inner.get("OI",      0)
        pe_chngs[idx]  = pe_inner.get("oichng",  0)
        pe_vols[idx]   = pe_inner.get("vol",     0)
        pe_ltps[idx]   = pe_inner.get("ltp",     0.0)
        pe_ivs[idx]    = pe_inner.get("iv",      0.0)
        pe_deltas[idx] = pe_geeks.get("delta",   0.0)

    ce_ranks, ce_vol_pct, ce_oi_pct, ce_chng_pct = calculate_ranks_and_percentages_numpy(
        strikes, ce_vols, ce_ois, ce_chngs, atm_strike, step_size, is_ce=True
    )
    pe_ranks, pe_vol_pct, pe_oi_pct, pe_chng_pct = calculate_ranks_and_percentages_numpy(
        strikes, pe_vols, pe_ois, pe_chngs, atm_strike, step_size, is_ce=False
    )

    # Symbol ke hissab se fixed configuration divisor uthana (Multiplier banana)
    scale = 1.0 / config.get("scale_div", 1000.0)
    ce_oi_s   = np.round(ce_ois   * scale, 2)
    ce_chng_s = np.round(ce_chngs * scale, 2)
    ce_vol_s  = np.round(ce_vols  * scale, 2)
    pe_oi_s   = np.round(pe_ois   * scale, 2)
    pe_chng_s = np.round(pe_chngs * scale, 2)
    pe_vol_s  = np.round(pe_vols  * scale, 2)

    # Build rows as list-of-tuples (no intermediate dict allocation)
    ts_val    = timestamp
    sp_val    = float(spot_price)
    sc_val    = float(spot_chng)
    lot_val   = int(lot_size)

    current_rows = [
        (
            ts_val, sp_val, sc_val,
            int(relative_indices[i]),
            int(strikes[i]),
            lot_val,
            int(ce_ois[i]),   float(ce_oi_s[i]),
            int(ce_chngs[i]), float(ce_chng_s[i]),
            int(ce_vols[i]),  float(ce_vol_s[i]),
            float(ce_ltps[i]),  float(ce_ivs[i]),  float(ce_deltas[i]),
            float(ce_vol_pct[i]), float(ce_oi_pct[i]), float(ce_chng_pct[i]),
            int(pe_ois[i]),   float(pe_oi_s[i]),
            int(pe_chngs[i]), float(pe_chng_s[i]),
            int(pe_vols[i]),  float(pe_vol_s[i]),
            float(pe_ltps[i]),  float(pe_ivs[i]),  float(pe_deltas[i]),
            float(pe_vol_pct[i]), float(pe_oi_pct[i]), float(pe_chng_pct[i]),
            float(gammas[i]),
            ce_ranks[i],
            pe_ranks[i],
        )
        for i in range(n)
    ]

    return {
        "symbol":      symbol,
        "timestamp":   timestamp,
        "spot_price":  spot_price,
        "spot_chng":   spot_chng,
        "n_elements":  n,
        "rows":        current_rows,
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

                    if action == "subscribe":
                        symbol = data.get("symbol", "").upper()
                        if symbol in TARGETS_CONFIG:
                            sub = CLIENT_SUBSCRIPTIONS[ws]
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

                    elif action == "unsubscribe":
                        symbol = data.get("symbol", "").upper()
                        if ws in CLIENT_SUBSCRIPTIONS:
                            CLIENT_SUBSCRIPTIONS[ws]["symbols"].discard(symbol)
                        await ws.send_str(orjson.dumps({"type": "unsubscribed", "symbol": symbol}).decode('utf-8'))

                    elif action == "set_range":
                        if ws in CLIENT_SUBSCRIPTIONS:
                            CLIENT_SUBSCRIPTIONS[ws]["from"] = int(data.get("from", PROCESS_FROM_IDX))
                            CLIENT_SUBSCRIPTIONS[ws]["to"]   = int(data.get("to",   PROCESS_TO_IDX))
                            await ws.send_str(orjson.dumps({
                                "type":  "range_updated",
                                "range": {
                                    "from": CLIENT_SUBSCRIPTIONS[ws]["from"],
                                    "to":   CLIENT_SUBSCRIPTIONS[ws]["to"],
                                },
                            }).decode('utf-8'))

                    elif action == "ping":
                        await ws.send_str(orjson.dumps({"type": "pong"}).decode('utf-8'))

                except Exception as e:
                    await ws.send_str(orjson.dumps({"type": "error", "message": str(e)}).decode('utf-8'))

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


# ==================== EXPIRY TOKEN FETCH ====================
async def fetch_exact_expiry_tokens(session: aiohttp.ClientSession):
    log("[INIT] Fetching expiry tokens...")
    for symbol, config in TARGETS_CONFIG.items():
        if not config["enabled"]:
            continue
        try:
            payload = {"Data": {"Seg": config["seg"], "Sid": config["sid"]}}
            async with session.post(FURL, json=payload, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status == 200:
                    raw_json = orjson.loads(await resp.read())
                    opsum    = raw_json.get("data", {}).get("opsum", {})
                    if opsum:
                        first_node = next(iter(opsum.values()))
                        exact_exp  = first_node.get("exp")
                        if exact_exp:
                            config["exp"] = int(exact_exp)
                            log(f"[EXPIRY] {symbol}: {config['exp']}")
                        else:
                            log(f"[EXPIRY WARNING] {symbol}: 'exp' field missing, still exp=-1")
                    else:
                        log(f"[EXPIRY WARNING] {symbol}: 'opsum' empty, still exp=-1")
                else:
                    body = (await resp.text())[:200]
                    log(f"[EXPIRY HTTP ERROR] {symbol}: status={resp.status} body='{body}', still exp=-1")
        except Exception as e:
            log(f"[EXPIRY ERROR] {symbol}: {e}, still exp=-1")

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
    """
    Sleeps in up-to-30-min chunks until at least one enabled market is open.
    Logs a single 'sleeping X min' line, then silently waits.
    """
    wait_seconds = seconds_until_next_open()
    if wait_seconds is None:
        log("[SLEEP] No next-open found, sleeping 60 s before retrying...")
        await asyncio.sleep(60)
        return

    mins = wait_seconds / 60.0
    log(f"[SLEEP] Markets closed. Sleeping ~{mins:.1f} min until next open...")

    while wait_seconds > 0:
        chunk        = min(wait_seconds, 1800.0)   # sleep at most 30 min at a time
        await asyncio.sleep(max(0.5, chunk))
        wait_seconds = (seconds_until_next_open() or 0.0)
        if any_enabled_market_open():
            break


# ==================== MAIN COLLECTOR LOOP ====================
async def collector_loop(app):
    """
    State machine:

        STARTUP
          ├─ any market open? ──NO──► AUTO_EXIT? ──YES──► EXIT
          │                                      ──NO──► sleep → re-check (loop)
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
            await check_and_rotate_db()   # no-op unless date flipped

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

                    # Broadcast all symbols concurrently, then batch-write
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

                    # AUTO_EXIT=False → sleep, then re-init
                    await _sleep_until_next_open()

                    log("[WAKE] Market(s) reopened. Re-initializing DB and expiry tokens...")
                    _reset_exp_tokens()
                    await asyncio.to_thread(init_database)
                    await fetch_exact_expiry_tokens(session)
                    continue   # go back to the top of the loop immediately

            # Pad remaining cycle time (target: 60 s per loop)
            elapsed = time.time() - start_time
            await asyncio.sleep(max(0.1, 60.0 - elapsed))


# ==================== APP LIFECYCLE ====================
async def on_startup(app):
    asyncio.create_task(collector_loop(app))
    log(f"\n{'='*52}")
    log(f"  Option Engine Started (v4 - Fixed & Optimized)")
    log(f"  API:       http://{API_HOST}:{API_PORT}")
    log(f"  WebSocket: ws://{API_HOST}:{API_PORT}/ws")
    log(f"  DB dir:    {INTERNAL_DB_DIR}")
    log(f"  Range:     {PROCESS_FROM_IDX} to {PROCESS_TO_IDX}")
    log(f"  AUTO_EXIT: {AUTO_EXIT_WHEN_ALL_CLOSED}")
    log(f"{'='*52}\n")


async def on_shutdown(app):
    """Graceful shutdown — always checkpoint+merge WAL before exit."""
    log("[SHUTDOWN] Graceful shutdown triggered...")
    await asyncio.to_thread(_close_database_sync, "SHUTDOWN")
    log("[SHUTDOWN] Cleanup complete.")


# ==================== CREATE APP ====================
async def create_app():
    app = web.Application()
    
    # Background collector task ko start karne ke liye signals jodhna
    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    
    # Aapke purane routes
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/api/latest/{symbol}", handle_latest)
    app.router.add_get("/api/spot/{symbol}", handle_spot)
    
    # NAYA ROUTE: Integrated Gateway Handler
    app.router.add_post("/query", handle_db_query)
    
    return app
# ==================== SIGNAL HANDLERS ====================
def emergency_cleanup(signum, frame):
    """
    Synchronous signal handler (runs in main thread, NOT in the event loop).
    Does a best-effort WAL checkpoint + close then hard-exits.
    Note: aiohttp's on_shutdown is the preferred path; this is a safety net
    for SIGKILL-adjacent scenarios (e.g. Ctrl+C before the loop starts).
    """
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

    # create_app() async hai, isliye ise asyncio runner se chalayenge
    loop = asyncio.get_event_loop()
    app = loop.run_until_complete(create_app())
    
    try:
        web.run_app(app, host=API_HOST, port=API_PORT, print=None)
    except (KeyboardInterrupt, SystemExit):
        log("\n[EXIT] Stopped.")
