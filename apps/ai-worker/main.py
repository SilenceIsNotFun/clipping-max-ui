from fastapi import FastAPI

app = FastAPI(title="contentrewardfarm-ai-worker")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
