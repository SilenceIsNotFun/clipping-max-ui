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
