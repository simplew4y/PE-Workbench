import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { consumeAsrSseBuffer, parseAsrSseLine, renderPeAudioTranscriptMarkdown, transcribePeAudio } = await jiti.import("./asr.ts");

test("parses Qwen3-ASR SSE event lines", () => {
  assert.deepEqual(parseAsrSseLine('data: {"type": "info", "message": "Received file"}'), {
    type: "info",
    message: "Received file",
  });
  assert.equal(parseAsrSseLine("data: not-json"), null);
  const done = parseAsrSseLine('data: {"type": "done", "total_segments": 1, "total_text": "hello", "results": []}');
  assert.equal(done.type, "done");
  assert.equal(done.total_text, "hello");
});

test("consumes buffered SSE chunks across incomplete lines", () => {
  const events = [];
  const rest = consumeAsrSseBuffer('data: {"type": "info", "message": "a"}\ndata: {"type": "fa', (event) => events.push(event));
  assert.equal(events.length, 1);
  consumeAsrSseBuffer(`${rest}tal_error", "message": "boom"}\n`, (event) => events.push(event));
  assert.equal(events[1].type, "fatal_error");
  assert.equal(events[1].message, "boom");
});

test("transcribePeAudio retains canonical segment text and records segment warnings", async () => {
  const sse = [
    'data: {"type": "info", "message": "ok"}',
    'data: {"type": "result", "segment": 0, "total": 1, "start_time": "00:00:00", "end_time": "00:00:01", "text": "hello", "language": "Chinese"}',
    'data: {"type": "error", "segment": 1, "total": 2, "message": "chunk failed"}',
    'data: {"type": "done", "total_segments": 1, "total_text": "full transcript"}',
    "",
  ].join("\n");
  const transcript = await transcribePeAudio({
    config: { serverUrl: "https://asr.example.test", maxChunkSeconds: 600, language: "" },
    filename: "call.wav",
    content: Buffer.from("RIFF"),
    fetchImpl: async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
  });
  assert.equal(transcript.totalText, "hello");
  assert.equal(transcript.segments[0].text, "hello");
  assert.deepEqual(transcript.warnings, ["转写不完整：segment 2: chunk failed"]);
  const markdown = renderPeAudioTranscriptMarkdown("call.wav", transcript);
  assert.match(markdown, /hello/u);
  assert.doesNotMatch(markdown, /Full transcript|full transcript/u);
  assert.match(markdown, /转写不完整/u);
});

test("transcribePeAudio throws on fatal_error", async () => {
  await assert.rejects(
    () => transcribePeAudio({
      config: { serverUrl: "https://asr.example.test", maxChunkSeconds: 600, language: "" },
      filename: "call.wav",
      content: Buffer.from("RIFF"),
      fetchImpl: async () => new Response('data: {"type": "fatal_error", "message": "cuda oom"}\n', {
        headers: { "content-type": "text/event-stream" },
      }),
    }),
    /cuda oom/u,
  );
});

for (const [name, events, message] of [
  ["missing completion", [{type:"result",segment:0,total:2,text:"first"}], /未收到完成事件/u],
  ["missing segment", [{type:"result",segment:0,total:2,text:"first"},{type:"done",total_segments:2,total_text:"first"}], /缺少第 2 段/u],
  ["duplicate segment", [{type:"result",segment:0,total:1,text:"a"},{type:"result",segment:0,total:1,text:"a"},{type:"done",total_segments:1}], /duplicate segment/u],
]) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(() => transcribePeAudio({
      config:{serverUrl:"https://fixture.invalid",maxChunkSeconds:600,language:""},
      filename:"call.wav",content:Buffer.from("RIFF"),
      fetchImpl:async()=>new Response(events.map(event=>`data: ${JSON.stringify(event)}`).join("\n")+"\n"),
    }), message);
  });
}

test("orders done-only segments and writes bounded text once", async () => {
  const text = "收入增长，需要核对订单。".repeat(200);
  const transcript = await transcribePeAudio({
    config:{serverUrl:"https://fixture.invalid",maxChunkSeconds:600,language:""},
    filename:"call.wav",content:Buffer.from("RIFF"),
    fetchImpl:async()=>new Response(`data: ${JSON.stringify({type:"done",total_segments:2,results:[{segment:1,text:"second"},{segment:0,text}]})}\n`),
  });
  assert.deepEqual(transcript.segments.map(segment=>segment.segment),[0,1]);
  const markdown=renderPeAudioTranscriptMarkdown("call.wav",transcript);
  assert.doesNotMatch(markdown,/Full transcript/u);
  assert.ok(markdown.split("\n").every(line=>Array.from(line).length<=800));
  assert.equal(markdown.split("second").length-1,1);
});
