"use client";

import { useState, useEffect, useRef, useCallback, memo } from "react";
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
type FontStyle = "system" | "sketch" | "serif" | "mono";

interface SavedSettings {
  symbol: string;
  reverseOrder: boolean;
  ceColumns: ColumnConfig[];
  peColumns: ColumnConfig[];
  rankColors?: RankColors;
  rankVisibility?: RankVisibility;
  theme?: ThemeMode;
  decorativeFont?: boolean; // legacy setting
  fontStyle?: FontStyle;
  fontScale?: number;
  fontWeight?: number;
  cellScale?: number; // legacy combined setting
  cellWidthScale?: number;
  cellHeightScale?: number;
  strikeRange?: number;
}

const STORAGE_KEY = "option_chain_settings";
const SETTINGS_VERSION = 2;
const SETTINGS_SAVE_DELAY_MS = 250;

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

const SYMBOL_GROUPS = [
  { category: "NSE", symbols: ["NIFTY", "BANKNIFTY"] },
  { category: "BSE", symbols: ["SENSEX"] },
  { category: "MCX", symbols: ["CRUDEOIL"] },
];

// ==================== HELPER: Decode meta_pack (mirrors engine.py _pack_meta) ====================
const UNIT_SUFFIX = ["", "K", "M", "B"];

function shortValue(raw: number, unitCode: number): number {
  return Math.round((raw / Math.pow(1000, unitCode)) * 100) / 100;
}

// ==================== HELPER: Parse row array to object ====================
function isValidWireRow(row: unknown): row is number[] {
  return Array.isArray(row) && row.length >= 26 && row.every((value, index) => index === 0 || Number.isFinite(value));
}

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

interface RankVisibility {
  rank2Enabled: boolean; rank2Threshold: number;
  rank3Enabled: boolean; rank3Threshold: number;
}
// CE: 1st=light red, 2nd=yellow, 3rd=light yellow | PE: 1st=green, 2nd=yellow, 3rd=light yellow
const DEFAULT_RANK_COLORS: RankColors = {
  ce1: "#f87171", ce2: "#eab308", ce3: "#fde047",
  pe1: "#22c55e", pe2: "#eab308", pe3: "#fde047",
};

const DEFAULT_RANK_VISIBILITY: RankVisibility = {
  rank2Enabled: true, rank2Threshold: 75,
  rank3Enabled: false, rank3Threshold: 75,
};

const RANK_ALPHA: Record<number, number> = { 1: 0.85, 2: 0.55, 3: 0.35 };

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map(c => c + c).join("") : clean;
  const int = parseInt(full, 16);
  const r = (int >> 16) & 255, g = (int >> 8) & 255, b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getRankColor(rankStr: string, rankIndex: number, side: "ce" | "pe", colors: RankColors, pctValue: unknown, visibility: RankVisibility): string {
  if (!rankStr || rankStr.length !== 3) return "";
  const rank = parseInt(rankStr[rankIndex], 10);
  if (!rank || rank < 1 || rank > 3) return "";
  const percentage = typeof pctValue === "number" ? pctValue : 0;
  const enabled = rank === 2 ? visibility.rank2Enabled : visibility.rank3Enabled;
  const threshold = rank === 2 ? visibility.rank2Threshold : visibility.rank3Threshold;
  if ((rank === 2 || rank === 3) && (!enabled || percentage <= threshold)) return "";

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
      const parsed = JSON.parse(saved);
      return parsed?.version ? parsed.settings : parsed; // migrate unversioned settings
    }
  } catch (e) {
    console.error("Failed to load settings:", e);
  }
  return null;
}

function saveSettings(settings: SavedSettings) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: SETTINGS_VERSION, settings }));
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
  const [rankVisibility, setRankVisibility] = useState<RankVisibility>(DEFAULT_RANK_VISIBILITY);
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [fontStyle, setFontStyle] = useState<FontStyle>("system");
  const [fontScale, setFontScale] = useState(1);
  const [fontWeight, setFontWeight] = useState(700);
  const [cellWidthScale, setCellWidthScale] = useState(1);
  const [cellHeightScale, setCellHeightScale] = useState(1);
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
      if (saved.rankVisibility) {
        const legacy = saved.rankVisibility as RankVisibility & {
          ceRank2Enabled?: boolean; ceRank2Threshold?: number; peRank2Enabled?: boolean; peRank2Threshold?: number;
          ceRank3Enabled?: boolean; ceRank3Threshold?: number; peRank3Enabled?: boolean; peRank3Threshold?: number;
        };
        setRankVisibility({
          rank2Enabled: legacy.rank2Enabled ?? legacy.ceRank2Enabled ?? legacy.peRank2Enabled ?? true,
          rank2Threshold: legacy.rank2Threshold ?? legacy.ceRank2Threshold ?? legacy.peRank2Threshold ?? 75,
          rank3Enabled: legacy.rank3Enabled ?? legacy.ceRank3Enabled ?? legacy.peRank3Enabled ?? false,
          rank3Threshold: legacy.rank3Threshold ?? legacy.ceRank3Threshold ?? legacy.peRank3Threshold ?? 75,
        });
      }
      setTheme(saved.theme === "dark" ? "dark" : "light");
      setFontStyle(saved.fontStyle || (saved.decorativeFont ? "sketch" : "system"));
      setFontScale(typeof saved.fontScale === "number" ? saved.fontScale : 1);
      setFontWeight(typeof saved.fontWeight === "number" ? saved.fontWeight : 700);
      const legacyCellScale = typeof saved.cellScale === "number" ? saved.cellScale : 1;
      setCellWidthScale(typeof saved.cellWidthScale === "number" ? saved.cellWidthScale : legacyCellScale);
      setCellHeightScale(typeof saved.cellHeightScale === "number" ? saved.cellHeightScale : legacyCellScale);
      setStrikeRange(saved.strikeRange === 30 ? 30 : 15);
    }
    setSettingsLoaded(true);
  }, []);

  // ==================== Save Settings on Change ====================
  useEffect(() => {
    if (!settingsLoaded) return;
    const timer = setTimeout(() => saveSettings({ symbol, reverseOrder, ceColumns, peColumns, rankColors, rankVisibility, theme, fontStyle, fontScale, fontWeight, cellWidthScale, cellHeightScale, strikeRange }), SETTINGS_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [symbol, reverseOrder, ceColumns, peColumns, rankColors, rankVisibility, theme, fontStyle, fontScale, fontWeight, cellWidthScale, cellHeightScale, strikeRange, settingsLoaded]);

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
            if (!Array.isArray(data.data)) return;
            const validRows = data.data.filter(isValidWireRow);
            if (validRows.length !== data.data.length) console.warn("Ignored malformed option-chain rows");
            const parsedRows = validRows.map(parseRowToObject);
            parsedRows.sort((a: OptionRow, b: OptionRow) =>
              reverseOrderRef.current ? b.relative_idx - a.relative_idx : a.relative_idx - b.relative_idx
            );
            setRows(previous => {
              const byStrike = new Map(previous.map(row => [row.strike, row]));
              return parsedRows.map((row: OptionRow) => {
                const oldRow = byStrike.get(row.strike);
                return oldRow && Object.keys(row).every(key => oldRow[key as keyof OptionRow] === row[key as keyof OptionRow]) ? oldRow : row;
              });
            });
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
    const rankColor = col.rankIndex !== undefined ? getRankColor(rankStr, col.rankIndex, side, rankColors, pctValue, rankVisibility) : "";
    
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
            width: `calc(${col.width}px * var(--uf-width-scale, 1))`,
            minWidth: `calc(${col.width}px * var(--uf-width-scale, 1))`,
            paddingTop: "calc(6px * var(--uf-height-scale, 1))",
            paddingBottom: "calc(6px * var(--uf-height-scale, 1))",
            paddingLeft: "calc(8px * var(--uf-width-scale, 1))",
            paddingRight: "calc(8px * var(--uf-width-scale, 1))",
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
            width: `calc(${col.width}px * var(--uf-width-scale, 1))`,
            minWidth: `calc(${col.width}px * var(--uf-width-scale, 1))`,
            paddingTop: "calc(6px * var(--uf-height-scale, 1))",
            paddingBottom: "calc(6px * var(--uf-height-scale, 1))",
            paddingLeft: "calc(8px * var(--uf-width-scale, 1))",
            paddingRight: "calc(8px * var(--uf-width-scale, 1))",
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
          width: `calc(${col.width}px * var(--uf-width-scale, 1))`,
          minWidth: `calc(${col.width}px * var(--uf-width-scale, 1))`,
          paddingTop: "calc(6px * var(--uf-height-scale, 1))",
          paddingBottom: "calc(6px * var(--uf-height-scale, 1))",
          paddingLeft: "calc(8px * var(--uf-width-scale, 1))",
          paddingRight: "calc(8px * var(--uf-width-scale, 1))",
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
      className={`min-h-screen bg-[var(--bg-page)] text-[var(--text-primary)] ${fontStyle === "sketch" ? "font-sketch" : fontStyle === "serif" ? "font-serif-ui" : fontStyle === "mono" ? "font-mono-ui" : ""}`}
      style={{ "--uf-scale": fontScale, "--uf-weight": fontWeight, "--uf-width-scale": cellWidthScale, "--uf-height-scale": cellHeightScale } as React.CSSProperties}
    >
      {/* ==================== HEADER ==================== */}
      <header className="sticky top-0 z-50 overflow-x-auto bg-[var(--bg-panel)] border-b border-[var(--border-color)] px-4 py-3">
        <div className="flex min-w-full flex-wrap items-center justify-between gap-2 sm:flex-nowrap">
          {/* Symbol Dropdown */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-4">
            <div className="relative">
              <select
                value={symbol}
                onChange={(e) => handleSymbolChange(e.target.value)}
                className="appearance-none w-auto max-w-[11rem] bg-[var(--bg-panel-alt)] text-[var(--text-primary)] pl-3 pr-8 py-2 rounded-lg font-semibold text-base cursor-pointer hover:bg-[var(--bg-hover)] transition-colors"
              >
                {SYMBOL_GROUPS.map(group => (
                  <optgroup key={group.category} label={group.category}>
                    {group.symbols.map(s => <option key={s} value={s}>{s}</option>)}
                  </optgroup>
                ))}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none text-[var(--text-secondary)]" />
            </div>
            
            {/* Connection Status */}
            <div role="status" aria-live="polite" className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium ${connected ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
              <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`}></span>
              {connected ? "Live" : "Disconnected"}
            </div>
            
            {timestamp && (
              <span className="text-xs text-[var(--text-secondary)] whitespace-nowrap">{timestamp}</span>
            )}
          </div>

          {/* Settings Button */}
          <button
            onClick={() => setSettingsOpen(true)}
            aria-label="Open settings"
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
        <table
          className="table-fixed border-collapse"
          style={{ width: `max(100%, calc(${visibleCeColumns.reduce((sum, col) => sum + col.width, 0) + 90 + visiblePeColumns.reduce((sum, col) => sum + col.width, 0)}px * var(--uf-width-scale, 1)))` }}
        >
          <colgroup>
            {visibleCeColumns.map(col => <col key={col.id} style={{ width: `calc(${col.width}px * var(--uf-width-scale, 1))` }} />)}
            <col style={{ width: "calc(90px * var(--uf-width-scale, 1))" }} />
            {visiblePeColumns.map(col => <col key={col.id} style={{ width: `calc(${col.width}px * var(--uf-width-scale, 1))` }} />)}
          </colgroup>
          {/* Column Headers - Sticky */}
          <thead className="sticky top-0 z-40 bg-[var(--bg-panel)]">
            <tr>
              {/* CE Headers */}
              {visibleCeColumns.map(col => (
                <th scope="col"
                  key={col.id}
                  className="text-center text-xs font-semibold uppercase tracking-wider text-red-500 border-b-2 border-red-500/30 bg-[var(--bg-panel)]"
                  style={{
                    width: `calc(${col.width}px * var(--uf-width-scale, 1))`,
                    minWidth: `calc(${col.width}px * var(--uf-width-scale, 1))`,
                    paddingTop: "calc(12px * var(--uf-height-scale, 1))",
                    paddingBottom: "calc(12px * var(--uf-height-scale, 1))",
                    paddingLeft: "calc(8px * var(--uf-width-scale, 1))",
                    paddingRight: "calc(8px * var(--uf-width-scale, 1))",
                  }}
                >
                  {col.shortLabel}
                </th>
              ))}
              
              {/* Strike Header */}
              <th scope="col"
                className="text-center text-xs font-semibold uppercase tracking-wider text-yellow-400 border-b-2 border-yellow-500/30 bg-[var(--bg-panel)]"
                style={{
                  paddingTop: "calc(12px * var(--uf-height-scale, 1))",
                  paddingBottom: "calc(12px * var(--uf-height-scale, 1))",
                  paddingLeft: "calc(16px * var(--uf-width-scale, 1))",
                  paddingRight: "calc(16px * var(--uf-width-scale, 1))",
                }}
              >
                Strike
              </th>
              
              {/* PE Headers */}
              {visiblePeColumns.map(col => (
                <th scope="col"
                  key={col.id}
                  className="text-center text-xs font-semibold uppercase tracking-wider text-green-600 border-b-2 border-green-500/30 bg-[var(--bg-panel)]"
                  style={{
                    width: `calc(${col.width}px * var(--uf-width-scale, 1))`,
                    minWidth: `calc(${col.width}px * var(--uf-width-scale, 1))`,
                    paddingTop: "calc(12px * var(--uf-height-scale, 1))",
                    paddingBottom: "calc(12px * var(--uf-height-scale, 1))",
                    paddingLeft: "calc(8px * var(--uf-width-scale, 1))",
                    paddingRight: "calc(8px * var(--uf-width-scale, 1))",
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
                          <span className="text-[var(--text-primary)] text-sm sm:text-lg font-bold whitespace-nowrap">{symbol === "CRUDEOIL" ? "Future Price" : "Spot Price"}</span>
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
                        paddingTop: "calc(8px * var(--uf-height-scale, 1))",
                        paddingBottom: "calc(8px * var(--uf-height-scale, 1))",
                        paddingLeft: "calc(16px * var(--uf-width-scale, 1))",
                        paddingRight: "calc(16px * var(--uf-width-scale, 1))",
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
            {/* Permanent blank row, always attached directly below the final data row. */}
            <tr aria-label="Empty row" className="bg-[var(--bg-panel)]">
              {visibleCeColumns.map(col => <td key={col.id} className="border-b border-r border-[var(--border-color)]" style={{ height: "calc(36px * var(--uf-height-scale, 1))", padding: 0 }} />)}
              <td className="border-x-2 border-b border-[var(--strike-border)] bg-[var(--bg-panel-alt)]" style={{ height: "calc(36px * var(--uf-height-scale, 1))", padding: 0 }} />
              {visiblePeColumns.map(col => <td key={col.id} className="border-b border-r border-[var(--border-color)]" style={{ height: "calc(36px * var(--uf-height-scale, 1))", padding: 0 }} />)}
            </tr>
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

                  <div className="bg-[var(--bg-panel-alt)] rounded-lg px-4 py-3">
                    <div className="text-sm font-medium mb-2">Font Style</div>
                    <select value={fontStyle} onChange={(e) => setFontStyle(e.target.value as FontStyle)} className="w-full bg-[var(--bg-panel)] border border-[var(--border-color)] rounded-lg px-3 py-2">
                      <option value="system">System (Default)</option>
                      <option value="sketch">Caveat / Sketch</option>
                      <option value="serif">Georgia / Serif</option>
                      <option value="mono">Monospace</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Cell width and row height are independently adjustable. */}
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-3">Cell Size</h3>
                <div className="space-y-3">
                  {([ ["Width", cellWidthScale, setCellWidthScale], ["Height", cellHeightScale, setCellHeightScale] ] as const).map(([label, value, setter]) => (
                    <div key={label} className="bg-[var(--bg-panel-alt)] rounded-lg px-4 py-3">
                      <div className="flex items-center justify-between mb-2"><span className="text-sm font-medium">{label}</span><span className="text-xs text-[var(--text-secondary)]">{Math.round(value * 100)}%</span></div>
                      <input type="range" min={0.6} max={1.8} step={0.1} value={value} onChange={(e) => setter(parseFloat(e.target.value))} className="w-full accent-cyan-500" />
                    </div>
                  ))}
                </div>
                <div className="text-xs text-[var(--text-secondary)] mt-2">Strike column stays proportional to the other columns at every width.</div>
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
                <p className="text-xs text-[var(--text-muted)] mb-3">Rank 1 is always visible. Rank 2 and 3 highlights can be filtered by their cell percentage.</p>
                <div className="grid sm:grid-cols-2 gap-3 mb-4">
                  {([2, 3] as const).map(rank => {
                    const enabledKey = `rank${rank}Enabled` as keyof RankVisibility;
                    const thresholdKey = `rank${rank}Threshold` as keyof RankVisibility;
                    const enabled = Boolean(rankVisibility[enabledKey]);
                    return (
                      <div key={rank} className="bg-[var(--bg-panel-alt)] rounded-lg px-3 py-3">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={enabled} onChange={(e) => setRankVisibility({ ...rankVisibility, [enabledKey]: e.target.checked })} className="w-4 h-4 accent-cyan-500" />
                          <span className="text-sm font-medium">Rank {rank} (CE &amp; PE)</span>
                        </label>
                        <label className={`block mt-3 ${enabled ? "" : "opacity-50"}`}>
                          <div className="flex justify-between text-xs text-[var(--text-secondary)] mb-1"><span>Minimum percentage</span><span>{rankVisibility[thresholdKey]}%</span></div>
                          <input aria-label={`Rank ${rank} minimum percentage`} type="range" min={0} max={100} step={5} disabled={!enabled} value={Number(rankVisibility[thresholdKey])} onChange={(e) => setRankVisibility({ ...rankVisibility, [thresholdKey]: parseInt(e.target.value, 10) })} className="w-full accent-cyan-500" />
                        </label>
                      </div>
                    );
                  })}
                </div>
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
                    setRankVisibility(DEFAULT_RANK_VISIBILITY);
                    setTheme("light");
                    setFontStyle("system");
                    setFontScale(1);
                    setFontWeight(700);
                    setCellWidthScale(1);
                    setCellHeightScale(1);
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
