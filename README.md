# RCC Extraction Agent (LangGraph.js)

RCC structural drawing extraction (beam, column, slab, footing) — TypeScript port of the cowork
Python pipeline using LangChain + LangGraph.

```
START → ingest → supervisor ⇒ extract(beam∥column∥slab∥footing) → context → validate → persist → END
```

## Quick start

```bash
npm install
cp .env.example .env   # add OPENAI_API_KEY

# batch a folder of drawings (like auto_runner.py)
npm run cli -- ./input

# or run the API
npm run dev
curl -F "file=@input/pattern-1.pdf" http://localhost:3000/extract
curl http://localhost:3000/extract/<jobId>
curl http://localhost:3000/extract/<jobId>/trace
```

Outputs land in `storage/processed/<jobId>/` as `<name>.json` + `<name>_trace.json`,
same shape as the Python pipeline.

See PLAN.md for architecture, build order, and design decisions.
