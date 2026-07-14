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
  ce_chng: number;
  ce_chng_short: number;
  ce_vol: number;
  ce_vol_short: number;
  ce_ltp: number;
  ce_iv: number;
  ce_delta: number;
  ce_vol_pct: number;
  ce_oi_pct: number;
  ce_chng_pct: number;
  pe_oi: number;
  pe_oi_short: number;
  pe_chng: number;
  pe_chng_short: number;
  pe_vol: number;
  pe_vol_short: number;
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
  secondaryKey?: keyof OptionRow; // For combined cells like IV+Delta
  rankIndex?: number;
  visible: boolean;
  width: number;
}

interface SavedSettings {
  symbol: string;
  reverseOrder: boolean;
  ceColumns: ColumnConfig[];
  peColumns: ColumnConfig[];
}

const STORAGE_KEY = "option_chain_settings";

// ==================== COLUMN DEFINITIONS ====================
const DEFAULT_CE_COLUMNS: ColumnConfig[] = [
  { id: "ce_vol", label: "Volume", shortLabel: "Vol", dataKey: "ce_vol_short", pctKey: "ce_vol_pct", rankIndex: 0, visible: true, width: 80 },
  { id: "ce_oi", label: "Open Interest", shortLabel: "OI", dataKey: "ce_oi_short", pctKey: "ce_oi_pct", rankIndex: 1, visible: true, width: 80 },
  { id: "ce_chng", label: "OI Change", shortLabel: "Chng", dataKey: "ce_chng_short", pctKey: "ce_chng_pct", rankIndex: 2, visible: true, width: 80 },
  { id: "ce_ltp", label: "LTP", shortLabel: "LTP", dataKey: "ce_ltp", visible: true, width: 70 },
  { id: "ce_iv_delta", label: "IV / Delta", shortLabel: "IV/Δ", dataKey: "ce_iv", secondaryKey: "ce_delta", visible: true, width: 70 },
];

const DEFAULT_PE_COLUMNS: ColumnConfig[] = [
  { id: "pe_iv_delta", label: "IV / Delta", shortLabel: "IV/Δ", dataKey: "pe_iv", secondaryKey: "pe_delta", visible: true, width: 70 },
  { id: "pe_ltp", label: "LTP", shortLabel: "LTP", dataKey: "pe_ltp", visible: true, width: 70 },
  { id: "pe_chng", label: "OI Change", shortLabel: "Chng", dataKey: "pe_chng_short", pctKey: "pe_chng_pct", rankIndex: 2, visible: true, width: 80 },
  { id: "pe_oi", label: "Open Interest", shortLabel: "OI", dataKey: "pe_oi_short", pctKey: "pe_oi_pct", rankIndex: 1, visible: true, width: 80 },
  { id: "pe_vol", label: "Volume", shortLabel: "Vol", dataKey: "pe_vol_short", pctKey: "pe_vol_pct", rankIndex: 0, visible: true, width: 80 },
];

const SYMBOLS = ["NIFTY", "BANKNIFTY", "SENSEX", "CRUDEOIL"];

// ==================== HELPER: Parse row array to object ====================
function parseRowToObject(row: number[]): OptionRow {
  return {
    timestamp: String(row[0]),
    spot_price: row[1],
    spot_chng: row[2],
    relative_idx: row[3],
    strike: row[4],
    lot_size: row[5],
    ce_oi: row[6],
    ce_oi_short: row[7],
    ce_chng: row[8],
    ce_chng_short: row[9],
    ce_vol: row[10],
    ce_vol_short: row[11],
    ce_ltp: row[12],
    ce_iv: row[13],
    ce_delta: row[14],
    ce_vol_pct: row[15],
    ce_oi_pct: row[16],
    ce_chng_pct: row[17],
    pe_oi: row[18],
    pe_oi_short: row[19],
    pe_chng: row[20],
    pe_chng_short: row[21],
    pe_vol: row[22],
    pe_vol_short: row[23],
    pe_ltp: row[24],
    pe_iv: row[25],
    pe_delta: row[26],
    pe_vol_pct: row[27],
    pe_oi_pct: row[28],
    pe_chng_pct: row[29],
    gamma: row[30],
    ce_rank: String(row[31]),
    pe_rank: String(row[32]),
  };
}

// ==================== HELPER: Get rank background color ====================
function getRankBg(rankStr: string, rankIndex: number, side: "ce" | "pe"): string {
  if (!rankStr || rankStr.length !== 3) return "";
  const rank = parseInt(rankStr[rankIndex], 10);
  if (rank === 0) return "";
  
  const colors = side === "ce" 
    ? { 1: "bg-cyan-500/40", 2: "bg-cyan-500/25", 3: "bg-cyan-500/15" }
    : { 1: "bg-orange-500/40", 2: "bg-orange-500/25", 3: "bg-orange-500/15" };
  
  return colors[rank as 1 | 2 | 3] || "";
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
  const [reverseOrder, setReverseOrder] = useState(false);
  const [ceColumns, setCeColumns] = useState<ColumnConfig[]>(DEFAULT_CE_COLUMNS);
  const [peColumns, setPeColumns] = useState<ColumnConfig[]>(DEFAULT_PE_COLUMNS);
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
      setReverseOrder(saved.reverseOrder || false);
      if (saved.ceColumns && saved.ceColumns.length > 0) {
        setCeColumns(saved.ceColumns);
      }
      if (saved.peColumns && saved.peColumns.length > 0) {
        setPeColumns(saved.peColumns);
      }
    }
    setSettingsLoaded(true);
  }, []);

  // ==================== Save Settings on Change ====================
  useEffect(() => {
    if (!settingsLoaded) return;
    saveSettings({ symbol, reverseOrder, ceColumns, peColumns });
  }, [symbol, reverseOrder, ceColumns, peColumns, settingsLoaded]);

  // ==================== WebSocket Connection ====================
  useEffect(() => {
    if (!settingsLoaded) return;

    const connect = () => {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        ws.send(JSON.stringify({ action: "subscribe", symbol, from: -30, to: 30 }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "tick" && data.symbol === symbol) {
            const parsedRows = data.data.map(parseRowToObject);
            parsedRows.sort((a: OptionRow, b: OptionRow) => 
              reverseOrder ? b.relative_idx - a.relative_idx : a.relative_idx - b.relative_idx
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
        setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();
    return () => {
      wsRef.current?.close();
    };
  }, [wsUrl, symbol, reverseOrder, settingsLoaded]);

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
      wsRef.current.send(JSON.stringify({ action: "subscribe", symbol: newSymbol, from: -30, to: 30 }));
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
    const secondaryValue = col.secondaryKey ? row[col.secondaryKey] : null;
    const rankStr = side === "ce" ? row.ce_rank : row.pe_rank;
    const rankBg = col.rankIndex !== undefined ? getRankBg(rankStr, col.rankIndex, side) : "";
    
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
            px-2 py-1.5 text-right cursor-pointer transition-all border-b border-slate-700/50
            hover:bg-slate-600/30
            ${isSelected ? "ring-2 ring-yellow-400 ring-inset" : ""}
            ${side === "ce" ? "text-cyan-100" : "text-orange-100"}
          `}
          style={{ width: col.width, minWidth: col.width }}
        >
          <div className="flex flex-col items-end leading-tight">
            <span className="text-[10px] opacity-70">
              IV: {typeof value === "number" ? value.toFixed(1) : value}
            </span>
            <span className="text-sm font-medium">
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
            px-2 py-1.5 text-right cursor-pointer transition-all border-b border-slate-700/50
            hover:bg-slate-600/30 ${rankBg}
            ${isSelected ? "ring-2 ring-yellow-400 ring-inset" : ""}
            ${side === "ce" ? "text-cyan-100" : "text-orange-100"}
          `}
          style={{ width: col.width, minWidth: col.width }}
        >
          <div className="flex flex-col items-end leading-tight">
            <span className="text-[10px] opacity-60">
              {typeof pctValue === "number" ? pctValue.toFixed(1) : pctValue}%
            </span>
            <span className="text-sm font-medium">
              {typeof value === "number" ? value.toFixed(2) : value}
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
          px-2 py-1.5 text-right cursor-pointer transition-all border-b border-slate-700/50
          hover:bg-slate-600/30
          ${isSelected ? "ring-2 ring-yellow-400 ring-inset" : ""}
          ${side === "ce" ? "text-cyan-100" : "text-orange-100"}
        `}
        style={{ width: col.width, minWidth: col.width }}
      >
        <span className="text-sm font-medium">
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
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-cyan-400 text-lg">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      {/* ==================== HEADER ==================== */}
      <header className="sticky top-0 z-50 bg-slate-800 border-b border-slate-700 px-4 py-3">
        <div className="flex items-center justify-between max-w-full">
          {/* Symbol Dropdown */}
          <div className="flex items-center gap-4">
            <div className="relative">
              <select
                value={symbol}
                onChange={(e) => handleSymbolChange(e.target.value)}
                className="appearance-none bg-slate-700 text-white px-4 py-2 pr-10 rounded-lg font-semibold text-lg cursor-pointer hover:bg-slate-600 transition-colors"
              >
                {SYMBOLS.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none text-slate-400" />
            </div>
            
            {/* Connection Status */}
            <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium ${connected ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
              <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`}></span>
              {connected ? "Live" : "Disconnected"}
            </div>
            
            {timestamp && (
              <span className="text-xs text-slate-400 hidden sm:inline">{timestamp}</span>
            )}
          </div>

          {/* Settings Button */}
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-2 rounded-lg bg-slate-700 hover:bg-slate-600 transition-colors"
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
          <thead className="sticky top-0 z-40 bg-slate-800">
            <tr>
              {/* CE Headers */}
              {visibleCeColumns.map(col => (
                <th 
                  key={col.id}
                  className="px-2 py-3 text-right text-xs font-semibold uppercase tracking-wider text-cyan-400 border-b-2 border-cyan-500/30 bg-slate-800"
                  style={{ width: col.width, minWidth: col.width }}
                >
                  {col.shortLabel}
                </th>
              ))}
              
              {/* Strike Header */}
              <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-yellow-400 border-b-2 border-yellow-500/30 bg-slate-800">
                Strike
              </th>
              
              {/* PE Headers */}
              {visiblePeColumns.map(col => (
                <th 
                  key={col.id}
                  className="px-2 py-3 text-right text-xs font-semibold uppercase tracking-wider text-orange-400 border-b-2 border-orange-500/30 bg-slate-800"
                  style={{ width: col.width, minWidth: col.width }}
                >
                  {col.shortLabel}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {rows.map((row, idx) => {
              const isAtm = row.relative_idx === 0;
              const showSpotRow = isAtm && !reverseOrder;
              const showSpotAfter = isAtm && reverseOrder;

              return (
                <React.Fragment key={row.strike}>
                  {/* Spot Price Row - Above ATM */}
                  {showSpotRow && (
                    <tr className="bg-gradient-to-r from-slate-800 via-slate-700 to-slate-800">
                      <td 
                        colSpan={visibleCeColumns.length + 1 + visiblePeColumns.length}
                        className="py-3 text-center border-b border-slate-600"
                      >
                        <div className="flex items-center justify-center gap-4 sm:gap-6">
                          <span className="text-slate-400 text-sm hidden sm:inline">Spot Price</span>
                          <span className="text-xl sm:text-2xl font-bold text-white">
                            {spotPrice.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                          </span>
                          <span className={`flex items-center gap-1 text-base sm:text-lg font-semibold ${spotChng >= 0 ? "text-green-400" : "text-red-400"}`}>
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
                      ${isAtm ? "bg-yellow-500/20 hover:bg-yellow-500/30" : "hover:bg-slate-800/50"}
                      ${row.relative_idx < 0 ? (reverseOrder ? "bg-orange-950/20" : "bg-cyan-950/20") : ""}
                      ${row.relative_idx > 0 ? (reverseOrder ? "bg-cyan-950/20" : "bg-orange-950/20") : ""}
                      transition-colors
                    `}
                  >
                    {/* CE Cells */}
                    {visibleCeColumns.map(col => renderCell(row, col, "ce"))}
                    
                    {/* Strike */}
                    <td className={`
                      px-4 py-2 text-center font-bold border-x border-slate-600
                      ${isAtm ? "text-yellow-300 text-lg bg-yellow-500/10" : "text-slate-200"}
                    `}>
                      {row.strike}
                    </td>
                    
                    {/* PE Cells */}
                    {visiblePeColumns.map(col => renderCell(row, col, "pe"))}
                  </tr>

                  {/* Spot Price Row - Below ATM (for reverse order) */}
                  {showSpotAfter && (
                    <tr className="bg-gradient-to-r from-slate-800 via-slate-700 to-slate-800">
                      <td 
                        colSpan={visibleCeColumns.length + 1 + visiblePeColumns.length}
                        className="py-3 text-center border-t border-slate-600"
                      >
                        <div className="flex items-center justify-center gap-4 sm:gap-6">
                          <span className="text-slate-400 text-sm hidden sm:inline">Spot Price</span>
                          <span className="text-xl sm:text-2xl font-bold text-white">
                            {spotPrice.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                          </span>
                          <span className={`flex items-center gap-1 text-base sm:text-lg font-semibold ${spotChng >= 0 ? "text-green-400" : "text-red-400"}`}>
                            {spotChng >= 0 ? <TrendingUp className="w-4 h-4 sm:w-5 sm:h-5" /> : <TrendingDown className="w-4 h-4 sm:w-5 sm:h-5" />}
                            {spotChng >= 0 ? "+" : ""}{spotChng.toFixed(2)}
                          </span>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ==================== SETTINGS MODAL ==================== */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-slate-800 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-auto">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700 sticky top-0 bg-slate-800">
              <h2 className="text-xl font-bold">Settings</h2>
              <button
                onClick={() => setSettingsOpen(false)}
                className="p-2 rounded-lg hover:bg-slate-700 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-6">
              {/* Strike Order */}
              <div>
                <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">Strike Order</h3>
                <div className="flex gap-3">
                  <button
                    onClick={() => setReverseOrder(false)}
                    className={`flex-1 px-4 py-3 rounded-lg border-2 transition-all ${!reverseOrder ? "border-cyan-500 bg-cyan-500/20" : "border-slate-600 hover:border-slate-500"}`}
                  >
                    <div className="text-sm font-medium">Small ↑ Big ↓</div>
                    <div className="text-xs text-slate-400 mt-1">Lower strikes on top</div>
                  </button>
                  <button
                    onClick={() => setReverseOrder(true)}
                    className={`flex-1 px-4 py-3 rounded-lg border-2 transition-all ${reverseOrder ? "border-cyan-500 bg-cyan-500/20" : "border-slate-600 hover:border-slate-500"}`}
                  >
                    <div className="text-sm font-medium">Big ↑ Small ↓</div>
                    <div className="text-xs text-slate-400 mt-1">Higher strikes on top</div>
                  </button>
                </div>
              </div>

              {/* CE Columns */}
              <div>
                <h3 className="text-sm font-semibold text-cyan-400 uppercase tracking-wider mb-3">CE Columns</h3>
                <div className="space-y-2">
                  {ceColumns.map((col, idx) => (
                    <div
                      key={col.id}
                      className="flex items-center gap-3 bg-slate-700/50 rounded-lg px-4 py-2"
                    >
                      <input
                        type="checkbox"
                        checked={col.visible}
                        onChange={() => toggleColumnVisibility("ce", col.id)}
                        className="w-4 h-4 rounded border-slate-500 text-cyan-500 focus:ring-cyan-500"
                      />
                      <span className="flex-1 text-sm">{col.label}</span>
                      <div className="flex gap-1">
                        <button
                          onClick={() => idx > 0 && moveColumn("ce", idx, idx - 1)}
                          disabled={idx === 0}
                          className="px-2 py-1 text-xs bg-slate-600 rounded hover:bg-slate-500 disabled:opacity-30"
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => idx < ceColumns.length - 1 && moveColumn("ce", idx, idx + 1)}
                          disabled={idx === ceColumns.length - 1}
                          className="px-2 py-1 text-xs bg-slate-600 rounded hover:bg-slate-500 disabled:opacity-30"
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
                <h3 className="text-sm font-semibold text-orange-400 uppercase tracking-wider mb-3">PE Columns</h3>
                <div className="space-y-2">
                  {peColumns.map((col, idx) => (
                    <div
                      key={col.id}
                      className="flex items-center gap-3 bg-slate-700/50 rounded-lg px-4 py-2"
                    >
                      <input
                        type="checkbox"
                        checked={col.visible}
                        onChange={() => toggleColumnVisibility("pe", col.id)}
                        className="w-4 h-4 rounded border-slate-500 text-orange-500 focus:ring-orange-500"
                      />
                      <span className="flex-1 text-sm">{col.label}</span>
                      <div className="flex gap-1">
                        <button
                          onClick={() => idx > 0 && moveColumn("pe", idx, idx - 1)}
                          disabled={idx === 0}
                          className="px-2 py-1 text-xs bg-slate-600 rounded hover:bg-slate-500 disabled:opacity-30"
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => idx < peColumns.length - 1 && moveColumn("pe", idx, idx + 1)}
                          disabled={idx === peColumns.length - 1}
                          className="px-2 py-1 text-xs bg-slate-600 rounded hover:bg-slate-500 disabled:opacity-30"
                        >
                          ↓
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Reset Settings */}
              <div className="pt-4 border-t border-slate-700">
                <button
                  onClick={() => {
                    setCeColumns(DEFAULT_CE_COLUMNS);
                    setPeColumns(DEFAULT_PE_COLUMNS);
                    setReverseOrder(false);
                  }}
                  className="px-4 py-2 text-sm bg-red-600/20 text-red-400 rounded-lg hover:bg-red-600/30 transition-colors"
                >
                  Reset to Defaults
                </button>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-slate-700 flex justify-between items-center sticky bottom-0 bg-slate-800">
              <span className="text-xs text-slate-500">Settings auto-saved locally</span>
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
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-slate-800 border border-slate-600 rounded-xl px-4 sm:px-6 py-3 shadow-2xl flex items-center gap-3 sm:gap-4">
          <div className="text-sm">
            <span className={selectedCell.side === "ce" ? "text-cyan-400" : "text-orange-400"}>
              {selectedCell.side.toUpperCase()}
            </span>
            <span className="text-white mx-2">|</span>
            <span className="text-yellow-400">Strike {selectedCell.strike}</span>
            <span className="text-white mx-2">|</span>
            <span className="text-slate-200">{selectedCell.column}</span>
          </div>
          <button
            onClick={() => setSelectedCell(null)}
            className="p-1 rounded hover:bg-slate-700"
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
