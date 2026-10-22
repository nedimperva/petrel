//! Petrel's engine: everything that is not a window.
//!
//! `store` owns the SQLite database (drafts, tags, versions, lists, search). `query` parses the search box.
//! `retention` decides what housekeeping keeps. `title` derives a draft's title and preview from its text.
//! Templates, actions and scripting arrive in packages 03 and 04.

pub mod gen;
pub mod query;
pub mod retention;
pub mod store;
pub mod title;

pub use retention::Retention;
pub use store::{
    Cursor, Draft, DraftSummary, Folder, ListPage, ListQuery, SearchHit, Sort, SortKey, Store, TagCount,
    UndoToken, Version,
};
