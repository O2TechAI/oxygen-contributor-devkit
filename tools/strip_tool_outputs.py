#!/usr/bin/env python3
"""Strip ordinary tool outputs and encrypted content, retaining user-input results."""

from __future__ import annotations

import argparse
import base64
import binascii
from collections import Counter
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
from typing import Any


REPORT_SCHEMA = "oxygen.codex-tool-output-filter-report"
REPORT_VERSION = 4
UNCHANGED = object()
ENCRYPTED_AGENT_MESSAGE_MARKER = "[Encrypted subagent message removed]"
AGENT_MESSAGE_TOOLS = {"spawn_agent", "send_message", "followup_task"}

_input_spec = importlib.util.spec_from_file_location("oxygen_trajectory_user_input", Path(__file__).with_name("trajectory_user_input.py"))
USER_INPUT = importlib.util.module_from_spec(_input_spec)
_input_spec.loader.exec_module(USER_INPUT)

OUTPUT_ITEM_TYPES = {
    "function_call_output",
    "custom_tool_call_output",
    "tool_search_output",
}

COMBINED_CALL_OUTPUT_ITEM_TYPES = {
    "image_generation_call",
}

TOOL_PRESENTATION_TYPES = {
    "CollabAgentToolCall",
    "CommandExecution",
    "DynamicToolCall",
    "Extension",
    "FileChange",
    "FunctionCallOutput",
    "ImageGeneration",
    "ImageView",
    "McpToolCall",
    "WebSearch",
}

NON_TOOL_PRESENTATION_TYPES = {
    "AgentMessage",
    "ContextCompaction",
    "EnteredReviewMode",
    "ExitedReviewMode",
    "HookPrompt",
    "Plan",
    "Reasoning",
    "SubAgentActivity",
    "UserMessage",
}

LEGACY_TOOL_RESULT_EVENTS = {
    "dynamic_tool_call_response",
    "exec_command_end",
    "exec_command_output_delta",
    "image_generation_end",
    "mcp_tool_call_end",
    "patch_apply_end",
    "turn_diff",
    "web_search_end",
}

TOOL_CALL_ITEM_TYPES = {
    "custom_tool_call",
    "function_call",
    "tool_search_call",
}

KNOWN_RESPONSE_ITEM_TYPES = {
    "additional_tools",
    "agent_message",
    "compaction",
    "compaction_summary",
    "compaction_trigger",
    "configuration_update",
    "context_compaction",
    "custom_tool_call",
    "custom_tool_call_output",
    "function_call",
    "function_call_output",
    "image_generation_call",
    "local_shell_call",
    "message",
    "reasoning",
    "tool_search_call",
    "tool_search_output",
    "web_search_call",
}

SAFE_EVENT_TYPES = {
    "agent_message",
    "agent_message_content_delta",
    "agent_message_delta",
    "agent_reasoning",
    "agent_reasoning_delta",
    "agent_reasoning_raw_content",
    "agent_reasoning_raw_content_delta",
    "agent_reasoning_section_break",
    "apply_patch_approval_request",
    "auth_recovery_completed",
    "auth_recovery_started",
    "collab_agent_interaction_begin",
    "collab_agent_spawn_begin",
    "collab_close_begin",
    "collab_resume_begin",
    "collab_waiting_begin",
    "context_compacted",
    "deprecation_notice",
    "dynamic_tool_call_request",
    "elicitation_request",
    "entered_review_mode",
    "environment_connected",
    "environment_disconnected",
    "error",
    "exec_approval_request",
    "exec_command_begin",
    "exited_review_mode",
    "guardian_assessment",
    "guardian_warning",
    "hook_completed",
    "hook_started",
    "image_generation_begin",
    "mcp_startup_complete",
    "mcp_startup_update",
    "mcp_tool_call_begin",
    "model_reroute",
    "model_verification",
    "patch_apply_begin",
    "patch_apply_updated",
    "plan_delta",
    "plan_update",
    "raw_response_completed",
    "reasoning_content_delta",
    "reasoning_raw_content_delta",
    "realtime_conversation_closed",
    "realtime_conversation_list_voices_response",
    "realtime_conversation_realtime",
    "realtime_conversation_sdp",
    "realtime_conversation_started",
    "request_permissions",
    "request_user_input",
    "safety_buffering",
    "session_configured",
    "shutdown_complete",
    "stream_error",
    "sub_agent_activity",
    "task_complete",
    "task_started",
    "terminal_interaction",
    "thread_goal_updated",
    "thread_queue_changed",
    "thread_rolled_back",
    "thread_settings_applied",
    "token_count",
    "turn_aborted",
    "turn_complete",
    "turn_moderation_metadata",
    "turn_started",
    "user_message",
    "view_image_tool_call",
    "warning",
    "web_search_begin",
}


class FilterError(ValueError):
    """A content-free, user-actionable validation failure."""


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise FilterError("duplicate JSON object key")
        value[key] = item
    return value


def _reject_constant(_: str) -> None:
    raise FilterError("non-finite JSON number")


def _decode_line(raw: bytes, line_number: int) -> dict[str, Any]:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise FilterError(f"line {line_number}: invalid UTF-8") from exc
    try:
        value = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_constant,
        )
    except FilterError as exc:
        raise FilterError(f"line {line_number}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise FilterError(f"line {line_number}: invalid JSON at column {exc.colno}") from exc
    if not isinstance(value, dict):
        raise FilterError(f"line {line_number}: rollout record must be an object")
    if not isinstance(value.get("type"), str):
        raise FilterError(f"line {line_number}: rollout record type must be a string")
    if not isinstance(value.get("payload"), dict):
        raise FilterError(f"line {line_number}: rollout payload must be an object")
    return value


def _canonical_json_bytes(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise FilterError("record cannot be serialized as strict JSON") from exc


def _is_output_item(item_type: str) -> bool:
    return (
        item_type in OUTPUT_ITEM_TYPES
        or item_type in COMBINED_CALL_OUTPUT_ITEM_TYPES
        or item_type.endswith("_output")
    )


def _is_legacy_tool_result_event(event_type: str) -> bool:
    return (
        event_type in LEGACY_TOOL_RESULT_EVENTS
        or (event_type.startswith("collab_") and event_type.endswith("_end"))
        or event_type.endswith("_tool_call_end")
        or event_type.endswith("_tool_call_output")
        or event_type.endswith("_tool_call_response")
    )


def _counter_dict(counter: Counter[str]) -> dict[str, int]:
    return {key: counter[key] for key in sorted(counter)}


def _encrypted_field_owners(value: Any):
    """Visit rollout fields, leaving strings and tool argument data opaque."""
    if isinstance(value, dict):
        if "encrypted_content" in value:
            yield value
        item_type = value.get("type")
        is_call = isinstance(item_type, str) and (
            item_type.endswith("_call")
            or item_type in {"exec_command_begin", "mcp_tool_call_begin", "dynamic_tool_call_request"}
        )
        for key, child in value.items():
            if key == "encrypted_content" or (is_call and key in {"arguments", "input"}):
                continue
            yield from _encrypted_field_owners(child)
    elif isinstance(value, list):
        for child in value:
            yield from _encrypted_field_owners(child)


def _is_encrypted_agent_message(value: Any) -> bool:
    """Recognize a complete opaque token, not a quoted token or arbitrary base64.

    This checks the observed envelope shape only; it does not decrypt or
    authenticate it. Restrict use to known collaboration message arguments.
    """
    if not isinstance(value, str) or not value.startswith("gAAAA"):
        return False
    if not re.fullmatch(r"[A-Za-z0-9_-]+={0,2}", value):
        return False
    try:
        decoded = base64.b64decode(value, altchars=b"-_", validate=True)
    except (ValueError, binascii.Error):
        return False
    return len(decoded) >= 73 and decoded[0] == 0x80 and (len(decoded) - 57) % 16 == 0


def _encrypted_agent_message_slots(value: Any):
    """Find message values in retained call carriers, including checkpoint history."""
    if isinstance(value, dict):
        kind = value.get("type")
        is_call = isinstance(kind, str) and kind.endswith("_call")
        name = value.get("name")
        agent_call = (value.get("namespace") in (None, "collaboration") and
                      isinstance(name, str) and
                      (name in AGENT_MESSAGE_TOOLS or name in {"collaboration." + n for n in AGENT_MESSAGE_TOOLS}))
        if is_call and agent_call:
            for key in ("arguments", "input"):
                arguments = value.get(key)
                if isinstance(arguments, str):
                    try:
                        arguments = json.loads(arguments, object_pairs_hook=_reject_duplicate_keys,
                                               parse_constant=_reject_constant)
                    except (ValueError, RecursionError):
                        continue  # Opaque/malformed argument text is not rewritten.
                if isinstance(arguments, dict) and _is_encrypted_agent_message(arguments.get("message")):
                    yield value, key, arguments
        for key, child in value.items():
            if is_call and key in {"arguments", "input"}:
                continue  # Never scan arbitrary code or nested tool-argument data.
            yield from _encrypted_agent_message_slots(child)
    elif isinstance(value, list):
        for child in value:
            yield from _encrypted_agent_message_slots(child)


def _replace_message_value(arguments: str, replacement: str) -> str:
    """Replace only a top-level message JSON value, preserving all other spelling."""
    decoder = json.JSONDecoder()
    position = arguments.index("{") + 1
    while True:
        position = re.match(r"\s*", arguments[position:]).end() + position
        key, position = decoder.raw_decode(arguments, position)
        position = arguments.index(":", position) + 1
        position = re.match(r"\s*", arguments[position:]).end() + position
        start = position
        _, position = decoder.raw_decode(arguments, position)
        if key == "message":
            return arguments[:start] + json.dumps(replacement) + arguments[position:]
        position = arguments.index(",", position) + 1


class FilterState:
    def __init__(self) -> None:
        self.input_records = 0
        self.output_records = 0
        self.removed_records = 0
        self.whole_record_bytes_removed = 0
        self.removed_payload_canonical_bytes = 0
        self.compacted_records_seen = 0
        self.compacted_records_rewritten = 0
        self.nested_output_items_removed = 0
        self.removed_by_carrier: Counter[str] = Counter()
        self.response_before: Counter[str] = Counter()
        self.response_after: Counter[str] = Counter()
        self.turn_item_before: Counter[str] = Counter()
        self.turn_item_after: Counter[str] = Counter()
        self.compaction_before: Counter[str] = Counter()
        self.compaction_after: Counter[str] = Counter()
        self.retained_tool_calls: Counter[str] = Counter()
        self.compaction_summaries_retained = 0
        self.encrypted_content_fields_removed = 0
        self.encrypted_content_value_utf8_bytes_removed = 0
        self.encrypted_agent_messages_removed = 0
        self.encrypted_agent_message_value_utf8_bytes_removed = 0
        self.records_with_encrypted_content_removed = 0
        self.user_inputs = USER_INPUT.UserInputResults()
        self.retained_user_input_results: Counter[str] = Counter()

    def _record_response_item(self, item_type: str, *, before: bool) -> None:
        target = self.response_before if before else self.response_after
        target[item_type] += 1
        if not before and (item_type in TOOL_CALL_ITEM_TYPES or item_type.endswith("_call")):
            self.retained_tool_calls[item_type] += 1

    def transform(
        self, record: dict[str, Any], raw_size: int, line_number: int
    ) -> bytes | None | object:
        self.input_records += 1
        record_type = record["type"]
        payload = record["payload"]
        rewritten = False

        if record_type == "raw_response_item":
            raise FilterError(
                f"line {line_number}: raw_response_item is unsupported because its output carriers are opaque"
            )

        if record_type == "response_item":
            item_type = payload.get("type")
            if not isinstance(item_type, str):
                raise FilterError(f"line {line_number}: response_item payload type must be a string")
            self._record_response_item(item_type, before=True)
            try:
                self.user_inputs.observe(payload)
                user_input_result = self.user_inputs.result_tool(payload)
            except ValueError as exc:
                raise FilterError(f"line {line_number}: {exc}") from exc
            if user_input_result:
                self.retained_user_input_results[f"response_item/{item_type}"] += 1
            if _is_output_item(item_type) and not user_input_result:
                self._remove_whole(
                    f"response_item/{item_type}", raw_size, payload
                )
                return None
            if item_type not in KNOWN_RESPONSE_ITEM_TYPES:
                raise FilterError(
                    f"line {line_number}: unknown response_item type; update the filter policy"
                )
            self._record_response_item(item_type, before=False)

        elif record_type == "event_msg":
            event_type = payload.get("type")
            if not isinstance(event_type, str):
                raise FilterError(f"line {line_number}: event_msg payload type must be a string")
            if event_type == "raw_response_item":
                raise FilterError(
                    f"line {line_number}: raw_response_item event is unsupported because its output carriers are opaque"
                )
            if _is_legacy_tool_result_event(event_type):
                self._remove_whole(f"event_msg/{event_type}", raw_size, payload)
                return None
            if event_type in {"item_started", "item_completed"}:
                item = payload.get("item")
                if not isinstance(item, dict):
                    raise FilterError(f"line {line_number}: turn item must be an object")
                item_type = item.get("type")
                if not isinstance(item_type, str):
                    raise FilterError(f"line {line_number}: turn item type must be a string")
                self.turn_item_before[item_type] += 1
                if item_type in TOOL_PRESENTATION_TYPES:
                    self._remove_whole(
                        f"event_msg/{event_type}/{item_type}", raw_size, item
                    )
                    return None
                if item_type not in NON_TOOL_PRESENTATION_TYPES:
                    raise FilterError(
                        f"line {line_number}: unknown turn item type; update the filter policy"
                    )
                self.turn_item_after[item_type] += 1
            elif event_type not in SAFE_EVENT_TYPES:
                raise FilterError(
                    f"line {line_number}: unknown event_msg type; update the filter policy"
                )

        elif record_type == "compacted":
            self.compacted_records_seen += 1
            if isinstance(payload.get("message"), str) and payload.get("message"):
                self.compaction_summaries_retained += 1
            rewritten = self._filter_compacted(payload, line_number)

        for owner, key, arguments in _encrypted_agent_message_slots(record):
            self.encrypted_agent_messages_removed += 1
            self.encrypted_agent_message_value_utf8_bytes_removed += len(arguments["message"].encode("utf-8"))
            if isinstance(owner[key], str):
                owner[key] = _replace_message_value(owner[key], ENCRYPTED_AGENT_MESSAGE_MARKER)
            else:
                arguments["message"] = ENCRYPTED_AGENT_MESSAGE_MARKER
            rewritten = True

        # Run after carrier removal so these counts describe additional field
        # removal, without counting bytes already removed with tool outputs.
        owners = list(_encrypted_field_owners(record))
        for owner in owners:
            encrypted = owner.pop("encrypted_content")
            if encrypted is not None and not isinstance(encrypted, str):
                raise FilterError(f"line {line_number}: encrypted_content must be a string or null")
            self.encrypted_content_fields_removed += 1
            self.encrypted_content_value_utf8_bytes_removed += (
                len(encrypted.encode("utf-8")) if encrypted is not None else 0
            )
        if owners:
            self.records_with_encrypted_content_removed += 1
            rewritten = True
        self.output_records += 1
        if rewritten:
            if record_type == "compacted":
                self.compacted_records_rewritten += 1
            return _canonical_json_bytes(record) + b"\n"
        return UNCHANGED

    def _remove_whole(self, carrier: str, raw_size: int, payload: Any) -> None:
        self.removed_records += 1
        self.whole_record_bytes_removed += raw_size
        self.removed_payload_canonical_bytes += len(_canonical_json_bytes(payload))
        self.removed_by_carrier[carrier] += 1

    def _filter_compacted(self, payload: dict[str, Any], line_number: int) -> bool:
        metadata_present = "replacement_history_metadata" in payload
        metadata = payload.get("replacement_history_metadata")
        history_present = "replacement_history" in payload
        history = payload.get("replacement_history")
        if not history_present or history is None:
            if metadata_present and metadata is not None:
                raise FilterError(
                    f"line {line_number}: replacement_history_metadata requires a replacement_history list"
                )
            return False
        if not isinstance(history, list):
            raise FilterError(
                f"line {line_number}: replacement_history must be a list or null"
            )
        if metadata_present and metadata is not None:
            if not isinstance(metadata, list) or len(metadata) != len(history):
                raise FilterError(
                    f"line {line_number}: replacement_history_metadata must align with the original history"
                )

        keep: list[bool] = []
        history_inputs = self.user_inputs.copy()
        for item in history:
            if not isinstance(item, dict) or not isinstance(item.get("type"), str):
                raise FilterError(
                    f"line {line_number}: replacement_history items require string types"
                )
            item_type = item["type"]
            self.compaction_before[item_type] += 1
            try:
                history_inputs.observe(item)
                user_input_result = history_inputs.result_tool(item)
            except ValueError as exc:
                raise FilterError(f"line {line_number}: {exc}") from exc
            if user_input_result:
                self.retained_user_input_results[f"compacted/replacement_history/{item_type}"] += 1
            remove = _is_output_item(item_type) and not user_input_result
            if not remove and item_type not in KNOWN_RESPONSE_ITEM_TYPES:
                raise FilterError(
                    f"line {line_number}: unknown replacement_history item type; update the filter policy"
                )
            keep.append(not remove)
            if remove:
                self.nested_output_items_removed += 1
                self.removed_payload_canonical_bytes += len(_canonical_json_bytes(item))
                self.removed_by_carrier[
                    f"compacted/replacement_history/{item_type}"
                ] += 1
            else:
                self.compaction_after[item_type] += 1

        self.user_inputs = history_inputs
        if all(keep):
            return False
        payload["replacement_history"] = [
            item for item, should_keep in zip(history, keep) if should_keep
        ]
        if metadata_present and metadata is not None:
            payload["replacement_history_metadata"] = [
                item for item, should_keep in zip(metadata, keep) if should_keep
            ]
        return True


def _same_file_snapshot(first: os.stat_result, second: os.stat_result) -> bool:
    return (
        first.st_dev,
        first.st_ino,
        first.st_size,
        first.st_mtime_ns,
    ) == (
        second.st_dev,
        second.st_ino,
        second.st_size,
        second.st_mtime_ns,
    )


def _audit_clean(path: Path) -> None:
    user_inputs = USER_INPUT.UserInputResults()
    with path.open("rb") as source:
        for line_number, raw in enumerate(source, 1):
            if not raw:
                continue
            record = _decode_line(raw, line_number)
            if next(_encrypted_agent_message_slots(record), None) is not None:
                raise FilterError("post-filter audit found an encrypted subagent message")
            if next(_encrypted_field_owners(record), None) is not None:
                raise FilterError("post-filter audit found an encrypted_content field")
            record_type = record["type"]
            payload = record["payload"]
            if record_type == "raw_response_item":
                raise FilterError("post-filter audit found opaque raw_response_item")
            if record_type == "response_item":
                item_type = payload.get("type")
                try:
                    user_inputs.observe(payload)
                    retained_input = user_inputs.result_tool(payload)
                except ValueError as exc:
                    raise FilterError(f"post-filter audit: {exc}") from exc
                if isinstance(item_type, str) and _is_output_item(item_type) and not retained_input:
                    raise FilterError("post-filter audit found a response output item")
            elif record_type == "event_msg":
                event_type = payload.get("type")
                if event_type == "raw_response_item":
                    raise FilterError("post-filter audit found an opaque raw_response_item event")
                if isinstance(event_type, str) and _is_legacy_tool_result_event(event_type):
                    raise FilterError("post-filter audit found a legacy tool result event")
                if event_type in {"item_started", "item_completed"}:
                    item = payload.get("item")
                    if isinstance(item, dict) and item.get("type") in TOOL_PRESENTATION_TYPES:
                        raise FilterError("post-filter audit found a tool presentation item")
            elif record_type == "compacted":
                history = payload.get("replacement_history")
                if isinstance(history, list):
                    for item in history:
                        if isinstance(item, dict):
                            item_type = item.get("type")
                            try:
                                user_inputs.observe(item)
                                retained_input = user_inputs.result_tool(item)
                            except ValueError as exc:
                                raise FilterError(f"post-filter audit: {exc}") from exc
                            if isinstance(item_type, str) and _is_output_item(item_type) and not retained_input:
                                raise FilterError("post-filter audit found a compacted output item")


def _link_private_temp(temp_path: Path, destination: Path) -> None:
    os.chmod(temp_path, 0o600)
    try:
        os.link(temp_path, destination)
    except FileExistsError as exc:
        raise FilterError("destination already exists") from exc
    finally:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass
    try:
        directory_fd = os.open(destination.parent, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _validate_paths(source: Path, destination: Path, report_path: Path | None) -> None:
    if not source.exists() or not source.is_file():
        raise FilterError("input must be an existing regular file")
    if stat.S_ISLNK(source.lstat().st_mode):
        raise FilterError("input symlinks are not accepted")
    if not destination.parent.exists() or not destination.parent.is_dir():
        raise FilterError("output parent directory must exist")
    if destination.exists() or destination.is_symlink():
        raise FilterError("output already exists")
    if source.resolve() == destination.resolve(strict=False):
        raise FilterError("input and output must be different files")
    if report_path is not None:
        if not report_path.parent.exists() or not report_path.parent.is_dir():
            raise FilterError("report parent directory must exist")
        if report_path.exists() or report_path.is_symlink():
            raise FilterError("report already exists")
        resolved_report = report_path.resolve(strict=False)
        if resolved_report in {source.resolve(), destination.resolve(strict=False)}:
            raise FilterError("report path must differ from input and output")


def filter_rollout(
    source_path: str | os.PathLike[str],
    destination_path: str | os.PathLike[str],
    report_path: str | os.PathLike[str] | None = None,
    *,
    markdown_path: str | os.PathLike[str] | None = None,
    tokenizer_path: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    source = Path(source_path)
    destination = Path(destination_path)
    report = Path(report_path) if report_path is not None else None
    _validate_paths(source, destination, report)
    markdown = Path(markdown_path) if markdown_path is not None else None
    if tokenizer_path is not None and markdown is None:
        raise FilterError("tokenizer requires a Markdown output path")
    if markdown is not None:
        _validate_paths(source, markdown, None)
        if markdown.suffix.lower() != ".md":
            raise FilterError("Markdown output must end in .md")
        if markdown.resolve(strict=False) in {destination.resolve(strict=False), report.resolve(strict=False) if report else None}:
            raise FilterError("Markdown path must differ from JSONL and report paths")
    if tokenizer_path is not None:
        tokenizer_file = Path(tokenizer_path)
        if not tokenizer_file.is_file() or tokenizer_file.is_symlink():
            raise FilterError("tokenizer must be a local regular tokenizer.json file")
        if tokenizer_file.resolve() in {p.resolve(strict=False) for p in (source, destination, report, markdown) if p is not None}:
            raise FilterError("tokenizer path must differ from input and output paths")

    state = FilterState()
    source_digest = hashlib.sha256()
    output_digest = hashlib.sha256()
    input_bytes = 0
    output_bytes = 0
    temp_fd, temp_name = tempfile.mkstemp(
        dir=destination.parent,
        prefix=f".{destination.name}.",
        suffix=".tmp",
    )
    temp_path = Path(temp_name)
    markdown_temp = None
    markdown_result = None
    try:
        with source.open("rb") as source_file, os.fdopen(temp_fd, "wb") as output_file:
            start_stat = os.fstat(source_file.fileno())
            for line_number, raw in enumerate(source_file, 1):
                if not raw:
                    continue
                source_digest.update(raw)
                input_bytes += len(raw)
                record = _decode_line(raw, line_number)
                transformed = state.transform(record, len(raw), line_number)
                if transformed is None:
                    continue
                emitted = raw if transformed is UNCHANGED else transformed
                assert isinstance(emitted, bytes)
                output_file.write(emitted)
                output_digest.update(emitted)
                output_bytes += len(emitted)
            output_file.flush()
            os.fsync(output_file.fileno())
            end_fd_stat = os.fstat(source_file.fileno())
        end_path_stat = source.stat()
        if not _same_file_snapshot(start_stat, end_fd_stat) or not _same_file_snapshot(
            start_stat, end_path_stat
        ):
            raise FilterError("input changed while it was being filtered")
        _audit_clean(temp_path)
        if markdown is not None:
            # Render and validate before publishing either requested trajectory.
            spec = importlib.util.spec_from_file_location("oxygen_trajectory_markdown", Path(__file__).with_name("trajectory_markdown.py"))
            renderer = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(renderer)
            with temp_path.open("rb") as filtered:
                records = [_decode_line(line, index) for index, line in enumerate(filtered, 1)]
            try:
                markdown_bytes, markdown_result = renderer.render(records, markdown.stem)
            except renderer.MarkdownError as exc:
                raise FilterError(str(exc)) from exc
            except (ValueError, TypeError, RecursionError) as exc:
                raise FilterError("invalid content structure for Markdown export") from exc
            if tokenizer_path is not None:
                try:
                    import tokenizers
                except ImportError as exc:
                    raise FilterError("optional Markdown token counts require the tokenizers package") from exc
                try:
                    tokenizer_bytes = Path(tokenizer_path).read_bytes()
                    tokenizer = tokenizers.Tokenizer.from_str(tokenizer_bytes.decode("utf-8"))
                    tokenizer.no_truncation()
                    tokenizer.no_padding()
                    token_count = len(tokenizer.encode(markdown_bytes.decode("utf-8"), add_special_tokens=False).ids)
                except Exception as exc:
                    raise FilterError("could not count Markdown with the supplied local tokenizer") from exc
                markdown_result["token_count"] = token_count
                markdown_result["tokenizer_sha256"] = hashlib.sha256(tokenizer_bytes).hexdigest()
                markdown_result["tokenizers_version"] = tokenizers.__version__
            md_fd, md_name = tempfile.mkstemp(dir=markdown.parent, prefix=f".{markdown.name}.", suffix=".tmp")
            markdown_temp = Path(md_name)
            with os.fdopen(md_fd, "wb") as stream:
                stream.write(markdown_bytes)
                stream.flush()
                os.fsync(stream.fileno())
        _link_private_temp(temp_path, destination)
        if markdown_temp is not None:
            _link_private_temp(markdown_temp, markdown)
    except Exception:
        try:
            os.close(temp_fd)
        except OSError:
            pass
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass
        if markdown_temp is not None:
            markdown_temp.unlink(missing_ok=True)
        raise

    result: dict[str, Any] = {
        "schema": REPORT_SCHEMA,
        "version": REPORT_VERSION,
        "input": {
            "sha256": source_digest.hexdigest(),
            "bytes": input_bytes,
            "records": state.input_records,
        },
        "output": {
            "sha256": output_digest.hexdigest(),
            "bytes": output_bytes,
            "records": state.output_records,
            "byte_delta": input_bytes - output_bytes,
        },
        "removed": {
            "whole_records": state.removed_records,
            "whole_record_bytes": state.whole_record_bytes_removed,
            "nested_compaction_items": state.nested_output_items_removed,
            "removed_payload_canonical_bytes": state.removed_payload_canonical_bytes,
            "by_carrier": _counter_dict(state.removed_by_carrier),
            "encrypted_content_fields": state.encrypted_content_fields_removed,
            "encrypted_content_value_utf8_bytes": state.encrypted_content_value_utf8_bytes_removed,
            "records_with_encrypted_content": state.records_with_encrypted_content_removed,
            "encrypted_agent_messages": state.encrypted_agent_messages_removed,
            "encrypted_agent_message_value_utf8_bytes": state.encrypted_agent_message_value_utf8_bytes_removed,
        },
        "compaction": {
            "records_seen": state.compacted_records_seen,
            "records_rewritten": state.compacted_records_rewritten,
            "summary_messages_retained": state.compaction_summaries_retained,
        },
        "inventory": {
            "response_item_before": _counter_dict(state.response_before),
            "response_item_after": _counter_dict(state.response_after),
            "turn_item_before": _counter_dict(state.turn_item_before),
            "turn_item_after": _counter_dict(state.turn_item_after),
            "replacement_history_before": _counter_dict(state.compaction_before),
            "replacement_history_after": _counter_dict(state.compaction_after),
            "tool_calls_retained": _counter_dict(state.retained_tool_calls),
            "user_input_results_retained": _counter_dict(state.retained_user_input_results),
        },
        "policy": {
            "explicit_tool_outputs_removed": False,
            "ordinary_tool_outputs_removed": True,
            "user_input_results_retained": True,
            "user_input_result_tools": sorted(USER_INPUT.USER_INPUT_TOOLS),
            "user_input_result_matching": "preceding_call_id_and_tool_identity",
            "encrypted_content_fields_removed": True,
            "standalone_tool_calls_and_arguments_retained": False,
            "standalone_tool_calls_retained": True,
            "tool_arguments_retained_except_encrypted_agent_messages": True,
            "encrypted_agent_messages_removed": True,
            "encrypted_agent_message_replacement": ENCRYPTED_AGENT_MESSAGE_MARKER,
            "combined_call_result_items_removed": True,
            "compaction_summaries_retained": True,
            "semantic_erasure_guaranteed": False,
            "resumable_codex_rollout": False,
        },
    }

    if markdown_result is not None:
        result["markdown"] = markdown_result
    if report is not None:
        report_bytes = _canonical_json_bytes(result) + b"\n"
        report_fd, report_name = tempfile.mkstemp(
            dir=report.parent,
            prefix=f".{report.name}.",
            suffix=".tmp",
        )
        report_temp = Path(report_name)
        try:
            with os.fdopen(report_fd, "wb") as report_file:
                report_file.write(report_bytes)
                report_file.flush()
                os.fsync(report_file.fileno())
            _link_private_temp(report_temp, report)
        except Exception:
            try:
                os.close(report_fd)
            except OSError:
                pass
            try:
                report_temp.unlink()
            except FileNotFoundError:
                pass
            raise
    return result


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Strip ordinary tool outputs and encrypted content; retain results from user-input tools."
    )
    parser.add_argument("input", help="approved local Codex rollout JSONL")
    parser.add_argument("--output", required=True, help="new private output JSONL path")
    parser.add_argument("--report", help="optional new content-free JSON report path")
    parser.add_argument("--markdown", help="also export a new plain-role Markdown transcript starting at the first original user input")
    parser.add_argument("--tokenizer", help="optional local tokenizer.json for Markdown token counts; requires tokenizers and --markdown")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        result = filter_rollout(args.input, args.output, args.report, markdown_path=args.markdown, tokenizer_path=args.tokenizer)
    except (FilterError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=True, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
