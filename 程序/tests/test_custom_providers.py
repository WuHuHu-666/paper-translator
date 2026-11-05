"""自定义供应商：配置解析 + 请求参数合并。

这些用例守的是「界面里填的模型参数真的会发到 API」这条链路：
config.model_extra_params() 负责解析，DeepSeekTranslator 负责并进请求体。
两边任何一边悄悄改了口径，这里就会红。
"""
from __future__ import annotations

import pytest

from src.config import Config, _coerce

PROVIDER = {
    "id": "cp1",
    "name": "strata",
    "base_url": "http://127.0.0.1:8080/v1",
    "protocol": "openai",
    "api_key": "sk-x",
    "models": [
        {
            "id": "swift-1.5",
            "context": "256K",
            "max_output": "32K",
            "inputs": ["text", "image"],
            "reasoning": {
                "enabled": True,
                "key": "reasoning_effort",
                "active": "low",
                "tiers": [{"level": "off", "value": "none"},
                          {"level": "low", "value": "low"}],
            },
            "params": [{"key": "top_p", "value": "0.95"}],
        },
        {"id": "no-params"},
    ],
}


def _cfg(**kw):
    base = {"custom_providers": [PROVIDER], "provider_id": "cp1",
            "model": "swift-1.5"}
    base.update(kw)
    return Config(**base)


# ---------------------------------------------------------------------------
# 配置解析
# ---------------------------------------------------------------------------

def test_extra_params_merges_reasoning_tier_and_custom_params():
    got = _cfg().model_extra_params()
    assert got == {"reasoning_effort": "low", "top_p": 0.95}


def test_reasoning_off_contributes_nothing():
    p = {**PROVIDER, "models": [
        {**PROVIDER["models"][0],
         "reasoning": {**PROVIDER["models"][0]["reasoning"], "enabled": False}}]}
    cfg = Config(custom_providers=[p], provider_id="cp1", model="swift-1.5")
    assert cfg.model_extra_params() == {"top_p": 0.95}


def test_unknown_active_tier_falls_back_to_first():
    """active 指向的档位被删掉后不能静默不发，退回第一档。"""
    p = {**PROVIDER, "models": [
        {**PROVIDER["models"][0],
         "reasoning": {"enabled": True, "key": "reasoning_effort",
                       "active": "已删除的档", "tiers": [{"level": "mid",
                                                          "value": "medium"}]}}]}
    cfg = Config(custom_providers=[p], provider_id="cp1", model="swift-1.5")
    assert cfg.model_extra_params()["reasoning_effort"] == "medium"


def test_preset_provider_has_no_extra_params():
    cfg = Config(base_url="https://api.deepseek.com", model="deepseek-v4-pro")
    assert cfg.model_extra_params() == {}
    assert cfg.provider() is None
    assert cfg.model_entry() is None


def test_provider_matched_by_base_url_when_id_missing():
    """旧 config.json 没有 provider_id：按接口地址也要认得出来。"""
    cfg = Config(custom_providers=[PROVIDER], provider_id="",
                 base_url="http://127.0.0.1:8080/v1/", model="swift-1.5")
    assert (cfg.provider() or {}).get("name") == "strata"


def test_model_not_in_catalogue_yields_nothing():
    cfg = _cfg(model="手填的模型名")
    assert cfg.model_entry() is None
    assert cfg.model_extra_params() == {}


def test_empty_keys_and_values_are_dropped():
    p = {**PROVIDER, "models": [{
        "id": "m", "params": [{"key": "", "value": "1"},
                              {"key": "seed", "value": ""},
                              {"key": "ok", "value": "1"}]}]}
    cfg = Config(custom_providers=[p], provider_id="cp1", model="m")
    assert cfg.model_extra_params() == {"ok": 1}


@pytest.mark.parametrize("raw,want", [
    ("0.95", 0.95), ("42", 42), ("true", True), ("false", False),
    ("low", "low"), ("", ""),
])
def test_coerce_keeps_types_sane(raw, want):
    assert _coerce(raw) == want and type(_coerce(raw)) is type(want)


# ---------------------------------------------------------------------------
# 请求体合并
# ---------------------------------------------------------------------------

class _Resp:
    def __init__(self, code=200, body=""):
        self.status_code, self.text = code, body

    def json(self):
        return {"choices": [{"message": {"content": "你好"}}]}


def _client(monkeypatch, handler, **kw):
    from src.translator import DeepSeekTranslator
    tr = DeepSeekTranslator(api_key="k", timeout=5, **kw)
    monkeypatch.setattr(tr.session, "post", handler)
    monkeypatch.setattr("time.sleep", lambda *_: None)
    return tr


def test_extra_params_are_sent_in_request(monkeypatch):
    seen = {}

    def handler(url, headers=None, json=None, timeout=None, verify=None):
        seen.update(json)
        return _Resp(200)

    tr = _client(monkeypatch, handler, extra_params={"top_p": 0.95, "seed": 42})
    tr._chat([{"role": "user", "content": "hi"}])
    assert seen["top_p"] == 0.95 and seen["seed"] == 42


def test_core_fields_cannot_be_overridden_by_extra_params(monkeypatch):
    """附加参数只能补充，不能把 model/messages/stream 改掉。"""
    seen = {}

    def handler(url, headers=None, json=None, timeout=None, verify=None):
        seen.update(json)
        return _Resp(200)

    tr = _client(monkeypatch, handler, model="real-model",
                 extra_params={"model": "hijack", "stream": True})
    tr._chat([{"role": "user", "content": "hi"}])
    assert seen["model"] == "real-model"
    assert seen["stream"] is False


def test_unsupported_extra_param_is_stripped_and_retried(monkeypatch):
    """服务不认自定义参数时回 400：剥掉重发一次，别让整篇翻译死在 400 上。"""
    seen = []

    def handler(url, headers=None, json=None, timeout=None, verify=None):
        seen.append("top_p" in json)
        if "top_p" in json:
            return _Resp(400, "Unrecognized request argument supplied: top_p")
        return _Resp(200)

    tr = _client(monkeypatch, handler, max_retries=1,
                 extra_params={"top_p": 0.95})
    assert tr._chat([{"role": "user", "content": "hi"}]) == "你好"
    assert seen == [True, False], "剥掉自定义参数后应真的再发一次"
