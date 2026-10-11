export const PE_ASR_MIN_CHUNK_SECONDS = 10;
export const PE_ASR_MAX_CHUNK_SECONDS = 600;
export const PE_ASR_DEFAULT_CHUNK_SECONDS = 600;
export const PE_ASR_NOT_CONFIGURED_MESSAGE = "上传语音文件前，请先在用户菜单的「其他设置」中配置 ASR 服务。";
export const PE_AUDIO_SUFFIXES = ["wav", "mp3", "flac", "m4a", "ogg", "aac", "webm"] as const;
export const PE_RESEARCH_UPLOAD_ACCEPT = [
  "application/pdf",
  ".pdf",
  ".xlsx",
  ".xlsm",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "audio/*",
  ...PE_AUDIO_SUFFIXES.map((suffix) => `.${suffix}`),
].join(",");

export function isPeAudioSuffix(suffix: string): boolean {
  return (PE_AUDIO_SUFFIXES as readonly string[]).includes(suffix.toLowerCase());
}
