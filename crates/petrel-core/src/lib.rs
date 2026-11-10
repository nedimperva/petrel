//! Petrel's engine: everything that is not a window.
//!
//! `store` owns the SQLite database (drafts, tags, versions, lists, search). `query` parses the search box.
//! `retention` decides what housekeeping keeps. `title` derives a draft's title and preview from its text.
//! `notes` keeps every note, capture and collection item as a Markdown file in one folder, indexed here; `links`
//! reads `[[links]]`. Drafts are the old capture store: kept so their text can be exported to files once.

pub mod gen;
pub mod links;
pub mod notes;
pub mod query;
pub mod retention;
pub mod store;
pub mod title;

pub use retention::Retention;
pub use store::{
    Cursor, Draft, DraftSummary, Folder, ListPage, ListQuery, SearchHit, Sort, SortKey, Store, TagCount,
    UndoToken, Version,
};
