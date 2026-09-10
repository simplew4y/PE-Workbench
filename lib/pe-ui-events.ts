export const PE_OPEN_MODELS_EVENT = "pe:open-models-config";
export const PE_OPEN_SKILLS_EVENT = "pe:open-skills-config";
export const PE_OPEN_PLUGINS_EVENT = "pe:open-plugins-config";
export const PE_MODEL_SERVICE_CHANGED_EVENT = "pe:model-service-changed";

export interface PeOpenConfigEventDetail {
  opened: boolean;
  error?: string;
}

export interface PeModelServiceChangedEventDetail {
  source: "platform" | "custom";
  balanceCny: string;
  selectedModel?: string | null;
  sessionId?: string | null;
  appliedModel?: { provider: string; modelId: string } | null;
}
