/**
 * Normalize relay receipt signatures without treating their presence as proof
 * that the resulting position was indexed. Position reconciliation remains
 * the success boundary for a tracked deploy.
 */
export function normalizeRelayExecutionSignatures(result) {
  const signatures = [];
  const seen = new Set();
  for (const value of []
    .concat(result?.signatures || [])
    .concat(result?.result?.txHashes || [])
    .concat(result?.result?.signatures || [])
    .concat(result?.result?.signature ? [result.result.signature] : [])) {
    if (typeof value !== "string" || !value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    signatures.push(value);
  }
  return signatures;
}

/**
 * A relay submission is successful only after a position address has been
 * observed in the reconciled position enumeration. Signatures are preserved
 * on failure so an operator can reconcile the submitted transactions.
 */
export function classifyRelayDeployResult({ submission, verifiedPositionAddress } = {}) {
  const txs = normalizeRelayExecutionSignatures(submission);
  const position = typeof verifiedPositionAddress === "string" && verifiedPositionAddress.trim()
    ? verifiedPositionAddress.trim()
    : null;
  if (position) {
    return {
      success: true,
      reconciliation_required: false,
      position,
      txs,
      error: null,
    };
  }
  return {
    success: false,
    reconciliation_required: true,
    position: null,
    txs,
    error: txs.length > 0
      ? "Relay submission returned transaction signatures but no verified position address; reconciliation is required."
      : "Relay submission did not yield a verified position address; reconciliation is required.",
  };
}
