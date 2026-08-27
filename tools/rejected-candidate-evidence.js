import fs from "fs";
import path from "path";

const DEFAULT_FILE = path.resolve(process.cwd(), "rejected-candidate-evidence.jsonl");

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function rejectedCandidateEvidenceFile() {
  return path.resolve(process.env.MERIDIAN_REJECTED_CANDIDATE_EVIDENCE_FILE || DEFAULT_FILE);
}

export function buildCandidateObservation(pool, { ts = new Date().toISOString(), reasons = [] } = {}) {
  return {
    schema: "meridian.rejected-candidate-observation.v1",
    ts,
    pool: pool?.pool || pool?.pool_address || null,
    name: pool?.name || null,
    base_mint: pool?.base?.mint || pool?.token_x?.address || null,
    base_symbol: pool?.base?.symbol || pool?.token_x?.symbol || null,
    quote_mint: pool?.quote?.mint || pool?.token_y?.address || null,
    price: finite(pool?.price ?? pool?.pool_price),
    min_price: finite(pool?.min_price),
    max_price: finite(pool?.max_price),
    volatility: finite(pool?.volatility),
    tvl: finite(pool?.tvl),
    active_tvl: finite(pool?.active_tvl),
    fee_window: finite(pool?.fee_window ?? pool?.fee),
    volume_window: finite(pool?.volume_window ?? pool?.volume),
    bin_step: finite(pool?.bin_step ?? pool?.dlmm_params?.bin_step),
    rejected: reasons.length > 0,
    reasons: [...new Set(reasons.filter(Boolean).map(String))],
  };
}

export function appendCandidateObservations(observations, { file = rejectedCandidateEvidenceFile() } = {}) {
  const valid = observations.filter((entry) => entry?.pool && entry?.ts);
  if (valid.length === 0) return { file, written: 0 };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${valid.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return { file, written: valid.length };
}
