from pydantic import BaseModel


class ParsedDocument(BaseModel):
    raw_text: str
    extracted_links: list[str]
    parsing_confidence: float
