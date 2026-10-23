//! Petrel's engine: everything that is not a window.
//!
//! `store` owns the SQLite database (drafts, tags, versions, lists, search). `query` parses the search box.
//! `retention` decides what housekeeping keeps. `title` derives a draft's title and preview from its text.
//! `template` renders `[[tags]]`; `action` runs actions through a `host::Host`; `store_actions` keeps them.
//! Scripting arrives in package 04.

pub mod action;
pub mod gen;
pub mod host;
pub mod query;
pub mod retention;
pub mod store;
pub mod store_actions;
pub mod template;
pub mod title;

pub use retention::Retention;
pub use store::{
    Cursor, Draft, DraftSummary, Folder, ListPage, ListQuery, SearchHit, Sort, SortKey, Store, TagCount,
    UndoToken, Version,
};
