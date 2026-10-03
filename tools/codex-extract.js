#!/usr/bin/env node

/*
 * Convert Codex JSON/JSONL trajectory files into a compact, human-readable
 * Markdown transcript. The same file runs in Node.js and in a browser worker.
 *
 * Browser API:
 *   CodexExtractor.extractCodexFiles([{ path, text }], options)
 *
 * Node CLI:
 *   node tools/codex-extract.js ~/.codex/sessions --output prepared-session.md
 */
(function attachCodexExtractor(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.CodexExtractor = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildExtractor() {
  "use strict";

  const DEFAULT_OPTIONS = Object.freeze({
    includeToolCalls: true,
    includeAssistantCommentary: true,
    normalizeHomePaths: true,
    redactSensitive: true,
    maxToolInputChars: 0,
    entryStart: 1,
    omitTopHeader: false,
  });

  const RUNTIME_BLOCK_TAGS = [
    "app-context",
    "apps_instructions",
    "collaboration_mode",
    "environment_context",
    "multi_agent_mode",
    "permissions instructions",
    "plugins_instructions",
    "recommended_plugins",
    "skills_instructions",
  ];

  const SECRET_KEY_NAMES = new Set([
    "apikey",
    "accesstoken",
    "auth",
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "password",
    "privatekey",
    "refreshtoken",
    "secret",
    "sessiontoken",
  ]);
  const SECRET_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/g;
  const SECRET_JSON_VALUE = /("(?:api_?key|access_?token|authorization|cookie|credential|password|private_?key|refresh_?token|secret|session_?token)"\s*:\s*)"[^"]*"/gi;
  const TOKEN_PATTERNS = [
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    /\bsk-[A-Za-z0-9_-]{12,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{12,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    /\bxox[baprs]-[A-Za-z0-9-]{12,}/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  ];

  function mergeOptions(options) {
    return Object.assign({}, DEFAULT_OPTIONS, options || {});
  }

  function normalizeSourcePath(value, options) {
    let path = String(value || "unknown").replace(/\\/g, "/");
    const marker = "/.codex/";
    const markerIndex = path.indexOf(marker);
    if (markerIndex >= 0) {
      return `.codex/${path.slice(markerIndex + marker.length)}`;
    }
    if (options.normalizeHomePaths) {
      path = path.replace(/^\/home\/[^/]+(?=\/|$)/, "~");
      path = path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
    }
    return path;
  }

  function createRedactor(options) {
    let count = 0;

    function mark(replacement) {
      count += 1;
      return replacement;
    }

    function redactString(input) {
      let value = String(input == null ? "" : input);
      if (!options.redactSensitive) {
        return value;
      }

      value = value.replace(/data:([\w.+-]+\/[\w.+-]+)?;base64,[A-Za-z0-9+/=]+/g, (match, mime) =>
        mark(`[embedded ${mime || "data"} omitted; ${match.length} chars]`)
      );
      value = value.replace(SECRET_ASSIGNMENT, (_match, key) => mark(`${key}=[REDACTED]`));
      value = value.replace(SECRET_JSON_VALUE, (_match, prefix) => mark(`${prefix}"[REDACTED]"`));
      for (const pattern of TOKEN_PATTERNS) {
        value = value.replace(pattern, (match) => {
          const label = /^Bearer/i.test(match) ? "Bearer [REDACTED]" : "[REDACTED TOKEN]";
          return mark(label);
        });
      }
      value = value.replace(/([?&](?:access_token|api_key|key|secret|signature|token)=)[^&#\s]+/gi, (_match, prefix) =>
        mark(`${prefix}[REDACTED]`)
      );
      value = value.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, () => mark("[email redacted]"));
      if (options.normalizeHomePaths) {
        value = value.replace(/\/home\/[^/\s"']+/g, "~");
        value = value.replace(/\/Users\/[^/\s"']+/g, "~");
      }
      return value;
    }

    function redactValue(value, seen) {
      if (typeof value === "string") {
        return redactString(value);
      }
      if (!value || typeof value !== "object") {
        return value;
      }
      const visited = seen || new WeakSet();
      if (visited.has(value)) {
        return "[circular value omitted]";
      }
      visited.add(value);
      if (Array.isArray(value)) {
        return value.map((item) => redactValue(item, visited));
      }
      const output = {};
      for (const [key, item] of Object.entries(value)) {
        const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
        const secretKey = SECRET_KEY_NAMES.has(normalizedKey) || /(?:apikey|accesstoken|auth(?:orization)?|cookie|credential|password|privatekey|refreshtoken|secret|sessiontoken)$/.test(normalizedKey);
        if (secretKey) {
          output[key] = mark("[REDACTED]");
        } else {
          output[key] = redactValue(item, visited);
        }
      }
      return output;
    }

    return {
      redactString,
      redactValue,
      get count() {
        return count;
      },
    };
  }

  function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function stripRuntimeContext(input) {
    let text = String(input || "");
    for (const tag of RUNTIME_BLOCK_TAGS) {
      const escaped = escapeRegex(tag);
      text = text.replace(new RegExp(`<${escaped}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escaped}>`, "gi"), "");
    }
    text = text.replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi, "");
    text = text.replace(/^\s*#\s*AGENTS\.md instructions\s*$/gim, "");
    text = text.replace(/^\s*<environment_context\s*\/>\s*$/gim, "");
    text = text.replace(/\n{3,}/g, "\n\n").trim();
    return text;
  }

  function parseJsonMaybe(value) {
    if (typeof value !== "string") {
      return value;
    }
    const trimmed = value.trim();
    if (!trimmed || !/^[{[]/.test(trimmed)) {
      return value;
    }
    try {
      return JSON.parse(trimmed);
    } catch (_error) {
      return value;
    }
  }

  function stableStringify(value) {
    if (typeof value === "string") {
      return value;
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch (_error) {
      return String(value);
    }
  }

  function parseInputFile(file) {
    const path = String(file.path || file.name || "unknown");
    const text = String(file.text == null ? "" : file.text);
    const rows = [];
    const errors = [];

    if (/\.jsonl$/i.test(path)) {
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].trim()) {
          continue;
        }
        try {
          rows.push({ value: JSON.parse(lines[index]), line: index + 1 });
        } catch (error) {
          errors.push(`line ${index + 1}: ${error.message}`);
        }
      }
      return { path, rows, errors, bytes: text.length };
    }

    if (/\.json$/i.test(path)) {
      try {
        const value = JSON.parse(text);
        const values = Array.isArray(value) ? value : [value];
        values.forEach((item, index) => rows.push({ value: item, line: index + 1 }));
      } catch (error) {
        errors.push(error.message);
      }
      return { path, rows, errors, bytes: text.length };
    }

    errors.push("unsupported file type; expected .json or .jsonl");
    return { path, rows, errors, bytes: text.length };
  }

  function messageText(payload, role, redactor) {
    const parts = [];
    for (const block of Array.isArray(payload.content) ? payload.content : []) {
      if (!block || typeof block !== "object") {
        continue;
      }
      if (typeof block.text === "string") {
        const clean = role === "user" ? stripRuntimeContext(block.text) : block.text.trim();
        if (clean) {
          parts.push(redactor.redactString(clean));
        }
      } else if (block.type === "input_image" || block.type === "image") {
        const imageValue = String(block.image_url || block.url || "");
        const mimeMatch = imageValue.match(/^data:([^;,]+)/i);
        parts.push(`[Attached image${mimeMatch ? `: ${mimeMatch[1]}` : ""}; binary data omitted]`);
      } else if (block.type === "input_file" || block.type === "file") {
        parts.push(`[Attached file: ${redactor.redactString(block.filename || block.name || "unnamed")}]`);
      }
    }
    return parts.join("\n\n").trim();
  }

  function toolInput(payload, redactor, options) {
    const raw = payload.input !== undefined ? payload.input : payload.arguments;
    if (raw === undefined || raw === null || raw === "") {
      return "";
    }
    const parsed = parseJsonMaybe(raw);
    let text = stableStringify(redactor.redactValue(parsed));
    if (options.maxToolInputChars > 0 && text.length > options.maxToolInputChars) {
      text = `${text.slice(0, options.maxToolInputChars)}\n[truncated ${text.length - options.maxToolInputChars} chars]`;
    }
    return text.trim();
  }

  function isToolCall(payload) {
    const type = String(payload.type || "");
    return type === "custom_tool_call" || type === "function_call" || type === "local_shell_call" || type.endsWith("_tool_call");
  }

  function entrySignature(entry) {
    return `${entry.kind}\u0000${entry.role || ""}\u0000${entry.phase || ""}\u0000${entry.name || ""}\u0000${entry.text}`;
  }

  function extractTrajectory(parsed, options, redactor) {
    const entries = [];
    const seen = new Set();
    const dropped = Object.create(null);
    let session = null;

    function drop(reason) {
      dropped[reason] = (dropped[reason] || 0) + 1;
    }

    for (const row of parsed.rows) {
      const record = row.value;
      if (!record || typeof record !== "object") {
        drop("non_object_record");
        continue;
      }
      const payload = record.payload && typeof record.payload === "object" ? record.payload : {};

      if (record.type === "session_meta") {
        session = {
          id: payload.id || payload.session_id || null,
          timestamp: payload.timestamp || record.timestamp || null,
          cwd: payload.cwd ? normalizeSourcePath(payload.cwd, options) : null,
          source: payload.source || null,
          cliVersion: payload.cli_version || null,
        };
        drop("session_metadata");
        continue;
      }

      if (record.type !== "response_item") {
        drop(record.type || "unknown_record");
        continue;
      }

      if (payload.type === "message") {
        const role = String(payload.role || "unknown").toLowerCase();
        if (role !== "user" && role !== "assistant") {
          drop(`${role}_message`);
          continue;
        }
        if (role === "assistant" && payload.phase === "commentary" && !options.includeAssistantCommentary) {
          drop("assistant_commentary");
          continue;
        }
        const text = messageText(payload, role, redactor);
        if (!text) {
          drop(role === "user" ? "runtime_only_user_message" : "empty_message");
          continue;
        }
        const entry = {
          kind: "message",
          role,
          phase: payload.phase || null,
          text,
          line: row.line,
          sourceId: payload.id || null,
        };
        const signature = entrySignature(entry);
        if (seen.has(signature)) {
          drop("duplicate_message");
          continue;
        }
        seen.add(signature);
        entries.push(entry);
        continue;
      }

      if (isToolCall(payload)) {
        if (!options.includeToolCalls) {
          drop("tool_call");
          continue;
        }
        const text = toolInput(payload, redactor, options);
        if (!text) {
          drop("empty_tool_call");
          continue;
        }
        entries.push({
          kind: "tool_call",
          name: redactor.redactString(payload.name || payload.type || "tool"),
          text,
          line: row.line,
          sourceId: payload.call_id || payload.id || null,
        });
        continue;
      }

      drop(payload.type || "unknown_response_item");
    }

    return { entries, dropped, session };
  }

  function extractSessionIndex(parsed, redactor) {
    const entries = [];
    for (const row of parsed.rows) {
      const value = row.value;
      if (!value || typeof value !== "object" || !("thread_name" in value) || !("id" in value)) {
        continue;
      }
      entries.push({
        kind: "index",
        role: "thread",
        text: redactor.redactString(value.thread_name || "Untitled task"),
        id: value.id,
        updatedAt: value.updated_at || null,
        line: row.line,
      });
    }
    return entries;
  }

  function extractHistory(parsed, redactor) {
    const entries = [];
    for (const row of parsed.rows) {
      const value = row.value;
      if (!value || typeof value !== "object" || typeof value.text !== "string" || !("session_id" in value)) {
        continue;
      }
      const text = redactor.redactString(stripRuntimeContext(value.text));
      if (text) {
        entries.push({ kind: "message", role: "user", text, line: row.line, sourceId: value.session_id });
      }
    }
    return entries;
  }

  function classify(parsed) {
    const values = parsed.rows.map((row) => row.value).filter((value) => value && typeof value === "object");
    if (values.some((value) => ["session_meta", "response_item", "event_msg", "turn_context", "world_state"].includes(value.type))) {
      return "trajectory";
    }
    if (values.length && values.every((value) => "id" in value && "thread_name" in value)) {
      return "session_index";
    }
    if (values.length && values.every((value) => "session_id" in value && "text" in value)) {
      return "history";
    }
    return "unsupported";
  }

  function markdownFence(text) {
    return text.includes("````") ? "`````" : "````";
  }

  function renderEntry(entry, id, sourcePath) {
    const source = `Source: \`${sourcePath}:${entry.line}\``;
    if (entry.kind === "tool_call") {
      const fence = markdownFence(entry.text);
      return `### ${id} — Tool call: \`${entry.name}\`\n\n${source}\n\n${fence}json\n${entry.text}\n${fence}`;
    }
    if (entry.kind === "index") {
      const details = [entry.id ? `ID: \`${entry.id}\`` : "", entry.updatedAt ? `Updated: ${entry.updatedAt}` : ""]
        .filter(Boolean)
        .join(" · ");
      return `### ${id} — Task index entry\n\n${source}${details ? `\n\n${details}` : ""}\n\n${entry.text}`;
    }
    const actor = entry.role === "assistant" ? "Assistant" : "User";
    const phase = entry.phase ? ` (${entry.phase})` : "";
    return `### ${id} — ${actor}${phase}\n\n${source}\n\n${entry.text}`;
  }

  function formatDropCounts(dropped) {
    const pairs = Object.entries(dropped || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return pairs.length ? pairs.map(([key, value]) => `${key}=${value}`).join(", ") : "none";
  }

  function extractCodexFiles(files, suppliedOptions) {
    const options = mergeOptions(suppliedOptions);
    const redactor = createRedactor(options);
    const output = [];
    const fileResults = [];
    let nextEntry = Number(options.entryStart) || 1;
    let totalBytes = 0;
    let totalRecords = 0;
    let keptEntries = 0;

    if (!options.omitTopHeader) {
      output.push("# Prepared Codex trajectory", "");
      output.push("Generated deterministically from Codex JSON/JSONL. Runtime instructions, reasoning, tool outputs, duplicated UI events, and binary payloads are omitted.", "");
    }

    for (const file of Array.isArray(files) ? files : []) {
      const parsed = parseInputFile(file);
      const sourcePath = normalizeSourcePath(parsed.path, options);
      const kind = classify(parsed);
      totalBytes += parsed.bytes;
      totalRecords += parsed.rows.length;

      let result = { entries: [], dropped: {}, session: null };
      if (kind === "trajectory") {
        result = extractTrajectory(parsed, options, redactor);
      } else if (kind === "session_index") {
        result.entries = extractSessionIndex(parsed, redactor);
      } else if (kind === "history") {
        result.entries = extractHistory(parsed, redactor);
      }

      output.push(`## File: \`${sourcePath}\``, "");
      output.push(`- Detected: ${kind}`);
      output.push(`- Input: ${parsed.rows.length} records, ${parsed.bytes} characters`);
      output.push(`- Kept: ${result.entries.length} human-readable entries`);
      if (result.session) {
        if (result.session.id) output.push(`- Session: \`${result.session.id}\``);
        if (result.session.timestamp) output.push(`- Started: ${result.session.timestamp}`);
        if (result.session.cwd) output.push(`- Working directory: \`${result.session.cwd}\``);
      }
      if (kind === "trajectory") {
        output.push(`- Omitted: ${formatDropCounts(result.dropped)}`);
      }
      if (parsed.errors.length) {
        output.push(`- Parse warnings: ${parsed.errors.map((error) => redactor.redactString(error)).join("; ")}`);
      }
      output.push("");

      if (!result.entries.length) {
        output.push("_No supported human-readable trajectory content found._", "");
      } else {
        for (const entry of result.entries) {
          const id = `E${String(nextEntry).padStart(4, "0")}`;
          output.push(renderEntry(entry, id, sourcePath), "");
          nextEntry += 1;
          keptEntries += 1;
        }
      }

      fileResults.push({
        path: sourcePath,
        detected: kind,
        records: parsed.rows.length,
        bytes: parsed.bytes,
        kept: result.entries.length,
        dropped: result.dropped,
        parseErrors: parsed.errors.slice(),
        session: result.session,
      });
    }

    const stats = {
      files: fileResults.length,
      supportedFiles: fileResults.filter((file) => file.detected !== "unsupported").length,
      totalBytes,
      totalRecords,
      keptEntries,
      redactions: redactor.count,
      fileResults,
    };

    if (!options.omitTopHeader) {
      output.splice(3, 0,
        `Files: ${stats.files} · Supported: ${stats.supportedFiles} · Records: ${stats.totalRecords} · Kept entries: ${stats.keptEntries} · Redactions: ${stats.redactions}`,
        ""
      );
    }

    return { markdown: `${output.join("\n").trim()}\n`, stats };
  }

  return {
    DEFAULT_OPTIONS,
    extractCodexFiles,
    stripRuntimeContext,
  };
});

if (typeof module === "object" && module.exports && typeof require === "function" && require.main === module) {
  const fs = require("fs");
  const path = require("path");

  function usage() {
    return [
      "Usage: node tools/codex-extract.js [options] <file-or-directory>...",
      "",
      "Options:",
      "  -o, --output <path>   Write Markdown to a file instead of stdout",
      "  --no-tools            Omit tool-call inputs",
      "  --no-commentary       Omit assistant commentary messages",
      "  --max-tool-chars <n>  Truncate each tool input to n characters (0 = unlimited)",
    ].join("\n");
  }

  function collectFiles(inputPaths) {
    const found = [];
    function visit(target) {
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(target).sort()) {
          visit(path.join(target, name));
        }
      } else if (/\.jsonl?$/i.test(target)) {
        found.push(target);
      }
    }
    inputPaths.forEach(visit);
    return found;
  }

  function parseArgs(argv) {
    const result = { inputs: [], output: null, includeToolCalls: true, includeAssistantCommentary: true, maxToolInputChars: 0 };
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === "-o" || arg === "--output") result.output = argv[++index];
      else if (arg === "--no-tools") result.includeToolCalls = false;
      else if (arg === "--no-commentary") result.includeAssistantCommentary = false;
      else if (arg === "--max-tool-chars") result.maxToolInputChars = Number(argv[++index]);
      else result.inputs.push(arg);
    }
    return result;
  }

  const args = parseArgs(process.argv.slice(2));
  if (!args.inputs.length) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 1;
  } else {
    const filePaths = collectFiles(args.inputs);
    const sections = [];
    const aggregate = { files: 0, supportedFiles: 0, totalBytes: 0, totalRecords: 0, keptEntries: 0, redactions: 0 };
    let entryStart = 1;

    for (const filePath of filePaths) {
      const result = module.exports.extractCodexFiles(
        [{ path: filePath, text: fs.readFileSync(filePath, "utf8") }],
        Object.assign({}, args, { entryStart, omitTopHeader: true })
      );
      sections.push(result.markdown.trim());
      entryStart += result.stats.keptEntries;
      for (const key of Object.keys(aggregate)) aggregate[key] += result.stats[key];
    }

    const markdown = [
      "# Prepared Codex trajectory",
      "",
      "Generated deterministically from Codex JSON/JSONL. Runtime instructions, reasoning, tool outputs, duplicated UI events, and binary payloads are omitted.",
      "",
      `Files: ${aggregate.files} · Supported: ${aggregate.supportedFiles} · Records: ${aggregate.totalRecords} · Kept entries: ${aggregate.keptEntries} · Redactions: ${aggregate.redactions}`,
      "",
      ...sections,
      "",
    ].join("\n");

    if (args.output) {
      fs.writeFileSync(args.output, markdown);
      process.stderr.write(`Wrote ${args.output} (${aggregate.keptEntries} entries from ${aggregate.files} files)\n`);
    } else {
      process.stdout.write(markdown);
    }
  }
}
