from fastapi import FastAPI

app = FastAPI(title="contentrewardfarm-video-worker")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
