from pydantic import BaseModel


class ParsedDocument(BaseModel):
    raw_text: str
    extracted_links: list[str]
    parsing_confidence: float


class PlanResult(BaseModel):
    strategy_summary: str
    requirements_checklist: list[str]
    content_plan: dict
    opportunity_score: int
