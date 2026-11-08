"""Gateway settings, read from environment variables."""
import os
from dataclasses import dataclass, field

HERE = os.path.dirname(os.path.abspath(__file__))


def _keys(value):
    return frozenset(k.strip() for k in (value or "").split(",") if k.strip())


@dataclass
class Settings:
    # API keys. Admin keys can do everything; client keys can only run card operations.
    admin_keys: frozenset = field(default_factory=frozenset)
    client_keys: frozenset = field(default_factory=frozenset)
    db_path: str = "gateway.db"
    templates_path: str = os.path.join(HERE, "..", "card_templates.json")
    # Seconds to wait for an agent to answer one command.
    invoke_timeout: float = 15.0
    # When False, operations whose template is not yet calibrated on real hardware are refused.
    allow_uncalibrated: bool = False

    def validate(self):
        if not self.admin_keys:
            raise RuntimeError(
                "No admin API key configured. Set GATEWAY_ADMIN_KEYS to one or more "
                "comma-separated secrets (e.g. `python -c \"import secrets;print(secrets.token_urlsafe(32))\"`)."
            )
        weak = [k for k in self.admin_keys | self.client_keys if len(k) < 16]
        if weak:
            raise RuntimeError("API keys must be at least 16 characters long.")
        return self


def load_settings():
    return Settings(
        admin_keys=_keys(os.environ.get("GATEWAY_ADMIN_KEYS")),
        client_keys=_keys(os.environ.get("GATEWAY_CLIENT_KEYS")),
        db_path=os.environ.get("GATEWAY_DB", "gateway.db"),
        templates_path=os.environ.get("GATEWAY_TEMPLATES", Settings.templates_path),
        invoke_timeout=float(os.environ.get("GATEWAY_INVOKE_TIMEOUT", "15")),
        allow_uncalibrated=os.environ.get("GATEWAY_ALLOW_UNCALIBRATED", "0") == "1",
    ).validate()
