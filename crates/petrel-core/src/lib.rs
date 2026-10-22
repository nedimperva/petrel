//! Petrel's engine: everything that is not a window.
//!
//! `store` owns the SQLite database (drafts, tags, versions, search). `title` derives a draft's title and
//! preview from its text. Templates, actions and scripting arrive in packages 03 and 04.

pub mod gen;
pub mod store;
pub mod title;

pub use store::{Draft, DraftSummary, Folder, ListPage, SearchHit, Store, Version};
