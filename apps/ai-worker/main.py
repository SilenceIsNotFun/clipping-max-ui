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
