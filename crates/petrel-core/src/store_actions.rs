//! The store's side of actions: the `actions`, `action_groups` and `action_runs` tables (schema v1), the JSON
//! mirror under `<data dir>/actions/`, trust, committing a run's working copy, and the default group.

use std::path::PathBuf;

use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::action::{Action, AfterSuccess, OpenTarget, Source, Step, WorkingDraft};
use crate::host::WriteMode;
use crate::store::Store;
use crate::title;

/// Where an action without a group shows.
pub const DEFAULT_GROUP: &str = "Actions";

/// One row of the action log (`g l`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLogEntry {
    pub id: i64,
    /// The action's name, or empty if it was deleted since.
    pub action: String,
    pub action_uuid: Option<String>,
    pub draft_id: Option<i64>,
    pub draft_title: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub status: String,
    pub step: Option<i64>,
    pub message: String,
    pub source: String,
}

const ACTION_COLUMNS: &str =
    "a.uuid, IFNULL(g.name, ''), a.name, a.description, a.icon, a.color, a.shortcut, \
    a.steps, a.after_success, a.add_tags, a.confirm, a.disabled, a.hidden, a.trusted_hash";

fn action_row(r: &Row) -> rusqlite::Result<(Action, Option<String>)> {
    let steps: String = r.get(7)?;
    let add_tags: String = r.get(9)?;
    let steps: Vec<Step> = serde_json::from_str(&steps).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let a = Action {
        uuid: r.get(0)?,
        group: r.get(1)?,
        name: r.get(2)?,
        description: r.get(3)?,
        icon: r.get(4)?,
        color: r.get(5)?,
        shortcut: r.get(6)?,
        steps,
        after_success: AfterSuccess::parse(&r.get::<_, String>(8)?),
        add_tags: add_tags.split(',').map(str::trim).filter(|t| !t.is_empty()).map(String::from).collect(),
        confirm: r.get(10)?,
        disabled: r.get(11)?,
        hidden: r.get(12)?,
        trusted: false,
    };
    Ok((a, r.get(13)?))
}

fn with_trust((mut a, hash): (Action, Option<String>)) -> Action {
    a.trusted = hash.is_some_and(|h| h == a.steps_hash());
    a
}

/// A name usable as a file or folder name on both systems.
fn file_name(name: &str) -> String {
    let s = crate::template::safe_title(name);
    let s = s.trim_matches('.').to_string();
    if s.is_empty() {
        "untitled".into()
    } else {
        s
    }
}

impl Store {
    /// The store's clock (milliseconds), for the action engine.
    pub fn clock_now(&self) -> i64 {
        self.now()
    }

    /// Every live action, by group then position.
    pub fn actions(&self) -> Result<Vec<Action>> {
        let mut stmt = self.conn.prepare_cached(&format!(
            "SELECT {ACTION_COLUMNS} FROM actions a LEFT JOIN action_groups g ON g.id = a.group_id \
             WHERE a.deleted_at IS NULL ORDER BY IFNULL(g.position, 1e9), a.position, a.id"
        ))?;
        let rows = stmt.query_map([], action_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().map(with_trust).collect())
    }

    /// An action by uuid, or by name (case-insensitive; the first in list order if two share a name).
    pub fn action(&self, key: &str) -> Result<Option<Action>> {
        let row = self
            .conn
            .prepare_cached(&format!(
                "SELECT {ACTION_COLUMNS} FROM actions a LEFT JOIN action_groups g ON g.id = a.group_id \
                 WHERE a.deleted_at IS NULL AND (a.uuid = ?1 OR a.name = ?1 COLLATE NOCASE) \
                 ORDER BY a.uuid = ?1 DESC, IFNULL(g.position, 1e9), a.position, a.id LIMIT 1"
            ))?
            .query_row(params![key.trim()], action_row)
            .optional()?;
        Ok(row.map(with_trust))
    }

    /// Inserts or updates an action (by uuid; a new uuid if empty) and mirrors it to disk. Saved from the editor
    /// (`from_editor`) it is trusted: the user just wrote it. Any other save keeps trust only if the steps are
    /// unchanged.
    pub fn save_action(&mut self, action: &Action, from_editor: bool) -> Result<Action> {
        if action.name.trim().is_empty() {
            bail!("an action needs a name");
        }
        let mut a = action.clone();
        if a.uuid.is_empty() {
            a.uuid = uuid::Uuid::new_v4().to_string();
        }
        if a.group.trim().is_empty() {
            a.group = DEFAULT_GROUP.into();
        }
        let old = self.action(&a.uuid)?.filter(|o| o.uuid == a.uuid);
        let hash = a.steps_hash();
        let trusted_hash = if from_editor || old.as_ref().is_some_and(|o| o.trusted && o.steps == a.steps) {
            Some(hash)
        } else {
            None
        };
        let now = self.now();
        let steps = serde_json::to_string(&a.steps)?;
        let tx = self.conn.transaction()?;
        let group_id: i64 = match tx
            .query_row(
                "SELECT id FROM action_groups WHERE name = ?1 COLLATE NOCASE AND deleted_at IS NULL",
                params![a.group],
                |r| r.get(0),
            )
            .optional()?
        {
            Some(id) => id,
            None => {
                tx.execute(
                    "INSERT INTO action_groups (uuid, name, position) \
                     SELECT ?1, ?2, IFNULL(MAX(position), -1) + 1 FROM action_groups",
                    params![uuid::Uuid::new_v4().to_string(), a.group],
                )?;
                tx.last_insert_rowid()
            }
        };
        let fields = params![
            a.uuid,
            group_id,
            a.name.trim(),
            a.description,
            a.icon,
            a.color,
            a.shortcut,
            steps,
            a.after_success.as_str(),
            a.add_tags.join(","),
            a.confirm,
            a.disabled,
            a.hidden,
            trusted_hash,
            now
        ];
        if old.is_some() {
            tx.execute(
                "UPDATE actions SET group_id = ?2, name = ?3, description = ?4, icon = ?5, color = ?6, \
                 shortcut = ?7, steps = ?8, after_success = ?9, add_tags = ?10, confirm = ?11, disabled = ?12, \
                 hidden = ?13, trusted_hash = ?14, modified_at = ?15 WHERE uuid = ?1",
                fields,
            )?;
        } else {
            tx.execute(
                "INSERT INTO actions (uuid, group_id, name, description, icon, color, shortcut, steps, \
                 after_success, add_tags, confirm, disabled, hidden, trusted_hash, modified_at, position) \
                 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, \
                   IFNULL(MAX(position), -1) + 1 FROM actions WHERE group_id = ?2",
                fields,
            )?;
        }
        tx.commit()?;
        let saved = self.action(&a.uuid)?.ok_or_else(|| anyhow::anyhow!("the action vanished"))?;
        if let Some(old) = &old {
            if self.mirror_path(old) != self.mirror_path(&saved) {
                self.unmirror(old);
            }
        }
        self.mirror(&saved)?;
        Ok(saved)
    }

    /// Tombstones an action and removes its mirror file.
    pub fn delete_action(&mut self, uuid: &str) -> Result<bool> {
        let Some(old) = self.action(uuid)?.filter(|a| a.uuid == uuid) else { return Ok(false) };
        let now = self.now();
        self.conn.execute(
            "UPDATE actions SET deleted_at = ?2, modified_at = ?2 WHERE uuid = ?1 AND deleted_at IS NULL",
            params![uuid, now],
        )?;
        self.unmirror(&old);
        Ok(true)
    }

    /// Records that the user saw and accepted these steps (`hash` is `Action::steps_hash` of what they saw).
    pub fn trust_action(&self, uuid: &str, hash: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE actions SET trusted_hash = ?2 WHERE uuid = ?1 AND deleted_at IS NULL",
            params![uuid, hash],
        )?;
        Ok(())
    }

    fn mirror_path(&self, a: &Action) -> Option<PathBuf> {
        let dir = self.path()?.parent()?.join("actions");
        Some(dir.join(file_name(&a.group)).join(format!("{}.json", file_name(&a.name))))
    }

    /// `<data dir>/actions/<group>/<name>.json`, so actions can be read and diffed. Reading them back is package 06.
    fn mirror(&self, a: &Action) -> Result<()> {
        let Some(path) = self.mirror_path(a) else { return Ok(()) };
        let mut action = serde_json::to_value(a)?;
        if let Some(o) = action.as_object_mut() {
            o.remove("trusted");
        }
        let doc = serde_json::json!({ "format": "petrel-action", "version": 1, "action": action });
        let text = serde_json::to_string_pretty(&doc)? + "\n";
        crate::host::system::write_file(&path, &text, WriteMode::Overwrite, true)
    }

    fn unmirror(&self, a: &Action) {
        if let Some(path) = self.mirror_path(a) {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Writes what a run changed in one transaction: only the fields that differ from `before`, so a run that
    /// only copied text leaves the draft (and its `modified_at`) alone.
    pub fn commit_draft(&mut self, before: &WorkingDraft, after: &WorkingDraft) -> Result<bool> {
        let now = self.now();
        let tx = self.conn.transaction()?;
        let mut changed = false;
        if after.content != before.content {
            tx.execute(
                "UPDATE drafts SET content = ?2, title = ?3, preview = ?4 WHERE id = ?1 AND deleted_at IS NULL",
                params![after.id, after.content, title::title(&after.content), title::preview(&after.content)],
            )?;
            changed = true;
        }
        if after.head != before.head || after.content != before.content {
            tx.execute("UPDATE drafts SET cursor = ?2 WHERE id = ?1", params![after.id, after.head as i64])?;
        }
        if after.flagged != before.flagged {
            tx.execute("UPDATE drafts SET flagged = ?2 WHERE id = ?1", params![after.id, after.flagged])?;
            changed = true;
        }
        if after.folder != before.folder {
            tx.execute(
                "UPDATE drafts SET folder = ?2 WHERE id = ?1",
                params![after.id, after.folder as i64],
            )?;
            changed = true;
        }
        if after.tags != before.tags {
            tx.execute("DELETE FROM draft_tags WHERE draft_id = ?1", params![after.id])?;
            for name in &after.tags {
                tx.execute(
                    "INSERT INTO tags (uuid, name) VALUES (?1, ?2) ON CONFLICT(name) DO NOTHING",
                    params![uuid::Uuid::new_v4().to_string(), name],
                )?;
                tx.execute(
                    "INSERT OR IGNORE INTO draft_tags (draft_id, tag_id) SELECT ?1, id FROM tags WHERE name = ?2",
                    params![after.id, name],
                )?;
            }
            changed = true;
        }
        if changed {
            tx.execute("UPDATE drafts SET modified_at = ?2 WHERE id = ?1", params![after.id, now])?;
        }
        tx.commit()?;
        Ok(changed)
    }

    /// The draft an `openDraft` step or `petrel://open` link names; created (titled) if asked and missing.
    pub fn resolve_open(&self, t: &OpenTarget) -> Result<Option<i64>> {
        if let Some(uuid) = &t.uuid {
            if let Some(id) = self.find_by_uuid(uuid)? {
                return Ok(Some(id));
            }
        }
        if let Some(title) = &t.title {
            let id = self
                .conn
                .query_row(
                    "SELECT id FROM drafts WHERE title = ?1 COLLATE NOCASE AND deleted_at IS NULL \
                     ORDER BY folder = 2, modified_at DESC LIMIT 1",
                    params![title.trim()],
                    |r| r.get(0),
                )
                .optional()?;
            if id.is_some() {
                return Ok(id);
            }
        }
        if t.new_if_missing {
            let text = t.title.as_deref().map(|s| format!("{s}\n")).unwrap_or_default();
            return Ok(Some(self.new_draft(&text)?.id));
        }
        Ok(None)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn log_run(
        &self,
        action_uuid: &str,
        draft_id: i64,
        started_at: i64,
        status: &str,
        step: Option<i64>,
        message: &str,
        source: Source,
    ) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO action_runs (action_id, draft_id, started_at, ended_at, status, step, message, source) \
             VALUES ((SELECT id FROM actions WHERE uuid = ?1), (SELECT id FROM drafts WHERE id = ?2), \
                     ?3, ?4, ?5, ?6, ?7, ?8)",
            params![action_uuid, draft_id, started_at, self.now(), status, step, message, source.as_str()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// The newest runs first.
    pub fn action_log(&self, limit: usize) -> Result<Vec<RunLogEntry>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT r.id, IFNULL(a.name, ''), a.uuid, r.draft_id, d.title, r.started_at, r.ended_at, r.status, \
                    r.step, r.message, r.source \
             FROM action_runs r LEFT JOIN actions a ON a.id = r.action_id LEFT JOIN drafts d ON d.id = r.draft_id \
             ORDER BY r.started_at DESC, r.id DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit as i64], |r| {
                Ok(RunLogEntry {
                    id: r.get(0)?,
                    action: r.get(1)?,
                    action_uuid: r.get(2)?,
                    draft_id: r.get(3)?,
                    draft_title: r.get(4)?,
                    started_at: r.get(5)?,
                    ended_at: r.get(6)?,
                    status: r.get(7)?,
                    step: r.get(8)?,
                    message: r.get(9)?,
                    source: r.get(10)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Adds the default group on the first start (actions.md, package 03): once, so deleting them sticks.
    /// Returns how many were added.
    pub fn seed_default_actions(&mut self) -> Result<usize> {
        let seeded: Option<String> = self
            .conn
            .query_row("SELECT value FROM meta WHERE key = 'actions_seeded'", [], |r| r.get(0))
            .optional()?;
        if seeded.is_some() {
            return Ok(0);
        }
        let defaults = default_actions();
        for a in &defaults {
            self.save_action(a, true)?;
        }
        self.conn.execute(
            "INSERT INTO meta (key, value) VALUES ('actions_seeded', ?1)",
            params![self.now().to_string()],
        )?;
        Ok(defaults.len())
    }
}

/// The default group. Shipped actions are trusted: they are saved as if from the editor.
pub fn default_actions() -> Vec<Action> {
    let step =
        |json: serde_json::Value| -> Step { serde_json::from_value(json).expect("a default step parses") };
    let action = |name: &str, icon: &str, color: &str, steps: Vec<Step>| Action {
        name: name.into(),
        group: "Basics".into(),
        icon: icon.into(),
        color: color.into(),
        steps,
        ..Action::default()
    };
    let (clip_name, clip_cmd) =
        if cfg!(windows) { ("Copy with clip", "clip") } else { ("Copy with wl-copy", "wl-copy") };
    vec![
        Action {
            shortcut: Some("c".into()),
            ..action("Copy", "copy", "blue", vec![step(serde_json::json!({ "type": "clipboard" }))])
        },
        action(
            "Copy as Markdown link",
            "link",
            "blue",
            vec![step(serde_json::json!({ "type": "clipboard", "text": "[[[title]]]([[draft_open_url]])" }))],
        ),
        action(
            "Save to file",
            "save",
            "green",
            vec![step(serde_json::json!({
                "type": "file", "path": "~/Documents/Petrel/[[safe_title]].md", "mode": "overwrite"
            }))],
        ),
        action(
            "Open as URL",
            "globe",
            "teal",
            vec![step(serde_json::json!({ "type": "url", "url": "[[line|1]]", "encode": false }))],
        ),
        action(
            "Search the web",
            "search",
            "teal",
            vec![step(
                serde_json::json!({ "type": "url", "url": "https://duckduckgo.com/?q=[[selection]]" }),
            )],
        ),
        action(
            "Send as mail",
            "mail",
            "orange",
            vec![step(
                serde_json::json!({ "type": "mail", "subject": "[[title]]", "body": "[[trimmed_body]]" }),
            )],
        ),
        action(
            "Append to journal",
            "book",
            "purple",
            vec![step(serde_json::json!({
                "type": "file", "path": "journal/[[date]].md", "mode": "append",
                "text": "\n## [[time]]\n\n[[draft]]\n"
            }))],
        ),
        action(
            clip_name,
            "terminal",
            "grey",
            vec![step(serde_json::json!({ "type": "runCommand", "command": clip_cmd }))],
        ),
    ]
}
