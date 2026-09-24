# BRD Ingest & Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Docker Compose stack (Next.js UI, Node.js API, Python FastAPI worker, SQLite, Ollama) that lets a single operator upload a BRD (PDF/DOCX/image), auto-parse it, generate an LLM-based reward strategy plan, store campaign history, and export the plan as a PDF.

**Architecture:** Three services behind a shared Docker network. `web-ui` (Next.js) is a thin client that only talks to `api`. `api` (Node.js/Express + better-sqlite3) owns the SQLite database, orchestrates uploads, and calls `ai-worker` synchronously for parsing and planning. `ai-worker` (Python FastAPI) is stateless — it receives a file or text, does OCR/document parsing, calls local Ollama, and returns structured JSON. No message queue; `api` calls `ai-worker` over HTTP and updates campaign status as each step completes.

**Tech Stack:** Next.js (TypeScript, App Router), Node.js + Express + TypeScript + better-sqlite3 + multer + pdfkit, Python 3.11 + FastAPI + pypdf + python-docx + Pillow + pytesseract + requests (Ollama HTTP API), Ollama (`mistral:7b-instruct`), Docker Compose with an NVIDIA GPU profile.

**Spec:** `docs/superpowers/specs/2026-09-21-brd-ingest-planner-design.md`

## Global Constraints

- Single operator only — no auth, no multi-user, no roles (spec: "Tidak termasuk").
- No auto-download of video from public links, no auto-edit/clipping (spec: "Tidak termasuk").
- No external platform integration (TikTok/Instagram/YouTube) and no real-time notifications (spec: "Tidak termasuk").
- Database is SQLite on a shared volume at `DB_PATH=/app/data/app.db`.
- `OLLAMA_MODEL=mistral:7b-instruct`, `UPLOAD_DIR=/app/uploads`, `DATA_DIR=/app/data`, `EXPORT_DIR=/app/data/exports`.
- Everything must run via `docker compose up` locally with an NVIDIA GPU profile for the RTX 4060 host.
- Focus MVP on parsing + planning correctness, not final content-generation quality; video generation/editing is deferred to the next sub-project.
- If a BRD is too varied for templates, extraction-first parsing wins over template-based parsing.

---

## File Structure

```
apps/ai-worker/
  main.py                # FastAPI app, /health, /parse, /plan routes
  parser.py               # parse_pdf, parse_docx, parse_image, extract_links
  planner.py               # build_prompt, call_ollama, parse_llm_response
  schemas.py               # pydantic request/response models
  requirements.txt
  Dockerfile
  tests/
    test_parser.py
    test_planner.py
    fixtures/
      sample.pdf
      sample.docx
      sample.png
      sample_no_text.png

apps/api/
  src/
    server.ts              # Express app bootstrap, mounts routes, healthcheck
    db.ts                    # better-sqlite3 connection + schema migration
    types.ts                  # shared TS types (Campaign, Plan, ReviewTask...)
    routes/campaigns.ts        # all /api/campaigns* routes
    services/aiWorkerClient.ts  # HTTP calls to ai-worker /parse and /plan
    services/pdfExport.ts        # renders a Plan into a PDF via pdfkit
  tests/
    db.test.ts
    campaigns.test.ts
    pdfExport.test.ts
    fixtures/sample.pdf
  package.json
  tsconfig.json
  Dockerfile

apps/web-ui/
  app/
    page.tsx                  # upload form + campaign list
    campaigns/[id]/page.tsx     # campaign detail: parsing result, plan, PDF link
  components/
    UploadForm.tsx
    CampaignList.tsx
    CampaignDetail.tsx
  lib/
    apiClient.ts                # fetch wrapper pointed at API_BASE_URL
  package.json
  tsconfig.json
  Dockerfile

docker/
  docker-compose.yml            # base stack: web-ui, api, ai-worker, ollama
  docker-compose.gpu.yml         # GPU profile override for ollama

tests/fixtures/                 # shared BRD samples referenced by spec's Testing section
  brd_sample.pdf
  brd_sample.docx
  brd_sample.png
```

Rationale: each service is a separate Dockerfile/package so they can be built, tested, and deployed independently, matching the spec's `apps/web-ui`, `apps/api`, `apps/ai-worker` layout. Inside `api`, routes/services/db are split by responsibility (routes = HTTP, services = external calls / rendering, db = persistence) because `campaigns.ts` would otherwise mix HTTP concerns with SQL and HTTP-client code.

---

### Task 1: Repo scaffolding and Docker Compose skeleton

**Files:**
- Create: `apps/ai-worker/requirements.txt`
- Create: `apps/ai-worker/Dockerfile`
- Create: `apps/ai-worker/main.py`
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/Dockerfile`
- Create: `apps/api/src/server.ts`
- Create: `apps/web-ui/package.json`
- Create: `apps/web-ui/Dockerfile`
- Create: `apps/web-ui/app/page.tsx`
- Create: `docker/docker-compose.yml`
- Create: `docker/docker-compose.gpu.yml`
- Create: `.env.example`

**Interfaces:**
- Produces: `ai-worker` listening on `:8000` with `GET /health` → `{"status": "ok"}`.
- Produces: `api` listening on `:4000` with `GET /api/health` → `{"status": "ok"}`.
- Produces: `web-ui` listening on `:3000`, root page renders `"ContentRewardFarm"`.

- [ ] **Step 1: Create `ai-worker` health-check skeleton**

`apps/ai-worker/requirements.txt`:
```
fastapi==0.115.0
uvicorn[standard]==0.30.6
pypdf==4.3.1
python-docx==1.1.2
Pillow==10.4.0
pytesseract==0.3.13
requests==2.32.3
pydantic==2.9.2
pytest==8.3.3
httpx==0.27.2
```

`apps/ai-worker/main.py`:
```python
from fastapi import FastAPI

app = FastAPI(title="contentrewardfarm-ai-worker")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
```

`apps/ai-worker/Dockerfile`:
```dockerfile
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 2: Create `api` health-check skeleton**

`apps/api/package.json`:
```json
{
  "name": "contentrewardfarm-api",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "dev": "ts-node-dev --respawn src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "test": "jest"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "express": "^4.21.0",
    "multer": "^1.4.5-lts.1",
    "pdfkit": "^0.15.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/jest": "^29.5.13",
    "@types/multer": "^1.4.12",
    "@types/node": "^20.16.5",
    "@types/pdfkit": "^0.13.4",
    "@types/supertest": "^6.0.2",
    "jest": "^29.7.0",
    "supertest": "^7.0.0",
    "ts-jest": "^29.2.5",
    "ts-node-dev": "^2.0.0",
    "typescript": "^5.6.2"
  }
}
```

`apps/api/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

`apps/api/src/server.ts`:
```typescript
import express from "express";

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  const port = process.env.PORT ?? 4000;
  app.listen(port, () => console.log(`api listening on ${port}`));
}
```

`apps/api/Dockerfile`:
```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build
CMD ["node", "dist/server.js"]
```

- [ ] **Step 3: Create `web-ui` skeleton**

`apps/web-ui/package.json`:
```json
{
  "name": "contentrewardfarm-web-ui",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "14.2.13",
    "react": "18.3.1",
    "react-dom": "18.3.1"
  },
  "devDependencies": {
    "typescript": "^5.6.2",
    "@types/react": "^18.3.5",
    "@types/node": "^20.16.5"
  }
}
```

`apps/web-ui/app/page.tsx`:
```tsx
export default function HomePage() {
  return (
    <main>
      <h1>ContentRewardFarm</h1>
    </main>
  );
}
```

`apps/web-ui/Dockerfile`:
```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build
CMD ["npm", "start"]
```

- [ ] **Step 4: Write base Docker Compose files**

`docker/docker-compose.yml`:
```yaml
services:
  web-ui:
    build: ../apps/web-ui
    ports:
      - "3000:3000"
    environment:
      - API_BASE_URL=http://api:4000
    depends_on:
      - api

  api:
    build: ../apps/api
    ports:
      - "4000:4000"
    environment:
      - PORT=4000
      - UPLOAD_DIR=/app/uploads
      - DATA_DIR=/app/data
      - DB_PATH=/app/data/app.db
      - EXPORT_DIR=/app/data/exports
      - AI_WORKER_URL=http://ai-worker:8000
    volumes:
      - uploads:/app/uploads
      - data:/app/data
    depends_on:
      - ai-worker

  ai-worker:
    build: ../apps/ai-worker
    ports:
      - "8000:8000"
    environment:
      - OLLAMA_URL=http://ollama:11434
      - OLLAMA_MODEL=mistral:7b-instruct
    depends_on:
      - ollama

  ollama:
    image: ollama/ollama:latest
    ports:
      - "11434:11434"
    volumes:
      - ollama:/root/.ollama

volumes:
  uploads:
  data:
  ollama:
```

`docker/docker-compose.gpu.yml`:
```yaml
services:
  ollama:
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

`.env.example`:
```
OLLAMA_MODEL=mistral:7b-instruct
UPLOAD_DIR=/app/uploads
DATA_DIR=/app/data
DB_PATH=/app/data/app.db
EXPORT_DIR=/app/data/exports
```

- [ ] **Step 5: Verify the stack boots**

Run: `docker compose -f docker/docker-compose.yml up --build -d`
Expected: three containers running; `curl localhost:8000/health` → `{"status":"ok"}`; `curl localhost:4000/api/health` → `{"status":"ok"}`; `curl localhost:3000` → HTML containing `ContentRewardFarm`.

Run: `docker compose -f docker/docker-compose.yml down`

- [ ] **Step 6: Commit**

```bash
git add apps docker .env.example
git commit -m "chore: scaffold web-ui, api, ai-worker services with compose stack"
```

---

### Task 2: `ai-worker` document parsers (PDF, DOCX, image OCR)

**Files:**
- Create: `apps/ai-worker/parser.py`
- Create: `apps/ai-worker/schemas.py`
- Create: `apps/ai-worker/tests/test_parser.py`
- Create: `apps/ai-worker/tests/fixtures/sample.pdf`
- Create: `apps/ai-worker/tests/fixtures/sample.docx`
- Create: `apps/ai-worker/tests/fixtures/sample.png`

**Interfaces:**
- Consumes: nothing from earlier tasks (parser is a pure module).
- Produces: `parse_document(file_path: str, doc_type: str) -> ParsedDocument` where `ParsedDocument` is a pydantic model with fields `raw_text: str`, `extracted_links: list[str]`, `parsing_confidence: float`. Task 3 and Task 4 (`/parse` route) depend on this exact signature and field names.

- [ ] **Step 1: Write failing tests for each format**

`apps/ai-worker/tests/test_parser.py`:
```python
import os
from parser import parse_document

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def test_parse_pdf_extracts_text_and_links():
    result = parse_document(os.path.join(FIXTURES, "sample.pdf"), "pdf")
    assert "Reward Campaign" in result.raw_text
    assert "https://example.com/brief-video" in result.extracted_links
    assert result.parsing_confidence > 0.5


def test_parse_docx_extracts_text_and_links():
    result = parse_document(os.path.join(FIXTURES, "sample.docx"), "docx")
    assert "Reward Campaign" in result.raw_text
    assert "https://example.com/brief-video" in result.extracted_links
    assert result.parsing_confidence > 0.5


def test_parse_image_uses_ocr():
    result = parse_document(os.path.join(FIXTURES, "sample.png"), "image")
    assert "REWARD" in result.raw_text.upper()
    assert 0.0 <= result.parsing_confidence <= 1.0


def test_parse_unknown_type_raises():
    import pytest

    with pytest.raises(ValueError):
        parse_document(os.path.join(FIXTURES, "sample.pdf"), "csv")
```

- [ ] **Step 2: Generate fixture files**

Run this once to create fixtures (not a test step, a setup script executed manually):
```python
# scripts/make_fixtures.py — run with: python scripts/make_fixtures.py
from pypdf import PdfWriter
from docx import Document
from PIL import Image, ImageDraw

# sample.pdf
writer = PdfWriter()
writer.add_blank_page(width=200, height=200)
with open("apps/ai-worker/tests/fixtures/sample.pdf", "wb") as f:
    writer.write(f)
# Note: pypdf can't easily draw text on a blank page; for a real text
# fixture, generate via reportlab instead. Swap sample.pdf for a
# reportlab-generated PDF containing:
#   "Reward Campaign Brief\nSource: https://example.com/brief-video"

# sample.docx
doc = Document()
doc.add_paragraph("Reward Campaign Brief")
doc.add_paragraph("Source: https://example.com/brief-video")
doc.save("apps/ai-worker/tests/fixtures/sample.docx")

# sample.png
img = Image.new("RGB", (400, 100), color="white")
draw = ImageDraw.Draw(img)
draw.text((10, 40), "REWARD CAMPAIGN", fill="black")
img.save("apps/ai-worker/tests/fixtures/sample.png")
```

Add `reportlab==4.2.2` to `apps/ai-worker/requirements.txt` and regenerate `sample.pdf` with:
```python
from reportlab.pdfgen import canvas

c = canvas.Canvas("apps/ai-worker/tests/fixtures/sample.pdf")
c.drawString(50, 750, "Reward Campaign Brief")
c.drawString(50, 730, "Source: https://example.com/brief-video")
c.save()
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/ai-worker && python -m pytest tests/test_parser.py -v`
Expected: `ModuleNotFoundError: No module named 'parser'` (or import error) since `parser.py` doesn't exist yet.

- [ ] **Step 4: Implement schemas and parser**

`apps/ai-worker/schemas.py`:
```python
from pydantic import BaseModel


class ParsedDocument(BaseModel):
    raw_text: str
    extracted_links: list[str]
    parsing_confidence: float
```

`apps/ai-worker/parser.py`:
```python
import re

import pytesseract
from docx import Document
from PIL import Image
from pypdf import PdfReader

from schemas import ParsedDocument

URL_RE = re.compile(r"https?://[^\s)>\]]+")


def extract_links(text: str) -> list[str]:
    return list(dict.fromkeys(URL_RE.findall(text)))


def _parse_pdf(file_path: str) -> tuple[str, float]:
    reader = PdfReader(file_path)
    pages = [page.extract_text() or "" for page in reader.pages]
    text = "\n".join(pages)
    confidence = 0.9 if text.strip() else 0.1
    return text, confidence


def _parse_docx(file_path: str) -> tuple[str, float]:
    doc = Document(file_path)
    text = "\n".join(p.text for p in doc.paragraphs)
    confidence = 0.9 if text.strip() else 0.1
    return text, confidence


def _parse_image(file_path: str) -> tuple[str, float]:
    image = Image.open(file_path)
    data = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT)
    words = [w for w in data["text"] if w.strip()]
    text = " ".join(words)
    confidences = [int(c) for c in data["conf"] if c not in ("-1", -1)]
    confidence = (sum(confidences) / len(confidences) / 100) if confidences else 0.0
    return text, confidence


PARSERS = {
    "pdf": _parse_pdf,
    "docx": _parse_docx,
    "image": _parse_image,
}


def parse_document(file_path: str, doc_type: str) -> ParsedDocument:
    if doc_type not in PARSERS:
        raise ValueError(f"unsupported doc_type: {doc_type}")
    text, confidence = PARSERS[doc_type](file_path)
    return ParsedDocument(
        raw_text=text,
        extracted_links=extract_links(text),
        parsing_confidence=confidence,
    )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/ai-worker && python -m pytest tests/test_parser.py -v`
Expected: all 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/ai-worker/parser.py apps/ai-worker/schemas.py apps/ai-worker/tests apps/ai-worker/requirements.txt scripts/make_fixtures.py
git commit -m "feat(ai-worker): parse PDF, DOCX, and image BRDs with link extraction"
```

---

### Task 3: `ai-worker` LLM planner (Ollama call + prompt/response parsing)

**Files:**
- Create: `apps/ai-worker/planner.py`
- Modify: `apps/ai-worker/schemas.py`
- Create: `apps/ai-worker/tests/test_planner.py`

**Interfaces:**
- Consumes: nothing from Task 2 directly (planner takes plain text, not `ParsedDocument`), so it can be tested in isolation.
- Produces: `build_prompt(campaign_summary: str, requirements_text: str, example_links: list[str], content_format: str, target_language: str, deadline: str, reward: str, constraints: str) -> str`; `call_ollama(prompt: str, ollama_url: str, model: str) -> str` (raw LLM text response); `parse_llm_response(raw: str) -> PlanResult` where `PlanResult` has `strategy_summary: str`, `requirements_checklist: list[str]`, `content_plan: dict`, `opportunity_score: int`. Task 4 (`/plan` route) depends on these three function names and `PlanResult`'s fields.

- [ ] **Step 1: Write failing tests**

`apps/ai-worker/tests/test_planner.py`:
```python
import json
from unittest.mock import patch

from planner import build_prompt, call_ollama, parse_llm_response


def test_build_prompt_includes_all_inputs():
    prompt = build_prompt(
        campaign_summary="Promote a snack brand",
        requirements_text="Must show product in first 3 seconds",
        example_links=["https://example.com/brief-video"],
        content_format="15s vertical video",
        target_language="id",
        deadline="2026-10-01",
        reward="Rp 500.000",
        constraints="No profanity",
    )
    assert "Promote a snack brand" in prompt
    assert "Must show product in first 3 seconds" in prompt
    assert "https://example.com/brief-video" in prompt
    assert "15s vertical video" in prompt
    assert "id" in prompt
    assert "2026-10-01" in prompt
    assert "Rp 500.000" in prompt
    assert "No profanity" in prompt


def test_call_ollama_posts_to_generate_endpoint():
    with patch("planner.requests.post") as mock_post:
        mock_post.return_value.json.return_value = {"response": "hello"}
        mock_post.return_value.raise_for_status.return_value = None
        result = call_ollama("prompt text", "http://ollama:11434", "mistral:7b-instruct")
        assert result == "hello"
        mock_post.assert_called_once_with(
            "http://ollama:11434/api/generate",
            json={"model": "mistral:7b-instruct", "prompt": "prompt text", "stream": False},
            timeout=120,
        )


def test_parse_llm_response_extracts_json_from_fenced_block():
    raw = """Here is the plan:
```json
{
  "strategy_summary": "Focus on unboxing hook",
  "requirements_checklist": ["Show product in 3s", "Use hashtag #brand"],
  "content_plan": {"hook": "Surprise reveal", "script": "...", "assets": ["product shot"]},
  "opportunity_score": 72
}
```
"""
    result = parse_llm_response(raw)
    assert result.strategy_summary == "Focus on unboxing hook"
    assert result.requirements_checklist == ["Show product in 3s", "Use hashtag #brand"]
    assert result.content_plan["hook"] == "Surprise reveal"
    assert result.opportunity_score == 72


def test_parse_llm_response_raises_on_missing_json():
    import pytest

    with pytest.raises(ValueError):
        parse_llm_response("no json here")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/ai-worker && python -m pytest tests/test_planner.py -v`
Expected: `ModuleNotFoundError: No module named 'planner'`.

- [ ] **Step 3: Implement planner**

Add to `apps/ai-worker/schemas.py`:
```python
class PlanResult(BaseModel):
    strategy_summary: str
    requirements_checklist: list[str]
    content_plan: dict
    opportunity_score: int
```

`apps/ai-worker/planner.py`:
```python
import json
import re

import requests

from schemas import PlanResult

PROMPT_TEMPLATE = """You are a content reward campaign strategist.

Campaign summary:
{campaign_summary}

Requirements from BRD:
{requirements_text}

Example links:
{example_links}

Content format requested: {content_format}
Target language: {target_language}
Deadline: {deadline}
Reward: {reward}
Constraints/risks: {constraints}

Respond with ONLY a JSON object in a ```json code block with these keys:
strategy_summary (string), requirements_checklist (array of strings),
content_plan (object with hook, script, assets, schedule),
opportunity_score (integer 0-100).
"""

JSON_BLOCK_RE = re.compile(r"```json\s*(\{.*?\})\s*```", re.DOTALL)


def build_prompt(
    campaign_summary: str,
    requirements_text: str,
    example_links: list[str],
    content_format: str,
    target_language: str,
    deadline: str,
    reward: str,
    constraints: str,
) -> str:
    return PROMPT_TEMPLATE.format(
        campaign_summary=campaign_summary,
        requirements_text=requirements_text,
        example_links="\n".join(example_links) or "none",
        content_format=content_format,
        target_language=target_language,
        deadline=deadline,
        reward=reward,
        constraints=constraints,
    )


def call_ollama(prompt: str, ollama_url: str, model: str) -> str:
    response = requests.post(
        f"{ollama_url}/api/generate",
        json={"model": model, "prompt": prompt, "stream": False},
        timeout=120,
    )
    response.raise_for_status()
    return response.json()["response"]


def parse_llm_response(raw: str) -> PlanResult:
    match = JSON_BLOCK_RE.search(raw)
    if not match:
        raise ValueError("no JSON block found in LLM response")
    data = json.loads(match.group(1))
    return PlanResult(**data)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/ai-worker && python -m pytest tests/test_planner.py -v`
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ai-worker/planner.py apps/ai-worker/schemas.py apps/ai-worker/tests/test_planner.py
git commit -m "feat(ai-worker): build LLM prompt, call Ollama, parse plan JSON"
```

---

### Task 4: `ai-worker` HTTP routes `/parse` and `/plan`

**Files:**
- Modify: `apps/ai-worker/main.py`
- Create: `apps/ai-worker/tests/test_main.py`

**Interfaces:**
- Consumes: `parse_document` from Task 2, `build_prompt`/`call_ollama`/`parse_llm_response` from Task 3.
- Produces: `POST /parse` accepting `{"file_path": str, "doc_type": str}`, returning the `ParsedDocument` JSON. `POST /plan` accepting `{"campaign_summary": str, "requirements_text": str, "example_links": list[str], "content_format": str, "target_language": str, "deadline": str, "reward": str, "constraints": str}`, returning `PlanResult` JSON. Task 6 (`aiWorkerClient.ts`) depends on these exact request/response shapes.

- [ ] **Step 1: Write failing tests using FastAPI TestClient**

`apps/ai-worker/tests/test_main.py`:
```python
import os
from unittest.mock import patch

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)
FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def test_health():
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_parse_route_returns_parsed_document():
    resp = client.post(
        "/parse",
        json={"file_path": os.path.join(FIXTURES, "sample.docx"), "doc_type": "docx"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "Reward Campaign" in body["raw_text"]
    assert body["extracted_links"] == ["https://example.com/brief-video"]


def test_parse_route_invalid_doc_type_returns_400():
    resp = client.post(
        "/parse",
        json={"file_path": os.path.join(FIXTURES, "sample.docx"), "doc_type": "csv"},
    )
    assert resp.status_code == 400


def test_plan_route_returns_plan_result():
    fake_raw = (
        "Here is the plan:\n"
        "```json\n"
        "{\n"
        '  "strategy_summary": "s",\n'
        '  "requirements_checklist": ["a"],\n'
        '  "content_plan": {"hook": "h"},\n'
        '  "opportunity_score": 50\n'
        "}\n"
        "```"
    )
    with patch("main.call_ollama", return_value=fake_raw):
        resp = client.post(
            "/plan",
            json={
                "campaign_summary": "sum",
                "requirements_text": "req",
                "example_links": [],
                "content_format": "video",
                "target_language": "id",
                "deadline": "2026-10-01",
                "reward": "500k",
                "constraints": "none",
            },
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["strategy_summary"] == "s"
    assert body["opportunity_score"] == 50
````

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/ai-worker && python -m pytest tests/test_main.py -v`
Expected: FAIL — routes `/parse` and `/plan` return 404 (not defined yet).

- [ ] **Step 3: Implement routes**

`apps/ai-worker/main.py`:
```python
import os

from fastapi import FastAPI, HTTPException

from parser import parse_document
from planner import build_prompt, call_ollama, parse_llm_response
from schemas import ParsedDocument, PlanResult

app = FastAPI(title="contentrewardfarm-ai-worker")

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "mistral:7b-instruct")


class ParseRequest(dict):
    pass


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/parse", response_model=ParsedDocument)
def parse(payload: dict) -> ParsedDocument:
    try:
        return parse_document(payload["file_path"], payload["doc_type"])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/plan", response_model=PlanResult)
def plan(payload: dict) -> PlanResult:
    prompt = build_prompt(
        campaign_summary=payload["campaign_summary"],
        requirements_text=payload["requirements_text"],
        example_links=payload["example_links"],
        content_format=payload["content_format"],
        target_language=payload["target_language"],
        deadline=payload["deadline"],
        reward=payload["reward"],
        constraints=payload["constraints"],
    )
    raw = call_ollama(prompt, OLLAMA_URL, OLLAMA_MODEL)
    try:
        return parse_llm_response(raw)
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/ai-worker && python -m pytest tests/test_main.py -v`
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ai-worker/main.py apps/ai-worker/tests/test_main.py
git commit -m "feat(ai-worker): expose /parse and /plan HTTP routes"
```

---

### Task 5: `api` SQLite schema and database module

**Files:**
- Create: `apps/api/src/db.ts`
- Create: `apps/api/src/types.ts`
- Create: `apps/api/tests/db.test.ts`
- Add to `apps/api/package.json`: jest config (see Step 4)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `getDb(dbPath: string): Database` (better-sqlite3 instance with schema applied), and TS types `Campaign`, `BrdDocument`, `Plan`, `ReviewTask` matching the spec's four tables exactly (field names/types). Tasks 6 and 7 depend on these table names, column names, and types.

- [ ] **Step 1: Write failing test**

`apps/api/tests/db.test.ts`:
```typescript
import fs from "fs";
import os from "os";
import path from "path";
import { getDb } from "../src/db";

describe("getDb", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-${Date.now()}.db`);
  });

  afterEach(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it("creates all four tables", () => {
    const db = getDb(dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row: any) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining(["campaigns", "brd_documents", "plans", "review_tasks"])
    );
    db.close();
  });

  it("inserts and reads a campaign row", () => {
    const db = getDb(dbPath);
    db.prepare(
      `INSERT INTO campaigns (id, title, status, source_file_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("c1", "Test Campaign", "uploaded", "/uploads/c1.pdf", "2026-09-21", "2026-09-21");
    const row = db.prepare("SELECT * FROM campaigns WHERE id = ?").get("c1") as any;
    expect(row.title).toBe("Test Campaign");
    expect(row.status).toBe("uploaded");
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/db.test.ts`
Expected: FAIL — `Cannot find module '../src/db'`.

- [ ] **Step 3: Implement types and db module**

`apps/api/src/types.ts`:
```typescript
export type CampaignStatus =
  | "uploaded"
  | "parsing"
  | "planned"
  | "needs_review"
  | "failed";

export interface Campaign {
  id: string;
  title: string;
  status: CampaignStatus;
  source_file_path: string;
  created_at: string;
  updated_at: string;
}

export interface BrdDocument {
  id: string;
  campaign_id: string;
  doc_type: "pdf" | "docx" | "image";
  raw_text: string;
  extracted_links: string; // JSON-encoded string[]
  parsing_confidence: number;
  created_at: string;
}

export interface Plan {
  id: string;
  campaign_id: string;
  strategy_summary: string;
  requirements_checklist: string; // JSON-encoded string[]
  content_plan: string; // JSON-encoded object
  opportunity_score: number;
  pdf_path: string | null;
  created_at: string;
}

export interface ReviewTask {
  id: string;
  campaign_id: string;
  reason: string;
  status: "open" | "resolved";
  created_at: string;
  resolved_at: string | null;
}
```

`apps/api/src/db.ts`:
```typescript
import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  source_file_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS brd_documents (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  doc_type TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  extracted_links TEXT NOT NULL,
  parsing_confidence REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  strategy_summary TEXT NOT NULL,
  requirements_checklist TEXT NOT NULL,
  content_plan TEXT NOT NULL,
  opportunity_score INTEGER NOT NULL,
  pdf_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_tasks (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
`;

let cached: Database.Database | null = null;

export function getDb(dbPath: string): Database.Database {
  if (cached) return cached;
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  cached = db;
  return db;
}

export function resetDbCacheForTests(): void {
  cached = null;
}
```

Update the test's `beforeEach` to also call `resetDbCacheForTests()` — add this line:
```typescript
import { getDb, resetDbCacheForTests } from "../src/db";
// inside beforeEach, after computing dbPath:
resetDbCacheForTests();
```

- [ ] **Step 4: Add Jest config and run tests**

Add to `apps/api/package.json` (merge into existing object):
```json
{
  "jest": {
    "preset": "ts-jest",
    "testEnvironment": "node"
  }
}
```

Run: `cd apps/api && npx jest tests/db.test.ts`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db.ts apps/api/src/types.ts apps/api/tests/db.test.ts apps/api/package.json
git commit -m "feat(api): add SQLite schema and db module for campaigns/plans/review_tasks"
```

---

### Task 6: `api` ai-worker HTTP client

**Files:**
- Create: `apps/api/src/services/aiWorkerClient.ts`
- Create: `apps/api/tests/aiWorkerClient.test.ts`

**Interfaces:**
- Consumes: the `/parse` and `/plan` route contracts from Task 4.
- Produces: `parseDocument(aiWorkerUrl: string, filePath: string, docType: string): Promise<ParsedDocumentResult>` and `planCampaign(aiWorkerUrl: string, input: PlanInput): Promise<PlanResultDto>`, both exported with named types `ParsedDocumentResult` (`raw_text`, `extracted_links: string[]`, `parsing_confidence: number`) and `PlanResultDto` (`strategy_summary`, `requirements_checklist: string[]`, `content_plan: object`, `opportunity_score: number`). Task 7 depends on these two function signatures.

- [ ] **Step 1: Write failing test using a mocked fetch**

`apps/api/tests/aiWorkerClient.test.ts`:
```typescript
import { parseDocument, planCampaign } from "../src/services/aiWorkerClient";

describe("aiWorkerClient", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("parseDocument posts file_path and doc_type, returns parsed result", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        raw_text: "hello",
        extracted_links: ["https://x.com"],
        parsing_confidence: 0.9,
      }),
    }) as any;

    const result = await parseDocument("http://ai-worker:8000", "/uploads/a.pdf", "pdf");

    expect(result.raw_text).toBe("hello");
    expect(global.fetch).toHaveBeenCalledWith(
      "http://ai-worker:8000/parse",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ file_path: "/uploads/a.pdf", doc_type: "pdf" }),
      })
    );
  });

  it("planCampaign posts plan input, returns plan result", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        strategy_summary: "s",
        requirements_checklist: ["a"],
        content_plan: { hook: "h" },
        opportunity_score: 80,
      }),
    }) as any;

    const result = await planCampaign("http://ai-worker:8000", {
      campaign_summary: "sum",
      requirements_text: "req",
      example_links: [],
      content_format: "video",
      target_language: "id",
      deadline: "2026-10-01",
      reward: "500k",
      constraints: "none",
    });

    expect(result.opportunity_score).toBe(80);
  });

  it("throws when ai-worker responds with non-ok status", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400 }) as any;
    await expect(
      parseDocument("http://ai-worker:8000", "/uploads/a.pdf", "pdf")
    ).rejects.toThrow("ai-worker /parse failed with status 400");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/aiWorkerClient.test.ts`
Expected: FAIL — `Cannot find module '../src/services/aiWorkerClient'`.

- [ ] **Step 3: Implement the client**

`apps/api/src/services/aiWorkerClient.ts`:
```typescript
export interface ParsedDocumentResult {
  raw_text: string;
  extracted_links: string[];
  parsing_confidence: number;
}

export interface PlanInput {
  campaign_summary: string;
  requirements_text: string;
  example_links: string[];
  content_format: string;
  target_language: string;
  deadline: string;
  reward: string;
  constraints: string;
}

export interface PlanResultDto {
  strategy_summary: string;
  requirements_checklist: string[];
  content_plan: Record<string, unknown>;
  opportunity_score: number;
}

export async function parseDocument(
  aiWorkerUrl: string,
  filePath: string,
  docType: string
): Promise<ParsedDocumentResult> {
  const res = await fetch(`${aiWorkerUrl}/parse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_path: filePath, doc_type: docType }),
  });
  if (!res.ok) throw new Error(`ai-worker /parse failed with status ${res.status}`);
  return res.json() as Promise<ParsedDocumentResult>;
}

export async function planCampaign(
  aiWorkerUrl: string,
  input: PlanInput
): Promise<PlanResultDto> {
  const res = await fetch(`${aiWorkerUrl}/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`ai-worker /plan failed with status ${res.status}`);
  return res.json() as Promise<PlanResultDto>;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/aiWorkerClient.test.ts`
Expected: all 3 tests PASS. (Node 20 has global `fetch`; no extra dependency needed.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiWorkerClient.ts apps/api/tests/aiWorkerClient.test.ts
git commit -m "feat(api): add HTTP client for ai-worker /parse and /plan"
```

---

### Task 7: `api` campaign routes — upload, list, detail, retry orchestration

**Files:**
- Create: `apps/api/src/routes/campaigns.ts`
- Modify: `apps/api/src/server.ts`
- Create: `apps/api/tests/campaigns.test.ts`
- Create: `apps/api/tests/fixtures/sample.pdf`

**Interfaces:**
- Consumes: `getDb` from Task 5, `parseDocument`/`planCampaign` from Task 6.
- Produces: mounted router exposing `POST /api/campaigns`, `GET /api/campaigns`, `GET /api/campaigns/:id`, `POST /api/campaigns/:id/retry`. Task 8 (PDF export route) and Task 9/10 (web-ui) depend on these exact paths and JSON shapes (`{id, title, status, source_file_path, created_at, updated_at}` for a campaign list item; detail adds `document` and `plan` nested objects when present).

- [ ] **Step 1: Write failing integration test**

`apps/api/tests/campaigns.test.ts`:
```typescript
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { createApp } from "../src/server";
import { resetDbCacheForTests } from "../src/db";

jest.mock("../src/services/aiWorkerClient", () => ({
  parseDocument: jest.fn().mockResolvedValue({
    raw_text: "Reward Campaign Brief",
    extracted_links: ["https://example.com/brief-video"],
    parsing_confidence: 0.9,
  }),
  planCampaign: jest.fn().mockResolvedValue({
    strategy_summary: "Focus on unboxing",
    requirements_checklist: ["Show product in 3s"],
    content_plan: { hook: "Surprise reveal" },
    opportunity_score: 75,
  }),
}));

describe("campaign routes", () => {
  let uploadDir: string;
  let dataDir: string;

  beforeEach(() => {
    resetDbCacheForTests();
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-"));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-"));
    process.env.UPLOAD_DIR = uploadDir;
    process.env.DATA_DIR = dataDir;
    process.env.DB_PATH = path.join(dataDir, "app.db");
    process.env.AI_WORKER_URL = "http://ai-worker:8000";
    jest.clearAllMocks();
  });

  it("uploads a BRD, parses, plans, and returns a planned campaign", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "sample.pdf");

    const res = await request(app)
      .post("/api/campaigns")
      .field("title", "Snack Brand Reward")
      .field("content_format", "15s vertical video")
      .field("target_language", "id")
      .field("deadline", "2026-10-01")
      .field("reward", "Rp 500.000")
      .field("constraints", "No profanity")
      .attach("file", fixture);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("planned");
    expect(res.body.title).toBe("Snack Brand Reward");

    const listRes = await request(app).get("/api/campaigns");
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);

    const detailRes = await request(app).get(`/api/campaigns/${res.body.id}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.plan.strategy_summary).toBe("Focus on unboxing");
    expect(detailRes.body.document.raw_text).toBe("Reward Campaign Brief");
  });

  it("returns 404 for retry on unknown campaign", async () => {
    const app = createApp();
    const res = await request(app).post("/api/campaigns/does-not-exist/retry");
    expect(res.status).toBe(404);
  });

  it("marks campaign needs_review when ai-worker /plan fails", async () => {
    const { planCampaign } = require("../src/services/aiWorkerClient");
    (planCampaign as jest.Mock).mockRejectedValueOnce(new Error("ai-worker /plan failed with status 502"));

    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "sample.pdf");
    const res = await request(app)
      .post("/api/campaigns")
      .field("title", "Failing Campaign")
      .field("content_format", "video")
      .field("target_language", "id")
      .field("deadline", "2026-10-01")
      .field("reward", "500k")
      .field("constraints", "none")
      .attach("file", fixture);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("needs_review");
  });
});
```

Create a minimal binary-ish fixture: `apps/api/tests/fixtures/sample.pdf` — copy the reportlab-generated PDF from Task 2, Step 2 (`cp apps/ai-worker/tests/fixtures/sample.pdf apps/api/tests/fixtures/sample.pdf`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/campaigns.test.ts`
Expected: FAIL — `Cannot find module '../src/routes/campaigns'` (server.ts doesn't mount it yet).

- [ ] **Step 3: Implement the campaign router**

`apps/api/src/routes/campaigns.ts`:
```typescript
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import express, { Router } from "express";
import multer from "multer";
import { getDb } from "../db";
import { parseDocument, planCampaign } from "../services/aiWorkerClient";

function docTypeFromMime(mime: string): "pdf" | "docx" | "image" | null {
  if (mime === "application/pdf") return "pdf";
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    return "docx";
  if (mime.startsWith("image/")) return "image";
  return null;
}

export function createCampaignsRouter(): Router {
  const router = express.Router();
  const uploadDir = process.env.UPLOAD_DIR ?? "/app/uploads";
  const dbPath = process.env.DB_PATH ?? "/app/data/app.db";
  const aiWorkerUrl = process.env.AI_WORKER_URL ?? "http://ai-worker:8000";
  fs.mkdirSync(uploadDir, { recursive: true });

  const upload = multer({ dest: uploadDir });

  router.post("/", upload.single("file"), async (req, res) => {
    const db = getDb(dbPath);
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    const docType = docTypeFromMime(file.mimetype);
    if (!docType) {
      res.status(400).json({ error: `unsupported file type: ${file.mimetype}` });
      return;
    }

    const finalPath = path.join(uploadDir, `${file.filename}${path.extname(file.originalname)}`);
    fs.renameSync(file.path, finalPath);

    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO campaigns (id, title, status, source_file_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, req.body.title, "parsing", finalPath, now, now);

    await runParseAndPlan(id, finalPath, docType, req.body, aiWorkerUrl, dbPath);

    const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);
    res.status(201).json(campaign);
  });

  router.get("/", (_req, res) => {
    const db = getDb(dbPath);
    const rows = db.prepare("SELECT * FROM campaigns ORDER BY created_at DESC").all();
    res.json(rows);
  });

  router.get("/:id", (req, res) => {
    const db = getDb(dbPath);
    const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const document = db
      .prepare("SELECT * FROM brd_documents WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(req.params.id) as any;
    const plan = db
      .prepare("SELECT * FROM plans WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(req.params.id) as any;
    res.json({
      ...campaign,
      document: document
        ? { ...document, extracted_links: JSON.parse(document.extracted_links) }
        : null,
      plan: plan
        ? {
            ...plan,
            requirements_checklist: JSON.parse(plan.requirements_checklist),
            content_plan: JSON.parse(plan.content_plan),
          }
        : null,
    });
  });

  router.post("/:id/retry", async (req, res) => {
    const db = getDb(dbPath);
    const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.id) as
      | { id: string; source_file_path: string }
      | undefined;
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const ext = path.extname(campaign.source_file_path).replace(".", "");
    const docType = ext === "pdf" ? "pdf" : ext === "docx" ? "docx" : "image";
    await runParseAndPlan(campaign.id, campaign.source_file_path, docType, req.body, aiWorkerUrl, dbPath);
    const updated = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaign.id);
    res.json(updated);
  });

  return router;
}

async function runParseAndPlan(
  campaignId: string,
  filePath: string,
  docType: "pdf" | "docx" | "image",
  body: Record<string, string>,
  aiWorkerUrl: string,
  dbPath: string
): Promise<void> {
  const db = getDb(dbPath);
  const now = new Date().toISOString();
  try {
    const parsed = await parseDocument(aiWorkerUrl, filePath, docType);
    db.prepare(
      `INSERT INTO brd_documents (id, campaign_id, doc_type, raw_text, extracted_links, parsing_confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      campaignId,
      docType,
      parsed.raw_text,
      JSON.stringify(parsed.extracted_links),
      parsed.parsing_confidence,
      now
    );

    if (parsed.parsing_confidence < 0.5) {
      db.prepare(
        `INSERT INTO review_tasks (id, campaign_id, reason, status, created_at) VALUES (?, ?, ?, ?, ?)`
      ).run(randomUUID(), campaignId, "low parsing confidence", "open", now);
      db.prepare("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?").run(
        "needs_review",
        now,
        campaignId
      );
      return;
    }

    const plan = await planCampaign(aiWorkerUrl, {
      campaign_summary: parsed.raw_text.slice(0, 500),
      requirements_text: parsed.raw_text,
      example_links: parsed.extracted_links,
      content_format: body.content_format ?? "",
      target_language: body.target_language ?? "",
      deadline: body.deadline ?? "",
      reward: body.reward ?? "",
      constraints: body.constraints ?? "",
    });

    db.prepare(
      `INSERT INTO plans (id, campaign_id, strategy_summary, requirements_checklist, content_plan, opportunity_score, pdf_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      campaignId,
      plan.strategy_summary,
      JSON.stringify(plan.requirements_checklist),
      JSON.stringify(plan.content_plan),
      plan.opportunity_score,
      null,
      now
    );

    db.prepare("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?").run(
      "planned",
      now,
      campaignId
    );
  } catch (err) {
    db.prepare(
      `INSERT INTO review_tasks (id, campaign_id, reason, status, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(randomUUID(), campaignId, (err as Error).message, "open", now);
    db.prepare("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?").run(
      "needs_review",
      now,
      campaignId
    );
  }
}
```

Modify `apps/api/src/server.ts`:
```typescript
import express from "express";
import { createCampaignsRouter } from "./routes/campaigns";

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/campaigns", createCampaignsRouter());

  return app;
}

if (require.main === module) {
  const app = createApp();
  const port = process.env.PORT ?? 4000;
  app.listen(port, () => console.log(`api listening on ${port}`));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/campaigns.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/campaigns.ts apps/api/src/server.ts apps/api/tests/campaigns.test.ts apps/api/tests/fixtures/sample.pdf
git commit -m "feat(api): add campaign upload, list, detail, retry orchestration"
```

---

### Task 8: `api` PDF export

**Files:**
- Create: `apps/api/src/services/pdfExport.ts`
- Modify: `apps/api/src/routes/campaigns.ts`
- Create: `apps/api/tests/pdfExport.test.ts`
- Modify: `apps/api/tests/campaigns.test.ts`

**Interfaces:**
- Consumes: `Plan` shape from Task 5/7 (`strategy_summary`, `requirements_checklist: string[]`, `content_plan: object`, `opportunity_score: number`), campaign title and extracted links.
- Produces: `renderPlanPdf(input: PlanPdfInput, outputPath: string): Promise<void>` writing a PDF file to `outputPath`; `GET /api/campaigns/:id/pdf` route that generates (if needed) and streams the file. Task 11 (web-ui detail page) depends on this route path.

- [ ] **Step 1: Write failing test for the renderer**

`apps/api/tests/pdfExport.test.ts`:
```typescript
import fs from "fs";
import os from "os";
import path from "path";
import { renderPlanPdf } from "../src/services/pdfExport";

describe("renderPlanPdf", () => {
  it("writes a non-empty PDF file", async () => {
    const outputPath = path.join(os.tmpdir(), `plan-${Date.now()}.pdf`);
    await renderPlanPdf(
      {
        campaignTitle: "Snack Brand Reward",
        strategySummary: "Focus on unboxing",
        requirementsChecklist: ["Show product in 3s"],
        contentPlan: { hook: "Surprise reveal", script: "..." },
        opportunityScore: 75,
        exampleLinks: ["https://example.com/brief-video"],
      },
      outputPath
    );

    expect(fs.existsSync(outputPath)).toBe(true);
    const header = fs.readFileSync(outputPath, { encoding: "latin1", flag: "r" }).slice(0, 5);
    expect(header).toBe("%PDF-");
    fs.unlinkSync(outputPath);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/pdfExport.test.ts`
Expected: FAIL — `Cannot find module '../src/services/pdfExport'`.

- [ ] **Step 3: Implement the renderer and route**

`apps/api/src/services/pdfExport.ts`:
```typescript
import fs from "fs";
import PDFDocument from "pdfkit";

export interface PlanPdfInput {
  campaignTitle: string;
  strategySummary: string;
  requirementsChecklist: string[];
  contentPlan: Record<string, unknown>;
  opportunityScore: number;
  exampleLinks: string[];
}

export function renderPlanPdf(input: PlanPdfInput, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    doc.fontSize(18).text(input.campaignTitle);
    doc.moveDown();
    doc.fontSize(14).text("Strategy Summary");
    doc.fontSize(11).text(input.strategySummary);
    doc.moveDown();

    doc.fontSize(14).text("Requirements Checklist");
    input.requirementsChecklist.forEach((item) => doc.fontSize(11).text(`- ${item}`));
    doc.moveDown();

    doc.fontSize(14).text("Content Plan");
    doc.fontSize(11).text(JSON.stringify(input.contentPlan, null, 2));
    doc.moveDown();

    doc.fontSize(14).text(`Opportunity Score: ${input.opportunityScore}`);
    doc.moveDown();

    doc.fontSize(14).text("Example Links");
    input.exampleLinks.forEach((link) => doc.fontSize(11).text(link));

    doc.end();
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
}
```

Add to `apps/api/src/routes/campaigns.ts` (inside `createCampaignsRouter`, after the `retry` route):
```typescript
  router.get("/:id/pdf", async (req, res) => {
    const db = getDb(dbPath);
    const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.id) as any;
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const plan = db
      .prepare("SELECT * FROM plans WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(req.params.id) as any;
    if (!plan) {
      res.status(404).json({ error: "no plan available for this campaign" });
      return;
    }
    const exportDir = process.env.EXPORT_DIR ?? "/app/data/exports";
    fs.mkdirSync(exportDir, { recursive: true });
    const outputPath = plan.pdf_path ?? path.join(exportDir, `${plan.id}.pdf`);

    if (!fs.existsSync(outputPath)) {
      const document = db
        .prepare("SELECT * FROM brd_documents WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(req.params.id) as any;
      await renderPlanPdf(
        {
          campaignTitle: campaign.title,
          strategySummary: plan.strategy_summary,
          requirementsChecklist: JSON.parse(plan.requirements_checklist),
          contentPlan: JSON.parse(plan.content_plan),
          opportunityScore: plan.opportunity_score,
          exampleLinks: document ? JSON.parse(document.extracted_links) : [],
        },
        outputPath
      );
      db.prepare("UPDATE plans SET pdf_path = ? WHERE id = ?").run(outputPath, plan.id);
    }

    res.download(outputPath, `${campaign.title.replace(/\s+/g, "_")}.pdf`);
  });
```

Add the import at the top of `apps/api/src/routes/campaigns.ts`:
```typescript
import { renderPlanPdf } from "../services/pdfExport";
```

- [ ] **Step 4: Add an integration test for the PDF route**

Append to `apps/api/tests/campaigns.test.ts`, inside the `describe` block:
```typescript
  it("generates and downloads a PDF for a planned campaign", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "sample.pdf");
    const created = await request(app)
      .post("/api/campaigns")
      .field("title", "PDF Test Campaign")
      .field("content_format", "video")
      .field("target_language", "id")
      .field("deadline", "2026-10-01")
      .field("reward", "500k")
      .field("constraints", "none")
      .attach("file", fixture);

    const pdfRes = await request(app).get(`/api/campaigns/${created.body.id}/pdf`);
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers["content-type"]).toBe("application/pdf");
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/pdfExport.test.ts tests/campaigns.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/pdfExport.ts apps/api/src/routes/campaigns.ts apps/api/tests/pdfExport.test.ts apps/api/tests/campaigns.test.ts
git commit -m "feat(api): render campaign plan as downloadable PDF"
```

---

### Task 9: `web-ui` API client and upload form

**Files:**
- Create: `apps/web-ui/lib/apiClient.ts`
- Create: `apps/web-ui/components/UploadForm.tsx`
- Modify: `apps/web-ui/app/page.tsx`

**Interfaces:**
- Consumes: `POST /api/campaigns` from Task 7 (multipart form: `file`, `title`, `content_format`, `target_language`, `deadline`, `reward`, `constraints`).
- Produces: `uploadCampaign(formData: FormData): Promise<Campaign>` in `apiClient.ts`; `<UploadForm onUploaded={(c: Campaign) => void} />` component. Task 10 (`CampaignList`) depends on `Campaign` type exported from `apiClient.ts`.

- [ ] **Step 1: Define the client**

`apps/web-ui/lib/apiClient.ts`:
```typescript
export interface Campaign {
  id: string;
  title: string;
  status: "uploaded" | "parsing" | "planned" | "needs_review" | "failed";
  source_file_path: string;
  created_at: string;
  updated_at: string;
}

export interface CampaignDetail extends Campaign {
  document: {
    raw_text: string;
    extracted_links: string[];
    parsing_confidence: number;
  } | null;
  plan: {
    strategy_summary: string;
    requirements_checklist: string[];
    content_plan: Record<string, unknown>;
    opportunity_score: number;
  } | null;
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export async function uploadCampaign(formData: FormData): Promise<Campaign> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns`, { method: "POST", body: formData });
  if (!res.ok) throw new Error(`upload failed with status ${res.status}`);
  return res.json();
}

export async function listCampaigns(): Promise<Campaign[]> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns`, { cache: "no-store" });
  if (!res.ok) throw new Error(`list failed with status ${res.status}`);
  return res.json();
}

export async function getCampaign(id: string): Promise<CampaignDetail> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${id}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`get campaign failed with status ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Build the upload form component**

`apps/web-ui/components/UploadForm.tsx`:
```tsx
"use client";

import { FormEvent, useState } from "react";
import { Campaign, uploadCampaign } from "../lib/apiClient";

export function UploadForm({ onUploaded }: { onUploaded: (c: Campaign) => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const formData = new FormData(e.currentTarget);
      const campaign = await uploadCampaign(formData);
      onUploaded(campaign);
      e.currentTarget.reset();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <input type="file" name="file" required />
      <input type="text" name="title" placeholder="Campaign title" required />
      <input type="text" name="content_format" placeholder="Content format (e.g. 15s video)" required />
      <input type="text" name="target_language" placeholder="Target language" required />
      <input type="text" name="deadline" placeholder="Deadline" required />
      <input type="text" name="reward" placeholder="Reward" required />
      <input type="text" name="constraints" placeholder="Constraints" />
      <button type="submit" disabled={submitting}>
        {submitting ? "Uploading..." : "Upload BRD"}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
```

- [ ] **Step 3: Wire into the home page**

`apps/web-ui/app/page.tsx`:
```tsx
"use client";

import { useState } from "react";
import { Campaign } from "../lib/apiClient";
import { UploadForm } from "../components/UploadForm";

export default function HomePage() {
  const [lastUploaded, setLastUploaded] = useState<Campaign | null>(null);

  return (
    <main>
      <h1>ContentRewardFarm</h1>
      <UploadForm onUploaded={setLastUploaded} />
      {lastUploaded && <p>Uploaded: {lastUploaded.title} ({lastUploaded.status})</p>}
    </main>
  );
}
```

- [ ] **Step 4: Manual verification**

Run: `docker compose -f docker/docker-compose.yml up --build -d`
Open `http://localhost:3000`, submit the upload form with a real BRD file.
Expected: page shows "Uploaded: <title> (planned)" or "(needs_review)" without a console error.

Run: `docker compose -f docker/docker-compose.yml down`

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/apiClient.ts apps/web-ui/components/UploadForm.tsx apps/web-ui/app/page.tsx
git commit -m "feat(web-ui): add BRD upload form wired to api"
```

---

### Task 10: `web-ui` campaign list

**Files:**
- Create: `apps/web-ui/components/CampaignList.tsx`
- Modify: `apps/web-ui/app/page.tsx`

**Interfaces:**
- Consumes: `listCampaigns` and `Campaign` from Task 9's `apiClient.ts`.
- Produces: `<CampaignList campaigns={Campaign[]} />` rendering a table linking each row to `/campaigns/{id}`. Task 11 relies on the same route path `/campaigns/[id]`.

- [ ] **Step 1: Build the list component**

`apps/web-ui/components/CampaignList.tsx`:
```tsx
import Link from "next/link";
import { Campaign } from "../lib/apiClient";

export function CampaignList({ campaigns }: { campaigns: Campaign[] }) {
  if (campaigns.length === 0) {
    return <p>No campaigns yet.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Title</th>
          <th>Status</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {campaigns.map((c) => (
          <tr key={c.id}>
            <td>
              <Link href={`/campaigns/${c.id}`}>{c.title}</Link>
            </td>
            <td>{c.status}</td>
            <td>{c.updated_at}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 2: Fetch and render the list on the home page**

Modify `apps/web-ui/app/page.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import { Campaign, listCampaigns } from "../lib/apiClient";
import { UploadForm } from "../components/UploadForm";
import { CampaignList } from "../components/CampaignList";

export default function HomePage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);

  async function refresh() {
    setCampaigns(await listCampaigns());
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <main>
      <h1>ContentRewardFarm</h1>
      <UploadForm onUploaded={refresh} />
      <CampaignList campaigns={campaigns} />
    </main>
  );
}
```

- [ ] **Step 3: Manual verification**

Run: `docker compose -f docker/docker-compose.yml up --build -d`
Upload two BRDs from the UI.
Expected: both appear in the table with correct status; clicking a title navigates to `/campaigns/<id>` (404 page is fine until Task 11 lands).

Run: `docker compose -f docker/docker-compose.yml down`

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/components/CampaignList.tsx apps/web-ui/app/page.tsx
git commit -m "feat(web-ui): list campaigns with status on home page"
```

---

### Task 11: `web-ui` campaign detail page (parsing result, plan, PDF download, review)

**Files:**
- Create: `apps/web-ui/app/campaigns/[id]/page.tsx`
- Create: `apps/web-ui/components/CampaignDetail.tsx`

**Interfaces:**
- Consumes: `getCampaign` and `CampaignDetail` type from Task 9's `apiClient.ts`; `GET /api/campaigns/:id/pdf` from Task 8.
- Produces: page at `/campaigns/[id]` rendering document text, extracted links, plan fields, a PDF download link, and (when `status === "needs_review"`) a review notice.

- [ ] **Step 1: Build the detail component**

`apps/web-ui/components/CampaignDetail.tsx`:
```tsx
import { CampaignDetail as CampaignDetailType } from "../lib/apiClient";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export function CampaignDetail({ campaign }: { campaign: CampaignDetailType }) {
  return (
    <div>
      <h1>{campaign.title}</h1>
      <p>Status: {campaign.status}</p>

      {campaign.status === "needs_review" && (
        <p role="alert">This campaign needs manual review.</p>
      )}

      {campaign.document && (
        <section>
          <h2>Parsed Document</h2>
          <p>Confidence: {campaign.document.parsing_confidence}</p>
          <ul>
            {campaign.document.extracted_links.map((link) => (
              <li key={link}>
                <a href={link} target="_blank" rel="noreferrer">
                  {link}
                </a>
              </li>
            ))}
          </ul>
          <pre>{campaign.document.raw_text}</pre>
        </section>
      )}

      {campaign.plan && (
        <section>
          <h2>Plan</h2>
          <p>{campaign.plan.strategy_summary}</p>
          <ul>
            {campaign.plan.requirements_checklist.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <pre>{JSON.stringify(campaign.plan.content_plan, null, 2)}</pre>
          <p>Opportunity score: {campaign.plan.opportunity_score}</p>
          <a href={`${API_BASE_URL}/api/campaigns/${campaign.id}/pdf`}>Download PDF</a>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build the page**

`apps/web-ui/app/campaigns/[id]/page.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import { CampaignDetail as CampaignDetailType, getCampaign } from "../../../lib/apiClient";
import { CampaignDetail } from "../../../components/CampaignDetail";

export default function CampaignDetailPage({ params }: { params: { id: string } }) {
  const [campaign, setCampaign] = useState<CampaignDetailType | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCampaign(params.id)
      .then(setCampaign)
      .catch((err) => setError((err as Error).message));
  }, [params.id]);

  if (error) return <p role="alert">{error}</p>;
  if (!campaign) return <p>Loading...</p>;
  return <CampaignDetail campaign={campaign} />;
}
```

- [ ] **Step 3: Manual verification**

Run: `docker compose -f docker/docker-compose.yml up --build -d`
Upload a BRD, click through from the list.
Expected: detail page shows parsed text, links, plan summary/checklist/content plan/score, and a working "Download PDF" link that saves a valid PDF.

Run: `docker compose -f docker/docker-compose.yml down`

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/app/campaigns apps/web-ui/components/CampaignDetail.tsx
git commit -m "feat(web-ui): add campaign detail page with plan, links, and PDF download"
```

---

### Task 12: End-to-end integration test across all three services

**Files:**
- Create: `tests/fixtures/brd_sample.pdf`
- Create: `tests/fixtures/brd_sample.docx`
- Create: `tests/fixtures/brd_sample.png`
- Create: `tests/e2e.test.sh`

**Interfaces:**
- Consumes: the full running stack from `docker compose up` (all prior tasks).
- Produces: a shell script exercising the real HTTP surface end-to-end, runnable in CI or locally, exiting non-zero on failure.

- [ ] **Step 1: Create shared fixtures**

Reuse the fixture generation approach from Task 2, Step 2, writing outputs to `tests/fixtures/` instead:
```bash
python - <<'PY'
from reportlab.pdfgen import canvas
from docx import Document
from PIL import Image, ImageDraw

c = canvas.Canvas("tests/fixtures/brd_sample.pdf")
c.drawString(50, 750, "Reward Campaign Brief")
c.drawString(50, 730, "Source: https://example.com/brief-video")
c.save()

doc = Document()
doc.add_paragraph("Reward Campaign Brief")
doc.add_paragraph("Source: https://example.com/brief-video")
doc.save("tests/fixtures/brd_sample.docx")

img = Image.new("RGB", (400, 100), color="white")
draw = ImageDraw.Draw(img)
draw.text((10, 40), "REWARD CAMPAIGN", fill="black")
img.save("tests/fixtures/brd_sample.png")
PY
```

- [ ] **Step 2: Write the failing e2e script**

`tests/e2e.test.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

API_URL="http://localhost:4000"
FIXTURE="tests/fixtures/brd_sample.pdf"

echo "Uploading BRD..."
RESPONSE=$(curl -sf -X POST "$API_URL/api/campaigns" \
  -F "file=@${FIXTURE};type=application/pdf" \
  -F "title=E2E Test Campaign" \
  -F "content_format=15s vertical video" \
  -F "target_language=id" \
  -F "deadline=2026-10-01" \
  -F "reward=Rp 500.000" \
  -F "constraints=No profanity")

CAMPAIGN_ID=$(echo "$RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")
STATUS=$(echo "$RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin)['status'])")

echo "Campaign $CAMPAIGN_ID status: $STATUS"
if [[ "$STATUS" != "planned" && "$STATUS" != "needs_review" ]]; then
  echo "FAIL: unexpected status $STATUS"
  exit 1
fi

echo "Fetching detail..."
DETAIL=$(curl -sf "$API_URL/api/campaigns/$CAMPAIGN_ID")
echo "$DETAIL" | python3 -c "import sys, json; json.load(sys.stdin)"

if [[ "$STATUS" == "planned" ]]; then
  echo "Downloading PDF..."
  curl -sf "$API_URL/api/campaigns/$CAMPAIGN_ID/pdf" -o /tmp/e2e-plan.pdf
  HEADER=$(head -c 5 /tmp/e2e-plan.pdf)
  if [[ "$HEADER" != "%PDF-" ]]; then
    echo "FAIL: downloaded file is not a PDF"
    exit 1
  fi
fi

echo "PASS"
```

Run: `chmod +x tests/e2e.test.sh`

- [ ] **Step 3: Run against the real stack**

Run:
```bash
docker compose -f docker/docker-compose.yml up --build -d
sleep 5
docker exec $(docker compose -f docker/docker-compose.yml ps -q ollama) ollama pull mistral:7b-instruct
./tests/e2e.test.sh
docker compose -f docker/docker-compose.yml down
```
Expected: script prints `PASS` and exits 0. If `STATUS` is `needs_review`, inspect `curl $API_URL/api/campaigns/$CAMPAIGN_ID` output to confirm a `review_tasks` reason is present rather than a silent failure — this is acceptable spec behavior, not a bug, as long as the reason is populated.

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures tests/e2e.test.sh
git commit -m "test: add end-to-end script covering upload through PDF download"
```

---

## Self-Review Notes

- **Spec coverage:** upload UI (Task 9), multi-format parsing (Task 2), link detection incl. manual-review fallback (Task 2 + Task 7's confidence check), LLM strategy/checklist/content-plan/score (Task 3), SQLite history across all four tables (Task 5, 7), PDF export (Task 8), Docker Compose + GPU profile (Task 1), retry flow (Task 7), review_tasks on failure (Task 7). Every "Termasuk" bullet has a task; every "Tidak termasuk" bullet is respected (no auto-download, no auto-edit, no external platform calls, no auth/roles, no realtime notifications).
- **Placeholder scan:** no TBD/TODO markers; every step has runnable code or an exact command.
- **Type consistency:** `ParsedDocument`/`ParsedDocumentResult` fields (`raw_text`, `extracted_links`, `parsing_confidence`) match across Task 2 (Python), Task 4 (route), and Task 6 (TS client). `PlanResult`/`PlanResultDto` fields (`strategy_summary`, `requirements_checklist`, `content_plan`, `opportunity_score`) match across Task 3, 4, 6, 7, 8. Route paths (`/api/campaigns`, `/api/campaigns/:id`, `/api/campaigns/:id/retry`, `/api/campaigns/:id/pdf`) are identical between Task 7/8 (server) and Task 9/11 (client).
