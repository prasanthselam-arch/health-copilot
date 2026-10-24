from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    llm_provider: str = "gemini"  # gemini | openai
    gemini_api_key: str = ""
    openai_api_key: str = ""
    # Corporate TLS-inspecting proxies (e.g. Zscaler) need their root CA appended to the bundle.
    ca_bundle: str | None = None

    # Comma-separated fallback chains; verification deliberately starts on a different model.
    gemini_extract_models: str = "gemini-3.5-flash,gemini-3-flash-preview,gemini-3.8-flash,gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-2.5-flash-lite"
    gemini_verify_models: str = "gemini-3-flash-preview,gemini-3.5-flash,gemini-3.8-flash,gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-2.5-flash-lite"
    gemini_fast_models: str = "gemini-3.5-flash,gemini-3-flash-preview,gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-2.5-flash-lite"
    openai_extract_models: str = "gpt-5.4"
    openai_verify_models: str = "gpt-5.4"
    openai_fast_models: str = "gpt-5.4-mini"
    gemini_thinking_level: str | None = "low"
    gemini_tts_models: str = "gemini-3.8-flash-lite-tts,gemini-3.8-flash-tts,gemini-2.5-flash-preview-tts"
    gemini_tts_voice: str = "Kore"
    openai_reasoning_effort: str = "low"
    enable_verification: bool = True

    def models_for(self, role: str) -> list[str]:
        chain = getattr(self, f"{self.llm_provider}_{role}_models")
        return [m.strip() for m in chain.split(",") if m.strip()]

    database_url: str = f"sqlite:///{BACKEND_DIR / 'data' / 'copilot.db'}"
    storage_dir: Path = BACKEND_DIR / "data" / "files"
    render_dpi: int = 200
    max_image_side: int = 2200
    max_pages: int = 8
    worker_threads: int = 3

    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    session_days: int = 30
    cookie_secure: bool = False  # set true when served over HTTPS
    demo_otp: str = "123456"

    # Email (codes, security alerts, reminders) through a Google Apps Script web app that sends from your Gmail
    # (scripts/google-apps-script/Code.gs). Render's free plan blocks SMTP, so Gmail can't be used directly.
    google_script_url: str = ""
    google_script_secret: str = ""
    mail_from_name: str = "Health Copilot"
    app_url: str = Field("http://localhost:5173", validation_alias=AliasChoices("APP_URL", "RENDER_EXTERNAL_URL"))
    cron_secret: str = ""  # lets the scheduled GitHub Action run the daily notification job
    push_contact: str = ""  # contact email in Web Push (VAPID) claims
    scheduler: bool = True  # background reminder loop; off in tests

    @property
    def mail_debug(self) -> bool:
        """Local development without an email provider: codes are shown on screen instead of emailed."""
        return not self.google_script_url and not self.cookie_secure

    # Hosting: the built frontend served by FastAPI, and a private GitHub repository ("owner/name") that keeps
    # the database and uploads across restarts on hosts without a persistent disk (see services/datastore.py).
    static_dir: Path | None = None
    data_repo: str = ""
    data_repo_token: str = ""
    data_repo_branch: str = "main"
    data_repo_dir: Path = BACKEND_DIR / ".data-repo"
    data_sync_seconds: int = 60


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.storage_dir.mkdir(parents=True, exist_ok=True)
    return s
