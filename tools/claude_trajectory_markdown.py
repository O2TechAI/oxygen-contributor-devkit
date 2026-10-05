"""Render structurally stripped Claude Code records as a plain-role Markdown transcript.

The output uses the same headings as the Codex exporter, so the summary, insight,
and redaction workers and the review app consume it unchanged.
"""

from collections import Counter
import hashlib
import importlib.util
from pathlib import Path
import re


_codex_spec = importlib.util.spec_from_file_location(
    "oxygen_codex_markdown", Path(__file__).with_name("trajectory_markdown.py"))
CODEX = importlib.util.module_from_spec(_codex_spec)
_codex_spec.loader.exec_module(CODEX)
_fence, _json = CODEX._fence, CODEX._json

_strip_spec = importlib.util.spec_from_file_location(
    "oxygen_claude_strip_markdown", Path(__file__).with_name("strip_claude_tool_outputs.py"))


class MarkdownError(ValueError):
    """Content-free export failure; the stripped JSONL remains authoritative."""


# Harness notes Claude Code wraps around typed text (timestamps, reminders).
EDGE_REMINDER = re.compile(r"^\s*<system-reminder>[\s\S]*?</system-reminder>\s*|\s*<system-reminder>[\s\S]*?</system-reminder>\s*$")
COMMAND_TAG = re.compile(r"<(command-name|command-message|command-args)>([\s\S]*?)</\1>")
BASH_INPUT = re.compile(r"^\s*<bash-input>([\s\S]*)</bash-input>\s*$")
MEDIA_PLACEHOLDER = {"image": "[image omitted]", "document": "[document omitted]"}
REJECTION_MARKER = "User rejected tool use"


def _strip_edge_reminders(text):
    previous = None
    while previous != text:
        previous, text = text, EDGE_REMINDER.sub("", text, count=1)
    return text


def _typed_text(text):
    """Return what the person typed, rendering slash and shell commands compactly."""
    text = _strip_edge_reminders(text)
    tags = dict((name, value.strip()) for name, value in COMMAND_TAG.findall(text))
    if "command-name" in tags and not COMMAND_TAG.sub("", text).strip():
        return (tags["command-name"] + (" " + tags["command-args"] if tags.get("command-args") else "")).strip()
    match = BASH_INPUT.match(text)
    if match:
        return "! " + match.group(1).strip()
    return text


def _content_text(content):
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            parts.append(block["text"])
        elif block.get("type") in MEDIA_PLACEHOLDER:
            parts.append(MEDIA_PLACEHOLDER[block["type"]])
        else:
            raise MarkdownError("unsupported non-text tool result content; inspect the stripped JSONL")
    return "\n".join(parts)


def _user_text(record):
    """Return (text or None, omission reasons) for a typed user message."""
    if record.get("isMeta"):
        return None, ["isMeta"]
    content = record["message"]["content"]
    blocks = [{"type": "text", "text": content}] if isinstance(content, str) else content
    parts, omitted = [], []
    for block in blocks:
        kind = block.get("type")
        if kind == "text":
            text = _typed_text(block["text"])
            if _strip_edge_reminders(block["text"]) != block["text"]:
                omitted.append("system_reminder")
            if text.strip():
                parts.append(text)
        elif kind in MEDIA_PLACEHOLDER:
            parts.append(MEDIA_PLACEHOLDER[kind])
        elif kind != "tool_result":
            raise MarkdownError("unsupported user content block")
    return ("\n\n".join(parts) if parts else None), omitted


def _tool_call(block):
    body = "**Name:** " + block["name"]
    if block["name"] == "AskUserQuestion":
        body += "\n\n**Call ID:** " + block["id"]
    arguments = block.get("input")
    if not isinstance(arguments, dict):
        return body + "\n\n" + _fence(_json(arguments), "json")
    if not arguments:
        return body + "\n\n**Arguments:** `{}`"
    for key, value in arguments.items():
        body += "\n\n### " + key + "\n\n"
        body += _fence(value) if isinstance(value, str) else _fence(_json(value), "json")
    return body


def _input_result(block, record, kind):
    rejected = kind.startswith("rejected:")
    tool = kind.split(":", 1)[1] if rejected else kind
    body = "**Tool:** " + tool + "\n\n**Call ID:** " + block["tool_use_id"]
    if record.get("toolUseResult") == REJECTION_MARKER:
        outcome = "rejected by user"
    elif block.get("is_error"):
        outcome = "error"
    else:
        outcome = "answered"
    body += "\n\n**Outcome:** " + outcome
    body += "\n\n" + _fence(_content_text(block.get("content")))
    structured = record.get("toolUseResult")
    if isinstance(structured, dict) and "answers" in structured:
        body += "\n\n### answers\n\n" + _fence(_json(structured["answers"]), "json")
    return body


def render(records, title):
    """Return UTF-8 Markdown and a content-free inventory; never execute content."""
    strip = importlib.util.module_from_spec(_strip_spec)
    _strip_spec.loader.exec_module(strip)
    calls = strip.ToolCalls()
    sections, roles, excluded, source_records, injected = [], Counter(), Counter(), [], []
    children = Counter()
    started = False

    def emit(role, body, index):
        sections.append("## " + role + "\n\n" + body)
        roles[role] += 1
        source_records.append(index + 1)

    for index, record in enumerate(records):
        kind = record["type"]
        if kind in {"user", "assistant"} and record.get("parentUuid") and not record.get("isMeta"):
            content = record["message"]["content"]
            if kind == "user" and (isinstance(content, str) or any(b.get("type") == "text" for b in content)):
                children[record["parentUuid"]] += 1
        if kind == "attachment":
            attachment = record["attachment"]
            if not strip.is_human_queued_command(attachment):
                raise MarkdownError("non-human queued command reached Markdown export")
            body, _ = _user_text({"message": {"content": attachment.get("prompt")}})
            if body is None:
                excluded["empty_queued_command"] += 1
                continue
            started = True
            emit("user", body, index)
            continue
        if kind == "system":
            excluded["system:" + str(record.get("subtype"))] += 1
            continue
        message = record["message"]
        content = message["content"]
        if kind == "user":
            if record.get("isCompactSummary"):
                if started:
                    emit("compaction summary", _content_text(content), index)
                else:
                    excluded["compaction_before_first_user"] += 1
                continue
            if isinstance(content, list) and any(b.get("type") == "tool_result" for b in content):
                for block in content:
                    if block.get("type") != "tool_result":
                        raise MarkdownError("mixed tool result and user content is unsupported")
                    result_kind = calls.retained_kind(block, record)
                    if not result_kind:
                        raise MarkdownError("unretained tool result reached Markdown export")
                    if started:
                        emit("user input result", _input_result(block, record, result_kind), index)
                continue
            body, omitted = _user_text(record)
            if omitted:
                injected.append({"stripped_record": index + 1, "whole_message": body is None,
                                 "reasons": dict(sorted(Counter(omitted).items()))})
            if body is None:
                excluded["injected_or_empty_user_message"] += 1
                continue
            started = True
            emit("user", body, index)
            continue
        # Assistant records hold one or more content blocks.
        blocks = [{"type": "text", "text": content}] if isinstance(content, str) else content
        for block in blocks:
            if block.get("type") in {"tool_use", "server_tool_use"}:
                calls.observe(block)
        if not started:
            excluded["assistant_before_first_user"] += 1
            continue
        if message.get("model") == "<synthetic>" or record.get("isApiErrorMessage"):
            excluded["synthetic_assistant_message"] += 1
            continue
        for block in blocks:
            block_type = block.get("type")
            if block_type == "text":
                if block["text"].strip():
                    emit("assistant", block["text"], index)
                else:
                    excluded["empty_assistant_text"] += 1
            elif block_type == "thinking":
                if (block.get("thinking") or "").strip():
                    emit("assistant reasoning", block["thinking"], index)
                else:
                    excluded["signature_only_thinking"] += 1
            elif block_type == "redacted_thinking":
                excluded["redacted_thinking"] += 1
            elif block_type in {"tool_use", "server_tool_use"}:
                emit("tool call", _tool_call(block), index)
            else:
                raise MarkdownError("unsupported assistant block in Markdown export")
    if not started:
        raise MarkdownError("no original user input found; Markdown was not exported")
    safe_title = title.replace("\r", " ").replace("\n", " ")
    data = ("# " + safe_title + "\n\n" + "\n\n---\n\n".join(sections) + "\n").encode("utf-8")
    return data, {
        "schema": "oxygen.claude-trajectory-markdown", "version": 1,
        "tool_call_format": "readable_tool_call",
        "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
        "sections": len(sections), "roles": dict(sorted(roles.items())),
        "stripped_record_for_each_section": source_records,
        "excluded": dict(sorted(excluded.items())),
        "injected_content_removed": {
            "messages": sum(item["whole_message"] for item in injected),
            "partial_messages": sum(not item["whole_message"] for item in injected),
            "records": injected,
        },
        # Rewinds create sibling prompts under one parent; the transcript keeps file order.
        "rewind_branch_points": sum(1 for count in children.values() if count > 1),
        "branch_policy": "file_order_all_branches",
        "user_input_results_included": True,
        "chat_template_applied": False,
        "base_system_prompts_included": False, "tool_definitions_included": False,
    }
