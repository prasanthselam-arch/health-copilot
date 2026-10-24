import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api import auth, care, documents, insights, internal, patients, voice
from app.config import get_settings
from app.db import init_db
from app.knowledge import drugs, icd10, labs
from app.pipeline import runner
from app.services import datastore, scheduler
from app.services.safety import DISCLAIMER, LANGUAGES

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
for noisy in ("httpx", "google_genai"):
    logging.getLogger(noisy).setLevel(logging.WARNING)


@asynccontextmanager
async def lifespan(_: FastAPI):
    datastore.restore()
    init_db()
    runner.resume_pending()
    datastore.start()
    if get_settings().scheduler:
        scheduler.start()
    yield
    scheduler.stop()
    datastore.stop()


app = FastAPI(title="Personal Health Copilot API", version="3.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=get_settings().cors_origins, allow_methods=["*"], allow_headers=["*"])
app.include_router(auth.router)
app.include_router(patients.router)
app.include_router(documents.router)
app.include_router(insights.router)
app.include_router(voice.router)
app.include_router(care.router)
app.include_router(internal.router)


@app.get("/api/health")
def health():
    s = get_settings()
    return {
        "status": "ok",
        "llm_provider": s.llm_provider,
        "models": {role: s.models_for(role)[0] for role in ("extract", "verify", "fast")},
        "verification": s.enable_verification,
        "knowledge": {"lab_tests": len(labs().tests), "drugs": len(drugs().drugs), "icd10": len(icd10().items)},
        "languages": LANGUAGES,
        "fhir": "R4 (ABDM / NRCeS profiles)",
    }


@app.get("/api/meta/disclaimer")
def disclaimer():
    return DISCLAIMER


# Production: serve the built frontend from the same origin as the API (one service, same-site cookies).
_static = get_settings().static_dir
if _static and (_static / "index.html").is_file():
    _root = _static.resolve()
    app.mount("/assets", StaticFiles(directory=_root / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            raise HTTPException(404, "Not found")
        f = (_root / path).resolve()
        if path and f.is_file() and f.is_relative_to(_root):
            return FileResponse(f)
        return FileResponse(_root / "index.html", headers={"Cache-Control": "no-cache"})
