//! Every agent's hook payload, mapped onto the events and fields the island
//! knows (Claude Code's). Same table as `normalize_event` /
//! `normalize_tool_fields` in the Mac relay (HookServer.swift), plus Cursor's
//! events and Antigravity / Codex tool input normalization.

use serde_json::{json, Map, Value};

/// The canonical name of an agent's event. Unknown names pass through.
pub fn event(name: &str) -> &str {
    match name {
        // Gemini CLI
        "BeforeTool" | "BeforeToolSelection" => "PreToolUse",
        "AfterTool" | "AfterModel" => "PostToolUse",
        "BeforeAgent" => "UserPromptSubmit",
        "AfterAgent" => "Stop",
        "startup" => "SessionStart",
        "exit" => "SessionEnd",
        // Antigravity
        "PreInvocation" => "UserPromptSubmit",
        "PostInvocation" => "PostToolUse",
        // snake_case relays
        "pre_tool_use" => "PreToolUse",
        "post_tool_use" => "PostToolUse",
        "user_prompt_submit" => "UserPromptSubmit",
        "session_start" => "SessionStart",
        "session_end" => "SessionEnd",
        "stop" => "Stop",
        // Copilot CLI (camelCase) — Cursor shares most of these
        "sessionStart" => "SessionStart",
        "userPromptSubmitted" => "UserPromptSubmit",
        "agentStop" => "Stop",
        "notification" => "Notification",
        "preToolUse" => "PreToolUse",
        "postToolUse" => "PostToolUse",
        "permissionRequest" => "PermissionRequest",
        "sessionEnd" => "SessionEnd",
        // Cursor
        "beforeSubmitPrompt" => "UserPromptSubmit",
        "postToolUseFailure" => "PostToolUseFailure",
        "subagentStart" => "SubagentStart",
        "subagentStop" => "SubagentStop",
        other => other,
    }
}

/// Keys of Antigravity's `toolCall.args` (and other agents' tool inputs) that
/// the island reads under Claude Code's canonical names.
const ARG_ALIASES: &[(&str, &str)] = &[
    ("CommandLine", "command"),
    ("FilePath", "file_path"),
    ("TargetFile", "file_path"),
    ("AbsolutePath", "file_path"),
    ("Path", "path"),
    ("DirectoryPath", "path"),
    ("SearchPath", "path"),
    ("Url", "url"),
    ("Query", "query"),
    ("Pattern", "pattern"),
    ("TargetContent", "old_string"),
    ("ReplacementContent", "new_string"),
    ("CodeContent", "content"),
    ("StartLine", "start_line"),
    ("EndLine", "end_line"),
];

fn non_empty_str<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// Normalizes a `tool_input` map in place without overwriting existing canonical keys.
fn normalize_tool_input(input: &mut Map<String, Value>) {
    for (from, to) in ARG_ALIASES {
        if !input.contains_key(*to) {
            if let Some(v) = input.get(*from).cloned() {
                input.insert((*to).to_string(), v);
            }
        }
    }

    // If `command` is an array (e.g. Codex `["powershell", "-Command", "..."]`) or absent
    // while `cmd` / `argv` is present, normalize into a single string `command`.
    if !input.get("command").is_some_and(Value::is_string) {
        let joined = ["command", "cmd", "argv"].iter().find_map(|k| match input.get(*k) {
            Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
            Some(Value::Array(arr)) => {
                let parts: Vec<&str> = arr.iter().filter_map(Value::as_str).collect();
                (!parts.is_empty()).then(|| parts.join(" "))
            }
            _ => None,
        });
        if let Some(cmd) = joined {
            input.insert("command".into(), Value::String(cmd));
        }
    }

    // Map Antigravity's `ReplacementChunks` (multi_replace_file_content) into `edits`.
    if !input.contains_key("edits") {
        if let Some(Value::Array(chunks)) = input.get("ReplacementChunks") {
            let edits: Vec<Value> = chunks
                .iter()
                .filter_map(Value::as_object)
                .map(|c| {
                    let mut edit = Map::new();
                    if let Some(old) = c.get("TargetContent").or_else(|| c.get("old_string")) {
                        edit.insert("old_string".into(), old.clone());
                    }
                    if let Some(new) = c.get("ReplacementContent").or_else(|| c.get("new_string")) {
                        edit.insert("new_string".into(), new.clone());
                    }
                    if let Some(start) = c.get("StartLine").or_else(|| c.get("start_line")) {
                        edit.insert("start_line".into(), start.clone());
                    }
                    if let Some(end) = c.get("EndLine").or_else(|| c.get("end_line")) {
                        edit.insert("end_line".into(), end.clone());
                    }
                    Value::Object(edit)
                })
                .collect();
            if !edits.is_empty() {
                input.insert("edits".into(), Value::Array(edits));
            }
        }
    }

    // Normalize Antigravity's `ask_question` items (`options: ["A", "B"]`, `is_multi_select`)
    // into Claude Code's `AskUserQuestion` shape (`options: [{"label": "A"}]`, `multiSelect`).
    if let Some(Value::Array(questions)) = input.get_mut("questions") {
        for q in questions.iter_mut() {
            let Some(q_obj) = q.as_object_mut() else { continue };
            if !q_obj.contains_key("multiSelect") {
                if let Some(Value::Bool(multi)) = q_obj.get("is_multi_select") {
                    q_obj.insert("multiSelect".into(), Value::Bool(*multi));
                }
            }
            if let Some(Value::Array(opts)) = q_obj.get_mut("options") {
                for opt in opts.iter_mut() {
                    if let Value::String(label) = opt {
                        *opt = json!({ "label": label.clone() });
                    }
                }
            }
        }
    }
}

/// Fills `tool_name`, `tool_input`, `session_id` and `cwd` from wherever the
/// agent put them. A field the payload already has is never overwritten.
/// `env` reads an environment variable (a parameter so tests stay pure).
pub fn fields(map: &mut Map<String, Value>, env: &dyn Fn(&str) -> Option<String>) {
    let tool_call = map.get("toolCall").and_then(Value::as_object).cloned();

    if !map.contains_key("tool_name") {
        // Copilot: toolName. Gemini CLI / Antigravity: toolCall.name. Others: tool.
        let name = non_empty_str(map, "toolName")
            .or_else(|| tool_call.as_ref().and_then(|t| non_empty_str(t, "name")))
            .or_else(|| non_empty_str(map, "tool"))
            .map(str::to_string);
        if let Some(name) = name {
            map.insert("tool_name".into(), Value::String(name));
        }
    }

    if !map.contains_key("tool_input") {
        // Copilot sends toolArgs as an object, or as the JSON text of one.
        let args = match map.get("toolArgs") {
            Some(Value::Object(o)) => Some(o.clone()),
            Some(Value::String(s)) => serde_json::from_str::<Value>(s)
                .ok()
                .and_then(|v| v.as_object().cloned()),
            _ => None,
        };
        let input = args.or_else(|| tool_call.as_ref()?.get("args")?.as_object().cloned());
        if let Some(mut input) = input {
            normalize_tool_input(&mut input);
            map.insert("tool_input".into(), Value::Object(input));
        }
    } else if let Some(Value::Object(input)) = map.get_mut("tool_input") {
        normalize_tool_input(input);
    }

    if non_empty_str(map, "session_id").is_none() {
        let sid = ["conversationId", "conversation_id", "sessionId", "GEMINI_SESSION_ID"]
            .iter()
            .find_map(|k| non_empty_str(map, k))
            .map(str::to_string)
            .or_else(|| env("GEMINI_SESSION_ID").filter(|s| !s.is_empty()));
        if let Some(sid) = sid {
            map.insert("session_id".into(), Value::String(sid));
        }
    }

    if non_empty_str(map, "cwd").is_none() {
        // Copilot: workdir. Gemini CLI / Antigravity: workspacePaths. Cursor: workspace_roots.
        let cwd = non_empty_str(map, "workdir").map(str::to_string).or_else(|| {
            ["workspacePaths", "workspace_roots"].iter().find_map(|k| {
                map.get(*k)?.as_array()?.first()?.as_str().filter(|s| !s.is_empty()).map(str::to_string)
            })
        });
        if let Some(cwd) = cwd {
            map.insert("cwd".into(), Value::String(cwd));
        }
    }
}

/// The event once the payload is known: a stop that reports an error (Cursor's
/// `status: "error"`) is a StopFailure.
pub fn refine(event: &str, map: &Map<String, Value>) -> String {
    if event == "Stop" && map.get("status").and_then(Value::as_str) == Some("error") {
        return "StopFailure".into();
    }
    event.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn every_agents_event_names_map_onto_claude_codes() {
        for (raw, canonical) in [
            ("BeforeTool", "PreToolUse"),
            ("BeforeToolSelection", "PreToolUse"),
            ("AfterTool", "PostToolUse"),
            ("AfterModel", "PostToolUse"),
            ("BeforeAgent", "UserPromptSubmit"),
            ("AfterAgent", "Stop"),
            ("startup", "SessionStart"),
            ("exit", "SessionEnd"),
            ("PreInvocation", "UserPromptSubmit"),
            ("PostInvocation", "PostToolUse"),
            ("pre_tool_use", "PreToolUse"),
            ("post_tool_use", "PostToolUse"),
            ("user_prompt_submit", "UserPromptSubmit"),
            ("session_start", "SessionStart"),
            ("session_end", "SessionEnd"),
            ("stop", "Stop"),
            ("sessionStart", "SessionStart"),
            ("userPromptSubmitted", "UserPromptSubmit"),
            ("agentStop", "Stop"),
            ("notification", "Notification"),
            ("preToolUse", "PreToolUse"),
            ("postToolUse", "PostToolUse"),
            ("permissionRequest", "PermissionRequest"),
            ("sessionEnd", "SessionEnd"),
            ("beforeSubmitPrompt", "UserPromptSubmit"),
            ("postToolUseFailure", "PostToolUseFailure"),
            ("subagentStart", "SubagentStart"),
            ("subagentStop", "SubagentStop"),
        ] {
            assert_eq!(event(raw), canonical, "{raw}");
        }
        // Claude Code's own names, and anything unknown, pass through.
        for same in ["PreToolUse", "PermissionRequest", "Stop", "Interrupt", "somethingNew"] {
            assert_eq!(event(same), same);
        }
    }

    #[test]
    fn antigravity_and_gemini_tool_calls_become_tool_name_and_input() {
        let mut m = obj(json!({
            "conversationId": "conv-1",
            "workspacePaths": ["C:\\Projects\\test"],
            "toolCall": { "name": "run_command", "args": { "CommandLine": "cargo check" } }
        }));
        fields(&mut m, &no_env);
        assert_eq!(m["tool_name"], "run_command");
        assert_eq!(m["tool_input"]["command"], "cargo check");
        assert_eq!(m["tool_input"]["CommandLine"], "cargo check");
        assert_eq!(m["session_id"], "conv-1");
        assert_eq!(m["cwd"], "C:\\Projects\\test");
    }

    #[test]
    fn antigravity_edit_and_question_args_are_normalized() {
        let mut m = obj(json!({
            "toolCall": {
                "name": "replace_file_content",
                "args": {
                    "TargetFile": "C:\\repo\\src\\main.ts",
                    "TargetContent": "const a = 1;",
                    "ReplacementContent": "const a = 2;",
                    "StartLine": 12,
                    "EndLine": 12
                }
            }
        }));
        fields(&mut m, &no_env);
        assert_eq!(m["tool_input"]["file_path"], "C:\\repo\\src\\main.ts");
        assert_eq!(m["tool_input"]["old_string"], "const a = 1;");
        assert_eq!(m["tool_input"]["new_string"], "const a = 2;");
        assert_eq!(m["tool_input"]["start_line"], 12);

        let mut q = obj(json!({
            "toolCall": {
                "name": "ask_question",
                "args": {
                    "questions": [{
                        "question": "Proceed with deploy?",
                        "options": ["Yes", "No"],
                        "is_multi_select": false
                    }]
                }
            }
        }));
        fields(&mut q, &no_env);
        assert_eq!(q["tool_input"]["questions"][0]["options"][0]["label"], "Yes");
        assert_eq!(q["tool_input"]["questions"][0]["multiSelect"], false);
    }

    #[test]
    fn copilot_tool_name_args_and_workdir_are_read() {
        let mut m = obj(json!({
            "toolName": "bash",
            "toolArgs": "{\"command\":\"npm test\"}",
            "sessionId": "s-9",
            "workdir": "/home/me/app"
        }));
        fields(&mut m, &no_env);
        assert_eq!(m["tool_name"], "bash");
        assert_eq!(m["tool_input"]["command"], "npm test");
        assert_eq!(m["session_id"], "s-9");
        assert_eq!(m["cwd"], "/home/me/app");

        let mut m = obj(json!({ "toolName": "edit", "toolArgs": { "path": "a.rs" } }));
        fields(&mut m, &no_env);
        assert_eq!(m["tool_input"]["path"], "a.rs");
    }

    #[test]
    fn cursor_conversation_and_workspace_become_session_and_cwd() {
        let mut m = obj(json!({ "conversation_id": "c-1", "workspace_roots": ["/w/proj"] }));
        fields(&mut m, &no_env);
        assert_eq!(m["session_id"], "c-1");
        assert_eq!(m["cwd"], "/w/proj");
    }

    #[test]
    fn what_the_payload_already_says_is_never_overwritten() {
        let mut m = obj(json!({
            "tool_name": "Bash", "tool_input": { "command": "ls" },
            "session_id": "keep", "cwd": "/keep",
            "toolName": "other", "toolArgs": { "command": "rm" },
            "conversationId": "no", "workdir": "/no"
        }));
        fields(&mut m, &|_| Some("env".into()));
        assert_eq!(m["tool_name"], "Bash");
        assert_eq!(m["tool_input"]["command"], "ls");
        assert_eq!(m["session_id"], "keep");
        assert_eq!(m["cwd"], "/keep");
    }

    #[test]
    fn gemini_session_comes_from_the_environment_last() {
        let mut m = obj(json!({}));
        fields(&mut m, &|k| (k == "GEMINI_SESSION_ID").then(|| "g-7".to_string()));
        assert_eq!(m["session_id"], "g-7");
    }

    #[test]
    fn odd_shapes_are_ignored_not_trusted() {
        let mut m = obj(json!({ "toolCall": "nope", "toolArgs": "not json", "workspacePaths": "x", "tool": 3 }));
        fields(&mut m, &no_env);
        assert!(!m.contains_key("tool_name"));
        assert!(!m.contains_key("tool_input"));
        assert!(!m.contains_key("cwd"));
    }

    #[test]
    fn a_stop_with_an_error_status_is_a_failure() {
        assert_eq!(refine("Stop", &obj(json!({ "status": "error" }))), "StopFailure");
        for status in ["completed", "aborted"] {
            assert_eq!(refine("Stop", &obj(json!({ "status": status }))), "Stop");
        }
        assert_eq!(refine("PreToolUse", &obj(json!({ "status": "error" }))), "PreToolUse");
    }
}
