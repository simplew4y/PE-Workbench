import { preparePeDocument } from "../../src/documents.ts";

const prepared = await preparePeDocument(process.argv[2], { docId: process.argv[3] });
process.stdout.write(JSON.stringify({ cachePath: prepared.cachePath, docId: prepared.document.doc_id }));
