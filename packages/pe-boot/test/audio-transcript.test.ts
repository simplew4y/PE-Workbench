import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { preparePeDocument } from "../src/documents.ts";
import { resolvePeEvidenceSource } from "../src/evidence.ts";
import { sourceId } from "../src/source.ts";
import { createDocumentProject } from "./document-fixture.ts";

describe("audio transcripts", () => {
	it("opens a transcribed audio document as readable text", async () => {
		const root = createDocumentProject();
		const wav = Buffer.from("RIFF....WAVEfmt ");
		wav.write("WAVE", 8);
		writeFileSync(join(root, "raw", "call.wav"), wav);
		mkdirSync(join(root, "meta", "text"), { recursive: true });
		writeFileSync(join(root, "meta", "text", "doc-audio.md"), "# call.wav\n\nhello from asr\n");
		const checksum = createHash("sha256").update(wav).digest("hex");
		const now = new Date().toISOString();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		try {
			database
				.prepare(
					`INSERT INTO documents (
            doc_id,dataset_id,logical_doc_id,version_no,is_current,original_filename,filename_key,
            source_relpath,stored_path,raw_path,file_type,checksum,sha256,file_size,status,
            readable_text_path,document_markdown_path,parser_name,parser_version,warnings_json,
            created_at,updated_at
          ) VALUES (
            'doc-audio','dataset-1','logical-audio',1,1,'call.wav','call.wav',
            'call.wav','raw/call.wav','raw/call.wav','wav',?,?,?,'completed',
            'meta/text/doc-audio.md','meta/text/doc-audio.md','qwen3-asr','1','[]',?,?
          )`,
				)
				.run(checksum, checksum, wav.length, now, now);
		} finally {
			database.close();
		}

		const prepared = await preparePeDocument(root, { path: "call.wav", datasetId: "dataset-1" });
		expect(prepared.document.file_type).toBe("wav");
		const readable = readFileSync(prepared.readablePath, "utf8");
		expect(readable).toContain("hello from asr");
		expect(readable).toContain("#pe-source?evidence_id=");
		expect(readable.match(/#pe-source\?/g)).toHaveLength(1);
		const id = sourceId({ docId: "doc-audio", location: { kind: "text", lineStart: 3, lineEnd: 3 } });
		const source = await resolvePeEvidenceSource(root, id);
		expect(source.payload.kind).toBe("text");
		if (source.payload.kind !== "text") throw new Error("Expected transcript text");
		expect(source.payload.content).toBe("hello from asr");
		expect(source.payload.evidence_id).toBe(id);
	});
});
