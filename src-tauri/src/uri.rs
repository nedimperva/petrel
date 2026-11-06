//! `petrel://` links (package 07). The OS starts `petrel petrel://…`; a second launch hands the argument to the
//! running Petrel through the single-instance plugin. Links are parsed here and queued; the main window takes
//! them (`take_links`) because it owns the open draft, and changing that draft behind the editor's back would
//! be overwritten by its next save.
//!
//! A link can come from any web page, so links only ever add text or show things. There is no `run` link:
//! running an action from a page would run its shell steps for whoever wrote the page.

use serde::Serialize;
use tauri::Url;

/// More than this in a link is not a note someone meant to send.
const TEXT_LIMIT: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Link {
    /// A new Inbox draft, opened in the window.
    Create {
        text: String,
        tags: Vec<String>,
    },
    Open {
        uuid: String,
    },
    /// `prepend: true` adds to the start.
    Append {
        uuid: String,
        text: String,
        prepend: bool,
    },
    Search {
        query: String,
    },
    /// Shown to the person as "Petrel doesn't know this link", so a typo is not silent.
    Unknown {
        url: String,
        why: String,
    },
}

/// The `petrel://` arguments in a command line, parsed. Other arguments are not links.
pub fn from_args(args: &[String]) -> Vec<Link> {
    args.iter().skip(1).filter(|a| a.starts_with("petrel:")).map(|a| parse(a)).collect()
}

pub fn parse(raw: &str) -> Link {
    let unknown = |why: &str| Link::Unknown { url: raw.chars().take(200).collect(), why: why.to_string() };
    let Ok(url) = Url::parse(raw) else { return unknown("not a link") };
    if url.scheme() != "petrel" {
        return unknown("not a petrel:// link");
    }
    // `petrel://create?…` puts the verb in the host; `petrel:create?…` in the path. Take either.
    let verb = url
        .host_str()
        .filter(|h| !h.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| url.path().trim_matches('/').to_string());
    let q = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    let all = |name: &str| {
        url.query_pairs().filter(|(k, _)| k == name).map(|(_, v)| v.into_owned()).collect::<Vec<_>>()
    };
    let text = || q("text").unwrap_or_default();
    if text().len() > TEXT_LIMIT {
        return unknown("the text is over 1 MB");
    }
    if q("x-success").is_some() || q("x-error").is_some() {
        log::info!("petrel:// link: x-callback parameters are ignored");
    }
    match verb.to_ascii_lowercase().as_str() {
        "create" | "new" => {
            let tags = all("tag")
                .iter()
                .flat_map(|t| t.split(','))
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(str::to_string)
                .collect();
            Link::Create { text: text(), tags }
        }
        "open" => match q("uuid") {
            Some(uuid) if !uuid.is_empty() => Link::Open { uuid },
            _ => unknown("open needs uuid="),
        },
        v @ ("append" | "prepend") => match q("uuid") {
            Some(uuid) if !uuid.is_empty() && !text().is_empty() => {
                Link::Append { uuid, text: text(), prepend: v == "prepend" }
            }
            _ => unknown(&format!("{v} needs uuid= and text=")),
        },
        "search" => Link::Search { query: q("query").or_else(|| q("q")).unwrap_or_default() },
        "run" => unknown("links can't run actions"),
        "" => unknown("the link has no command"),
        other => unknown(&format!("Petrel has no \"{other}\" link")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_with_text_and_tags() {
        assert_eq!(
            parse("petrel://create?text=buy%20milk%0Aand%20eggs&tag=home&tag=errand,shop"),
            Link::Create {
                text: "buy milk\nand eggs".into(),
                tags: vec!["home".into(), "errand".into(), "shop".into()]
            }
        );
        assert_eq!(parse("petrel:create?text=hi"), Link::Create { text: "hi".into(), tags: vec![] });
        assert_eq!(parse("petrel://create"), Link::Create { text: "".into(), tags: vec![] });
    }

    #[test]
    fn open_append_search() {
        assert_eq!(parse("petrel://open?uuid=abc"), Link::Open { uuid: "abc".into() });
        assert_eq!(
            parse("petrel://prepend?uuid=abc&text=top"),
            Link::Append { uuid: "abc".into(), text: "top".into(), prepend: true }
        );
        assert_eq!(
            parse("petrel://search?query=tag:work%20milk"),
            Link::Search { query: "tag:work milk".into() }
        );
    }

    #[test]
    fn refused_and_unknown() {
        for raw in [
            "petrel://run?action=Copy",
            "petrel://open",
            "petrel://append?uuid=x",
            "petrel://frobnicate",
            "http://x",
        ] {
            assert!(matches!(parse(raw), Link::Unknown { .. }), "{raw}");
        }
        let big = format!("petrel://create?text={}", "a".repeat(TEXT_LIMIT + 1));
        assert!(matches!(parse(&big), Link::Unknown { .. }));
    }

    #[test]
    fn only_links_in_args() {
        let args: Vec<String> = ["petrel", "--hidden", "petrel://open?uuid=1"].map(String::from).into();
        assert_eq!(from_args(&args), vec![Link::Open { uuid: "1".into() }]);
    }
}
