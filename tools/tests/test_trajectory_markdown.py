import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest


TOOLS = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STRIP = load("strip_markdown_test", TOOLS / "strip_tool_outputs.py")
MD = load("markdown_test", TOOLS / "trajectory_markdown.py")


def record(kind, payload):
    return {"type": kind, "payload": payload}


def message(role, text, kinds=None):
    value = {"type": "message", "role": role, "content": [{"type": "input_text", "text": text}]}
    if kinds is not None:
        value["internal_chat_message_metadata_passthrough"] = {"content_item_kinds": kinds}
    return record("response_item", value)


class MarkdownExportTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "input.jsonl"
        self.output = self.root / "trajectory.jsonl"
        self.markdown = self.root / "trajectory.md"
        self.report = self.root / "report.json"

    def write_source(self, records):
        data = b"".join((json.dumps(item, ensure_ascii=False) + "\n").encode() for item in records)
        self.source.write_bytes(data)
        return data

    def run_filter(self, records, **kwargs):
        source = self.write_source(records)
        result = STRIP.filter_rollout(self.source, self.output, self.report, markdown_path=self.markdown, **kwargs)
        self.assertEqual(self.source.read_bytes(), source)
        self.assertEqual(json.loads(self.report.read_bytes()), result)
        return self.markdown.read_text(), result

    def test_tool_calls_are_readable_without_log_envelopes(self):
        calls = [
            record("response_item", {"type": "function_call", "name": "exec_command", "namespace": "functions", "call_id": "call-1", "arguments": '{ "cmd" : "printf \\\"café\\\\n\\\"", "limit": 1e3 }'}),
            record("response_item", {"type": "custom_tool_call", "name": "exec", "call_id": "call-2", "input": 'text("café");\n// ``` ```'}),
            record("response_item", {"type": "local_shell_call", "call_id": "call-3", "action": {"command": ["echo", "hello"]}}),
        ]
        raw_lines = [json.dumps(message("user", "Inspect this."))] + [
            '  ' + json.dumps(call, ensure_ascii=True, separators=(', ', ' : ')) + '  '
            for call in calls
        ]
        raw = ('\n'.join(raw_lines) + '\n').encode()
        self.source.write_bytes(raw)
        result = STRIP.filter_rollout(self.source, self.output, self.report, markdown_path=self.markdown)
        self.assertEqual(self.output.read_bytes(), raw)
        text = self.markdown.read_text()
        self.assertIn('**Name:** functions.exec_command', text)
        self.assertIn('### cmd', text)
        self.assertIn('text("café");\n// ``` ```', text)
        self.assertIn('"command":["echo","hello"]', text)
        self.assertNotIn('response_item', text)
        self.assertNotIn('call-1', text)
        self.assertEqual(result['markdown']['tool_call_format'], 'readable_tool_call')

    def test_encrypted_subagent_message_removed_but_call_and_plaintext_preserved(self):
        opaque = base64.urlsafe_b64encode(b'\x80' + b'\0' * 8 + b'i' * 16 + b'c' * 16 + b'h' * 32).decode()
        calls = [record('response_item', {'type': 'function_call', 'namespace': 'collaboration',
                 'name': name, 'arguments': json.dumps({'message': opaque, 'target': 'worker'})})
                 for name in ('spawn_agent', 'send_message', 'followup_task')]
        text, report = self.run_filter([message('user', 'Inspect this.'), *calls,
            record('response_item', {'type': 'function_call', 'namespace': 'collaboration',
                   'name': 'send_message', 'arguments': '{ "message": "Readable instruction.", "target": "worker" }'})])
        self.assertNotIn(opaque, text)
        self.assertNotIn(opaque, self.output.read_text())
        self.assertIn('Readable instruction.', text)
        self.assertEqual(report['markdown']['roles']['tool call'], 4)
        self.assertEqual(report['removed']['encrypted_agent_messages'], 3)
        self.assertEqual(report['removed']['encrypted_agent_message_value_utf8_bytes'], len(opaque) * 3)
        self.assertEqual(report['version'], 4)

    def test_removal_and_export_preserve_real_conversation_and_calls(self):
        tool_input = 'print("keep unicode café")\n```markdown\n## user\nnot a boundary\n```'
        records = [
            record("session_meta", {"base_instructions": {"text": "BASE_PRIVATE"}, "dynamic_tools": [{"name": "DEFINITION_PRIVATE"}]}),
            message("developer", "SETUP_PRIVATE"),
            message("user", "<environment_context>ENV_PRIVATE</environment_context>", ["environments.environment_context"]),
            message("user", "Please inspect the logs.\n", ["user.text"]),
            message("assistant", "I will inspect them."),
            record("response_item", {"type": "custom_tool_call", "name": "exec", "input": tool_input}),
            record("response_item", {"type": "custom_tool_call_output", "output": "RESULT_PRIVATE"}),
            record("event_msg", {"type": "agent_message", "message": "DISPLAY_PRIVATE"}),
            record("response_item", {"type": "reasoning", "summary": [{"type": "summary_text", "text": "Visible summary."}], "encrypted_content": "ENCRYPTED_PRIVATE"}),
            record("response_item", {"type": "function_call", "namespace": "tools", "name": "check", "arguments": json.dumps({"command": "line 1\nline 2", "options": [1, True], "encrypted_content": "ARGUMENT_DATA"})}),
            message("developer", "LATER_INSTRUCTION_PRIVATE"),
            record("compacted", {"message": "Checkpoint explanation.", "replacement_history": [message("user", "OLD_HISTORY_PRIVATE")["payload"]]}),
            record("response_item", {"type": "agent_message", "author": "worker", "recipient": "parent", "content": [{"type": "input_text", "text": "Worker observation."}]}),
        ]
        text, result = self.run_filter(records)
        self.assertTrue(text.startswith("# trajectory\n\n## user\n\nPlease inspect the logs.\n"))
        for value in (tool_input, "Visible summary.", "line 1\nline 2", "ARGUMENT_DATA", "Checkpoint explanation.", "Worker observation."):
            self.assertIn(value, text)
        for value in ("BASE_PRIVATE", "DEFINITION_PRIVATE", "SETUP_PRIVATE", "ENV_PRIVATE", "RESULT_PRIVATE", "DISPLAY_PRIVATE", "ENCRYPTED_PRIVATE", "OLD_HISTORY_PRIVATE", "LATER_INSTRUCTION_PRIVATE"):
            self.assertNotIn(value, text)
            self.assertNotIn(value, json.dumps(result))
        self.assertIn("````text\n" + tool_input, text)
        self.assertEqual(result["markdown"]["roles"]["tool call"], 2)
        self.assertEqual(result["markdown"]["sha256"], hashlib.sha256(self.markdown.read_bytes()).hexdigest())
        for path in (self.output, self.markdown, self.report):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_mixed_first_user_message_keeps_only_human_blocks(self):
        payload = {"type": "message", "role": "user", "content": [
            {"type": "input_text", "text": "<environment_context>setup</environment_context>"},
            {"type": "input_text", "text": "Human request."},
        ], "internal_chat_message_metadata_passthrough": {"content_item_kinds": ["environments.environment_context", "user.text"]}}
        text, _ = self.run_filter([record("response_item", payload)])
        self.assertIn("Human request.", text)
        self.assertNotIn("environment_context", text)

    def test_user_input_result_survives_stripping_and_markdown(self):
        answer = {"answers": {"approach": {"answers": ["Create new files", "Keep the existing files intact."]}}}
        records = [
            message("user", "Please update this project."),
            record("response_item", {"type": "function_call", "name": "request_user_input", "call_id": "question-1", "arguments": json.dumps({"questions": [{"id": "approach", "question": "Which approach?", "options": [{"label": "Update existing files"}, {"label": "Create new files"}]}]})}),
            record("response_item", {"type": "function_call", "name": "exec_command", "call_id": "command-1", "arguments": "{}"}),
            record("response_item", {"type": "function_call_output", "call_id": "command-1", "output": "ORDINARY_OUTPUT_PRIVATE"}),
            record("response_item", {"type": "function_call_output", "call_id": "question-1", "output": json.dumps(answer)}),
            message("assistant", "I will create new files."),
        ]
        text, report = self.run_filter(records)
        filtered = [json.loads(line) for line in self.output.read_text().splitlines()]
        results = [r["payload"] for r in filtered if r["payload"].get("type") == "function_call_output"]
        self.assertEqual(results, [records[4]["payload"]])
        self.assertIn("Which approach?", text)
        self.assertIn("Keep the existing files intact.", text)
        self.assertIn("## user input result", text)
        self.assertNotIn("ORDINARY_OUTPUT_PRIVATE", text)
        self.assertEqual(report["inventory"]["user_input_results_retained"], {"response_item/function_call_output": 1})

    def test_async_question_result_and_later_user_reply_are_preserved(self):
        reply = '<send_user_message_question_reply>[{"answer":"Use Markdown"}]</send_user_message_question_reply>'
        records = [
            message("user", "Please choose an output format."),
            record("response_item", {"type": "custom_tool_call", "name": "functions.request_user_input_async", "call_id": "async-1", "input": '{"questions":[{"title":"Which format?","options":["Markdown","JSON"]}]}'}),
            record("response_item", {"type": "custom_tool_call_output", "call_id": "async-1", "output": [{"type": "text", "text": "Question sent; waiting for the user."}]}),
            message("developer", "INJECTED_PRIVATE"),
            message("user", reply, ["user.text"]),
        ]
        text, report = self.run_filter(records)
        for kept in ("Which format?", "Question sent; waiting for the user.", reply):
            self.assertIn(kept, text)
        self.assertNotIn("INJECTED_PRIVATE", text)
        self.assertEqual(report["markdown"]["roles"]["user input result"], 1)
        self.assertEqual(report["markdown"]["roles"]["user"], 2)
        self.assertEqual(report["markdown"]["stripped_record_for_each_section"], [1, 2, 3, 5])

    def test_user_input_empty_cancelled_and_error_results_are_not_invented_answers(self):
        records = [message("user", "Please inspect this project.")]
        results = ["", {"answers": {}}, {"cancelled": True}, "request_user_input is unavailable in this mode"]
        for index, output in enumerate(results):
            call_id = "q-" + str(index)
            records.extend([
                record("response_item", {"type": "function_call", "name": "tools.request_user_input", "call_id": call_id, "arguments": "{}"}),
                record("response_item", {"type": "function_call_output", "call_id": call_id, "output": output}),
            ])
        text, report = self.run_filter(records)
        self.assertEqual(report["markdown"]["roles"]["user input result"], 4)
        self.assertEqual(report["markdown"]["roles"]["user"], 1)
        self.assertIn('"cancelled":true', text)
        self.assertIn('"answers":{}', text)
        self.assertIn("request_user_input is unavailable in this mode", text)

    def test_encrypted_agent_message_shells_do_not_block_export(self):
        records = [
            message("user", "Please inspect this project."),
            record("response_item", {"type": "agent_message", "author": "worker", "recipient": "parent", "content": [
                {"type": "encrypted_content", "encrypted_content": "EMPTY_PRIVATE"},
            ]}),
            record("response_item", {"type": "agent_message", "author": "worker", "recipient": "parent", "content": [
                {"type": "encrypted_content", "encrypted_content": "MIXED_PRIVATE"},
                {"type": "text", "text": "Readable worker feedback."},
            ]}),
            message("assistant", "Inspection complete."),
        ]
        text, report = self.run_filter(records)
        self.assertIn("Readable worker feedback.", text)
        self.assertIn("Inspection complete.", text)
        self.assertNotIn("PRIVATE", text)
        self.assertEqual(report["markdown"]["roles"]["agent message"], 1)
        self.assertEqual(report["markdown"]["excluded_records"]["empty_agent_message"], 1)
        self.assertEqual(report["removed"]["encrypted_content_fields"], 2)

    def test_injected_turns_after_model_switch_are_removed(self):
        records = [
            message("user", "First request.", ["user.text"]),
            message("assistant", "Original response."),
            message("developer", "<model_switch>MODEL_SWITCH_PRIVATE</model_switch>", ["model_switch.instructions"]),
            message("developer", "PERMISSIONS_PRIVATE", ["permissions.instructions"]),
            message("user", "<environment_context>ENV_REFRESH_PRIVATE</environment_context>", ["environments.environment_context"]),
            message("developer", "SKILLS_REFRESH_PRIVATE", ["host_skills.instructions"]),
            message("user", "Second request.", ["user.text"]),
            message("assistant", "New response."),
        ]
        text, report = self.run_filter(records)
        for sentinel in ("MODEL_SWITCH_PRIVATE", "PERMISSIONS_PRIVATE", "ENV_REFRESH_PRIVATE", "SKILLS_REFRESH_PRIVATE"):
            self.assertNotIn(sentinel, text)
        for retained in ("First request.", "Original response.", "Second request.", "New response."):
            self.assertIn(retained, text)
        inventory = report["markdown"]["injected_content_removed"]
        self.assertEqual(inventory["messages"], 4)
        self.assertEqual(inventory["by_role"], {"developer": 3, "user": 1})
        self.assertEqual([item["stripped_record"] for item in inventory["records"]], [3, 4, 5, 6])
        self.assertEqual(report["markdown"]["stripped_record_for_each_section"], [1, 2, 7, 8])

    def test_mixed_later_user_message_preserves_human_text_and_unknown_kinds(self):
        human = "<environment_context>This is my actual follow-up.</environment_context>"
        mixed = message("user", human, ["user.text"])
        mixed["payload"]["content"].extend([
            {"type": "input_text", "text": "INJECTED_PRIVATE"},
            {"type": "input_text", "text": "Unknown provenance stays visible."},
        ])
        mixed["payload"]["internal_chat_message_metadata_passthrough"]["content_item_kinds"].extend([
            "environments.environment_context", "future.unrecognized",
        ])
        text, report = self.run_filter([message("user", "Original request."), mixed])
        self.assertIn(human, text)
        self.assertIn("Unknown provenance stays visible.", text)
        self.assertNotIn("INJECTED_PRIVATE", text)
        inventory = report["markdown"]["injected_content_removed"]
        self.assertEqual(inventory["messages"], 0)
        self.assertEqual(inventory["partial_messages"], 1)
        self.assertEqual(inventory["content_blocks"], 1)

    def test_legacy_refreshes_removed_without_scrubbing_quoted_conversation(self):
        quoted = "<model_switch>Quoted instruction</model_switch>"
        records = [
            message("user", "Original request."),
            message("system", "SYSTEM_REFRESH_PRIVATE"),
            message("developer", "DEVELOPER_REFRESH_PRIVATE"),
            message("user", "<environment_context>ENV_PRIVATE</environment_context>"),
            message("user", "<recommended_plugins>PLUGIN_PRIVATE</recommended_plugins>"),
            message("user", "# AGENTS.md instructions for /workspace\nAGENTS_PRIVATE"),
            message("user", "<permissions instructions>PERMISSIONS_PRIVATE</permissions>"),
            message("user", "Please explain this: " + quoted),
            message("assistant", quoted),
            record("response_item", {"type": "custom_tool_call", "name": "exec", "input": quoted}),
        ]
        text, report = self.run_filter(records)
        self.assertNotIn("PRIVATE", text)
        self.assertEqual(text.count(quoted), 3)
        self.assertEqual(report["markdown"]["roles"], {"assistant": 1, "tool call": 1, "user": 2})

    def test_legacy_user_setup_and_raw_arguments(self):
        text, _ = self.run_filter([
            message("user", "# AGENTS.md instructions for /workspace\nsetup"),
            message("user", "<recommended_plugins>setup</recommended_plugins>"),
            message("user", "<environment_context>setup</environment_context>"),
            message("user", "Original request."),
            record("response_item", {"type": "function_call", "name": "exec", "arguments": "not JSON\nraw input"}),
            record("response_item", {"type": "local_shell_call", "action": {"command": ["echo", "hi"]}}),
        ])
        self.assertNotIn("setup", text)
        self.assertIn("not JSON\nraw input", text)
        self.assertIn('"command":["echo","hi"]', text)

    def test_explicit_user_text_is_not_mistaken_for_injected_setup(self):
        text, _ = self.run_filter([message("user", "<environment_context>My actual request</environment_context>", ["user.text"])])
        self.assertIn("My actual request", text)

    def test_opaque_argument_strings_are_not_lossily_decoded(self):
        arguments = ['{"x":"first","x":"second"}', '{"x": NaN}', '{"x": 1e400}']
        records = [message("user", "Original request.")] + [
            record("response_item", {"type": "function_call", "name": "exec", "arguments": value})
            for value in arguments
        ]
        text, _ = self.run_filter(records)
        for value in arguments:
            self.assertIn(value, text)

    def test_encrypted_only_compaction_is_not_a_plaintext_summary(self):
        text, result = self.run_filter([message('user', 'Request'), record('compacted', {
            'message': '', 'replacement_history': [
                {'type': 'compaction', 'encrypted_content': 'PRIVATE_CHECKPOINT'}]})])
        self.assertEqual(result['compaction']['records_seen'], 1)
        self.assertEqual(result['compaction']['summary_messages_retained'], 0)
        self.assertEqual(result['markdown']['roles'].get('compaction summary', 0), 0)
        self.assertNotIn('PRIVATE_CHECKPOINT', text)

    def test_no_user_and_nontext_fail_before_any_output(self):
        cases = [
            [message("developer", "PRIVATE")],
            [message("user", "<environment_context>PRIVATE</environment_context>")],
            [message("user", "Request"), record("response_item", {"type": "message", "role": "user", "content": [{"type": "input_image", "image_url": "PRIVATE"}]})],
            [message("user", "Request"), message("user", "PRIVATE", ["user.text", "environments.environment_context"])],
        ]
        for records in cases:
            with self.subTest(records=len(records)):
                before = self.write_source(records)
                with self.assertRaises(STRIP.FilterError) as context:
                    STRIP.filter_rollout(self.source, self.output, self.report, markdown_path=self.markdown)
                self.assertNotIn("PRIVATE", str(context.exception))
                self.assertEqual(self.source.read_bytes(), before)
                self.assertFalse(self.output.exists())
                self.assertFalse(self.markdown.exists())
                self.assertFalse(self.report.exists())
                self.assertEqual(list(self.root.glob(".*.tmp")), [])

    def test_existing_markdown_and_output_alias_refused(self):
        self.write_source([message("user", "Request")])
        self.markdown.write_text("keep me")
        with self.assertRaises(STRIP.FilterError):
            STRIP.filter_rollout(self.source, self.output, self.report, markdown_path=self.markdown)
        self.assertEqual(self.markdown.read_text(), "keep me")
        self.assertFalse(self.output.exists())
        self.markdown.unlink()
        with self.assertRaises(STRIP.FilterError):
            STRIP.filter_rollout(self.source, self.markdown, self.report, markdown_path=self.markdown)
        self.assertFalse(self.markdown.exists())

    def test_dangling_markdown_symlink_refused_before_jsonl_publication(self):
        self.write_source([message("user", "Request")])
        self.markdown.symlink_to(self.root / "absent.md")
        with self.assertRaises(STRIP.FilterError):
            STRIP.filter_rollout(self.source, self.output, self.report, markdown_path=self.markdown)
        self.assertTrue(self.markdown.is_symlink())
        self.assertFalse(self.output.exists())

    @unittest.skipUnless(importlib.util.find_spec("tokenizers"), "optional tokenizers package")
    def test_local_tokenizer_counts_without_configured_truncation_or_padding(self):
        from tokenizers import Tokenizer, models, pre_tokenizers, processors

        tokenizer = Tokenizer(models.WordLevel({"[UNK]": 0, "[BOS]": 1}, unk_token="[UNK]"))
        tokenizer.pre_tokenizer = pre_tokenizers.Whitespace()
        tokenizer.post_processor = processors.TemplateProcessing(single="[BOS] $A", special_tokens=[("[BOS]", 1)])
        tokenizer.enable_truncation(max_length=2)
        tokenizer.enable_padding(length=100, pad_id=0, pad_token="[UNK]")
        path = self.root / "tokenizer.json"
        tokenizer.save(str(path))
        text, result = self.run_filter([message("user", "Count this entire multiword request exactly.")], tokenizer_path=path)
        tokenizer.no_truncation()
        tokenizer.no_padding()
        expected = len(tokenizer.encode(text, add_special_tokens=False).ids)
        self.assertGreater(expected, 2)
        self.assertLess(expected, 100)
        self.assertEqual(result["markdown"]["token_count"], expected)
        self.assertEqual(result["markdown"]["tokenizer_sha256"], hashlib.sha256(path.read_bytes()).hexdigest())

    def test_cli_outputs_a_report_and_freezes_markdown_for_workers(self):
        self.write_source([
            message("user", "Check a reported result."),
            record("response_item", {"type": "function_call", "name": "request_user_input", "call_id": "question", "arguments": '{"questions":[{"id":"scope","question":"Which result?"}]}'}),
            record("response_item", {"type": "function_call_output", "call_id": "question", "output": '{"answers":{"scope":{"answers":["The most recent result"]}}}'}),
            message("assistant", "Verification is pending."),
        ])
        result = subprocess.run([sys.executable, str(TOOLS / "strip_tool_outputs.py"), str(self.source), "--output", str(self.output), "--markdown", str(self.markdown), "--report", str(self.report)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["markdown"]["sections"], 4)
        agents = load("markdown_agents_test", TOOLS.parent / "skills/oxygen-deterministic-trajectory-agents/scripts/trajectory_agents.py")
        prepared = agents.prepare(self.markdown)
        run = Path(prepared["run_directory"])
        original = self.markdown.read_bytes()
        self.assertIn(b"The most recent result", original)
        self.assertEqual((run / "source.md").read_bytes(), original)
        self.assertFalse((run / "trajectory.json").exists())
        self.markdown.write_text("later source edit")
        call = agents.issue_call(self.markdown, "summary")
        self.assertEqual((run / "source.md").read_bytes(), original)
        self.assertIn("role-labeled trajectory or existing summary", call["message"])


if __name__ == "__main__":
    unittest.main()
