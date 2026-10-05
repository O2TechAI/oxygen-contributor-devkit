#!/usr/bin/env python3
"""Strip tool outputs, harness context, and opaque signatures from a Claude Code session.

Results of AskUserQuestion calls and tool calls the user rejected are retained,
because they carry human input. Identity comes from the preceding tool_use block
and the harness's structured rejection marker, never from answer wording.
"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from typing import Any


REPORT_SCHEMA = "oxygen.claude-tool-output-filter-report"
REPORT_VERSION = 1
UNCHANGED = object()

_codex_spec = importlib.util.spec_from_file_location(
    "oxygen_strip_codex", Path(__file__).with_name("strip_tool_outputs.py"))
CODEX = importlib.util.module_from_spec(_codex_spec)
_codex_spec.loader.exec_module(CODEX)
FilterError = CODEX.FilterError

USER_INPUT_TOOLS = {"AskUserQuestion"}
# Claude Code records a user's denial of a tool call with this structured result.
REJECTION_MARKER = "User rejected tool use"
# Human-typed text arrives through these attachments while the agent is working.
RETAINED_ATTACHMENTS = {"queued_command"}
RETAINED_SYSTEM_SUBTYPES = {"compact_boundary"}
OUTPUT_TEXT_PREFIXES = ("<local-command-stdout>", "<local-command-stderr>", "<bash-stdout>", "<bash-stderr>")
ASSISTANT_BLOCKS = {"text", "thinking", "redacted_thinking", "tool_use", "server_tool_use"}
USER_BLOCKS = {"text", "image", "document", "tool_result"}
MEDIA_BLOCKS = {"image", "document"}


def _decode_line(raw: bytes, line_number: int) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=CODEX._reject_duplicate_keys,
                           parse_constant=CODEX._reject_constant)
    except UnicodeDecodeError as exc:
        raise FilterError(f"line {line_number}: invalid UTF-8") from exc
    except FilterError as exc:
        raise FilterError(f"line {line_number}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise FilterError(f"line {line_number}: invalid JSON at column {exc.colno}") from exc
    if not isinstance(value, dict) or not isinstance(value.get("type"), str):
        raise FilterError(f"line {line_number}: session record must be an object with a string type")
    return value


def _encode(record: dict[str, Any]) -> bytes:
    return CODEX._canonical_json_bytes(record) + b"\n"


def _size(value: Any) -> int:
    return len(CODEX._canonical_json_bytes(value))


def _message(record: dict[str, Any], line_number: int) -> dict[str, Any]:
    message = record.get("message")
    if not isinstance(message, dict):
        raise FilterError(f"line {line_number}: {record['type']} record requires a message object")
    content = message.get("content")
    if not isinstance(content, (str, list)) or isinstance(content, list) and not all(isinstance(b, dict) for b in content):
        raise FilterError(f"line {line_number}: message content must be text or a list of blocks")
    return message


def _leading_text(content: Any) -> str:
    if isinstance(content, str):
        return content.lstrip()
    for block in content:
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            return block["text"].lstrip()
    return ""


def is_task_notification(record: dict[str, Any]) -> bool:
    origin = record.get("origin")
    if isinstance(origin, dict) and origin.get("kind") == "task-notification":
        return True
    return _leading_text(record["message"]["content"]).startswith("<task-notification>")


def is_human_queued_command(attachment: dict[str, Any]) -> bool:
    origin = attachment.get("origin")
    if origin is not None and not (isinstance(origin, dict) and origin.get("kind") == "human"):
        return False
    return attachment.get("commandMode") == "prompt"


class ToolCalls:
    """Map tool_use IDs to tool names so results are classified by call identity."""

    def __init__(self) -> None:
        self.names: dict[str, str] = {}

    def observe(self, block: dict[str, Any]) -> None:
        call_id, name = block.get("id"), block.get("name")
        if not isinstance(call_id, str) or not call_id or not isinstance(name, str):
            raise ValueError("tool_use block requires a string id and name")
        if self.names.setdefault(call_id, name) != name:
            raise ValueError("conflicting tool names for a tool_use id")

    def retained_kind(self, block: dict[str, Any], record: dict[str, Any]) -> str | None:
        name = self.names.get(block.get("tool_use_id"))
        if name in USER_INPUT_TOOLS:
            return name
        if name and block.get("is_error") is True and record.get("toolUseResult") == REJECTION_MARKER:
            return "rejected:" + name
        return None


class FilterState:
    def __init__(self) -> None:
        self.calls = ToolCalls()
        self.input_records = 0
        self.output_records = 0
        self.records_before: Counter[str] = Counter()
        self.records_after: Counter[str] = Counter()
        self.removed_by_carrier: Counter[str] = Counter()
        self.removed_bytes = 0
        self.dropped_metadata: Counter[str] = Counter()
        self.signatures_removed = 0
        self.signature_bytes_removed = 0
        self.media_removed: Counter[str] = Counter()
        self.media_bytes_removed = 0
        self.retained_tool_calls: Counter[str] = Counter()
        self.retained_user_input_results: Counter[str] = Counter()
        self.compaction_summaries = 0

    def _remove(self, carrier: str, value: Any) -> None:
        self.removed_by_carrier[carrier] += 1
        self.removed_bytes += _size(value)

    def transform(self, record: dict[str, Any], line_number: int) -> Any:
        self.input_records += 1
        kind = record["type"]
        label = kind
        if kind == "system":
            label += ":" + str(record.get("subtype"))
        elif kind == "attachment":
            attachment = record.get("attachment")
            label += ":" + str(attachment.get("type") if isinstance(attachment, dict) else None)
        self.records_before[label] += 1
        try:
            result = self._transform(record, kind, label, line_number)
        except ValueError as exc:
            if isinstance(exc, FilterError):
                raise
            raise FilterError(f"line {line_number}: {exc}") from exc
        if result is not None:
            self.output_records += 1
            self.records_after[label] += 1
        return result

    def _transform(self, record, kind, label, line_number):
        if kind == "assistant":
            return self._assistant(record, line_number)
        if kind == "user":
            return self._user(record, line_number)
        if kind == "system" and record.get("subtype") in RETAINED_SYSTEM_SUBTYPES:
            return UNCHANGED
        if kind == "attachment" and label.split(":", 1)[1] in RETAINED_ATTACHMENTS:
            return self._queued(record, label, line_number)
        if kind in {"system", "attachment"}:
            # Harness context and local command/hook output; never part of the transcript.
            self._remove(label, record)
            return None
        # Titles, queue operations, file-history backups, mode switches, and newer
        # metadata records. Unknown metadata is dropped and counted, not fatal.
        self.dropped_metadata[kind] += 1
        return None

    def _queued(self, record, label, line_number):
        attachment = record["attachment"]
        if not is_human_queued_command(attachment):
            # Background task notifications are delivered through the same queue.
            self._remove(label + ":" + str(attachment.get("commandMode")), record)
            return None
        prompt = attachment.get("prompt")
        if isinstance(prompt, str):
            return UNCHANGED
        if not isinstance(prompt, list) or not all(isinstance(block, dict) for block in prompt):
            raise FilterError(f"line {line_number}: queued prompt must be text or a list of blocks")
        blocks, changed = self._strip_media(prompt, line_number)
        if not changed:
            return UNCHANGED
        return dict(record, attachment=dict(attachment, prompt=blocks))

    def _strip_media(self, blocks, line_number):
        kept, changed = [], False
        for block in blocks:
            if block.get("type") in MEDIA_BLOCKS:
                source = block.get("source")
                if isinstance(source, dict) and "data" in source:
                    data = source["data"]
                    self.media_removed[block["type"]] += 1
                    self.media_bytes_removed += len(data.encode("utf-8")) if isinstance(data, str) else 0
                    block = dict(block, source={key: value for key, value in source.items() if key != "data"})
                    changed = True
            elif block.get("type") != "text":
                raise FilterError(f"line {line_number}: unsupported queued prompt block type")
            kept.append(block)
        return kept, changed

    def _assistant(self, record, line_number):
        message = _message(record, line_number)
        content = message["content"]
        if isinstance(content, str):
            return UNCHANGED
        changed = False
        kept = []
        for block in content:
            block_type = block.get("type")
            if isinstance(block_type, str) and block_type.endswith("_tool_result"):
                self._remove("assistant:" + block_type, block)
                changed = True
                continue
            if block_type not in ASSISTANT_BLOCKS:
                raise FilterError(f"line {line_number}: unsupported assistant block type")
            if block_type in {"tool_use", "server_tool_use"}:
                self.calls.observe(block)
                self.retained_tool_calls[block["name"]] += 1
            field = {"thinking": "signature", "redacted_thinking": "data"}.get(block_type)
            if field and field in block:
                value = block[field]
                if value is not None and not isinstance(value, str):
                    raise FilterError(f"line {line_number}: {field} must be a string or null")
                block = {key: item for key, item in block.items() if key != field}
                self.signatures_removed += 1
                self.signature_bytes_removed += len((value or "").encode("utf-8"))
                changed = True
            kept.append(block)
        if not changed:
            return UNCHANGED
        if not kept:
            return None
        return dict(record, message=dict(message, content=kept))

    def _user(self, record, line_number):
        message = _message(record, line_number)
        content = message["content"]
        if is_task_notification(record):
            self._remove("user:task_notification", record)
            return None
        if _leading_text(content).startswith(OUTPUT_TEXT_PREFIXES):
            self._remove("user:local_command_output", record)
            return None
        if isinstance(content, str):
            if "toolUseResult" in record:
                self._remove("toolUseResult", record["toolUseResult"])
                return {key: value for key, value in record.items() if key != "toolUseResult"}
            if record.get("isCompactSummary"):
                self.compaction_summaries += 1
            return UNCHANGED
        changed = False
        kept = []
        retained_results = []
        for block in content:
            block_type = block.get("type")
            if block_type not in USER_BLOCKS:
                raise FilterError(f"line {line_number}: unsupported user block type")
            if block_type == "tool_result":
                retained = self.calls.retained_kind(block, record)
                if retained:
                    retained_results.append(retained)
                    kept.append(block)
                else:
                    name = self.calls.names.get(block.get("tool_use_id"), "unknown")
                    self._remove("tool_result:" + name, block)
                    changed = True
                continue
            if block_type in MEDIA_BLOCKS:
                source = block.get("source")
                if isinstance(source, dict) and "data" in source:
                    data = source["data"]
                    self.media_removed[block_type] += 1
                    self.media_bytes_removed += len(data.encode("utf-8")) if isinstance(data, str) else 0
                    source = {key: value for key, value in source.items() if key != "data"}
                    block = dict(block, source=source)
                    changed = True
            kept.append(block)
        keep_result_payload = len(retained_results) == 1 and len(kept) == 1
        updated = dict(record)
        if "toolUseResult" in record and not keep_result_payload:
            self._remove("toolUseResult", record["toolUseResult"])
            del updated["toolUseResult"]
            changed = True
        for retained in retained_results:
            self.retained_user_input_results[retained] += 1
        if record.get("isCompactSummary"):
            self.compaction_summaries += 1
        if not kept:
            return None
        if not changed:
            return UNCHANGED
        updated["message"] = dict(message, content=kept)
        return updated


def _audit_clean(path: Path) -> None:
    calls = ToolCalls()
    with path.open("rb") as stream:
        for line_number, raw in enumerate(stream, 1):
            record = _decode_line(raw, line_number)
            kind = record["type"]
            if kind == "system" and record.get("subtype") not in RETAINED_SYSTEM_SUBTYPES:
                raise FilterError("post-filter audit found a system record")
            if kind == "attachment":
                attachment = record.get("attachment") or {}
                if attachment.get("type") not in RETAINED_ATTACHMENTS or not is_human_queued_command(attachment):
                    raise FilterError("post-filter audit found a context attachment")
                prompt = attachment.get("prompt")
                if isinstance(prompt, list) and any("data" in (block.get("source") or {}) for block in prompt):
                    raise FilterError("post-filter audit found embedded media data")
            if kind not in {"user", "assistant", "system", "attachment"}:
                raise FilterError("post-filter audit found a metadata record")
            if kind not in {"user", "assistant"}:
                continue
            content = record["message"]["content"]
            if kind == "user" and (is_task_notification(record) or _leading_text(content).startswith(OUTPUT_TEXT_PREFIXES)):
                raise FilterError("post-filter audit found a tool output message")
            if isinstance(content, str):
                if "toolUseResult" in record:
                    raise FilterError("post-filter audit found a tool result payload")
                continue
            retained = 0
            for block in content:
                block_type = block.get("type")
                if block_type in {"tool_use", "server_tool_use"}:
                    calls.observe(block)
                if block_type == "thinking" and "signature" in block or block_type == "redacted_thinking" and "data" in block:
                    raise FilterError("post-filter audit found an opaque signature")
                if block_type in MEDIA_BLOCKS and "data" in (block.get("source") or {}):
                    raise FilterError("post-filter audit found embedded media data")
                if isinstance(block_type, str) and block_type.endswith("_tool_result"):
                    raise FilterError("post-filter audit found a server tool result")
                if block_type == "tool_result":
                    if not calls.retained_kind(block, record):
                        raise FilterError("post-filter audit found a tool result")
                    retained += 1
            if "toolUseResult" in record and not (retained == 1 and len(content) == 1):
                raise FilterError("post-filter audit found a tool result payload")


def _write_private(destination: Path, data: bytes) -> None:
    fd, name = tempfile.mkstemp(dir=destination.parent, prefix=f".{destination.name}.", suffix=".tmp")
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        CODEX._link_private_temp(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def filter_session(source_path, destination_path, report_path=None, *, markdown_path=None, tokenizer_path=None):
    source = Path(source_path)
    destination = Path(destination_path)
    report = Path(report_path) if report_path is not None else None
    CODEX._validate_paths(source, destination, report)
    markdown = Path(markdown_path) if markdown_path is not None else None
    if tokenizer_path is not None and markdown is None:
        raise FilterError("tokenizer requires a Markdown output path")
    if markdown is not None:
        CODEX._validate_paths(source, markdown, None)
        if markdown.suffix.lower() != ".md":
            raise FilterError("Markdown output must end in .md")
        if markdown.resolve(strict=False) in {destination.resolve(strict=False), report.resolve(strict=False) if report else None}:
            raise FilterError("Markdown path must differ from JSONL and report paths")

    state = FilterState()
    source_digest, output_digest = hashlib.sha256(), hashlib.sha256()
    input_bytes = output_bytes = 0
    temp_fd, temp_name = tempfile.mkstemp(dir=destination.parent, prefix=f".{destination.name}.", suffix=".tmp")
    temp_path = Path(temp_name)
    markdown_result = None
    markdown_bytes = None
    try:
        with source.open("rb") as source_file, os.fdopen(temp_fd, "wb") as output_file:
            start_stat = os.fstat(source_file.fileno())
            for line_number, raw in enumerate(source_file, 1):
                source_digest.update(raw)
                input_bytes += len(raw)
                if not raw.strip():
                    continue
                transformed = state.transform(_decode_line(raw, line_number), line_number)
                if transformed is None:
                    continue
                if transformed is UNCHANGED:
                    emitted = raw if raw.endswith(b"\n") else raw + b"\n"
                else:
                    emitted = _encode(transformed)
                output_file.write(emitted)
                output_digest.update(emitted)
                output_bytes += len(emitted)
            output_file.flush()
            os.fsync(output_file.fileno())
            end_stat = os.fstat(source_file.fileno())
        if not CODEX._same_file_snapshot(start_stat, end_stat) or not CODEX._same_file_snapshot(start_stat, source.stat()):
            raise FilterError("input changed while it was being filtered")
        _audit_clean(temp_path)
        if markdown is not None:
            spec = importlib.util.spec_from_file_location(
                "oxygen_claude_markdown", Path(__file__).with_name("claude_trajectory_markdown.py"))
            renderer = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(renderer)
            with temp_path.open("rb") as filtered:
                records = [_decode_line(line, index) for index, line in enumerate(filtered, 1)]
            try:
                markdown_bytes, markdown_result = renderer.render(records, markdown.stem)
            except renderer.MarkdownError as exc:
                raise FilterError(str(exc)) from exc
            except (ValueError, TypeError, KeyError, RecursionError) as exc:
                raise FilterError("invalid content structure for Markdown export") from exc
            if tokenizer_path is not None:
                markdown_result.update(_count_tokens(markdown_bytes, Path(tokenizer_path)))
        CODEX._link_private_temp(temp_path, destination)
        if markdown_bytes is not None:
            _write_private(markdown, markdown_bytes)
    except Exception:
        try:
            os.close(temp_fd)
        except OSError:
            pass
        temp_path.unlink(missing_ok=True)
        raise

    counter = CODEX._counter_dict
    result: dict[str, Any] = {
        "schema": REPORT_SCHEMA, "version": REPORT_VERSION, "format": "claude-code",
        "input": {"sha256": source_digest.hexdigest(), "bytes": input_bytes, "records": state.input_records},
        "output": {"sha256": output_digest.hexdigest(), "bytes": output_bytes, "records": state.output_records,
                   "byte_delta": input_bytes - output_bytes},
        "removed": {
            "by_carrier": counter(state.removed_by_carrier),
            "removed_payload_canonical_bytes": state.removed_bytes,
            "metadata_records": counter(state.dropped_metadata),
            "opaque_signatures": state.signatures_removed,
            "opaque_signature_value_utf8_bytes": state.signature_bytes_removed,
            "embedded_media": counter(state.media_removed),
            "embedded_media_value_utf8_bytes": state.media_bytes_removed,
        },
        "compaction": {"summary_messages_retained": state.compaction_summaries},
        "inventory": {
            "records_before": counter(state.records_before),
            "records_after": counter(state.records_after),
            "tool_calls_retained": counter(state.retained_tool_calls),
            "user_input_results_retained": counter(state.retained_user_input_results),
        },
        "policy": {
            "ordinary_tool_outputs_removed": True,
            "user_input_results_retained": True,
            "user_input_result_tools": sorted(USER_INPUT_TOOLS),
            "user_rejections_retained": True,
            "user_input_result_matching": "preceding_tool_use_id_and_structured_rejection_marker",
            "task_notifications_removed": True,
            "context_attachments_removed": True,
            "queued_user_messages_retained": True,
            "thinking_signatures_removed": True,
            "embedded_media_data_removed": True,
            "subagent_transcripts_included": False,
            "semantic_erasure_guaranteed": False,
            "resumable_claude_session": False,
        },
    }
    if markdown_result is not None:
        result["markdown"] = markdown_result
    if report is not None:
        _write_private(report, CODEX._canonical_json_bytes(result) + b"\n")
    return result


def _count_tokens(data: bytes, tokenizer_file: Path) -> dict[str, Any]:
    if not tokenizer_file.is_file() or tokenizer_file.is_symlink():
        raise FilterError("tokenizer must be a local regular tokenizer.json file")
    try:
        import tokenizers
    except ImportError as exc:
        raise FilterError("optional Markdown token counts require the tokenizers package") from exc
    try:
        raw = tokenizer_file.read_bytes()
        tokenizer = tokenizers.Tokenizer.from_str(raw.decode("utf-8"))
        tokenizer.no_truncation()
        tokenizer.no_padding()
        count = len(tokenizer.encode(data.decode("utf-8"), add_special_tokens=False).ids)
    except Exception as exc:
        raise FilterError("could not count Markdown with the supplied local tokenizer") from exc
    return {"token_count": count, "tokenizer_sha256": hashlib.sha256(raw).hexdigest(),
            "tokenizers_version": tokenizers.__version__}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("input", help="collected Claude Code session JSONL snapshot")
    parser.add_argument("--output", required=True, help="new private output JSONL path")
    parser.add_argument("--report", help="optional new content-free JSON report path")
    parser.add_argument("--markdown", help="also export a plain-role Markdown transcript")
    parser.add_argument("--tokenizer", help="optional local tokenizer.json for Markdown token counts")
    args = parser.parse_args(argv)
    try:
        result = filter_session(args.input, args.output, args.report,
                                markdown_path=args.markdown, tokenizer_path=args.tokenizer)
    except (FilterError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=True, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
