//! Review finding G (filtered search), as it was found. E and F were about actions, which are gone.

use petrel_core::Store;

fn store() -> (Store, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("petrel-findings-{}", uuid::Uuid::new_v4()));
    (Store::open(&dir.join("petrel.db")).unwrap(), dir)
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
