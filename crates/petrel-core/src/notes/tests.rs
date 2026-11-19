//! The notes engine's tests.

use super::*;

fn store_in(dir: &Path) -> Store {
    let mut s = Store::open_in_memory().unwrap();
    s.set_notes_root(dir).unwrap();
    s
}

fn tmp() -> PathBuf {
    let d = std::env::temp_dir().join(format!("petrel-notes-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn a_collection_template_round_trips() {
    let dir = tmp();
    let mut s = store_in(&dir);
    s.create_note("Meetings", "First", "x\n", &[]).unwrap();
    s.set_topic_face("Meetings", "teal", "", "").unwrap();
    let t = "# {{today}} meeting\n\n## Who\n\nC:\\path";
    s.set_collection_template("Meetings", t).unwrap();
    assert_eq!(s.collection_template("Meetings/2026").unwrap(), t);
    // The look is kept, and the look keeps the template.
    s.set_topic_face("Meetings", "rose", "", "").unwrap();
    assert_eq!(s.collection_template("Meetings").unwrap(), t);
    assert_eq!(s.topic_faces().unwrap()["Meetings"].color, "rose");
    s.set_collection_template("Meetings", "").unwrap();
    assert_eq!(s.collection_template("Meetings").unwrap(), "");
    assert_eq!(s.collection_template("").unwrap(), "");
}

#[test]
fn bosnian_titles_and_text_are_found() {
    let dir = tmp();
    let mut s = store_in(&dir);
    let a = s.create_note("", "Šta ima novo", "vijesti\n", &[]).unwrap();
    let b = s.create_note("", "Ćevapi", "kod Đorđa u Baščaršiji\n", &[]).unwrap();
    let c = s.create_note("", "Bread recipe", "flour, water, the word cevapi in passing\n", &[]).unwrap();
    assert_eq!(s.find_notes("šta", 5).unwrap()[0].id, a.id);
    assert_eq!(s.find_notes("sta", 5).unwrap()[0].id, a.id);
    assert_eq!(s.find_notes("cevapi", 5).unwrap()[0].id, b.id);
    assert_eq!(s.find_notes("recpie", 5).unwrap()[0].id, c.id);
    let ids = |v: Vec<NoteSummary>| v.into_iter().map(|n| n.id).collect::<Vec<_>>();
    assert_eq!(ids(s.search_notes("djordja", 5).unwrap()), vec![b.id]);
    assert_eq!(ids(s.search_notes("Đorđa", 5).unwrap()), vec![b.id]);
    // The title weighs more than a word in passing.
    assert_eq!(ids(s.search_notes("cevapi", 5).unwrap()), vec![b.id, c.id]);
}

#[test]
fn titles_windows_keeps_for_devices_get_a_mark() {
    assert_eq!(clean_title("Con"), "Con_");
    assert_eq!(clean_title("nul"), "nul_");
    assert_eq!(clean_title("COM3"), "COM3_");
    assert_eq!(clean_title("Console"), "Console");
    assert_eq!(clean_title("COM0"), "COM0");
    assert!(is_conflict_copy("Tern release (conflict 2026-11-11 2114)"));
    assert!(!is_conflict_copy("Tern release (conflict notes)"));
}

#[test]
fn a_title_that_differs_only_in_capitals_gets_a_number() {
    let dir = tmp();
    let mut s = store_in(&dir);
    s.create_note("", "Plan", "a", &[]).unwrap();
    let n = s.create_note("", "plan", "b", &[]).unwrap();
    assert_eq!(n.title, "plan 2");
    assert!(dir.join("plan 2.md").exists());
}

#[test]
fn similar_notes_share_telling_words() {
    let dir = tmp();
    let mut s = store_in(&dir);
    let a = s
        .create_note("", "Sourdough bread", "starter flour water salt starter overnight proof\n", &[])
        .unwrap();
    let b =
        s.create_note("", "Bread log", "fed the starter, more flour and water, salt last\n", &[]).unwrap();
    let _c = s.create_note("", "Trip", "flour shop near the station\n", &[]).unwrap();
    let near: Vec<i64> = s.similar_notes(a.id, 5).unwrap().into_iter().map(|n| n.id).collect();
    assert_eq!(near, vec![b.id]);
    let within = s.notes_about_within("starter", &[_c.id, b.id], 8).unwrap();
    assert_eq!(within.iter().map(|n| n.id).collect::<Vec<_>>(), vec![b.id, _c.id]);
}

#[test]
fn capture_file_and_merge() {
    let dir = tmp();
    let mut s = store_in(&dir);
    let c = s.capture_note("Ask about the release date\n").unwrap();
    assert_eq!(c.folder, INBOX_DIR);
    assert!(dir.join(&c.path).exists());
    let target = s.create_note("work", "Tern release", "Open questions\n", &[]).unwrap();
    // Linked from elsewhere: the link follows a move.
    let other = s.create_note("", "Week", "See [[Plan]]\n", &[]).unwrap();
    let plan = s.create_note(INBOX_DIR, "Plan", "steps\n", &[]).unwrap();
    let moved = s.move_note(plan.id, "ideas", "Plan").unwrap();
    assert_eq!(moved.note.path, "ideas/Plan.md");
    assert!(dir.join("ideas/Plan.md").exists() && !dir.join("inbox/Plan.md").exists());
    assert!(s.peek_note(other.id).unwrap().body.contains("[[Plan]]"));
    s.undo_notes(&moved.token.token).unwrap();
    assert!(dir.join("inbox/Plan.md").exists());

    let merged = s.merge_note(c.id, target.id).unwrap();
    let body = s.peek_note(target.id).unwrap().body;
    assert!(body.starts_with("Open questions") && body.contains("Ask about the release date"), "{body}");
    assert!(!dir.join(&c.path).exists());
    assert!(s.merge_note(target.id, target.id).is_err());
    s.undo_notes(&merged.token.token).unwrap();
    assert!(dir.join(&c.path).exists());
    assert_eq!(s.peek_note(target.id).unwrap().body, "Open questions\n");
}

#[test]
fn history_travels_with_the_folder() {
    // Two computers: one folder, two indexes.
    let dir = tmp();
    let mut a = store_in(&dir);
    let n = a.create_note("Travel", "Rome", "first\n", &[]).unwrap();
    a.snapshot_note(n.id, "ai").unwrap();
    let hist = dir.join("Travel/.history/Rome");
    assert_eq!(std::fs::read_dir(&hist).unwrap().count(), 1);
    let mut b = store_in(&dir);
    b.scan_notes().unwrap();
    let id = b.id_of("Travel/Rome.md").unwrap().unwrap();
    let vs = b.note_versions(id).unwrap();
    assert_eq!(vs.len(), 1);
    assert_eq!(vs[0].reason, "ai");
    assert!(b.note_version_text(vs[0].id).unwrap().starts_with("first"));
    // Read once: a second look does not add it again.
    assert_eq!(b.note_versions(id).unwrap().len(), 1);
    // A rename takes the history along.
    a.rename_note(n.id, "Roma").unwrap();
    assert!(dir.join("Travel/.history/Roma").is_dir() && !hist.exists());
    // The history is not a note.
    assert!(b.scan_notes().is_ok());
    assert!(b.id_of("Travel/.history/Roma").unwrap().is_none());
}

#[test]
fn versions_restore_copies_and_asking() {
    let dir = tmp();
    let mut s = store_in(&dir);
    let n =
        s.create_note("Prompts", "Review", "Review this code for {{lang}} bugs\n", &["ai".into()]).unwrap();
    s.snapshot_note(n.id, "ai").unwrap();
    let saved = s.save_note(n.id, "Shorter\n", &n.hash).unwrap();
    assert!(saved.conflict.is_none());
    let versions = s.note_versions(n.id).unwrap();
    assert_eq!(versions[0].reason, "ai");
    assert!(s.note_version_text(versions[0].id).unwrap().starts_with("Review this code"));
    let back = s.restore_note_version(n.id, versions[0].id).unwrap();
    assert!(back.body.starts_with("Review this code") && back.tags == vec!["ai".to_string()]);
    let other = s.create_note("", "Other", "x\n", &[]).unwrap();
    assert!(s.restore_note_version(other.id, versions[0].id).is_err());

    assert_eq!(s.record_copy(n.id, None).unwrap(), 1);
    assert_eq!(s.record_copy(n.id, Some("Code")).unwrap(), 2);
    assert_eq!(s.copy_counts().unwrap().get("Prompts/Review.md"), Some(&2));
    assert_eq!(s.copy_counts_in("Code").unwrap().get("Prompts/Review.md"), Some(&1));
    assert!(s.copy_counts_in("Firefox").unwrap().is_empty());

    s.create_note("", "Garden", "Tomatoes need sun and water\n", &[]).unwrap();
    let found = s.notes_about("What do my tomatoes need?", 5).unwrap();
    assert_eq!(found[0].title, "Garden");
    assert!(s.notes_about("what is the", 5).unwrap().is_empty());
}

#[test]
fn previews_keep_lines_and_drop_marks() {
    assert_eq!(body_preview("# Plan\n\n- [ ] milk\n- [x] eggs\n- bread\n"), "Plan\n☐ milk\n☑ eggs\n• bread");
    let long = "word ".repeat(100);
    assert!(body_preview(&long).chars().count() <= PREVIEW_CHARS);
    assert_eq!(body_preview("1\n2\n3\n4\n5\n6\n7\n8"), "1\n2\n3\n4\n5\n6");
}

#[test]
fn drafts_are_exported_once() {
    let dir = tmp();
    let mut s = store_in(&dir);
    // The drafts tables as an old Petrel left them: an inbox draft, an archived one, an empty one.
    for (i, (title, content, folder)) in
        [("Shopping", "Shopping\nmilk", 0), ("Book idea", "Book idea\nThe lighthouse", 1), ("", "   ", 0)]
            .into_iter()
            .enumerate()
    {
        s.raw()
            .execute(
                "INSERT INTO drafts (uuid, content, title, folder, created_at, modified_at, accessed_at) \
                 VALUES (?1, ?2, ?3, ?4, 0, 0, 0)",
                params![format!("u{i}"), content, title, folder],
            )
            .unwrap();
    }
    assert_eq!(s.export_drafts_once().unwrap(), 2);
    assert_eq!(s.export_drafts_once().unwrap(), 0);
    assert!(dir.join("drafts/Book idea.md").exists());
    let inbox = s.list_notes(&NoteQuery { folder: Some(INBOX_DIR.into()), ..Default::default() }).unwrap();
    assert_eq!(inbox.len(), 1);
    assert!(s.peek_note(inbox[0].id).unwrap().body.contains("milk"));
}

#[test]
fn front_matter_round_trip() {
    let t = "---\ntitle: kept\ntags: [a, \"b\"]\npinned: true\n---\nBody\n";
    let (raw, body) = split_front(t);
    assert_eq!(body, "Body\n");
    let f = parse_front(raw);
    assert_eq!(f.tags, vec!["a", "b"]);
    assert!(f.pinned);
    assert_eq!(f.other, vec!["title: kept"]);
    assert_eq!(render_front(&f), "---\ntitle: kept\ntags: [a, b]\npinned: true\n---\n");
    let list = parse_front("---\ntags:\n  - x\n  - '#y'\n---\n");
    assert_eq!(list.tags, vec!["x", "y"]);
    assert_eq!(split_front("--- not front\n"), ("", "--- not front\n"));
    assert_eq!(split_front("---\nnever closed\n").0, "");
}

#[test]
fn titles_are_file_names() {
    assert_eq!(clean_title("  a/b: c?  "), "a-b- c-");
    assert_eq!(clean_title("..hidden."), "hidden");
    assert_eq!(clean_folder("../Projects//Petrel/.git"), "Projects/Petrel");
}

#[test]
fn create_scan_save_and_conflict() {
    let dir = tmp();
    let mut s = store_in(&dir);
    let n = s.create_note("Projects/Petrel", "Roadmap", "M1 then M2.\n", &["petrel".into()]).unwrap();
    assert_eq!(n.path, "Projects/Petrel/Roadmap.md");
    let on_disk = std::fs::read_to_string(dir.join("Projects/Petrel/Roadmap.md")).unwrap();
    assert_eq!(on_disk, "---\ntags: [petrel]\n---\nM1 then M2.\n");
    let again = s.create_note("Projects/Petrel", "Roadmap", "", &[]).unwrap();
    assert_eq!(again.title, "Roadmap 2");

    let saved = s.save_note(n.id, "M1, M2, M3.\n", &n.hash).unwrap();
    assert!(saved.conflict.is_none());
    assert_eq!(s.note(n.id).unwrap().body, "M1, M2, M3.\n");
    // Changed in another editor while open in Petrel: both texts are kept.
    std::fs::write(dir.join("Projects/Petrel/Roadmap.md"), "---\ntags: [petrel, x]\n---\nTheirs\n").unwrap();
    let saved = s.save_note(n.id, "Mine\n", &saved.hash).unwrap();
    let copy = saved.conflict.expect("a conflict copy");
    assert!(std::fs::read_to_string(dir.join(&copy)).unwrap().contains("Theirs"));
    let mine = std::fs::read_to_string(dir.join("Projects/Petrel/Roadmap.md")).unwrap();
    assert_eq!(mine, "---\ntags: [petrel, x]\n---\nMine\n", "their front matter, my body");

    std::fs::write(dir.join("Loose.md"), "Dropped in by hand").unwrap();
    std::fs::create_dir_all(dir.join(".hidden")).unwrap();
    std::fs::write(dir.join(".hidden/No.md"), "x").unwrap();
    std::fs::write(dir.join("bin.md"), [0xff, 0xfe, 0x00]).unwrap();
    let r = s.scan_notes().unwrap();
    assert_eq!((r.added, r.skipped), (1, 1));
    assert_eq!(s.find_notes("loose", 5).unwrap()[0].title, "Loose");
    std::fs::remove_file(dir.join("Loose.md")).unwrap();
    assert_eq!(s.scan_notes().unwrap().removed, 1);
    let folders: Vec<String> = s.note_folders().unwrap().into_iter().map(|f| f.path).collect();
    assert_eq!(folders, vec!["Projects", "Projects/Petrel"]);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn rename_rewrites_links_and_undoes() {
    let dir = tmp();
    let mut s = store_in(&dir);
    let target = s.create_note("", "Omarchy", "Binds.\n", &[]).unwrap();
    let other = s.create_note("", "Laptop", "See [[Omarchy#Binds]] and [[Unrelated]].\n", &[]).unwrap();
    let d = s.create_note("", "Wifi", "Same machine as [[omarchy]].\n", &[]).unwrap();
    let c = s.rename_note(target.id, "Omarchy setup").unwrap();
    assert_eq!(c.relinked, 2);
    assert!(dir.join("Omarchy setup.md").exists() && !dir.join("Omarchy.md").exists());
    assert_eq!(s.note(other.id).unwrap().body, "See [[Omarchy setup#Binds]] and [[Unrelated]].\n");
    assert!(s.note(d.id).unwrap().body.ends_with("[[Omarchy setup]].\n"));
    let back = s.backlinks(target.id).unwrap();
    assert_eq!(back.linked.len(), 2);
    s.undo(&c.token.token).unwrap();
    assert!(dir.join("Omarchy.md").exists());
    assert!(s.note(d.id).unwrap().body.ends_with("[[omarchy]].\n"));
    assert_eq!(s.note(other.id).unwrap().body, "See [[Omarchy#Binds]] and [[Unrelated]].\n");
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn resolve_targets_and_mentions() {
    let dir = tmp();
    let mut s = store_in(&dir);
    let n = s.create_note("Home", "Omarchy setup", "x", &[]).unwrap();
    let laptop = s.create_note("", "Laptop", "I should redo the omarchy setup soon.\n", &[]).unwrap();
    assert_eq!(s.resolve_link("Home/Omarchy setup").unwrap(), Resolved::Note { id: n.id });
    assert_eq!(s.resolve_link("Moved/Omarchy setup").unwrap(), Resolved::Note { id: n.id });
    assert!(matches!(s.resolve_link("d:Wifi fix").unwrap(), Resolved::Missing { draft: true, .. }));
    assert!(matches!(s.resolve_link("Nope").unwrap(), Resolved::Missing { draft: false, .. }));
    let t = s.link_targets("omar", 5).unwrap();
    assert_eq!(t[0].kind, "note");
    let b = s.backlinks(n.id).unwrap();
    assert_eq!((b.linked.len(), b.mentioned.len()), (0, 1));
    assert_eq!(b.mentioned[0].id, laptop.id);
    let tok = s.link_mention(n.id, "note", laptop.id).unwrap();
    assert!(s.note(laptop.id).unwrap().body.contains("the [[Omarchy setup|omarchy setup]] soon"));
    assert_eq!(s.backlinks(n.id).unwrap().linked.len(), 1);
    s.undo(&tok.token).unwrap();
    assert_eq!(s.backlinks(n.id).unwrap().linked.len(), 0);
    let tok = s.trash_note(n.id).unwrap();
    assert!(!dir.join("Home/Omarchy setup.md").exists());
    s.undo(&tok.token).unwrap();
    assert!(dir.join("Home/Omarchy setup.md").exists());
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn captures_go_to_a_day_page() {
    let dir = tmp();
    let mut s = store_in(&dir);
    assert!(s.day_note("2026-11-11").unwrap().is_none());
    assert!(s.day_note("2026-13-40").is_err() && s.day_note("../x").is_err());
    let c = s.capture_note("Lunch with Amra\n").unwrap();
    let ch = s.file_into_day(c.id, "2026-11-11").unwrap();
    assert_eq!(ch.note.path, "journal/2026-11-11.md");
    let body = &ch.note.body;
    assert!(
        body.len() > 6 && body.as_bytes()[2] == b':' && body.contains(" Lunch with Amra  \n_from capture_"),
        "{body}"
    );
    let q = s.capture_note("> a quote\n").unwrap();
    let body = s.file_into_day(q.id, "2026-11-11").unwrap().note.body;
    assert!(body.contains("\n> a quote"), "{body}");
    // One undo for the first: the capture comes back and the page it made goes.
    let c2 = s.capture_note("again\n").unwrap();
    let other = s.file_into_day(c2.id, "2026-11-12").unwrap();
    s.undo_notes(&other.token.token).unwrap();
    assert!(dir.join(&c2.path).exists() && !dir.join("journal/2026-11-12.md").exists());
    assert_eq!(day_entry("09:05", "- [ ] milk"), "09:05\n- [ ] milk\n\n_from capture_\n");
    assert_eq!(day_entry("09:05", "milk"), "09:05 milk  \n_from capture_\n");
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn pictures_move_with_their_note() {
    let dir = tmp();
    let mut s = store_in(&dir);
    let link = s.save_attachment(INBOX_DIR, "Screen shot.PNG", b"png bytes").unwrap();
    assert_eq!(link, "attachments/Screen-shot.png");
    assert_eq!(s.attachment(INBOX_DIR, &link).unwrap(), b"png bytes");
    assert!(s.attachment(INBOX_DIR, "attachments/../../secret.png").is_err());
    assert!(s.save_attachment(INBOX_DIR, "x.exe", b"MZ").is_err());
    // The scan never takes a picture for a note.
    assert_eq!(s.scan_notes().unwrap().added, 0);

    let c = s.capture_note(&format!("Shelf ![shelf]({link})\n")).unwrap();
    // A picture of the same name already lives in Home: the moved one is renamed and the link follows.
    std::fs::create_dir_all(dir.join("Home/attachments")).unwrap();
    std::fs::write(dir.join("Home/attachments/Screen-shot.png"), b"other").unwrap();
    let moved = s.move_note(c.id, "Home", "Shelf").unwrap();
    assert!(moved.note.body.contains("](attachments/Screen-shot-2.png)"), "{}", moved.note.body);
    assert_eq!(std::fs::read(dir.join("Home/attachments/Screen-shot-2.png")).unwrap(), b"png bytes");
    assert!(!dir.join("inbox/attachments/Screen-shot.png").exists());
    s.undo_notes(&moved.token.token).unwrap();
    assert!(dir.join("inbox/attachments/Screen-shot.png").exists());
    let back = s.peek_note(s.id_of(&c.path).unwrap().unwrap()).unwrap();
    assert!(back.body.contains("](attachments/Screen-shot.png)"), "{}", back.body);

    // Added to a note in another folder: the picture goes there too.
    let into = s.create_note("work", "Plan", "Steps\n", &[]).unwrap();
    let merged = s.merge_note(back.id, into.id).unwrap();
    assert!(merged.note.body.contains("](attachments/Screen-shot.png)"));
    assert!(dir.join("work/attachments/Screen-shot.png").exists());
    s.undo_notes(&merged.token.token).unwrap();
    assert!(
        dir.join("inbox/attachments/Screen-shot.png").exists()
            && !dir.join("work/attachments/Screen-shot.png").exists()
    );
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn collections_have_a_look() {
    let dir = tmp();
    let mut s = store_in(&dir);
    s.create_note("Travel", "Mostar", "", &[]).unwrap();
    assert!(s.topic_faces().unwrap().is_empty());
    std::fs::write(dir.join("Travel").join(FACE_FILE), "keep: me\ncolor: rose\n").unwrap();
    let f = s.set_topic_face("Travel", "teal", "plane", "").unwrap();
    assert_eq!((f.color.as_str(), f.mark.as_str()), ("teal", "plane"));
    let text = std::fs::read_to_string(dir.join("Travel").join(FACE_FILE)).unwrap();
    assert!(text.contains("keep: me") && !text.contains("rose"), "{text}");
    assert_eq!(s.topic_faces().unwrap()["Travel"], f);
    let f = s.set_topic_face("Travel", "teal", "plane", "yes").unwrap();
    assert_eq!(s.topic_faces().unwrap()["Travel"].copy, "yes");
    assert_eq!(f.copy, "yes");
    assert!(s.set_topic_face("Travel", "teal", "", "maybe").is_err());
    assert!(s.set_topic_face("inbox", "teal", "", "").is_err());
    assert!(s.set_topic_face("Travel/Sub", "teal", "", "").is_err());
    assert!(s.set_topic_face("Travel", "Teal; rm", "", "").is_err());
    assert!(s.set_topic_face("Nowhere", "teal", "", "").is_err());
    // The face file is not a note.
    assert_eq!(s.scan_notes().unwrap().added, 0);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn notes_that_have_things() {
    let dir = tmp();
    let mut s = store_in(&dir);
    let a = s.create_note("", "A", "See [[B]]\n", &[]).unwrap();
    let b = s.create_note("", "B", "- [ ] milk\n- [x] eggs\n", &[]).unwrap();
    let c = s.create_note("", "C", "![](attachments/x.png)\n", &[]).unwrap();
    s.create_note("", "D", "- [x] done\n[[ not closed\n", &[]).unwrap();
    assert_eq!(s.notes_having("link").unwrap(), vec![a.id]);
    assert_eq!(s.notes_having("task").unwrap(), vec![b.id]);
    assert_eq!(s.notes_having("picture").unwrap(), vec![c.id]);
    assert!(s.notes_having("x; DROP TABLE notes").is_err());
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn notes_of_a_week() {
    let dir = tmp();
    let mut s = store_in(&dir);
    let a = s.create_note("", "A", "one", &[]).unwrap();
    let all = s.notes_between(0, i64::MAX).unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].id, a.id);
    assert!(s.notes_between(a.modified_at + 1, i64::MAX).unwrap().is_empty());
    std::fs::remove_dir_all(dir).ok();
}
