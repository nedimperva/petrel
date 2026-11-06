//! Review findings E (file paths), F (command timeouts) and G (filtered search), each as it was found.

use petrel_core::action::{self, *};
use petrel_core::host::{Call, CancelToken, PromptReply, RecordingHost, ScopeItem};
use petrel_core::Store;
use serde_json::json;

fn store() -> (Store, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("petrel-findings-{}", uuid::Uuid::new_v4()));
    (Store::open(&dir.join("petrel.db")).unwrap(), dir)
}

fn act(name: &str, v: serde_json::Value) -> Action {
    Action { name: name.into(), steps: serde_json::from_value(v).unwrap(), ..Action::default() }
}

fn writes(h: &RecordingHost) -> Vec<String> {
    h.calls
        .iter()
        .filter_map(|c| match c {
            Call::WriteFile(p, _) => Some(p.to_string_lossy().replace('\\', "/")),
            _ => None,
        })
        .collect()
}

fn scope_items(h: &RecordingHost) -> Vec<ScopeItem> {
    h.calls
        .iter()
        .filter_map(|c| match c {
            Call::ConfirmScope(_, items) => Some(items.clone()),
            _ => None,
        })
        .flatten()
        .collect()
}

#[test]
fn e_a_relative_path_cannot_climb_out_of_files_unseen() {
    let (mut s, dir) = store();
    let id = s.new_draft("x").unwrap().id;
    s.save_action(&act("Climb", json!([{ "type": "file", "path": "../../outside.txt" }])), false).unwrap();
    s.save_action(&act("Db", json!([{ "type": "file", "path": "../petrel.db" }])), false).unwrap();
    s.save_action(&act("Inside", json!([{ "type": "file", "path": "a/../b.txt" }])), false).unwrap();

    let mut h = RecordingHost::default();
    h.confirms.push_back(false);
    let r = action::run(&mut s, "Climb", id, None, Source::Ui, &mut h, &CancelToken::default()).unwrap();
    assert_eq!(r.outcome, RunOutcome::Cancelled);
    let outside = dir.parent().unwrap().join("outside.txt");
    assert_eq!(
        scope_items(&h),
        vec![ScopeItem::Path(outside.display().to_string())],
        "the real place, no `..`"
    );
    assert!(writes(&h).is_empty(), "declined: nothing written");

    let mut h = RecordingHost::default();
    h.confirms.push_back(false);
    action::run(&mut s, "Db", id, None, Source::Ui, &mut h, &CancelToken::default()).unwrap();
    assert_eq!(scope_items(&h).len(), 1, "the database beside files/ is out of scope");
    assert!(writes(&h).is_empty());

    let mut h = RecordingHost::default();
    let r = action::run(&mut s, "Inside", id, None, Source::Ui, &mut h, &CancelToken::default()).unwrap();
    assert_eq!(r.outcome, RunOutcome::Ok);
    assert!(scope_items(&h).is_empty(), "still inside files/: no prompt");
    assert!(writes(&h)[0].ends_with("/files/b.txt"), "{:?}", writes(&h));
    drop(s);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn e_a_path_from_a_prompt_is_checked_at_the_call() {
    let (mut s, dir) = store();
    let id = s.new_draft("x").unwrap().id;
    let steps = json!([
        { "type": "prompt", "title": "Where?", "buttons": ["OK"], "fields": [{ "key": "Path", "label": "Path" }] },
        { "type": "file", "path": "[[prompt_path]]" }
    ]);
    s.save_action(&act("P", steps), false).unwrap();
    let answer = |path: &str| {
        Some(PromptReply { button: "OK".into(), values: [("Path".to_string(), path.to_string())].into() })
    };
    let outside = std::env::temp_dir().join("petrel-outside.txt");
    let outside = outside.to_string_lossy().replace('\\', "/");

    let mut h = RecordingHost::default();
    h.prompts.push_back(answer(&outside));
    h.confirms.push_back(false);
    let r = action::run(&mut s, "P", id, None, Source::Ui, &mut h, &CancelToken::default()).unwrap();
    assert_eq!(r.outcome, RunOutcome::Cancelled);
    assert_eq!(scope_items(&h).len(), 1, "{:?}", h.calls);
    assert!(writes(&h).is_empty(), "declined at the call: nothing written");
    assert!(!s.action("P").unwrap().unwrap().trusted);

    let mut h = RecordingHost::default();
    h.prompts.push_back(answer(&outside));
    let r = action::run(&mut s, "P", id, None, Source::Ui, &mut h, &CancelToken::default()).unwrap();
    assert_eq!(r.outcome, RunOutcome::Ok);
    assert_eq!(writes(&h).len(), 1);
    assert!(s.action("P").unwrap().unwrap().trusted, "allowed once, trusted after, as the upfront dialog");
    drop(s);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn e_a_command_that_changes_after_the_dialog_asks_again() {
    let (mut s, dir) = store();
    let id = s.new_draft("x").unwrap().id;
    let steps = json!([
        { "type": "runCommand", "command": "echo [[prompt_word]]" },
        { "type": "prompt", "title": "Word?", "buttons": ["OK"], "fields": [{ "key": "Word", "label": "Word" }] },
        { "type": "runCommand", "command": "echo [[prompt_word]]" }
    ]);
    s.save_action(&act("Echo", steps), false).unwrap();
    let mut h = RecordingHost::default();
    h.prompts.push_back(Some(PromptReply {
        button: "OK".into(),
        values: [("Word".to_string(), "; rm -rf ~".to_string())].into(),
    }));
    h.confirms.push_back(true);
    h.confirms.push_back(false);
    let r = action::run(&mut s, "Echo", id, None, Source::Ui, &mut h, &CancelToken::default()).unwrap();
    assert_eq!(r.outcome, RunOutcome::Cancelled);
    let asked = scope_items(&h);
    assert_eq!(asked.len(), 2, "{asked:?}");
    assert_eq!(asked[1], ScopeItem::Command("echo ; rm -rf ~".into()));
    let ran = h.calls.iter().filter(|c| matches!(c, Call::RunCommand(_))).count();
    assert_eq!(ran, 1, "only the command the person saw ran");
    drop(s);
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(unix)]
#[test]
fn f_a_background_child_does_not_outlive_the_timeout() {
    use petrel_core::host::{system, Command, Shell};
    use std::time::{Duration, Instant};
    let cmd = Command {
        command: "sleep 3 &".into(),
        stdin: String::new(),
        shell: Shell::Sh,
        timeout: Duration::from_millis(200),
        cwd: None,
    };
    let t = Instant::now();
    let r = system::run_command(&cmd, &CancelToken::default());
    assert!(r.is_err(), "the limit is reported");
    assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
}

#[test]
fn g_a_narrow_filter_keeps_matches_beyond_the_text_cap() {
    let (mut s, dir) = store();
    let old = s.new_draft("common term here").unwrap().id;
    s.set_tags(old, &["unique".into()]).unwrap();
    let flagged = s.new_draft("common term, flagged").unwrap().id;
    s.flag_drafts(&[flagged], true).unwrap();
    let archived = s.new_draft("common term, archived").unwrap().id;
    s.move_drafts(&[archived], petrel_core::Folder::Archive).unwrap();
    for i in 0..petrel_core::store::CANDIDATES_MAX + 1 {
        s.new_draft(&format!("common term {i}")).unwrap();
    }
    assert_eq!(s.search("tag:unique", 50).unwrap().len(), 1);
    let hits = s.search("tag:unique common", 50).unwrap();
    assert_eq!(hits.iter().map(|h| h.id).collect::<Vec<_>>(), vec![old]);
    assert!(s.search("tag:unique missing", 50).unwrap().is_empty());
    let hits = s.search("is:flagged common", 50).unwrap();
    assert_eq!(hits.iter().map(|h| h.id).collect::<Vec<_>>(), vec![flagged]);
    let hits = s.search("in:archive common", 50).unwrap();
    assert_eq!(hits.iter().map(|h| h.id).collect::<Vec<_>>(), vec![archived]);
    drop(s);
    let _ = std::fs::remove_dir_all(dir);
}
