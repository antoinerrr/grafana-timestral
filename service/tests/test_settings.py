import pytest

from settings import Settings


@pytest.mark.parametrize("env", [
    {"TIMESTRAL_MODEL": "http://arbitrary-model.invalid"},
    {"TORCH_NUM_THREADS": "0"},
    {"TORCH_NUM_THREADS": "128.1"},
    {"TIMESTRAL_CACHE_TTL_SECONDS": "-1"},
    {"TIMESTRAL_CACHE_MAX_MIB": "513"},
    {"TIMESTRAL_MAX_ADMITTED_REQUESTS": "17"},
    {"TIMESTRAL_QUEUE_TIMEOUT_SECONDS": "0"},
    {"TIMESTRAL_LOAD_ATTEMPTS": "6"},
    {"TIMESTRAL_API_TOKEN": ""},
    {"TIMESTRAL_API_TOKEN": "short"},
    {"TIMESTRAL_API_TOKEN": "token with spaces in it"},
    {"TIMESTRAL_API_TOKEN": "x" * 4097},
    {"TIMESTRAL_API_TOKEN": "control-token-12345\x1b"},
    {"HF_HUB_CACHE": ""},
])
def test_invalid_configuration_fails_early(env):
    with pytest.raises(ValueError):
        Settings.from_env(env)


def test_token_file_reads_trailing_newline_and_repr_hides_secret(tmp_path):
    secret = "test-token-only-1234567890"
    path = tmp_path / "token"
    path.write_text(secret + "\n")
    settings = Settings.from_env({"TIMESTRAL_API_TOKEN_FILE": str(path)})
    assert settings.api_token == secret
    assert secret not in repr(settings)


def test_token_file_error_does_not_echo_path(tmp_path):
    with pytest.raises(ValueError) as exc:
        Settings.from_env({"TIMESTRAL_API_TOKEN_FILE": str(tmp_path / "private-secret-path")})
    assert "private-secret-path" not in str(exc.value)


def test_token_sources_are_mutually_exclusive(tmp_path):
    with pytest.raises(ValueError, match="only one"):
        Settings.from_env({"TIMESTRAL_API_TOKEN": "test-token-123456", "TIMESTRAL_API_TOKEN_FILE": str(tmp_path)})


def test_oversized_token_file_is_not_truncated(tmp_path):
    path = tmp_path / "token"
    path.write_text("x" * 4096 + "\n\n" + "unread-tail")
    with pytest.raises(ValueError, match="length limit"):
        Settings.from_env({"TIMESTRAL_API_TOKEN_FILE": str(path)})


def test_defaults_and_explicit_model_selection():
    assert Settings.from_env({}).model_id == "mistralai/Timestral-5M"
    selected = Settings.from_env({"TIMESTRAL_MODEL": "28M", "TIMESTRAL_CACHE_TTL_SECONDS": "0"})
    assert selected.model_id == "mistralai/Timestral-28M"
    assert selected.cache_ttl_seconds == 0
    assert selected.api_token is None
