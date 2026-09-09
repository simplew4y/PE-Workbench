/** Consensus analysis is opt-in and shares one switch across SDK tools and Web. */
export function isPeConsensusEnabled(): boolean {
	return (process.env.PE_CONSENSUS_ENABLED ?? "").trim() === "1";
}
