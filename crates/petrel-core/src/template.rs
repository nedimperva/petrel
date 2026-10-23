//! The `[[tag]]` template engine (docs/design/actions.md, "Template engine"). Every string field of an action
//! step is a template. Tags are case-insensitive, take `|`-separated arguments, and an unknown tag is left as
//! written and reported, so a typo shows up in the output instead of silently dropping text.
//!
//! Three spellings choose the encoding of a value: `[[x]]` follows the field's default (percent-encoded in a URL
//! field, raw elsewhere), `{{x}}` is always percent-encoded, `%%x%%` is never encoded. `\[[` is a literal `[[`.

use chrono::format::{Item, StrftimeItems};
use chrono::{DateTime, Datelike, Days, Duration, Local, Months, TimeZone, Weekday};

/// How `[[x]]` values are encoded in this field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    Raw,
    Url,
}

/// The result of rendering: the text and every tag that was not understood, as written.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Rendered {
    pub text: String,
    pub unknown: Vec<String>,
}

/// Where tag values come from. `TagSource` implements the spec's table over a draft; tests and the action
/// editor's dry run can supply their own.
pub trait Tags {
    /// The value of `name` (lower-cased) with its arguments, or `None` if the tag is unknown or its arguments are
    /// not understood.
    fn value(&mut self, name: &str, args: &[&str]) -> Option<String>;
    /// The text of `<data dir>/templates/<name>`, for `[[template|name]]`.
    fn template_text(&mut self, _name: &str) -> Option<String> {
        None
    }
}

/// `[[template|…]]` includes nest at most this deep; deeper is an unknown tag (and so visible).
pub const INCLUDE_DEPTH: usize = 5;

pub fn render(input: &str, tags: &mut dyn Tags, encoding: Encoding) -> Rendered {
    let mut out = Rendered::default();
    render_into(input, tags, encoding, 0, &mut out);
    out
}

fn render_into(input: &str, tags: &mut dyn Tags, encoding: Encoding, depth: usize, out: &mut Rendered) {
    let mut rest = input;
    while !rest.is_empty() {
        // The next opener of any kind.
        let next = ["\\[[", "[[", "{{", "%%"]
            .iter()
            .filter_map(|o| rest.find(o).map(|i| (i, *o)))
            .min_by_key(|(i, o)| (*i, std::cmp::Reverse(o.len())));
        let Some((at, opener)) = next else {
            out.text.push_str(rest);
            break;
        };
        out.text.push_str(&rest[..at]);
        rest = &rest[at..];
        // `[[[title]]](url)` is a Markdown link around a tag: the first `[` is text.
        if opener == "[[" && rest.starts_with("[[[") {
            out.text.push('[');
            rest = &rest[1..];
            continue;
        }
        if opener == "\\[[" {
            out.text.push_str("[[");
            rest = &rest[3..];
            continue;
        }
        let closer = match opener {
            "[[" => "]]",
            "{{" => "}}",
            _ => "%%",
        };
        let body_start = 2;
        let Some(len) = rest[body_start..].find(closer) else {
            // An opener with no closer is text.
            out.text.push_str(opener);
            rest = &rest[2..];
            continue;
        };
        let whole = &rest[..body_start + len + 2];
        let body = &rest[body_start..body_start + len];
        let mut parts = body.split('|');
        let name = parts.next().unwrap_or("").trim().to_lowercase();
        let args: Vec<&str> = parts.collect();
        if !is_tag_name(&name) {
            if opener == "[[" {
                out.text.push_str(whole);
                out.unknown.push(whole.to_string());
                rest = &rest[whole.len()..];
            } else {
                // `{{` and `%%` only make tags of tag names, so "100%% sure, 50%% maybe" stays text.
                out.text.push_str(&rest[..1]);
                rest = &rest[1..];
            }
            continue;
        }
        rest = &rest[whole.len()..];
        let value = if name == "template" {
            match args.first() {
                Some(t) if depth < INCLUDE_DEPTH => tags.template_text(t.trim()).map(|text| {
                    let mut inner = Rendered::default();
                    render_into(&text, tags, encoding, depth + 1, &mut inner);
                    out.unknown.extend(inner.unknown);
                    inner.text
                }),
                _ => None,
            }
        } else {
            tags.value(&name, &args)
        };
        match value {
            Some(v) => {
                let encode = match opener {
                    "{{" => true,
                    "%%" => false,
                    _ => encoding == Encoding::Url,
                };
                if encode {
                    out.text.push_str(&percent_encode(&v));
                } else {
                    out.text.push_str(&v);
                }
            }
            None => {
                out.text.push_str(whole);
                out.unknown.push(whole.to_string());
            }
        }
    }
}

fn is_tag_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '.')
}

/// Percent-encodes everything but the RFC 3986 unreserved characters.
pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

// ---- the spec's tags over a draft ---------------------------------------------------------------------------

/// Everything the spec's tag table reads. Built by the action engine per step; the clipboard and the templates
/// folder are asked for only when a tag needs them.
pub struct TagSource<'a> {
    pub content: &'a str,
    pub uuid: &'a str,
    /// Sorted.
    pub tags: &'a [String],
    pub created: DateTime<Local>,
    pub modified: DateTime<Local>,
    /// The selected text, if an editor reported a non-empty selection.
    pub selection: Option<&'a str>,
    /// The 0-based line the cursor is on.
    pub cursor_line: usize,
    pub now: DateTime<Local>,
    /// Template tags set earlier in the run (`prompt_*`, command output, scripts).
    pub custom: &'a std::collections::HashMap<String, String>,
    pub clipboard: &'a mut dyn FnMut() -> Option<String>,
    pub template: &'a mut dyn FnMut(&str) -> Option<String>,
    pub env: &'a dyn Fn(&str) -> Option<String>,
}

impl Tags for TagSource<'_> {
    fn value(&mut self, name: &str, args: &[&str]) -> Option<String> {
        if let Some(v) = self.custom.get(name) {
            return Some(v.clone());
        }
        let arg = |i: usize| args.get(i).map(|s| s.trim());
        Some(match name {
            "draft" => self.content.to_string(),
            "title" => crate::title::title(self.content),
            "safe_title" => safe_title(&crate::title::title(self.content)),
            "body" => body(self.content).to_string(),
            "trimmed_body" => trim_blank_lines(body(self.content)).to_string(),
            "selection" => self.selection.unwrap_or(self.content).to_string(),
            "selection_only" => self.selection.unwrap_or("").to_string(),
            "line" => match arg(0) {
                None => self.content.split('\n').nth(self.cursor_line).unwrap_or("").to_string(),
                Some(range) => lines(self.content, range)?,
            },
            "clipboard" => (self.clipboard)()?,
            "uuid" => self.uuid.to_string(),
            "tags" => self.tags.join(", "),
            "created" => format_time(&self.created, arg(0).unwrap_or("%Y-%m-%dT%H:%M:%S%:z"))?,
            "modified" => format_time(&self.modified, arg(0).unwrap_or("%Y-%m-%dT%H:%M:%S%:z"))?,
            "date" => match (arg(0), arg(1)) {
                (None, _) => format_time(&self.now, "%Y-%m-%d")?,
                (Some(a), fmt) => match relative(&self.now, a) {
                    Some(t) => format_time(&t, fmt.unwrap_or("%Y-%m-%d"))?,
                    // A first argument that starts like an offset and does not parse is a typo, not a format.
                    None if fmt.is_none() && !a.starts_with(['+', '-']) => format_time(&self.now, a)?,
                    None => return None,
                },
            },
            "time" => format_time(&self.now, "%H:%M")?,
            "longdate" => format_time(&self.now, "%A, %B %-d, %Y")?,
            "shortdate" => format_time(&self.now, "%d/%m/%Y")?,
            "draft_open_url" => format!("petrel://open?uuid={}", self.uuid),
            "env" => (self.env)(arg(0)?)?,
            _ => return None,
        })
    }

    fn template_text(&mut self, name: &str) -> Option<String> {
        (self.template)(name)
    }
}

/// `title` made safe as a file name on Linux and Windows: `/\:*?"<>|` and control characters become `-`.
pub fn safe_title(title: &str) -> String {
    let s: String = title
        .chars()
        .map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '-' } else { c })
        .take(120)
        .collect();
    s.trim().to_string()
}

fn body(content: &str) -> &str {
    content.split_once('\n').map_or("", |(_, rest)| rest)
}

fn trim_blank_lines(s: &str) -> &str {
    let lines: Vec<&str> = s.split('\n').collect();
    let first = lines.iter().position(|l| !l.trim().is_empty());
    let last = lines.iter().rposition(|l| !l.trim().is_empty());
    match (first, last) {
        (Some(a), Some(b)) => {
            let start: usize = lines[..a].iter().map(|l| l.len() + 1).sum();
            let end: usize = lines[..=b].iter().map(|l| l.len() + 1).sum::<usize>() - 1;
            &s[start..end]
        }
        _ => "",
    }
}

/// `n` or `n..m`, 1-based and inclusive; a range past the end is cut at the end.
fn lines(content: &str, range: &str) -> Option<String> {
    let (a, b) = match range.split_once("..") {
        Some((a, b)) => (a.trim().parse::<usize>().ok()?, b.trim().parse::<usize>().ok()?),
        None => {
            let n = range.parse::<usize>().ok()?;
            (n, n)
        }
    };
    if a == 0 || b < a {
        return None;
    }
    let all: Vec<&str> = content.split('\n').collect();
    if a > all.len() {
        return Some(String::new());
    }
    Some(all[a - 1..b.min(all.len())].join("\n"))
}

/// strftime, or `None` for a format chrono cannot render (it would panic on `to_string`).
pub fn format_time<Tz: TimeZone>(t: &DateTime<Tz>, fmt: &str) -> Option<String>
where
    Tz::Offset: std::fmt::Display,
{
    let items: Vec<Item> = StrftimeItems::new(fmt).collect();
    if items.iter().any(|i| matches!(i, Item::Error)) {
        return None;
    }
    use std::fmt::Write;
    let mut s = String::new();
    write!(s, "{}", t.format_with_items(items.into_iter())).ok()?;
    Some(s)
}

/// `+N unit` / `-N unit` (day, week, month, year, hour, minute; plural allowed), `today`, `tomorrow`,
/// `yesterday`, or a weekday name for its next occurrence after today.
pub fn relative(now: &DateTime<Local>, spec: &str) -> Option<DateTime<Local>> {
    let s = spec.trim().to_lowercase();
    match s.as_str() {
        "today" => return Some(*now),
        "tomorrow" => return now.checked_add_days(Days::new(1)),
        "yesterday" => return now.checked_sub_days(Days::new(1)),
        _ => {}
    }
    if let Some(day) = weekday(&s) {
        let ahead = (7 + day.num_days_from_monday() as i64 - now.weekday().num_days_from_monday() as i64) % 7;
        let ahead = if ahead == 0 { 7 } else { ahead };
        return now.checked_add_days(Days::new(ahead as u64));
    }
    let (sign, rest) = match s.chars().next()? {
        '+' => (1i64, &s[1..]),
        '-' => (-1i64, &s[1..]),
        _ => return None,
    };
    let rest = rest.trim();
    let split = rest.find(|c: char| !c.is_ascii_digit())?;
    let n: i64 = rest[..split].parse().ok()?;
    let unit = rest[split..].trim();
    let unit = unit.strip_suffix('s').unwrap_or(unit);
    let n = n * sign;
    match unit {
        "minute" | "min" => now.checked_add_signed(Duration::try_minutes(n)?),
        "hour" => now.checked_add_signed(Duration::try_hours(n)?),
        "day" => shift_days(now, n),
        "week" => shift_days(now, n.checked_mul(7)?),
        "month" => shift_months(now, n),
        "year" => shift_months(now, n.checked_mul(12)?),
        _ => None,
    }
}

fn shift_days(now: &DateTime<Local>, n: i64) -> Option<DateTime<Local>> {
    if n >= 0 {
        now.checked_add_days(Days::new(n as u64))
    } else {
        now.checked_sub_days(Days::new(n.unsigned_abs()))
    }
}

/// Calendar months: Jan 31 + 1 month is the last day of February, as chrono does it.
fn shift_months(now: &DateTime<Local>, n: i64) -> Option<DateTime<Local>> {
    let m = Months::new(u32::try_from(n.unsigned_abs()).ok()?);
    if n >= 0 {
        now.checked_add_months(m)
    } else {
        now.checked_sub_months(m)
    }
}

fn weekday(s: &str) -> Option<Weekday> {
    Some(match s {
        "monday" => Weekday::Mon,
        "tuesday" => Weekday::Tue,
        "wednesday" => Weekday::Wed,
        "thursday" => Weekday::Thu,
        "friday" => Weekday::Fri,
        "saturday" => Weekday::Sat,
        "sunday" => Weekday::Sun,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const DRAFT: &str = "# Shopping list\n\nmilk\neggs\n\n";

    /// Renders `input` against `DRAFT` at Saturday 2026-01-31 09:05 local, cursor on line 3 ("milk").
    fn r_at(input: &str, encoding: Encoding, now: DateTime<Local>, selection: Option<&str>) -> Rendered {
        let tags = vec!["home".to_string(), "list".to_string()];
        let mut custom = HashMap::new();
        custom.insert("prompt_name".to_string(), "Ada & Bob".to_string());
        let mut clipboard = || Some("from clipboard".to_string());
        let mut template = |name: &str| match name {
            "sig" => Some("-- [[title]]".to_string()),
            "loop" => Some("[[template|loop]]".to_string()),
            _ => None,
        };
        let env = |name: &str| (name == "EDITOR").then(|| "hx".to_string());
        let created = Local.with_ymd_and_hms(2025, 12, 24, 18, 30, 0).unwrap();
        let mut source = TagSource {
            content: DRAFT,
            uuid: "u-1",
            tags: &tags,
            created,
            modified: created,
            selection,
            cursor_line: 2,
            now,
            custom: &custom,
            clipboard: &mut clipboard,
            template: &mut template,
            env: &env,
        };
        render(input, &mut source, encoding)
    }

    fn now() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 1, 31, 9, 5, 0).unwrap()
    }

    fn r(input: &str) -> String {
        r_at(input, Encoding::Raw, now(), None).text
    }

    #[test]
    fn the_table() {
        let cases: &[(&str, &str)] = &[
            // Plain text and escapes.
            ("", ""),
            ("no tags here", "no tags here"),
            ("\\[[title]]", "[[title]]"),
            ("a \\[[ b", "a [[ b"),
            ("[[title", "[[title"),
            ("open [[ only", "open [[ only"),
            ("]] close only", "]] close only"),
            ("100%% sure, 50%% not", "100%% sure, 50%% not"),
            ("{{ not a tag }}", "{{ not a tag }}"),
            // The draft.
            ("[[title]]", "Shopping list"),
            ("[[TITLE]]", "Shopping list"),
            ("[[ title ]]", "Shopping list"),
            ("[[draft]]", DRAFT),
            ("[[body]]", "\nmilk\neggs\n\n"),
            ("[[trimmed_body]]", "milk\neggs"),
            ("[[safe_title]]", "Shopping list"),
            ("[[uuid]]", "u-1"),
            ("[[tags]]", "home, list"),
            ("[[draft_open_url]]", "petrel://open?uuid=u-1"),
            ("[[title]]: [[tags]]", "Shopping list: home, list"),
            ("[[[title]]](x)", "[Shopping list](x)"),
            // Selection and lines.
            ("[[selection]]", DRAFT),
            ("[[selection_only]]", ""),
            ("[[line]]", "milk"),
            ("[[line|1]]", "# Shopping list"),
            ("[[line|3..4]]", "milk\neggs"),
            ("[[line|4..99]]", "eggs\n\n"),
            ("[[line|99]]", ""),
            ("[[line|0]]", "[[line|0]]"),
            ("[[line|3..2]]", "[[line|3..2]]"),
            ("[[line|x]]", "[[line|x]]"),
            // Host values and custom tags.
            ("[[clipboard]]", "from clipboard"),
            ("[[env|EDITOR]]", "hx"),
            ("[[env|NOPE]]", "[[env|NOPE]]"),
            ("[[env]]", "[[env]]"),
            ("[[prompt_name]]", "Ada & Bob"),
            // Dates.
            ("[[date]]", "2026-01-31"),
            ("[[date|%H:%M]]", "09:05"),
            ("[[time]]", "09:05"),
            ("[[shortdate]]", "31/01/2026"),
            ("[[longdate]]", "Saturday, January 31, 2026"),
            ("[[date|+1 day]]", "2026-02-01"),
            ("[[date|+1 day|%d.%m.]]", "01.02."),
            ("[[date|-1 day]]", "2026-01-30"),
            ("[[date|+2 weeks]]", "2026-02-14"),
            ("[[date|+1 month]]", "2026-02-28"),
            ("[[date|-2 months]]", "2025-11-30"),
            ("[[date|+1 year]]", "2027-01-31"),
            ("[[date|+3 hours|%H:%M]]", "12:05"),
            ("[[date|+90 minutes|%H:%M]]", "10:35"),
            ("[[date|tomorrow]]", "2026-02-01"),
            ("[[date|yesterday]]", "2026-01-30"),
            ("[[date|today]]", "2026-01-31"),
            ("[[date|monday]]", "2026-02-02"),
            ("[[date|Saturday]]", "2026-02-07"),
            ("[[date|+1 fortnight]]", "[[date|+1 fortnight]]"),
            ("[[date|%Q]]", "[[date|%Q]]"),
            ("[[created]]", "2025-12-24T18:30:00"),
            ("[[created|%Y]]", "2025"),
            // Includes.
            ("[[template|sig]]", "-- Shopping list"),
            ("[[template|missing]]", "[[template|missing]]"),
            ("[[template]]", "[[template]]"),
            // Unknown tags stay.
            ("[[nope]]", "[[nope]]"),
            ("[[some note]]", "[[some note]]"),
            ("a [[nope]] b [[title]]", "a [[nope]] b Shopping list"),
            // Forced encoding in a raw field.
            ("{{prompt_name}}", "Ada%20%26%20Bob"),
            ("%%prompt_name%%", "Ada & Bob"),
            ("{{nope}}", "{{nope}}"),
        ];
        let mut failed = Vec::new();
        for (input, want) in cases {
            let got = r(input);
            // `created` carries the local offset, which depends on the machine running the tests.
            let ok = if input.starts_with("[[created]]") { got.starts_with(want) } else { &got == want };
            if !ok {
                failed.push(format!("{input:?}: got {got:?}, want {want:?}"));
            }
        }
        assert!(
            failed.is_empty(),
            "{} of {} cases failed:\n{}",
            failed.len(),
            cases.len(),
            failed.join("\n")
        );
        assert!(cases.len() >= 60, "the spec asks for 60+ cases");
    }

    #[test]
    fn url_fields_encode_by_default() {
        let u = |s| r_at(s, Encoding::Url, now(), None).text;
        assert_eq!(u("https://x.test/?q=[[title]]"), "https://x.test/?q=Shopping%20list");
        assert_eq!(u("https://x.test/?q=%%title%%"), "https://x.test/?q=Shopping list");
        assert_eq!(u("https://x.test/?q={{title}}"), "https://x.test/?q=Shopping%20list");
        assert_eq!(u("[[prompt_name]]/é"), "Ada%20%26%20Bob/é", "only values are encoded, never the field");
        assert_eq!(percent_encode("a-b_c.d~é/"), "a-b_c.d~%C3%A9%2F");
    }

    #[test]
    fn unknown_tags_are_reported() {
        let out = r_at("[[nope]] [[title]] [[line|x]] {{bad}}", Encoding::Raw, now(), None);
        assert_eq!(out.unknown, vec!["[[nope]]", "[[line|x]]", "{{bad}}"]);
    }

    #[test]
    fn includes_stop_at_the_depth_limit() {
        let out = r_at("[[template|loop]]", Encoding::Raw, now(), None);
        assert_eq!(out.text, "[[template|loop]]");
        assert_eq!(out.unknown.len(), 1);
    }

    #[test]
    fn selection_wins_when_there_is_one() {
        let sel = |s| r_at(s, Encoding::Raw, now(), Some("eggs")).text;
        assert_eq!(sel("[[selection]]"), "eggs");
        assert_eq!(sel("[[selection_only]]"), "eggs");
    }

    #[test]
    fn relative_dates_cross_month_and_year_ends() {
        let at = |y, m, d| Local.with_ymd_and_hms(y, m, d, 12, 0, 0).unwrap();
        let rel = |t: DateTime<Local>, s| relative(&t, s).map(|t| t.format("%Y-%m-%d").to_string());
        assert_eq!(rel(at(2026, 12, 31), "+1 day").as_deref(), Some("2027-01-01"));
        assert_eq!(rel(at(2026, 3, 1), "-1 day").as_deref(), Some("2026-02-28"));
        assert_eq!(rel(at(2028, 2, 28), "+1 day").as_deref(), Some("2028-02-29"), "leap year");
        assert_eq!(rel(at(2028, 2, 29), "+1 year").as_deref(), Some("2029-02-28"));
        assert_eq!(rel(at(2026, 12, 30), "monday").as_deref(), Some("2027-01-04"), "next week, next year");
        assert_eq!(rel(at(2026, 10, 31), "+1 month").as_deref(), Some("2026-11-30"));
        assert_eq!(rel(at(2026, 1, 1), "+1"), None, "a unit is needed");
        assert_eq!(rel(at(2026, 1, 1), "1 day"), None, "a sign is needed");
    }

    #[test]
    fn safe_titles_are_file_names() {
        assert_eq!(safe_title("a/b\\c:d*e?f\"g<h>i|j"), "a-b-c-d-e-f-g-h-i-j");
        assert_eq!(safe_title("  tab\there  "), "tab-here");
        assert_eq!(safe_title(&"x".repeat(300)).chars().count(), 120);
    }
}
