import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import {
  getSettlementPerformanceHistory,
  getSettlementPerformanceSummary,
} from "./settlement-report.js";

const STATE_FILE = repoPath("state.json");
const LESSONS_FILE = repoPath("lessons.json");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatSol(value, digits = 6) {
  if (value == null) return "n/a";
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "n/a";
}

function signedSol(value) {
  if (value == null) return "n/a";
  const number = Number(value);
  if (!Number.isFinite(number)) return "n/a";
  return `${number >= 0 ? "+" : "-"}◎${Math.abs(number).toFixed(6)}`;
}

function signedPct(value) {
  if (value == null) return "n/a";
  const number = Number(value);
  if (!Number.isFinite(number)) return "n/a";
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}%`;
}

export async function generateBriefing() {
  const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [] };
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Positions Activity
  const allPositions = Object.values(state.positions || {});
  const openedLast24h = allPositions.filter(p => new Date(p.deployed_at) > last24h);

  // Closed-position economics never fall back to the Meteora/web PnL views.
  let settledLast24h = null;
  let settledAllTime = null;
  let settlementError = null;
  try {
    settledLast24h = getSettlementPerformanceHistory({ hours: 24, now, limit: 0 });
    settledAllTime = getSettlementPerformanceSummary({ now });
  } catch (error) {
    settlementError = error;
    log("briefing_error", `Authoritative settlement report unavailable: ${error.message}`);
  }

  // 3. Lessons Learned
  const lessonsLast24h = (lessonsData.lessons || []).filter(l => new Date(l.created_at) > last24h);

  // 4. Current State
  const openPositions = allPositions.filter(p => !p.closed);
  const performanceLines = settlementError
    ? [
        `<b>Kinerja Final On-chain:</b>`,
        `Tidak tersedia: ${escapeHtml(settlementError.message)}`,
        `Tidak memakai fallback PnL Meteora/web-LP.`,
      ]
    : [
        `<b>Kinerja Final On-chain:</b>`,
        `Sumber: arus wallet lifecycle ter-rekonsiliasi; tanpa fallback web-LP`,
        `💰 Net PnL: ${signedSol(settledLast24h.total_pnl_sol)} (${signedPct(settledLast24h.total_pnl_pct)})`,
        `Modal → Akhir: ◎${formatSol(settledLast24h.total_principal_sol)} → ◎${formatSol(settledLast24h.total_final_sol)}`,
        `Arus Wallet: keluar ◎${formatSol(settledLast24h.total_wallet_deploy_outflow_sol)} | kembali ◎${formatSol(settledLast24h.total_wallet_post_deploy_inflow_sol)}`,
        `Biaya Transaksi: ◎${formatSol(settledLast24h.total_tx_fee_sol)}`,
        settledLast24h.total_positions_settled > 0
          ? `📈 Win Rate (24 jam): ${Math.round(settledLast24h.win_rate_pct)}%`
          : "📈 Win Rate (24 jam): N/A",
        settledLast24h.settlement_pending_count > 0
          ? `⚠️ Settlement tertunda: ${settledLast24h.settlement_pending_count}`
          : null,
      ];

  // 5. Format Message
  const lines = [
    "☀️ <b>Laporan Pagi</b> (24 Jam Terakhir)",
    "────────────────",
    `<b>Aktivitas:</b>`,
    `📥 Posisi Dibuka: ${openedLast24h.length}`,
    `📤 Settlement Tunai: ${settledLast24h?.total_positions_settled ?? "tidak tersedia"}`,
    "",
    ...performanceLines,
    "",
    `<b>Pelajaran:</b>`,
    lessonsLast24h.length > 0
      ? lessonsLast24h.map(l => `• ${escapeHtml(l.rule)}`).join("\n")
      : "• Tidak ada pelajaran baru.",
    "",
    `<b>Portofolio Saat Ini:</b>`,
    `📂 Posisi Terbuka: ${openPositions.length}`,
    openPositions.length > 0 ? `PnL posisi terbuka: estimasi eksekusi, bukan hasil final` : null,
    settledAllTime?.total_positions_settled > 0
      ? `📊 PnL Final Tunai All-time: ${signedSol(settledAllTime.total_pnl_sol)} (${Math.round(settledAllTime.win_rate_pct)}% win)`
      : `📊 PnL Final Tunai All-time: N/A`,
    settledAllTime?.excluded_non_cash_count > 0
      ? `Settlement lama non-tunai yang dikecualikan: ${settledAllTime.excluded_non_cash_count}`
      : null,
    "────────────────"
  ].filter((line) => line != null);

  return lines.join("\n");
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}
