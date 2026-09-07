/**
 * Consensus/divergence is still under development. It stays off unless a deployment opts in with
 * PE_CONSENSUS_ENABLED=1, so a production install never registers the tool, never spends model
 * calls building cards at ingest, and never serves the cards API.
 *
 * Read at call time rather than at module load so a process can set it before building the prompt.
 */
export function isPeConsensusEnabled(): boolean {
	return (process.env.PE_CONSENSUS_ENABLED ?? "").trim() === "1";
}
