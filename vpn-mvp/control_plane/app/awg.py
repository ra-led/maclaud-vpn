import uuid


def new_pending_secret() -> str:
    return uuid.uuid4().hex


def normalize_client_conf(conf_text: str) -> str:
    return conf_text if conf_text.endswith("\n") else f"{conf_text}\n"
