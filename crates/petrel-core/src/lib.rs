//! Petrel's engine: everything that is not a window.
//!
//! `notes` keeps every note, capture and collection item as a Markdown file in one folder, indexed in SQLite;
//! `store` owns that database (its schema steps are in `schema`), settings and undo. `links` reads `[[links]]`,
//! `attachments` names the pictures pasted into notes, `sync` and `merge` keep the folder in step with Google
//! Drive, `outside` is what the `petrel` command and the MCP server may do, `retention` decides which versions
//! housekeeping keeps, and `title` derives a title and preview from text.

pub mod attachments;
pub mod links;
pub mod merge;
pub mod notes;
pub mod outside;
pub mod retention;
mod schema;
pub mod store;
pub mod sync;
pub mod title;

pub use retention::Retention;
pub use store::{Store, UndoToken};
