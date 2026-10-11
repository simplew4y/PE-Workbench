export interface PeAsrRuntimeConfig {
  serverUrl: string;
  maxChunkSeconds: number;
  language: string;
}

export interface PeAsrSegment {
  segment: number;
  startTime: string;
  endTime: string;
  text: string;
  language: string;
}

export interface PeAsrTranscript {
  totalText: string;
  segments: PeAsrSegment[];
  warnings: string[];
}

export type PeAsrSseEvent =
  | { type: "info"; message: string }
  | { type: "progress"; segment: number; total: number; start_time: string; end_time: string }
  | { type: "result"; segment: number; total: number; start_time: string; end_time: string; text: string; language: string }
  | { type: "error"; segment: number; total: number; message: string }
  | { type: "done"; total_segments: number; total_text: string; results?: Array<Record<string, unknown>> }
  | { type: "fatal_error"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseAsrSseLine(line: string): PeAsrSseEvent | null {
  const payload = line.startsWith("data:") ? line.slice(5).trim() : "";
  if (!payload) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  switch (raw.type) {
    case "info":
      return { type: "info", message: textField(raw.message) };
    case "progress":
      return {
        type: "progress",
        segment: numberField(raw.segment),
        total: numberField(raw.total),
        start_time: textField(raw.start_time),
        end_time: textField(raw.end_time),
      };
    case "result":
      return {
        type: "result",
        segment: numberField(raw.segment),
        total: numberField(raw.total),
        start_time: textField(raw.start_time),
        end_time: textField(raw.end_time),
        text: textField(raw.text),
        language: textField(raw.language),
      };
    case "error":
      return {
        type: "error",
        segment: numberField(raw.segment),
        total: numberField(raw.total),
        message: textField(raw.message) || "ASR segment failed",
      };
    case "done":
      return {
        type: "done",
        total_segments: numberField(raw.total_segments),
        total_text: textField(raw.total_text),
        results: Array.isArray(raw.results) ? raw.results.filter(isRecord) : undefined,
      };
    case "fatal_error":
      return { type: "fatal_error", message: textField(raw.message) || "ASR request failed" };
    default:
      return null;
  }
}

export function consumeAsrSseBuffer(
  buffer: string,
  onEvent: (event: PeAsrSseEvent) => void,
): string {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    const event = parseAsrSseLine(line.trimEnd());
    if (event) onEvent(event);
  }
  return rest;
}

function segmentFromRecord(value: Record<string, unknown>, index: number): PeAsrSegment {
  return {
    segment: typeof value.segment === "number" ? value.segment : index,
    startTime: textField(value.start_time),
    endTime: textField(value.end_time),
    text: textField(value.text),
    language: textField(value.language),
  };
}

export function renderPeAudioTranscriptMarkdown(
  filename: string,
  transcript: PeAsrTranscript,
): string {
  const languages = [...new Set(transcript.segments.map((segment) => segment.language).filter(Boolean))];
  const lines = [
    `# ${filename}`,
    "",
    `- parser: qwen3-asr`,
    `- segments: ${transcript.segments.length}`,
    ...(languages.length > 0 ? [`- language: ${languages.join(", ")}`] : []),
    "",
  ];
  for (const segment of transcript.segments) {
    const stamp = [segment.startTime, segment.endTime].filter(Boolean).join(" – ");
    lines.push(`## ${stamp || `Segment ${segment.segment + 1}`}`);
    // Bound lines so native read/grep can retrieve a paragraph without a huge chunk.
    const paragraphs = (segment.text || "_(empty)_").split("\n").flatMap((line) => {
      const characters = Array.from(line);
      if (characters.length === 0) return [""];
      const parts: string[] = [];
      for (let offset = 0; offset < characters.length; offset += 800) {
        parts.push(characters.slice(offset, offset + 800).join(""));
      }
      return parts;
    });
    lines.push("", ...paragraphs, "");
  }
  if (transcript.segments.length === 0) lines.push(transcript.totalText || "_(empty)_", "");
  if (transcript.warnings.length > 0) {
    lines.splice(5, 0, ...transcript.warnings.map((warning) => `- warning: ${warning}`));
  }
  return `${lines.join("\n")}\n`;
}

export async function transcribePeAudio(options: {
  config: PeAsrRuntimeConfig;
  filename: string;
  content: Buffer;
  mimeType?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<PeAsrTranscript> {
  const form = new FormData();
  const bytes = new Uint8Array(options.content);
  form.append(
    "file",
    new File([bytes], options.filename, { type: options.mimeType || "application/octet-stream" }),
  );
  form.append("max_chunk_seconds", String(options.config.maxChunkSeconds));
  if (options.config.language) form.append("language", options.config.language);

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${options.config.serverUrl}/asr/transcribe`, {
    method: "POST",
    body: form,
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`ASR HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("ASR response had no body");

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const segments: PeAsrSegment[] = [];
  const warnings: string[] = [];
  let totalText = "";
  let completed = false;
  let declaredSegments = 0;
  let expectedSegments = 0;
  const failedSegments = new Set<number>();
  let buffer = "";

  const onEvent = (event: PeAsrSseEvent) => {
    if (event.type === "result" || event.type === "error" || event.type === "progress") {
      if (!Number.isSafeInteger(event.total) || event.total < 1 ||
          !Number.isSafeInteger(event.segment) || event.segment < 0 || event.segment >= event.total) {
        throw new Error("ASR returned invalid segment coverage");
      }
      expectedSegments = Math.max(expectedSegments, event.total);
    }
    if (event.type === "result") {
      if (segments.some((segment) => segment.segment === event.segment)) {
        throw new Error("ASR returned a duplicate segment");
      }
      segments.push({
        segment: event.segment,
        startTime: event.start_time,
        endTime: event.end_time,
        text: event.text,
        language: event.language,
      });
      return;
    }
    if (event.type === "error") {
      failedSegments.add(event.segment);
      warnings.push(`转写不完整：segment ${event.segment + 1}: ${event.message}`);
      return;
    }
    if (event.type === "fatal_error") throw new Error(event.message);
    if (event.type === "done") {
      if (completed) throw new Error("ASR returned duplicate completion events");
      completed = true;
      declaredSegments = event.total_segments;
      totalText = event.total_text || segments.map((segment) => segment.text).filter(Boolean).join("\n");
      if (event.results && event.results.length > 0 && segments.length === 0) {
        segments.push(...event.results.map(segmentFromRecord));
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer = consumeAsrSseBuffer(`${buffer}${decoder.decode(value, { stream: true })}`, onEvent);
  }
  if (buffer.trim()) consumeAsrSseBuffer(`${buffer}\n`, onEvent);
  if (!completed) throw new Error("ASR 转写不完整：连接结束但未收到完成事件，未发布转录稿");
  if (!Number.isSafeInteger(declaredSegments) || declaredSegments < 1) {
    throw new Error("ASR returned invalid completion coverage");
  }
  if (segments.length === 0 && declaredSegments > 1) {
    throw new Error("ASR 转写不完整：缺少分段结果，无法核对覆盖范围");
  }
  if (segments.length > 0) {
    const ids = new Set(segments.map((segment) => segment.segment));
    if (ids.size !== segments.length) throw new Error("ASR returned duplicate segments");
    const expected = Math.max(expectedSegments, declaredSegments);
    for (let index = 0; index < expected; index++) {
      if (!ids.has(index) && !failedSegments.has(index)) {
        throw new Error(`ASR 转写不完整：缺少第 ${index + 1} 段，未发布转录稿`);
      }
    }
    if (segments.some((segment) => !Number.isSafeInteger(segment.segment) || segment.segment < 0 || segment.segment >= expected)) {
      throw new Error("ASR returned invalid segment IDs");
    }
    if (declaredSegments !== segments.length && declaredSegments !== expected) {
      throw new Error("ASR 转写不完整：完成事件与分段数量不一致");
    }
    segments.sort((left, right) => left.segment - right.segment);
    totalText = segments.map((segment) => segment.text).filter(Boolean).join("\n");
    for (const segment of segments) {
      if (!segment.text.trim()) warnings.push(`转写不完整：第 ${segment.segment + 1} 段为空，请核对原录音`);
    }
  }
  if (segments.length === 0 && !totalText) {
    throw new Error("ASR returned no transcript");
  }
  if (segments.length === 0) {
    segments.push({
      segment: 0,
      startTime: "",
      endTime: "",
      text: totalText,
      language: "",
    });
  }
  return { totalText, segments, warnings };
}
