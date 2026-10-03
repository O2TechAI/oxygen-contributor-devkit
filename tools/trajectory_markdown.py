"""Render structurally stripped Codex records as a plain-role Markdown transcript."""

from collections import Counter
import hashlib
import importlib.util
import json
from pathlib import Path
import re


_input_spec = importlib.util.spec_from_file_location("oxygen_markdown_user_input", Path(__file__).with_name("trajectory_user_input.py"))
USER_INPUT = importlib.util.module_from_spec(_input_spec)
_input_spec.loader.exec_module(USER_INPUT)


class MarkdownError(ValueError):
    """Content-free export failure; the source JSONL remains authoritative."""


SETUP_BLOCK = re.compile(
    r"\s*<(environment_context|recommended_plugins|skills_instructions|user_instructions|"
    r"model_switch|permissions|collaboration_mode|apps_instructions|plugins_instructions|"
    r"multi_agent_role|multi_agent_mode|app-context)(?:\s[^>]*)?>"
    r"[\s\S]*?</\1>\s*"
)
SETUP_ITEMS = {"additional_tools", "configuration_update", "compaction_trigger"}
INJECTED_KIND_PREFIXES = (
    "generic.", "host_skills.", "permissions.", "collaboration_mode.",
    "apps.", "plugins.", "multi_agent.", "model_switch.", "environments.",
)


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _argument_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate argument key")
        value[key] = item
    return value


def _fence(text, language="text"):
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    delimiter = "`" * max(3, longest + 1)
    return delimiter + language + "\n" + text + ("" if text.endswith("\n") else "\n") + delimiter


def _text(content):
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        raise MarkdownError("Markdown content must be text or a list of text blocks")
    parts = []
    for block in content:
        if not isinstance(block, dict):
            raise MarkdownError("invalid Markdown content block")
        if not block or block == {"type": "encrypted_content"}:
            # The structural filter removes ciphertext but preserves the type
            # marker. This empty shell contains no readable evidence.
            continue
        if block.get("type") not in {None, "input_text", "output_text", "summary_text", "text", "reasoning_text"} or not isinstance(block.get("text"), str):
            raise MarkdownError("unsupported non-text content; inspect the stripped JSONL")
        parts.append(block["text"])
    return "\n".join(parts)


def _user_input(payload):
    """Return retained text and omitted-block reasons; explicit user provenance wins."""
    if payload.get("type") != "message" or payload.get("role") != "user":
        return None, []
    content = payload.get("content", [])
    if isinstance(content, str):
        blocks = [{"type": "text", "text": content}]
    elif isinstance(content, list):
        blocks = content
    else:
        raise MarkdownError("invalid user content")
    metadata = payload.get("internal_chat_message_metadata_passthrough") or {}
    if not isinstance(metadata, dict):
        raise MarkdownError("invalid user content metadata")
    kinds = metadata.get("content_item_kinds")
    if kinds is not None:
        if not isinstance(kinds, list) or len(kinds) != len(blocks) or any(not isinstance(kind, str) for kind in kinds):
            raise MarkdownError("misaligned user content metadata")
    else:
        kinds = [None] * len(blocks)
    selected, omitted = [], []
    for block, kind in zip(blocks, kinds):
        if kind and kind.startswith(INJECTED_KIND_PREFIXES):
            omitted.append(kind)
            continue
        text = _text([block])
        # Provenance identifies actual human text even when it quotes a whole
        # setup block. Unknown kinds remain evidence unless a legacy wrapper
        # identifies the entire block as injected context.
        if not (kind and kind.startswith("user.")):
            if SETUP_BLOCK.fullmatch(text):
                omitted.append("legacy.setup_block")
                continue
            if text.lstrip().startswith("# AGENTS.md instructions for "):
                omitted.append("legacy.agents_instructions")
                continue
        if text.strip():
            selected.append(block)
    return (_text(selected) if selected else None), omitted


def _tool_call(payload):
    kind = payload["type"]
    name = payload.get("name", kind)
    if not isinstance(name, str):
        raise MarkdownError("invalid tool name")
    namespace = payload.get("namespace")
    if namespace:
        if not isinstance(namespace, str):
            raise MarkdownError("invalid tool namespace")
        name = namespace + "." + name
    body = "**Name:** " + name
    if USER_INPUT.user_input_tool(payload.get("name")):
        body += "\n\n**Call ID:** " + str(payload.get("call_id", ""))
    if kind == "custom_tool_call":
        value = payload.get("input", "")
        return body + "\n\n" + (_fence(value) if isinstance(value, str) else _fence(_json(value), "json"))
    if "arguments" in payload:
        arguments = payload["arguments"]
    else:
        # Shell/search calls can carry structured action fields directly.
        arguments = {key: value for key, value in payload.items() if key not in {
            "type", "name", "namespace", "id", "call_id", "status", "internal_chat_message_metadata_passthrough",
        }}
    if isinstance(arguments, str):
        try:
            decoded = json.loads(arguments, object_pairs_hook=_argument_object)
            _json(decoded)  # Non-finite numbers cannot be losslessly reserialized as JSON.
        except (ValueError, RecursionError):
            return body + "\n\n" + _fence(arguments)
        if not isinstance(decoded, dict):
            return body + "\n\n" + _fence(arguments)
        arguments = decoded
    if not isinstance(arguments, dict):
        return body + "\n\n" + _fence(_json(arguments), "json")
    if not arguments:
        return body + "\n\n**Arguments:** `{}`"
    for key, value in arguments.items():
        body += "\n\n### " + key + "\n\n"
        body += _fence(value) if isinstance(value, str) else _fence(_json(value), "json")
    return body


def _user_input_result(payload, tool):
    body = "**Tool:** " + tool + "\n\n**Call ID:** " + payload["call_id"]
    output = payload["output"]
    # Preserve the full result, including question IDs, free text, empty answers,
    # cancellations, and errors. A result is not necessarily a human approval.
    if isinstance(output, str):
        return body + "\n\n" + _fence(output)
    return body + "\n\n" + _fence(_json(output), "json")


def render(records, title):
    """Return UTF-8 Markdown and a content-free inventory; never execute content."""
    first = None
    user_text = {}
    injected = []
    input_results = {}
    user_inputs = USER_INPUT.UserInputResults()
    for index, record in enumerate(records):
        payload = record["payload"]
        try:
            if record["type"] == "compacted":
                for item in payload.get("replacement_history") or []:
                    user_inputs.observe(item)
            elif record["type"] == "response_item":
                user_inputs.observe(payload)
                result_tool = user_inputs.result_tool(payload)
                if result_tool:
                    input_results[index] = result_tool
        except ValueError as exc:
            raise MarkdownError(str(exc)) from exc
        if record["type"] != "response_item" or payload.get("type") != "message":
            continue
        role = payload.get("role")
        if role in {"system", "developer"}:
            content = payload.get("content")
            omitted = ["role:" + role] * (len(content) if isinstance(content, list) else int(bool(content)))
            whole_message = True
        elif role == "user":
            body, omitted = _user_input(payload)
            user_text[index] = body
            whole_message = body is None
            if first is None and body is not None:
                first = index
        else:
            continue
        if omitted or role in {"system", "developer"}:
            injected.append({
                "stripped_record": index + 1, "role": role,
                "whole_message": whole_message, "content_blocks": len(omitted),
                "reasons": dict(sorted(Counter(omitted).items())),
            })
    if first is None:
        raise MarkdownError("no original user input found; Markdown was not exported")
    sections = []
    roles = Counter()
    excluded = Counter(record["type"] for record in records[:first])
    source_records = []
    for index, record in enumerate(records[first:], first):
        payload = record["payload"]
        record_type = record["type"]
        role, body = None, None
        if record_type == "response_item":
            kind = payload.get("type")
            if kind == "message":
                role = payload.get("role")
                if role not in {"user", "assistant", "developer", "system"}:
                    raise MarkdownError("unsupported message role")
                if role in {"system", "developer"}:
                    excluded["injected_" + role + "_message"] += 1
                    continue
                body = user_text[index] if role == "user" else _text(payload.get("content"))
                if body is None:
                    excluded["injected_or_empty_user_message"] += 1
                    continue
            elif kind == "agent_message":
                content = _text(payload.get("content"))
                if not content:
                    excluded["empty_agent_message"] += 1
                    continue
                role = "agent message"
                body = "**From:** " + str(payload.get("author", "unknown")) + "\n\n**To:** " + str(payload.get("recipient", "unknown")) + "\n\n" + content
            elif kind == "reasoning":
                role = "assistant reasoning"
                body = "\n".join(part for field in ("summary", "content") if (part := _text(payload.get(field))))
                if not body:
                    excluded["empty_reasoning"] += 1
                    continue
            elif isinstance(kind, str) and kind.endswith("_call") and kind != "image_generation_call":
                role, body = "tool call", _tool_call(payload)
            elif index in input_results:
                role = "user input result"
                body = _user_input_result(payload, input_results[index])
            elif kind in {"compaction", "compaction_summary", "context_compaction"}:
                role = "compaction summary"
                body = "\n".join(part for field in ("message", "summary", "content") if (part := _text(payload.get(field))))
                if not body:
                    excluded["empty_compaction"] += 1
                    continue
            elif kind in SETUP_ITEMS:
                excluded[kind] += 1
                continue
            else:
                raise MarkdownError("unsupported response item in Markdown export")
        elif record_type == "compacted" and payload.get("message"):
            role, body = "compaction summary", _text(payload["message"])
        else:
            excluded[record_type] += 1
            continue
        sections.append("## " + role + "\n\n" + body)
        roles[role] += 1
        source_records.append(index + 1)
    # Keep the familiar transcript title; the first conversation section is user.
    safe_title = title.replace("\r", " ").replace("\n", " ")
    data = ("# " + safe_title + "\n\n" + "\n\n---\n\n".join(sections) + "\n").encode("utf-8")
    return data, {
        "schema": "oxygen.trajectory-markdown", "version": 5,
        "tool_call_format": "readable_tool_call",
        "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
        "sections": len(sections), "roles": dict(sorted(roles.items())),
        "first_user_stripped_record": first + 1,
        "stripped_record_for_each_section": source_records,
        "excluded_records": dict(sorted(excluded.items())),
        "injected_content_removed": {
            "messages": sum(item["whole_message"] for item in injected),
            "partial_messages": sum(not item["whole_message"] for item in injected),
            "content_blocks": sum(item["content_blocks"] for item in injected),
            "by_role": dict(sorted(Counter(item["role"] for item in injected).items())),
            "records": injected,
        },
        "injected_turn_policy": "all_system_developer_and_recognized_user_context_throughout",
        "user_input_results_included": True,
        "chat_template_applied": False,
        "base_system_prompts_included": False, "tool_definitions_included": False,
    }
