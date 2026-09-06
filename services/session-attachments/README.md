# Session attachment extractor

This isolated Python helper preserves the existing multi-format chat attachment
behavior. It is not part of the project PDF ingestion pipeline, which runs in
TypeScript under `lib/pe-ingest/`.

Set up the optional chat attachment environment once:

```bash
bash services/session-attachments/setup.sh
```
