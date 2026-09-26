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

JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)


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
        # A 7B model can take well over 2 minutes on CPU-only inference (no
        # GPU passthrough, or GPU not yet detected by Ollama); keep this
        # generous rather than failing plan generation on slow hardware.
        timeout=600,
    )
    response.raise_for_status()
    return response.json()["response"]


def parse_llm_response(raw: str) -> PlanResult:
    match = JSON_BLOCK_RE.search(raw)
    if match:
        candidate = match.group(1)
    else:
        # Smaller/less-compliant models (e.g. mistral:7b-instruct) often
        # ignore the "wrap it in a ```json code block" instruction and just
        # return a bare JSON object, optionally with surrounding prose --
        # fall back to the outermost {...} span in the raw text.
        start = raw.find("{")
        end = raw.rfind("}")
        if start == -1 or end == -1 or end < start:
            raise ValueError("no JSON object found in LLM response")
        candidate = raw[start : end + 1]

    try:
        data = json.loads(candidate)
    except json.JSONDecodeError as exc:
        raise ValueError(f"LLM response was not valid JSON: {exc}") from exc
    return PlanResult(**data)
