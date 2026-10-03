import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "strip_tool_outputs.py"
SPEC = importlib.util.spec_from_file_location("strip_tool_outputs", SCRIPT)
FILTER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(FILTER)


def line(record):
    return json.dumps(record, separators=(",", ":"), ensure_ascii=False).encode() + b"\n"


def record(record_type, payload):
    return {"timestamp": "2026-01-01T00:00:00Z", "type": record_type, "payload": payload}


class StripToolOutputsTests(unittest.TestCase):
    def test_encrypted_agent_messages_in_calls_and_checkpoint_history(self):
        token = base64.urlsafe_b64encode(b'\x80' + b'\0' * 8 + b'i' * 16 + b'c' * 16 + b'h' * 32).decode()
        arguments = '{ "target" : "worker", "other" : {"x": 1e3}, "message" : "' + token + '", "text": "caf\\u00e9" }'
        expected_arguments = arguments.replace(json.dumps(token), json.dumps('[Encrypted subagent message removed]'))
        call = {'type': 'function_call', 'name': 'collaboration.send_message', 'arguments': arguments}
        nested = {'type': 'custom_tool_call', 'namespace': 'collaboration', 'name': 'followup_task',
                  'input': {'target': 'worker', 'message': token, 'other': 'keep'}}
        _, output, report = self.run_filter([record('response_item', call), record('compacted', {
            'message': 'Readable checkpoint.', 'replacement_history': [nested],
            'replacement_history_metadata': [{'keep': True}]})])
        rows = [json.loads(raw) for raw in output.splitlines()]
        self.assertEqual(rows[0]['payload']['arguments'], expected_arguments)
        self.assertEqual(rows[1]['payload']['replacement_history_metadata'], [{'keep': True}])
        self.assertEqual(rows[1]['payload']['replacement_history'][0]['input'],
                         {'target': 'worker', 'message': '[Encrypted subagent message removed]', 'other': 'keep'})
        self.assertEqual(report['removed']['encrypted_agent_messages'], 2)
        self.assertEqual(report['removed']['encrypted_agent_message_value_utf8_bytes'], 2 * len(token))
        self.assertNotIn(token.encode(), output)
        _, repeated, again = self.run_filter(rows)
        self.assertEqual(repeated, output)
        self.assertEqual(again['removed']['encrypted_agent_messages'], 0)

    def test_encrypted_agent_detection_does_not_scrub_quoted_or_unrelated_data(self):
        token = base64.urlsafe_b64encode(b'\x80' + b'\0' * 8 + b'i' * 16 + b'c' * 16 + b'h' * 32).decode()
        records = [
            record('response_item', {'type': 'function_call', 'namespace': 'collaboration', 'name': 'send_message',
                   'arguments': json.dumps({'message': 'Please explain ' + token})}),
            record('response_item', {'type': 'function_call', 'namespace': 'unrelated', 'name': 'send_message',
                   'arguments': {'message': token}}),
            record('response_item', {'type': 'function_call', 'name': 'exec', 'arguments': {'message': token}}),
            record('response_item', {'type': 'function_call', 'namespace': 'collaboration', 'name': 'spawn_agent',
                   'arguments': json.dumps({'message': 'gAAAA_not_an_encrypted_envelope'})}),
            record('response_item', {'type': 'custom_tool_call', 'name': 'exec', 'input': token}),
        ]
        before, after, report = self.run_filter(records)
        self.assertEqual(before, after)
        self.assertEqual(report['removed']['encrypted_agent_messages'], 0)

    def test_post_filter_audit_rejects_encrypted_agent_message(self):
        token = base64.urlsafe_b64encode(b'\x80' + b'\0' * 8 + b'i' * 16 + b'c' * 16 + b'h' * 32).decode()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bad.jsonl'
            path.write_bytes(line(record('response_item', {'type': 'function_call', 'name': 'spawn_agent',
                                  'arguments': {'message': token}})))
            with self.assertRaisesRegex(FILTER.FilterError, 'encrypted subagent message'):
                FILTER._audit_clean(path)

    def run_filter(self, records):
        directory = tempfile.TemporaryDirectory()
        root = Path(directory.name)
        source = root / "input.jsonl"
        output = root / "output.jsonl"
        report = root / "report.json"
        source.write_bytes(b"".join(line(item) for item in records))
        before = source.read_bytes()
        result = FILTER.filter_rollout(source, output, report)
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual(json.loads(report.read_text()), result)
        self.addCleanup(directory.cleanup)
        return before, output.read_bytes(), result

    def test_removes_raw_outputs_and_completed_tool_presentations_but_keeps_calls(self):
        records = [
            record("session_meta", {"id": "session"}),
            record("response_item", {"type": "function_call", "name": "exec", "arguments": "keep-call"}),
            record("response_item", {"type": "function_call_output", "output": "raw-function-sentinel"}),
            record("response_item", {"type": "custom_tool_call", "name": "shell", "input": "keep-custom-call"}),
            record("response_item", {"type": "custom_tool_call_output", "output": "raw-custom-sentinel"}),
            record("response_item", {"type": "tool_search_call", "arguments": "keep-search-call"}),
            record("response_item", {"type": "tool_search_output", "output": "raw-search-sentinel"}),
            record("response_item", {"type": "image_generation_call", "revised_prompt": "combined-call", "result": "raw-image-sentinel"}),
            record("event_msg", {"type": "item_completed", "item": {"type": "CommandExecution", "stdout": "ui-command-sentinel"}}),
            record("event_msg", {"type": "item_completed", "item": {"type": "Extension", "results": ["ui-search-sentinel"]}}),
            record("event_msg", {"type": "item_started", "item": {"type": "FunctionCallOutput", "output": "ui-function-sentinel"}}),
            record("event_msg", {"type": "item_completed", "item": {"type": "AgentMessage", "content": [{"text": "keep-message"}]}}),
        ]
        _, output, report = self.run_filter(records)
        for sentinel in (
            b"raw-function-sentinel",
            b"raw-custom-sentinel",
            b"raw-search-sentinel",
            b"raw-image-sentinel",
            b"ui-command-sentinel",
            b"ui-search-sentinel",
            b"ui-function-sentinel",
        ):
            self.assertNotIn(sentinel, output)
        for retained in (b"keep-call", b"keep-custom-call", b"keep-search-call", b"keep-message"):
            self.assertIn(retained, output)
        self.assertEqual(report["removed"]["whole_records"], 7)
        self.assertEqual(report["inventory"]["tool_calls_retained"], {
            "custom_tool_call": 1,
            "function_call": 1,
            "tool_search_call": 1,
        })
        self.assertFalse(report["policy"]["resumable_codex_rollout"])
        self.assertTrue(report["policy"]["combined_call_result_items_removed"])

    def test_filters_every_compaction_and_keeps_metadata_aligned(self):
        first_history = [
            {"type": "message", "role": "user", "content": [{"text": "keep-user"}]},
            {"type": "function_call", "name": "exec", "arguments": "keep-call"},
            {"type": "function_call_output", "output": "nested-output-one"},
            {"type": "reasoning", "summary": []},
        ]
        second_history = [
            {"type": "message", "role": "assistant", "content": [{"text": "keep-assistant"}]},
            {"type": "future_tool_output", "output": "nested-output-two"},
            {"type": "image_generation_call", "status": "completed", "result": "nested-image-output"},
            {"type": "compaction", "encrypted_content": "remove-opaque"},
        ]
        records = [
            record("compacted", {
                "message": "keep-summary",
                "replacement_history": first_history,
                "replacement_history_metadata": ["m0", "m1", "m2", "m3"],
            }),
            record("compacted", {"message": "", "replacement_history": second_history}),
        ]
        _, output, report = self.run_filter(records)
        decoded = [json.loads(raw) for raw in output.splitlines()]
        self.assertEqual(
            [item["type"] for item in decoded[0]["payload"]["replacement_history"]],
            ["message", "function_call", "reasoning"],
        )
        self.assertEqual(decoded[0]["payload"]["replacement_history_metadata"], ["m0", "m1", "m3"])
        self.assertEqual(
            [item["type"] for item in decoded[1]["payload"]["replacement_history"]],
            ["message", "compaction"],
        )
        self.assertEqual(decoded[0]["payload"]["message"], "keep-summary")
        self.assertNotIn(b"remove-opaque", output)
        self.assertEqual(decoded[1]["payload"]["replacement_history"][1], {"type": "compaction"})
        self.assertNotIn(b"nested-output-one", output)
        self.assertNotIn(b"nested-output-two", output)
        self.assertNotIn(b"nested-image-output", output)
        self.assertEqual(report["compaction"], {
            "records_seen": 2,
            "records_rewritten": 2,
            "summary_messages_retained": 1,
        })
        self.assertEqual(report["removed"]["nested_compaction_items"], 3)

    def test_user_input_exception_matches_call_identity_not_answer_shape(self):
        records = [
            record("response_item", {"type": "function_call", "name": "functions.request_user_input", "call_id": "human", "arguments": "{}"}),
            record("response_item", {"type": "function_call", "name": "exec", "call_id": "command", "arguments": "{}"}),
            record("response_item", {"type": "function_call", "name": "my_request_user_input", "call_id": "similar", "arguments": "{}"}),
            record("response_item", {"type": "function_call_output", "call_id": "command", "output": {"answers": {"q": ["COMMAND_PRIVATE"]}}}),
            record("response_item", {"type": "function_call_output", "call_id": "similar", "output": "SIMILAR_PRIVATE"}),
            record("response_item", {"type": "function_call_output", "call_id": "unknown", "output": "UNKNOWN_PRIVATE"}),
            record("response_item", {"type": "function_call_output", "call_id": "human", "output": {"answers": {"q": ["Keep this decision"]}, "encrypted_content": "ENCRYPTED_PRIVATE"}}),
        ]
        _, output, report = self.run_filter(records)
        for sentinel in (b"COMMAND_PRIVATE", b"SIMILAR_PRIVATE", b"UNKNOWN_PRIVATE", b"ENCRYPTED_PRIVATE"):
            self.assertNotIn(sentinel, output)
        self.assertIn(b"Keep this decision", output)
        self.assertEqual(report["removed"]["whole_records"], 3)
        self.assertEqual(report["removed"]["encrypted_content_fields"], 1)
        self.assertEqual(report["inventory"]["user_input_results_retained"], {"response_item/function_call_output": 1})
        self.assertTrue(report["policy"]["user_input_results_retained"])
        self.assertTrue(report["policy"]["ordinary_tool_outputs_removed"])

    def test_user_input_results_survive_compaction_and_repeat_filtering(self):
        question = {"type": "function_call", "name": "request_user_input", "call_id": "human", "arguments": "{}"}
        answer = {"type": "function_call_output", "call_id": "human", "output": '{"answers":{"q":{"answers":["Keep this answer"]}}}'}
        async_question = {"type": "custom_tool_call", "name": "tools.request_user_input_async", "call_id": "async", "input": "{}"}
        async_result = {"type": "custom_tool_call_output", "call_id": "async", "output": [{"type": "text", "text": "Keep async result"}]}
        records = [
            record("response_item", question), record("response_item", answer),
            record("compacted", {
                "replacement_history": [question, answer, async_question, async_result,
                                        {"type": "function_call_output", "call_id": "other", "output": "REMOVE_PRIVATE"}],
                "replacement_history_metadata": [0, 1, 2, 3, 4],
            }),
            record("response_item", async_result),
        ]
        _, output, report = self.run_filter(records)
        decoded = [json.loads(raw) for raw in output.splitlines()]
        self.assertEqual(decoded[0:2], records[0:2])
        self.assertEqual(decoded[2]["payload"]["replacement_history"], [question, answer, async_question, async_result])
        self.assertEqual(decoded[2]["payload"]["replacement_history_metadata"], [0, 1, 2, 3])
        self.assertEqual(decoded[3], records[3])
        self.assertEqual(report["inventory"]["user_input_results_retained"], {
            "response_item/function_call_output": 1, "response_item/custom_tool_call_output": 1,
            "compacted/replacement_history/function_call_output": 1,
            "compacted/replacement_history/custom_tool_call_output": 1,
        })
        before, again, _ = self.run_filter(decoded)
        self.assertEqual(before, again)

    def test_ambiguous_user_input_pairing_fails_before_output(self):
        question = {"type": "function_call", "name": "request_user_input", "call_id": "human", "arguments": "{}"}
        cases = [
            [{"type": "function_call", "name": "request_user_input", "arguments": "{}"}],
            [question, {"type": "function_call", "name": "exec", "call_id": "human", "arguments": "{}"}],
            [question, {"type": "custom_tool_call_output", "call_id": "human", "output": "PRIVATE"}],
            [question, {"type": "function_call_output", "call_id": "human"}],
            [{"type": "function_call_output", "name": "request_user_input", "call_id": "missing", "output": "PRIVATE"}],
        ]
        for index, items in enumerate(cases):
            with self.subTest(index=index), tempfile.TemporaryDirectory() as directory:
                source, output = Path(directory) / "source.jsonl", Path(directory) / "out.jsonl"
                source.write_bytes(b"".join(line(record("response_item", item)) for item in items))
                with self.assertRaises(FILTER.FilterError) as context:
                    FILTER.filter_rollout(source, output)
                self.assertNotIn("PRIVATE", str(context.exception))
                self.assertFalse(output.exists())

    def test_post_filter_audit_allows_only_matched_user_input_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.jsonl"
            question = record("response_item", {"type": "function_call", "name": "request_user_input", "call_id": "human", "arguments": "{}"})
            answer = record("response_item", {"type": "function_call_output", "call_id": "human", "output": "Keep"})
            source.write_bytes(line(question) + line(answer))
            FILTER._audit_clean(source)
            answer["payload"]["call_id"] = "other"
            source.write_bytes(line(question) + line(answer))
            with self.assertRaisesRegex(FILTER.FilterError, "response output item"):
                FILTER._audit_clean(source)

    def test_strips_encrypted_fields_preserving_plaintext_and_tool_arguments(self):
        arguments = {"encrypted_content": "literal-tool-argument", "text": "keep"}
        call = record("response_item", {
            "type": "function_call", "name": "exec", "arguments": arguments,
        })
        custom_call = record("response_item", {
            "type": "custom_tool_call", "name": "shell",
            "input": '{"encrypted_content":"literal-input"}',
        })
        reasoning = record("response_item", {
            "type": "reasoning", "encrypted_content": "opaque-α",
            "summary": [{"type": "summary_text", "text": "keep reasoning summary"}],
            "content": [{"type": "text", "text": "keep plaintext"}],
        })
        message = record("response_item", {
            "type": "agent_message", "content": [
                {"type": "encrypted_content", "encrypted_content": "opaque-message"},
                {"type": "text", "text": "keep conversation and encrypted_content mentions"},
            ],
        })
        world = record("world_state", {"state": {
            "encrypted_content": None, "encrypted_flag": True, "text": "keep metadata",
        }})
        _, output, report = self.run_filter([call, custom_call, reasoning, message, world])
        decoded = [json.loads(raw) for raw in output.splitlines()]
        self.assertEqual(decoded[:2], [call, custom_call])
        del reasoning["payload"]["encrypted_content"]
        del message["payload"]["content"][0]["encrypted_content"]
        del world["payload"]["state"]["encrypted_content"]
        self.assertEqual(decoded[2:], [reasoning, message, world])
        self.assertEqual(report["version"], 4)
        self.assertEqual(report["removed"]["encrypted_content_fields"], 3)
        self.assertEqual(report["removed"]["records_with_encrypted_content"], 3)
        self.assertEqual(report["removed"]["encrypted_content_value_utf8_bytes"],
                         len("opaque-αopaque-message".encode("utf-8")))
        self.assertTrue(report["policy"]["encrypted_content_fields_removed"])

    def test_encrypted_only_compaction_rewrite_is_aligned_deterministic_and_idempotent(self):
        checkpoint = record("compacted", {
            "message": "keep summary",
            "replacement_history": [
                {"type": "compaction", "encrypted_content": "checkpoint-secret"},
                {"type": "agent_message", "content": [
                    {"type": "encrypted_content", "encrypted_content": "message-secret"},
                    {"type": "text", "text": "keep message"},
                ]},
            ],
            "replacement_history_metadata": [{"id": "a"}, {"id": "b"}],
        })
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.jsonl"
            # Exercise deterministic serialization of a changed, noncanonical line.
            source.write_bytes(json.dumps(checkpoint, ensure_ascii=True).encode() + b"\r\n")
            original = source.read_bytes()
            first, second, third = (root / name for name in ("first", "second", "third"))
            report = FILTER.filter_rollout(source, first)
            repeat = FILTER.filter_rollout(source, second)
            again = FILTER.filter_rollout(first, third)
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(report, repeat)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(first.read_bytes(), third.read_bytes())
            self.assertEqual(again["removed"]["encrypted_content_fields"], 0)
            self.assertEqual(again["output"]["byte_delta"], 0)
            self.assertEqual(report["compaction"]["records_rewritten"], 1)
            self.assertEqual(report["removed"]["encrypted_content_fields"], 2)
            payload = json.loads(first.read_bytes())["payload"]
            self.assertEqual(payload["replacement_history_metadata"],
                             checkpoint["payload"]["replacement_history_metadata"])
            self.assertEqual(len(payload["replacement_history"]), 2)
            self.assertEqual(payload["replacement_history"][0], {"type": "compaction"})
            self.assertEqual(payload["message"], "keep summary")
            self.assertEqual(first.stat().st_mode & 0o777, 0o600)

    def test_encrypted_counts_exclude_removed_output_carriers(self):
        records = [
            record("response_item", {"type": "function_call_output", "encrypted_content": "whole"}),
            record("compacted", {"replacement_history": [
                {"type": "function_call_output", "encrypted_content": "nested"},
                {"type": "reasoning", "encrypted_content": "retained", "summary": []},
            ]}),
        ]
        _, output, report = self.run_filter(records)
        self.assertNotIn(b"encrypted_content", output)
        self.assertEqual(report["removed"]["whole_records"], 1)
        self.assertEqual(report["removed"]["nested_compaction_items"], 1)
        self.assertEqual(report["removed"]["encrypted_content_fields"], 1)
        self.assertEqual(report["removed"]["encrypted_content_value_utf8_bytes"], 8)

    def test_invalid_encrypted_field_and_post_filter_audit_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / "input.jsonl", root / "output.jsonl"
            source.write_bytes(line(record("response_item", {
                "type": "reasoning", "encrypted_content": {"unexpected": "secret"},
            })))
            with self.assertRaisesRegex(FILTER.FilterError, "must be a string or null"):
                FILTER.filter_rollout(source, output)
            self.assertFalse(output.exists())
            source.write_bytes(line(record("compacted", {"replacement_history": [
                {"type": "compaction", "encrypted_content": "opaque"},
            ]})))
            with self.assertRaisesRegex(FILTER.FilterError, "encrypted_content field"):
                FILTER._audit_clean(source)

    def test_removes_legacy_tool_result_events(self):
        records = [
            record("event_msg", {"type": "patch_apply_end", "stdout": "legacy-one"}),
            record("event_msg", {"type": "some_tool_call_response", "result": "legacy-two"}),
            record("event_msg", {"type": "exec_command_output_delta", "chunk": "legacy-three"}),
            record("event_msg", {"type": "turn_diff", "unified_diff": "legacy-four"}),
            record("event_msg", {"type": "collab_agent_interaction_end", "status": "legacy-five"}),
            record("event_msg", {"type": "agent_message", "message": "keep"}),
        ]
        _, output, report = self.run_filter(records)
        self.assertNotIn(b"legacy-one", output)
        self.assertNotIn(b"legacy-two", output)
        self.assertNotIn(b"legacy-three", output)
        self.assertNotIn(b"legacy-four", output)
        self.assertNotIn(b"legacy-five", output)
        self.assertIn(b"keep", output)
        self.assertEqual(report["removed"]["whole_records"], 5)

    def test_misaligned_compaction_metadata_fails_without_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.jsonl"
            output = root / "output.jsonl"
            source.write_bytes(line(record("compacted", {
                "replacement_history": [
                    {"type": "message", "role": "user"},
                    {"type": "function_call_output", "output": "secret"},
                ],
                "replacement_history_metadata": [{}],
            })))
            with self.assertRaisesRegex(FILTER.FilterError, "must align"):
                FILTER.filter_rollout(source, output)
            self.assertFalse(output.exists())

    def test_orphaned_compaction_metadata_fails_without_output(self):
        for history in ("absent", None):
            with self.subTest(history=history), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / "input.jsonl"
                output = root / "output.jsonl"
                payload = {"replacement_history_metadata": [{}]}
                if history is None:
                    payload["replacement_history"] = None
                source.write_bytes(line(record("compacted", payload)))
                with self.assertRaisesRegex(FILTER.FilterError, "requires"):
                    FILTER.filter_rollout(source, output)
                self.assertFalse(output.exists())

    def test_unknown_turn_item_and_raw_response_items_fail_closed(self):
        cases = [
            record("event_msg", {"type": "item_completed", "item": {"type": "FutureResult", "value": "secret"}}),
            record("event_msg", {"type": "future_combined_result", "value": "secret"}),
            record("event_msg", {"type": "raw_response_item", "item": {"type": "function_call_output", "output": "secret"}}),
            record("response_item", {"type": "future_combined_result", "value": "secret"}),
            record("raw_response_item", {"opaque": "secret"}),
        ]
        for index, candidate in enumerate(cases):
            with self.subTest(index=index), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / "input.jsonl"
                output = root / "output.jsonl"
                source.write_bytes(line(candidate))
                with self.assertRaises(FILTER.FilterError):
                    FILTER.filter_rollout(source, output)
                self.assertFalse(output.exists())

    def test_malformed_duplicate_and_existing_destination_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "output.jsonl"
            for name, source_bytes in (
                ("malformed", b'{"type":"event_msg"\n'),
                ("duplicate", b'{"type":"event_msg","type":"response_item","payload":{}}\n'),
            ):
                source = root / f"{name}.jsonl"
                source.write_bytes(source_bytes)
                with self.subTest(name=name), self.assertRaises(FILTER.FilterError):
                    FILTER.filter_rollout(source, output)
                self.assertFalse(output.exists())

            source = root / "valid.jsonl"
            source.write_bytes(line(record("session_meta", {"id": "session"})))
            output.write_text("do-not-overwrite")
            with self.assertRaisesRegex(FILTER.FilterError, "already exists"):
                FILTER.filter_rollout(source, output)
            self.assertEqual(output.read_text(), "do-not-overwrite")

    def test_untouched_lines_are_byte_identical_and_run_is_deterministic(self):
        retained = line(record("response_item", {
            "type": "message", "role": "assistant", "content": [{"text": "x" * 100_000}]
        }))
        removed = line(record("response_item", {
            "type": "function_call_output", "output": "y" * 100_000
        }))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.jsonl"
            first = root / "first.jsonl"
            second = root / "second.jsonl"
            source.write_bytes(retained + removed)
            first_report = FILTER.filter_rollout(source, first)
            second_report = FILTER.filter_rollout(source, second)
            self.assertEqual(first.read_bytes(), retained)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(first_report["output"]["sha256"], second_report["output"]["sha256"])


if __name__ == "__main__":
    unittest.main()
