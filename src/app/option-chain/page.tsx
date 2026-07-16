"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Settings, ChevronDown, X, TrendingUp, TrendingDown } from "lucide-react";

// ==================== TYPES ====================
interface OptionRow {
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

interface ColumnConfig {
  id: string;
  label: string;
  shortLabel: string;
  dataKey: keyof OptionRow;
  pctKey?: keyof OptionRow;
  unitKey?: keyof OptionRow; // K/M/B suffix for this cell
  secondaryKey?: keyof OptionRow; // For combined cells like IV+Delta
  rankIndex?: number;
  visible: boolean;
  width: number;
}

type ThemeMode = "light" | "dark";

interface SavedSettings {
  symbol: string;
  reverseOrder: boolean;
  ceColumns: ColumnConfig[];
  peColumns: ColumnConfig[];
  rankColors?: RankColors;
  theme?: ThemeMode;
  decorativeFont?: boolean;
  fontScale?: number;
  fontWeight?: number;
  cellScale?: number;
  strikeRange?: number;
}

const STORAGE_KEY = "option_chain_settings";

// ==================== COLUMN DEFINITIONS ====================
const DEFAULT_CE_COLUMNS: ColumnConfig[] = [
  { id: "ce_iv_delta", label: "IV / Delta", shortLabel: "IV/Δ", dataKey: "ce_iv", secondaryKey: "ce_delta", visible: true, width: 70 },
  { id: "ce_chng", label: "OI Change", shortLabel: "Chng", dataKey: "ce_chng_short", pctKey: "ce_chng_pct", unitKey: "ce_chng_unit", rankIndex: 2, visible: true, width: 80 },
  { id: "ce_oi", label: "Open Interest", shortLabel: "OI", dataKey: "ce_oi_short", pctKey: "ce_oi_pct", unitKey: "ce_oi_unit", rankIndex: 1, visible: true, width: 80 },
  { id: "ce_vol", label: "Volume", shortLabel: "Vol", dataKey: "ce_vol_short", pctKey: "ce_vol_pct", unitKey: "ce_vol_unit", rankIndex: 0, visible: true, width: 80 },
  { id: "ce_ltp", label: "LTP", shortLabel: "LTP", dataKey: "ce_ltp", visible: true, width: 70 },
];

const DEFAULT_PE_COLUMNS: ColumnConfig[] = [
  { id: "pe_ltp", label: "LTP", shortLabel: "LTP", dataKey: "pe_ltp", visible: true, width: 70 },
  { id: "pe_vol", label: "Volume", shortLabel: "Vol", dataKey: "pe_vol_short", pctKey: "pe_vol_pct", unitKey: "pe_vol_unit", rankIndex: 0, visible: true, width: 80 },
  { id: "pe_oi", label: "Open Interest", shortLabel: "OI", dataKey: "pe_oi_short", pctKey: "pe_oi_pct", unitKey: "pe_oi_unit", rankIndex: 1, visible: true, width: 80 },
  { id: "pe_chng", label: "OI Change", shortLabel: "Chng", dataKey: "pe_chng_short", pctKey: "pe_chng_pct", unitKey: "pe_chng_unit", rankIndex: 2, visible: true, width: 80 },
  { id: "pe_iv_delta", label: "IV / Delta", shortLabel: "IV/Δ", dataKey: "pe_iv", secondaryKey: "pe_delta", visible: true, width: 70 },
];

const SYMBOLS = ["NIFTY", "BANKNIFTY", "SENSEX", "CRUDEOIL"];

// ==================== HELPER: Decode meta_pack (mirrors engine.py _pack_meta) ====================
const UNIT_SUFFIX = ["", "K", "M", "B"];

function shortValue(raw: number, unitCode: number): number {
  return Math.round((raw / Math.pow(1000, unitCode)) * 100) / 100;
}

// ==================== HELPER: Parse row array to object ====================
function parseRowToObject(row: number[]): OptionRow {
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
    // Same 3-digit "vol,oi,chng" string format as before -> getRankColor needs zero changes
    ce_rank: `${ce_vol_rank}${ce_oi_rank}${ce_chng_rank}`,
    pe_rank: `${pe_vol_rank}${pe_oi_rank}${pe_chng_rank}`,
  };
}

// ==================== HELPER: Rank colors (user-configurable) ====================
interface RankColors {
  ce1: string; ce2: string; ce3: string;
  pe1: string; pe2: string; pe3: string;
}

// CE: 1st=light red, 2nd=yellow, 3rd=light yellow | PE: 1st=green, 2nd=yellow, 3rd=light yellow
const DEFAULT_RANK_COLORS: RankColors = {
  ce1: "#f87171", ce2: "#eab308", ce3: "#fde047",
  pe1: "#22c55e", pe2: "#eab308", pe3: "#fde047",
};

const RANK_ALPHA: Record<number, number> = { 1: 0.85, 2: 0.55, 3: 0.35 };

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map(c => c + c).join("") : clean;
  const int = parseInt(full, 16);
  const r = (int >> 16) & 255, g = (int >> 8) & 255, b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getRankColor(rankStr: string, rankIndex: number, side: "ce" | "pe", colors: RankColors): string {
  if (!rankStr || rankStr.length !== 3) return "";
  const rank = parseInt(rankStr[rankIndex], 10);
  if (!rank || rank < 1 || rank > 3) return "";

  const base = side === "ce"
    ? [colors.ce1, colors.ce2, colors.ce3][rank - 1]
    : [colors.pe1, colors.pe2, colors.pe3][rank - 1];

  return hexToRgba(base, RANK_ALPHA[rank]);
}

// ==================== HELPER: Load/Save Settings ====================
function loadSettings(): SavedSettings | null {
  if (typeof window === "undefined") return null;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.error("Failed to load settings:", e);
  }
  return null;
}

function saveSettings(settings: SavedSettings) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error("Failed to save settings:", e);
  }
}

// ==================== MAIN COMPONENT ====================
export default function OptionChainPage() {
  // State - initialized with defaults, will be overwritten by localStorage
  const [symbol, setSymbol] = useState("NIFTY");
  const [rows, setRows] = useState<OptionRow[]>([]);
  const [spotPrice, setSpotPrice] = useState(0);
  const [spotChng, setSpotChng] = useState(0);
  const [timestamp, setTimestamp] = useState("");
  const [connected, setConnected] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reverseOrder, setReverseOrder] = useState(true);
  const [ceColumns, setCeColumns] = useState<ColumnConfig[]>(DEFAULT_CE_COLUMNS);
  const [peColumns, setPeColumns] = useState<ColumnConfig[]>(DEFAULT_PE_COLUMNS);
  const [rankColors, setRankColors] = useState<RankColors>(DEFAULT_RANK_COLORS);
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [decorativeFont, setDecorativeFont] = useState(false);
  const [fontScale, setFontScale] = useState(1);
  const [fontWeight, setFontWeight] = useState(700);
  const [cellScale, setCellScale] = useState(1);
  const [strikeRange, setStrikeRange] = useState(15);
  const [selectedCell, setSelectedCell] = useState<{strike: number; column: string; side: "ce" | "pe"} | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  
  const wsRef = useRef<WebSocket | null>(null);
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const atmRowRef = useRef<HTMLTableRowElement>(null);
  const hasScrolledToAtm = useRef(false);

  // WebSocket URL from env or default
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "ws://127.0.0.1:8788/ws";

  // ==================== Load Settings on Mount ====================
  useEffect(() => {
    const saved = loadSettings();
    if (saved) {
      setSymbol(saved.symbol || "NIFTY");
      setReverseOrder(saved.reverseOrder ?? true);
      if (saved.ceColumns && saved.ceColumns.length > 0) {
        setCeColumns(saved.ceColumns);
      }
      if (saved.peColumns && saved.peColumns.length > 0) {
        setPeColumns(saved.peColumns);
      }
      if (saved.rankColors) {
        setRankColors({ ...DEFAULT_RANK_COLORS, ...saved.rankColors });
      }
      setTheme(saved.theme === "dark" ? "dark" : "light");
      setDecorativeFont(!!saved.decorativeFont);
      setFontScale(typeof saved.fontScale === "number" ? saved.fontScale : 1);
      setFontWeight(typeof saved.fontWeight === "number" ? saved.fontWeight : 700);
      setCellScale(typeof saved.cellScale === "number" ? saved.cellScale : 1);
      setStrikeRange(saved.strikeRange === 30 ? 30 : 15);
    }
    setSettingsLoaded(true);
  }, []);

  // ==================== Save Settings on Change ====================
  useEffect(() => {
    if (!settingsLoaded) return;
    saveSettings({ symbol, reverseOrder, ceColumns, peColumns, rankColors, theme, decorativeFont, fontScale, fontWeight, cellScale, strikeRange });
  }, [symbol, reverseOrder, ceColumns, peColumns, rankColors, theme, decorativeFont, fontScale, fontWeight, cellScale, strikeRange, settingsLoaded]);

  // reverseOrder kept in a ref so the socket effect below doesn't need to
  // depend on it (that was reconnecting the socket - and racing a stale
  // reconnect timer - every time the toggle changed).
  const reverseOrderRef = useRef(reverseOrder);
  useEffect(() => {
    reverseOrderRef.current = reverseOrder;
    // Re-sort whatever we already have immediately, don't wait for next tick
    setRows(prev => {
      const next = [...prev];
      next.sort((a, b) => reverseOrder ? b.relative_idx - a.relative_idx : a.relative_idx - b.relative_idx);
      return next;
    });
  }, [reverseOrder]);

  // ==================== WebSocket Connection ====================
  useEffect(() => {
    if (!settingsLoaded) return;

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        ws.send(JSON.stringify({ action: "subscribe", symbol, from: -strikeRange, to: strikeRange }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "tick" && data.symbol === symbol) {
            const parsedRows = data.data.map(parseRowToObject);
            parsedRows.sort((a: OptionRow, b: OptionRow) => 
              reverseOrderRef.current ? b.relative_idx - a.relative_idx : a.relative_idx - b.relative_idx
            );
            setRows(parsedRows);
            setSpotPrice(data.spot);
            setSpotChng(data.spot_chng);
            setTimestamp(data.timestamp);
          }
        } catch (e) {
          console.error("Parse error:", e);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!stopped) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [wsUrl, symbol, strikeRange, settingsLoaded]);

  // ==================== Scroll to ATM on first load ====================
  useEffect(() => {
    if (rows.length > 0 && atmRowRef.current && !hasScrolledToAtm.current) {
      atmRowRef.current.scrollIntoView({ block: "center", behavior: "auto" });
      hasScrolledToAtm.current = true;
    }
  }, [rows]);

  // Reset scroll flag on symbol change
  useEffect(() => {
    hasScrolledToAtm.current = false;
  }, [symbol]);

  // ==================== Symbol Change ====================
  const handleSymbolChange = (newSymbol: string) => {
    setSymbol(newSymbol);
    setRows([]);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ action: "unsubscribe", symbol }));
      wsRef.current.send(JSON.stringify({ action: "subscribe", symbol: newSymbol, from: -strikeRange, to: strikeRange }));
    }
  };

  // ==================== Column Reorder ====================
  const moveColumn = (side: "ce" | "pe", fromIndex: number, toIndex: number) => {
    const cols = side === "ce" ? [...ceColumns] : [...peColumns];
    const [moved] = cols.splice(fromIndex, 1);
    cols.splice(toIndex, 0, moved);
    side === "ce" ? setCeColumns(cols) : setPeColumns(cols);
  };

  const toggleColumnVisibility = (side: "ce" | "pe", colId: string) => {
    if (side === "ce") {
      setCeColumns(cols => cols.map(c => c.id === colId ? { ...c, visible: !c.visible } : c));
    } else {
      setPeColumns(cols => cols.map(c => c.id === colId ? { ...c, visible: !c.visible } : c));
    }
  };

  // ==================== Cell Click Handler ====================
  const handleCellClick = (row: OptionRow, column: ColumnConfig, side: "ce" | "pe") => {
    setSelectedCell({
      strike: row.strike,
      column: column.id,
      side
    });
    console.log(`Query: Strike=${row.strike}, Column=${column.id}, Side=${side}`);
  };

  // ==================== Render Cell ====================
  const renderCell = (row: OptionRow, col: ColumnConfig, side: "ce" | "pe") => {
    const value = row[col.dataKey];
    const pctValue = col.pctKey ? row[col.pctKey] : null;
    const unitSuffix = col.unitKey ? (row[col.unitKey] as string) : "";
    const secondaryValue = col.secondaryKey ? row[col.secondaryKey] : null;
    const rankStr = side === "ce" ? row.ce_rank : row.pe_rank;
    const rankColor = col.rankIndex !== undefined ? getRankColor(rankStr, col.rankIndex, side, rankColors) : "";
    
    const isSelected = selectedCell?.strike === row.strike && 
                       selectedCell?.column === col.id && 
                       selectedCell?.side === side;

    // Combined cell (IV + Delta)
    if (secondaryValue !== null) {
      return (
        <td
          key={col.id}
          onClick={() => handleCellClick(row, col, side)}
          className={`
            text-center cursor-pointer transition-all border-b border-[var(--border-color)]
            hover:bg-[var(--bg-hover)]
            ${isSelected ? "ring-2 ring-yellow-400 ring-inset" : ""}
            text-[var(--text-primary)]
          `}
          style={{
            width: `calc(${col.width}px * var(--uf-cell-scale, 1))`,
            minWidth: `calc(${col.width}px * var(--uf-cell-scale, 1))`,
            paddingTop: "calc(6px * var(--uf-cell-scale, 1))",
            paddingBottom: "calc(6px * var(--uf-cell-scale, 1))",
            paddingLeft: "calc(8px * var(--uf-cell-scale, 1))",
            paddingRight: "calc(8px * var(--uf-cell-scale, 1))",
          }}
        >
          <div className="flex flex-col items-center leading-tight gap-0.5">
            <span style={{ fontSize: "calc(11px * var(--uf-scale, 1))", fontWeight: "var(--uf-weight, 700)" }}>
              IV: {typeof value === "number" ? value.toFixed(1) : value}
            </span>
            <span style={{ fontSize: "calc(11px * var(--uf-scale, 1))", fontWeight: "var(--uf-weight, 700)" }}>
              Δ {typeof secondaryValue === "number" ? secondaryValue.toFixed(2) : secondaryValue}
            </span>
          </div>
        </td>
      );
    }

    // Cell with percentage (Vol, OI, Chng)
    if (pctValue !== null) {
      return (
        <td
          key={col.id}
          onClick={() => handleCellClick(row, col, side)}
          className={`
            text-center cursor-pointer transition-all border-b border-[var(--border-color)]
            hover:bg-[var(--bg-hover)]
            ${isSelected ? "ring-2 ring-yellow-400 ring-inset" : ""}
            text-[var(--text-primary)]
          `}
          style={{
            width: `calc(${col.width}px * var(--uf-cell-scale, 1))`,
            minWidth: `calc(${col.width}px * var(--uf-cell-scale, 1))`,
            paddingTop: "calc(6px * var(--uf-cell-scale, 1))",
            paddingBottom: "calc(6px * var(--uf-cell-scale, 1))",
            paddingLeft: "calc(8px * var(--uf-cell-scale, 1))",
            paddingRight: "calc(8px * var(--uf-cell-scale, 1))",
            backgroundColor: rankColor || undefined,
            color: rankColor ? "#111827" : undefined,
          }}
        >
          <div className="flex flex-col items-center leading-tight gap-0.5">
            <span style={{ fontSize: "calc(11px * var(--uf-scale, 1))", fontWeight: "var(--uf-weight, 700)" }}>
              {typeof pctValue === "number" ? pctValue.toFixed(1) : pctValue}%
            </span>
            <span style={{ fontSize: "calc(11px * var(--uf-scale, 1))", fontWeight: "var(--uf-weight, 700)" }}>
              {typeof value === "number" ? value.toFixed(2) : value}{unitSuffix}
            </span>
          </div>
        </td>
      );
    }

    // Simple cell (LTP)
    return (
      <td
        key={col.id}
        onClick={() => handleCellClick(row, col, side)}
        className={`
          text-center cursor-pointer transition-all border-b border-[var(--border-color)]
          hover:bg-[var(--bg-hover)]
          ${isSelected ? "ring-2 ring-yellow-400 ring-inset" : ""}
          text-[var(--text-primary)]
        `}
        style={{
          width: `calc(${col.width}px * var(--uf-cell-scale, 1))`,
          minWidth: `calc(${col.width}px * var(--uf-cell-scale, 1))`,
          paddingTop: "calc(6px * var(--uf-cell-scale, 1))",
          paddingBottom: "calc(6px * var(--uf-cell-scale, 1))",
          paddingLeft: "calc(8px * var(--uf-cell-scale, 1))",
          paddingRight: "calc(8px * var(--uf-cell-scale, 1))",
        }}
      >
        <span style={{ fontSize: "calc(14px * var(--uf-scale, 1))", fontWeight: "var(--uf-weight, 700)" }}>
          {typeof value === "number" ? value.toFixed(2) : value}
        </span>
      </td>
    );
  };

  // ==================== Visible Columns ====================
  const visibleCeColumns = ceColumns.filter(c => c.visible);
  const visiblePeColumns = peColumns.filter(c => c.visible);

  // Don't render until settings loaded
  if (!settingsLoaded) {
    return (
      <div data-theme={theme} className="min-h-screen bg-[var(--bg-page)] flex items-center justify-center">
        <div className="text-red-500 text-lg">Loading...</div>
      </div>
    );
  }

  return (
    <div
      data-theme={theme}
      className={`min-h-screen bg-[var(--bg-page)] text-[var(--text-primary)] ${decorativeFont ? "font-sketch" : ""}`}
      style={{ "--uf-scale": fontScale, "--uf-weight": fontWeight, "--uf-cell-scale": cellScale } as React.CSSProperties}
    >
      {/* ==================== HEADER ==================== */}
      <header className="sticky top-0 z-50 bg-[var(--bg-panel)] border-b border-[var(--border-color)] px-4 py-3">
        <div className="flex items-center justify-between max-w-full">
          {/* Symbol Dropdown */}
          <div className="flex items-center gap-4">
            <div className="relative">
              <select
                value={symbol}
                onChange={(e) => handleSymbolChange(e.target.value)}
                className="appearance-none bg-[var(--bg-panel-alt)] text-[var(--text-primary)] px-4 py-2 pr-10 rounded-lg font-semibold text-lg cursor-pointer hover:bg-[var(--bg-hover)] transition-colors"
              >
                {SYMBOLS.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none text-[var(--text-secondary)]" />
            </div>
            
            {/* Connection Status */}
            <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium ${connected ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
              <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`}></span>
              {connected ? "Live" : "Disconnected"}
            </div>
            
            {timestamp && (
              <span className="text-xs text-[var(--text-secondary)] hidden sm:inline">{timestamp}</span>
            )}
          </div>

          {/* Settings Button */}
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-2 rounded-lg bg-[var(--bg-panel-alt)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* ==================== MAIN TABLE ==================== */}
      <div 
        ref={tableContainerRef}
        className="overflow-auto"
        style={{ height: "calc(100vh - 64px)" }}
      >
        <table className="w-full border-collapse">
          {/* Column Headers - Sticky */}
          <thead className="sticky top-0 z-40 bg-[var(--bg-panel)]">
            <tr>
              {/* CE Headers */}
              {visibleCeColumns.map(col => (
                <th 
                  key={col.id}
                  className="text-center text-xs font-semibold uppercase tracking-wider text-red-500 border-b-2 border-red-500/30 bg-[var(--bg-panel)]"
                  style={{
                    width: `calc(${col.width}px * var(--uf-cell-scale, 1))`,
                    minWidth: `calc(${col.width}px * var(--uf-cell-scale, 1))`,
                    paddingTop: "calc(12px * var(--uf-cell-scale, 1))",
                    paddingBottom: "calc(12px * var(--uf-cell-scale, 1))",
                    paddingLeft: "calc(8px * var(--uf-cell-scale, 1))",
                    paddingRight: "calc(8px * var(--uf-cell-scale, 1))",
                  }}
                >
                  {col.shortLabel}
                </th>
              ))}
              
              {/* Strike Header */}
              <th
                className="text-center text-xs font-semibold uppercase tracking-wider text-yellow-400 border-b-2 border-yellow-500/30 bg-[var(--bg-panel)]"
                style={{
                  paddingTop: "calc(12px * var(--uf-cell-scale, 1))",
                  paddingBottom: "calc(12px * var(--uf-cell-scale, 1))",
                  paddingLeft: "calc(16px * var(--uf-cell-scale, 1))",
                  paddingRight: "calc(16px * var(--uf-cell-scale, 1))",
                }}
              >
                Strike
              </th>
              
              {/* PE Headers */}
              {visiblePeColumns.map(col => (
                <th 
                  key={col.id}
                  className="text-center text-xs font-semibold uppercase tracking-wider text-green-600 border-b-2 border-green-500/30 bg-[var(--bg-panel)]"
                  style={{
                    width: `calc(${col.width}px * var(--uf-cell-scale, 1))`,
                    minWidth: `calc(${col.width}px * var(--uf-cell-scale, 1))`,
                    paddingTop: "calc(12px * var(--uf-cell-scale, 1))",
                    paddingBottom: "calc(12px * var(--uf-cell-scale, 1))",
                    paddingLeft: "calc(8px * var(--uf-cell-scale, 1))",
                    paddingRight: "calc(8px * var(--uf-cell-scale, 1))",
                  }}
                >
                  {col.shortLabel}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {rows.map((row, idx) => {
              const isAtm = row.relative_idx === 0;
              // Spot price always belongs directly above the ATM strike row: the ATM
              // strike is the nearest strike at-or-below spot, so spot itself sits
              // just above it whichever direction the list is sorted in.
              const showSpotRow = isAtm;

              return (
                <React.Fragment key={row.strike}>
                  {/* Spot Price Row - Above ATM */}
                  {showSpotRow && (
                    <tr className="bg-[var(--bg-panel-alt)]">
                      <td 
                        colSpan={visibleCeColumns.length + 1 + visiblePeColumns.length}
                        className="py-3 text-center border-b border-[var(--border-color)]"
                      >
                        <div className="flex items-center justify-center gap-4 sm:gap-6">
                          <span className="text-[var(--text-primary)] text-base sm:text-lg font-bold hidden sm:inline">Spot Price</span>
                          <span className="text-xl sm:text-2xl font-bold text-[var(--text-primary)]">
                            {spotPrice.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                          </span>
                          <span className={`flex items-center gap-1 text-base sm:text-lg font-semibold ${spotChng >= 0 ? "text-green-500" : "text-red-500"}`}>
                            {spotChng >= 0 ? <TrendingUp className="w-4 h-4 sm:w-5 sm:h-5" /> : <TrendingDown className="w-4 h-4 sm:w-5 sm:h-5" />}
                            {spotChng >= 0 ? "+" : ""}{spotChng.toFixed(2)}
                          </span>
                        </div>
                      </td>
                    </tr>
                  )}

                  {/* Data Row */}
                  <tr
                    ref={isAtm ? atmRowRef : null}
                    className={`
                      hover:bg-[var(--bg-hover)]
                      ${row.relative_idx < 0 ? (reverseOrder ? "bg-[var(--row-alt-pe)]" : "bg-[var(--row-alt-ce)]") : ""}
                      ${row.relative_idx > 0 ? (reverseOrder ? "bg-[var(--row-alt-ce)]" : "bg-[var(--row-alt-pe)]") : ""}
                      transition-colors
                    `}
                  >
                    {/* CE Cells */}
                    {visibleCeColumns.map(col => renderCell(row, col, "ce"))}
                    
                    {/* Strike */}
                    <td
                      className="text-center border-x-2 border-[var(--strike-border)] text-[var(--text-primary)] bg-[var(--bg-panel-alt)]"
                      style={{
                        fontSize: "calc(16px * var(--uf-scale, 1))",
                        fontWeight: "var(--uf-weight, 700)",
                        paddingTop: "calc(8px * var(--uf-cell-scale, 1))",
                        paddingBottom: "calc(8px * var(--uf-cell-scale, 1))",
                        paddingLeft: "calc(16px * var(--uf-cell-scale, 1))",
                        paddingRight: "calc(16px * var(--uf-cell-scale, 1))",
                      }}
                    >
                      {row.strike}
                    </td>
                    
                    {/* PE Cells */}
                    {visiblePeColumns.map(col => renderCell(row, col, "pe"))}
                  </tr>

                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ==================== SETTINGS MODAL ==================== */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-[var(--bg-panel)] rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-auto">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-color)] sticky top-0 bg-[var(--bg-panel)]">
              <h2 className="text-xl font-bold">Settings</h2>
              <button
                onClick={() => setSettingsOpen(false)}
                className="p-2 rounded-lg hover:bg-[var(--bg-hover)] transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-6">
              {/* Strike Order */}
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-3">Strike Order</h3>
                <div className="flex gap-3">
                  <button
                    onClick={() => setReverseOrder(false)}
                    className={`flex-1 px-4 py-3 rounded-lg border-2 transition-all ${!reverseOrder ? "border-cyan-500 bg-cyan-500/20" : "border-[var(--border-color)] hover:border-[var(--text-muted)]"}`}
                  >
                    <div className="text-sm font-medium">Small ↑ Big ↓</div>
                    <div className="text-xs text-[var(--text-secondary)] mt-1">Lower strikes on top</div>
                  </button>
                  <button
                    onClick={() => setReverseOrder(true)}
                    className={`flex-1 px-4 py-3 rounded-lg border-2 transition-all ${reverseOrder ? "border-cyan-500 bg-cyan-500/20" : "border-[var(--border-color)] hover:border-[var(--text-muted)]"}`}
                  >
                    <div className="text-sm font-medium">Big ↑ Small ↓</div>
                    <div className="text-xs text-[var(--text-secondary)] mt-1">Higher strikes on top</div>
                  </button>
                </div>
              </div>

              {/* Theme */}
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-3">Theme</h3>
                <div className="flex gap-3">
                  <button
                    onClick={() => setTheme("light")}
                    className={`flex-1 px-4 py-3 rounded-lg border-2 transition-all ${theme === "light" ? "border-cyan-500 bg-cyan-500/20" : "border-[var(--border-color)] hover:border-[var(--text-muted)]"}`}
                  >
                    <div className="text-sm font-medium">Light</div>
                    <div className="text-xs text-[var(--text-secondary)] mt-1">Default theme</div>
                  </button>
                  <button
                    onClick={() => setTheme("dark")}
                    className={`flex-1 px-4 py-3 rounded-lg border-2 transition-all ${theme === "dark" ? "border-cyan-500 bg-cyan-500/20" : "border-[var(--border-color)] hover:border-[var(--text-muted)]"}`}
                  >
                    <div className="text-sm font-medium">Dark</div>
                    <div className="text-xs text-[var(--text-secondary)] mt-1">Low-light viewing</div>
                  </button>
                </div>
              </div>

              {/* Font: size, boldness, and optional decorative typeface */}
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-3">Font</h3>
                <div className="space-y-3">
                  <div className="bg-[var(--bg-panel-alt)] rounded-lg px-4 py-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium">Font Size</span>
                      <span className="text-xs text-[var(--text-secondary)]">{Math.round(fontScale * 100)}%{fontScale === 1 ? " (Default)" : ""}</span>
                    </div>
                    <input
                      type="range"
                      min={0.85}
                      max={1.3}
                      step={0.05}
                      value={fontScale}
                      onChange={(e) => setFontScale(parseFloat(e.target.value))}
                      className="w-full accent-cyan-500"
                    />
                  </div>

                  <div className="bg-[var(--bg-panel-alt)] rounded-lg px-4 py-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium">Boldness</span>
                      <span className="text-xs text-[var(--text-secondary)]">
                        {({ 400: "Normal", 500: "Medium", 600: "Semibold", 700: "Bold", 800: "Extra Bold" } as Record<number, string>)[fontWeight] || fontWeight}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={400}
                      max={800}
                      step={100}
                      value={fontWeight}
                      onChange={(e) => setFontWeight(parseInt(e.target.value, 10))}
                      className="w-full accent-cyan-500"
                    />
                  </div>

                  <label className="flex items-center gap-3 bg-[var(--bg-panel-alt)] rounded-lg px-4 py-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={decorativeFont}
                      onChange={(e) => setDecorativeFont(e.target.checked)}
                      className="w-4 h-4 rounded border-[var(--border-color)] text-cyan-500 focus:ring-cyan-500"
                    />
                    <div className="flex-1">
                      <div className="text-sm font-medium">Decorative sketch font</div>
                      <div className="text-xs text-[var(--text-secondary)] mt-1">Optional handwritten-style font. Off by default. Size/boldness above still apply.</div>
                    </div>
                  </label>
                </div>
              </div>

              {/* Cell Size: width + height scale together, so structure never breaks */}
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-3">Cell Size</h3>
                <div className="bg-[var(--bg-panel-alt)] rounded-lg px-4 py-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium">Width &amp; Height</span>
                    <span className="text-xs text-[var(--text-secondary)]">{Math.round(cellScale * 100)}%{cellScale === 1 ? " (Default)" : ""}</span>
                  </div>
                  <input
                    type="range"
                    min={0.8}
                    max={1.4}
                    step={0.05}
                    value={cellScale}
                    onChange={(e) => setCellScale(parseFloat(e.target.value))}
                    className="w-full accent-cyan-500"
                  />
                  <div className="text-xs text-[var(--text-secondary)] mt-1">All columns and rows scale together, so the table layout never gets lopsided.</div>
                </div>
              </div>

              {/* Number of strikes loaded from the server */}
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-3">Strikes to Load</h3>
                <div className="flex gap-3">
                  <button
                    onClick={() => setStrikeRange(15)}
                    className={`flex-1 px-4 py-3 rounded-lg border-2 transition-all ${strikeRange === 15 ? "border-cyan-500 bg-cyan-500/20" : "border-[var(--border-color)] hover:border-[var(--text-muted)]"}`}
                  >
                    <div className="text-sm font-medium">15 Strikes</div>
                    <div className="text-xs text-[var(--text-secondary)] mt-1">Default, lighter data feed</div>
                  </button>
                  <button
                    onClick={() => setStrikeRange(30)}
                    className={`flex-1 px-4 py-3 rounded-lg border-2 transition-all ${strikeRange === 30 ? "border-cyan-500 bg-cyan-500/20" : "border-[var(--border-color)] hover:border-[var(--text-muted)]"}`}
                  >
                    <div className="text-sm font-medium">30 Strikes</div>
                    <div className="text-xs text-[var(--text-secondary)] mt-1">Wider strike coverage</div>
                  </button>
                </div>
                <div className="text-xs text-[var(--text-secondary)] mt-2">Controls how many strikes above/below spot are requested from the server (the subscribe message&apos;s from/to range).</div>
              </div>

              {/* CE Columns */}
              <div>
                <h3 className="text-sm font-semibold text-red-500 uppercase tracking-wider mb-3">CE Columns</h3>
                <div className="space-y-2">
                  {ceColumns.map((col, idx) => (
                    <div
                      key={col.id}
                      className="flex items-center gap-3 bg-[var(--bg-panel-alt)] rounded-lg px-4 py-2"
                    >
                      <input
                        type="checkbox"
                        checked={col.visible}
                        onChange={() => toggleColumnVisibility("ce", col.id)}
                        className="w-4 h-4 rounded border-[var(--border-color)] text-red-500 focus:ring-red-500"
                      />
                      <span className="flex-1 text-sm">{col.label}</span>
                      <div className="flex gap-1">
                        <button
                          onClick={() => idx > 0 && moveColumn("ce", idx, idx - 1)}
                          disabled={idx === 0}
                          className="px-2 py-1 text-xs bg-[var(--bg-hover)] rounded hover:bg-[var(--bg-hover)] disabled:opacity-30"
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => idx < ceColumns.length - 1 && moveColumn("ce", idx, idx + 1)}
                          disabled={idx === ceColumns.length - 1}
                          className="px-2 py-1 text-xs bg-[var(--bg-hover)] rounded hover:bg-[var(--bg-hover)] disabled:opacity-30"
                        >
                          ↓
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* PE Columns */}
              <div>
                <h3 className="text-sm font-semibold text-green-600 uppercase tracking-wider mb-3">PE Columns</h3>
                <div className="space-y-2">
                  {peColumns.map((col, idx) => (
                    <div
                      key={col.id}
                      className="flex items-center gap-3 bg-[var(--bg-panel-alt)] rounded-lg px-4 py-2"
                    >
                      <input
                        type="checkbox"
                        checked={col.visible}
                        onChange={() => toggleColumnVisibility("pe", col.id)}
                        className="w-4 h-4 rounded border-[var(--border-color)] text-green-600 focus:ring-green-600"
                      />
                      <span className="flex-1 text-sm">{col.label}</span>
                      <div className="flex gap-1">
                        <button
                          onClick={() => idx > 0 && moveColumn("pe", idx, idx - 1)}
                          disabled={idx === 0}
                          className="px-2 py-1 text-xs bg-[var(--bg-hover)] rounded hover:bg-[var(--bg-hover)] disabled:opacity-30"
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => idx < peColumns.length - 1 && moveColumn("pe", idx, idx + 1)}
                          disabled={idx === peColumns.length - 1}
                          className="px-2 py-1 text-xs bg-[var(--bg-hover)] rounded hover:bg-[var(--bg-hover)] disabled:opacity-30"
                        >
                          ↓
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Rank Colors */}
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-3">Rank Highlight Colors</h3>
                <p className="text-xs text-[var(--text-muted)] mb-3">Applies to the top-3 Vol / OI / Chng cells on each side.</p>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-red-500">CE side</div>
                    {(["ce1", "ce2", "ce3"] as const).map((key, i) => (
                      <div key={key} className="flex items-center gap-2 bg-[var(--bg-panel-alt)] rounded-lg px-3 py-2">
                        <input
                          type="color"
                          value={rankColors[key]}
                          onChange={(e) => setRankColors({ ...rankColors, [key]: e.target.value })}
                          className="w-8 h-8 rounded cursor-pointer bg-transparent"
                        />
                        <span className="text-xs text-[var(--text-secondary)]">#{i + 1} rank</span>
                      </div>
                    ))}
                  </div>
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-green-600">PE side</div>
                    {(["pe1", "pe2", "pe3"] as const).map((key, i) => (
                      <div key={key} className="flex items-center gap-2 bg-[var(--bg-panel-alt)] rounded-lg px-3 py-2">
                        <input
                          type="color"
                          value={rankColors[key]}
                          onChange={(e) => setRankColors({ ...rankColors, [key]: e.target.value })}
                          className="w-8 h-8 rounded cursor-pointer bg-transparent"
                        />
                        <span className="text-xs text-[var(--text-secondary)]">#{i + 1} rank</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Reset Settings */}
              <div className="pt-4 border-t border-[var(--border-color)]">
                <button
                  onClick={() => {
                    setCeColumns(DEFAULT_CE_COLUMNS);
                    setPeColumns(DEFAULT_PE_COLUMNS);
                    setReverseOrder(true);
                    setRankColors(DEFAULT_RANK_COLORS);
                    setTheme("light");
                    setDecorativeFont(false);
                    setFontScale(1);
                    setFontWeight(700);
                    setCellScale(1);
                    setStrikeRange(15);
                  }}
                  className="px-4 py-2 text-sm bg-red-600/20 text-red-400 rounded-lg hover:bg-red-600/30 transition-colors"
                >
                  Reset to Defaults
                </button>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-[var(--border-color)] flex justify-between items-center sticky bottom-0 bg-[var(--bg-panel)]">
              <span className="text-xs text-[var(--text-muted)]">Settings auto-saved locally</span>
              <button
                onClick={() => setSettingsOpen(false)}
                className="px-6 py-2 bg-cyan-600 hover:bg-cyan-500 rounded-lg font-medium transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== SELECTED CELL INFO ==================== */}
      {selectedCell && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-[var(--bg-panel)] border border-[var(--border-color)] rounded-xl px-4 sm:px-6 py-3 shadow-2xl flex items-center gap-3 sm:gap-4">
          <div className="text-sm">
            <span className={selectedCell.side === "ce" ? "text-red-500" : "text-green-600"}>
              {selectedCell.side.toUpperCase()}
            </span>
            <span className="text-[var(--text-primary)] mx-2">|</span>
            <span className="text-yellow-400">Strike {selectedCell.strike}</span>
            <span className="text-[var(--text-primary)] mx-2">|</span>
            <span className="text-[var(--text-primary)]">{selectedCell.column}</span>
          </div>
          <button
            onClick={() => setSelectedCell(null)}
            className="p-1 rounded hover:bg-[var(--bg-hover)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}

// Need to import React for Fragment
import React from "react";
