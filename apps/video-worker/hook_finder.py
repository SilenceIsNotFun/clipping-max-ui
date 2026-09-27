import json
import re

from schemas import HookSuggestion

JSON_ARRAY_RE = re.compile(r"```(?:json)?\s*(\[.*?\])\s*```", re.DOTALL)

PROMPT_TEMPLATE = """You are helping a video clipper find the strongest hook moments in this footage for a brand reward campaign.

Campaign hook direction: {hook}
Campaign strategy: {strategy_summary}
Requirements the final clip MUST satisfy:
{requirements_checklist}

Watch the video and identify the 3-5 strongest hook/payoff moments. For each, give:
- start_seconds, end_seconds (a tight window covering just that moment, typically 15-45 seconds)
- title: a short, punchy suggested clip title
- reasoning: one sentence on why this moment works as a hook, and how it fits the requirements above

Respond with ONLY a JSON array of objects with keys: start_seconds, end_seconds, title, reasoning.
"""


def build_prompt(hook: str, strategy_summary: str, requirements_checklist: list[str]) -> str:
    checklist_text = "\n".join(f"- {item}" for item in requirements_checklist) or "- none specified"
    return PROMPT_TEMPLATE.format(hook=hook, strategy_summary=strategy_summary, requirements_checklist=checklist_text)


def parse_hook_response(raw: str) -> list[HookSuggestion]:
    match = JSON_ARRAY_RE.search(raw)
    if match:
        candidate = match.group(1)
    else:
        # Gemini (like the smaller local models this project already deals
        # with in ai-worker/planner.py) doesn't always wrap output in a
        # ```json fence -- fall back to the outermost [...] span.
        start = raw.find("[")
        end = raw.rfind("]")
        if start == -1 or end == -1 or end < start:
            raise ValueError("no JSON array found in Gemini response")
        candidate = raw[start : end + 1]

    try:
        data = json.loads(candidate)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Gemini response was not valid JSON: {exc}") from exc

    return [
        HookSuggestion(
            start_ms=int(float(item["start_seconds"]) * 1000),
            end_ms=int(float(item["end_seconds"]) * 1000),
            title=item["title"],
            reasoning=item["reasoning"],
        )
        for item in data
    ]
