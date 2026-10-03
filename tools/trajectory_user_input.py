"""Identify user-input results by recorded call identity, never by answer keywords."""


USER_INPUT_TOOLS = {"request_user_input", "request_user_input_async"}
CALL_RESULT_TYPES = {
    "function_call": "function_call_output",
    "custom_tool_call": "custom_tool_call_output",
}
RESULT_TYPES = set(CALL_RESULT_TYPES.values())


def user_input_tool(name):
    if not isinstance(name, str):
        return None
    for prefix in ("functions.", "tools."):
        if name.startswith(prefix):
            name = name[len(prefix):]
            break
    return name if name in USER_INPUT_TOOLS else None


class UserInputResults:
    """Track preceding calls, including interleaved calls and checkpoint history."""

    def __init__(self):
        self.calls = {}

    def copy(self):
        tracker = UserInputResults()
        tracker.calls = self.calls.copy()
        return tracker

    def observe(self, item):
        kind = item.get("type")
        if kind not in CALL_RESULT_TYPES:
            return
        tool = user_input_tool(item.get("name"))
        call_id = item.get("call_id")
        if not isinstance(call_id, str) or not call_id:
            if tool:
                raise ValueError("user-input tool call requires a nonempty call_id")
            return
        identity = (kind, item.get("namespace"), item.get("name"), tool)
        previous = self.calls.get(call_id)
        if previous is not None and previous != identity:
            raise ValueError("conflicting tool identities for a call_id")
        self.calls[call_id] = identity

    def result_tool(self, item):
        if item.get("type") not in RESULT_TYPES:
            return None
        call_id = item.get("call_id")
        previous = self.calls.get(call_id) if isinstance(call_id, str) else None
        if previous is not None and previous[3]:
            if item["type"] != CALL_RESULT_TYPES[previous[0]]:
                raise ValueError("user-input result type does not match its call")
            if "output" not in item:
                raise ValueError("user-input result is missing its output")
            return previous[3]
        if user_input_tool(item.get("name")):
            raise ValueError("named user-input result has no matching preceding call")
        return None
