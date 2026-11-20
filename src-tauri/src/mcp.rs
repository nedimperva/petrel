//! `petrel mcp`: an MCP server over stdio for Claude Desktop and Claude Code. Claude starts it when the owner
//! asks something there; it reads and (if allowed) adds to the notes through `petrel_core::outside`, held to
//! the scope set in Settings › Claude. It never calls anything: it only answers. JSON-RPC 2.0, one message a
//! line, as MCP's stdio transport says.

use std::io::{BufRead, Write};

use anyhow::{Context, Result};
use petrel_core::outside::{self, Scope};
use petrel_core::Store;
use serde_json::{json, Value};

const PROTOCOL: &str = "2025-06-18";

const INSTRUCTIONS: &str = "Petrel is the owner's notes app: Markdown notes in collections (top folders), a page \
for each day (journal/), an inbox of captures, and collections of things to copy (Prompts, Snippets) whose \
{{blanks}} are filled in. Search before reading; cite a note by its title in [[double brackets]]. Add only when \
the owner asks you to.";

pub fn serve() -> Result<()> {
    let db = crate::cli::db_path()?;
    {
        // Files written while Petrel was closed are found once at the start.
        let mut store = Store::open(&db).with_context(|| format!("opening {}", db.display()))?;
        store.notes_root_or(&crate::notes::default_root(&db))?;
        let _ = store.scan_notes();
    }
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => answer(&db, &msg),
            Err(e) => Some(
                json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": e.to_string()}}),
            ),
        };
        if let Some(r) = reply {
            writeln!(out, "{r}")?;
            out.flush()?;
        }
    }
    Ok(())
}

/// The reply to one message; none for a notification.
fn answer(db: &std::path::Path, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned()?;
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "petrel", "title": "Petrel notes", "version": env!("CARGO_PKG_VERSION")},
            "instructions": INSTRUCTIONS,
        })),
        "ping" => Ok(json!({})),
        "tools/list" => open(db).map(|(_, scope)| json!({"tools": tools(&scope)})),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            // A tool that fails says so to Claude as its result, so it can tell the owner; it is not a protocol error.
            Ok(match call(db, name, &args) {
                Ok(text) => json!({"content": [{"type": "text", "text": text}]}),
                Err(e) => json!({"content": [{"type": "text", "text": format!("{e:#}")}], "isError": true}),
            })
        }
        _ => Err((-32601, format!("no method {method}"))),
    };
    Some(match result {
        Ok(r) => json!({"jsonrpc": "2.0", "id": id, "result": r}),
        Err((code, m)) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": m}}),
    })
}

/// The store and the scope, read again for each call: a change in Settings counts at once.
fn open(db: &std::path::Path) -> Result<(Store, Scope), (i64, String)> {
    let store = Store::open(db).map_err(|e| (-32603, format!("{e:#}")))?;
    let scope = Scope::for_mcp(&store).map_err(|e| (-32603, format!("{e:#}")))?;
    Ok((store, scope))
}

fn tools(scope: &Scope) -> Vec<Value> {
    let mut list = vec![
        json!({
            "name": "search_notes",
            "title": "Search notes",
            "description": "Find the owner's notes by words. Returns titles, paths, their collection and a line of each.",
            "inputSchema": {"type": "object", "properties": {
                "query": {"type": "string", "description": "Words to look for."},
                "limit": {"type": "integer", "description": "At most this many (default 10)."}
            }, "required": ["query"]},
            "annotations": {"readOnlyHint": true}
        }),
        json!({
            "name": "read_note",
            "title": "Read a note",
            "description": "A note's whole text, by its title or path. 'today', 'yesterday' or a date like 2026-11-19 reads that day's page.",
            "inputSchema": {"type": "object", "properties": {
                "name": {"type": "string", "description": "The title, the path, today, or a date."}
            }, "required": ["name"]},
            "annotations": {"readOnlyHint": true}
        }),
        json!({
            "name": "list_collections",
            "title": "List collections",
            "description": "The collections (top folders) shared with Claude and how many notes each has.",
            "inputSchema": {"type": "object", "properties": {}},
            "annotations": {"readOnlyHint": true}
        }),
        json!({
            "name": "fill_card",
            "title": "Fill a card",
            "description": "A card from a collection (a prompt, a snippet) with its {{blanks}} filled. Returns the text; it does not copy.",
            "inputSchema": {"type": "object", "properties": {
                "name": {"type": "string", "description": "The card's title."},
                "blanks": {"type": "object", "additionalProperties": {"type": "string"}, "description": "Values for the blanks by name."}
            }, "required": ["name"]},
            "annotations": {"readOnlyHint": true}
        }),
    ];
    if scope.write {
        list.push(json!({
            "name": "add_to_notes",
            "title": "Add to notes",
            "description": "Add text where the owner says: 'today' (or a date) puts it on that day's page under the time, \
'inbox' as a capture, a collection's name as a new note titled by its first line, a note's title at its end. Only when the owner asks.",
            "inputSchema": {"type": "object", "properties": {
                "text": {"type": "string", "description": "What to add, as Markdown."},
                "place": {"type": "string", "description": "today, a date, inbox, a collection or a note's title. Default inbox."}
            }, "required": ["text"]},
            "annotations": {"readOnlyHint": false, "destructiveHint": false}
        }));
    }
    list
}

fn call(db: &std::path::Path, name: &str, args: &Value) -> Result<String> {
    let (mut store, scope) = open(db).map_err(|(_, m)| anyhow::anyhow!(m))?;
    let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    match name {
        "search_notes" => {
            let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(10) as usize;
            let hits = outside::find(&store, &scope, &s("query"), limit)?;
            if hits.is_empty() {
                return Ok("Nothing found.".into());
            }
            Ok(hits
                .iter()
                .map(|h| format!("[[{}]] ({}, {})\n{}", h.title, h.collection, h.path, h.line))
                .collect::<Vec<_>>()
                .join("\n\n"))
        }
        "read_note" => {
            let n = outside::read(&store, &scope, &s("name"))?;
            Ok(format!("# {}\n({})\n\n{}", n.title, n.path, n.body))
        }
        "list_collections" => {
            let cs = outside::collections(&store, &scope)?;
            Ok(cs.iter().map(|c| format!("{} ({} notes)", c.name, c.notes)).collect::<Vec<_>>().join("\n"))
        }
        "fill_card" => {
            let blanks: Vec<(String, String)> = args
                .get("blanks")
                .and_then(Value::as_object)
                .map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect())
                .unwrap_or_default();
            Ok(outside::card(&store, &scope, &s("name"), &blanks)?.1)
        }
        "add_to_notes" => {
            let place = s("place");
            outside::add(&mut store, &scope, if place.is_empty() { "inbox" } else { &place }, &s("text"))
        }
        _ => anyhow::bail!("Petrel has no tool called {name}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_and_unknown_methods() {
        let db = std::env::temp_dir().join(format!("petrel-mcp-{}", std::process::id())).join("petrel.db");
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let r = answer(&db, &json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}})).unwrap();
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert!(answer(&db, &json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).is_none());
        assert_eq!(
            answer(&db, &json!({"jsonrpc": "2.0", "id": 2, "method": "nope"})).unwrap()["error"]["code"],
            -32601
        );
        let list = answer(&db, &json!({"jsonrpc": "2.0", "id": 3, "method": "tools/list"})).unwrap();
        let names: Vec<&str> =
            list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        // Adding is off until the owner turns it on.
        assert!(names.contains(&"search_notes") && !names.contains(&"add_to_notes"), "{names:?}");
        let _ = std::fs::remove_dir_all(db.parent().unwrap());
    }
}
