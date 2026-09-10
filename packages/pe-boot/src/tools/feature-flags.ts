/** 共识默认关闭；SDK 工具、Skill、Web API 和上传后分析使用同一个服务端开关。 */
export function isPeConsensusEnabled(): boolean {
	// 调用时读取，避免模块初始化时固化开关，使工具注册与提示词可见性不一致。
	return (process.env.PE_CONSENSUS_ENABLED ?? "").trim() === "1";
}
