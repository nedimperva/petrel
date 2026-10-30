//! How long things are kept. Versions are thinned by age tier, only in `Store::sweep()`, never on the save path:
//! every version from the last hour, the newest of each hour for a day, of each day for 30 days, then of each
//! week. A version taken before an action run or a restore is kept whole for 90 days before it joins the tiers.
//! Trash becomes a tombstone after 30 days, and a tombstone row is deleted after 90.
//!
//! Every period is a setting (`retention.<field>`, a whole number) with a floor, so a mistyped setting can
//! shorten history but never make it vanish within the hour.

use serde::{Deserialize, Serialize};

pub const HOUR_MS: i64 = 60 * 60 * 1000;
pub const DAY_MS: i64 = 24 * HOUR_MS;
pub const WEEK_MS: i64 = 7 * DAY_MS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Retention {
    /// Drafts in Trash longer than this become tombstones.
    pub trash_days: i64,
    /// Tombstones older than this are deleted. Long enough for M4 sync to see the deletion.
    pub tombstone_days: i64,
    /// Every version younger than this is kept.
    pub versions_all_hours: i64,
    /// Then the newest version of each hour, up to this age.
    pub versions_hourly_days: i64,
    /// Then the newest of each day, up to this age; the newest of each week after that.
    pub versions_daily_days: i64,
    /// `before_action:*` and `restore` versions are kept whole for this long.
    pub versions_protected_days: i64,
}

impl Default for Retention {
    fn default() -> Retention {
        Retention {
            trash_days: 30,
            tombstone_days: 90,
            versions_all_hours: 1,
            versions_hourly_days: 1,
            versions_daily_days: 30,
            versions_protected_days: 90,
        }
    }
}

/// The smallest value each setting may take.
const FLOORS: Retention = Retention {
    trash_days: 1,
    tombstone_days: 30,
    versions_all_hours: 1,
    versions_hourly_days: 1,
    versions_daily_days: 7,
    versions_protected_days: 30,
};

impl Retention {
    /// The settings keys, in field order, with a setter for each.
    pub const KEYS: [&'static str; 6] = [
        "retention.trashDays",
        "retention.tombstoneDays",
        "retention.versionsAllHours",
        "retention.versionsHourlyDays",
        "retention.versionsDailyDays",
        "retention.versionsProtectedDays",
    ];

    fn field(&mut self, i: usize) -> &mut i64 {
        match i {
            0 => &mut self.trash_days,
            1 => &mut self.tombstone_days,
            2 => &mut self.versions_all_hours,
            3 => &mut self.versions_hourly_days,
            4 => &mut self.versions_daily_days,
            _ => &mut self.versions_protected_days,
        }
    }

    /// Defaults overridden by whichever settings are present and numeric, each raised to its floor.
    pub fn from_settings(get: impl Fn(&str) -> Option<String>) -> Retention {
        let mut r = Retention::default();
        let mut floors = FLOORS;
        for (i, key) in Retention::KEYS.iter().enumerate() {
            if let Some(n) = get(key).and_then(|v| v.trim().parse::<i64>().ok()) {
                *r.field(i) = n.max(*floors.field(i));
            }
        }
        // The tiers must widen as they age, or a daily tier could end before the hourly one does.
        r.versions_daily_days = r.versions_daily_days.max(r.versions_hourly_days);
        r
    }
}

/// One version as thinning sees it.
pub struct VersionAge<'a> {
    pub id: i64,
    pub draft_id: i64,
    pub reason: &'a str,
    pub created_at: i64,
}

/// The versions `sweep()` deletes. `versions` must be ordered by draft, then newest first. Buckets are fixed
/// windows of the epoch (UTC hours, days, weeks), so thinning is stable: a second sweep at the same time
/// deletes nothing, and a version kept as the newest of its day stays until it ages into the weekly tier.
pub fn versions_to_thin(versions: &[VersionAge], now: i64, r: &Retention) -> Vec<i64> {
    let all_until = now - r.versions_all_hours * HOUR_MS;
    let hourly_until = now - r.versions_hourly_days * DAY_MS;
    let daily_until = now - r.versions_daily_days * DAY_MS;
    let protected_until = now - r.versions_protected_days * DAY_MS;
    let mut doomed = Vec::new();
    let mut draft = None;
    let mut last_bucket: Option<(u8, i64)> = None;
    for v in versions {
        if draft != Some(v.draft_id) {
            draft = Some(v.draft_id);
            last_bucket = None;
        }
        let protected = v.reason.starts_with("before_action")
            || v.reason.starts_with("action_conflict")
            || v.reason == "restore";
        if v.created_at >= all_until || (protected && v.created_at >= protected_until) {
            continue;
        }
        let bucket = if v.created_at >= hourly_until {
            (0, v.created_at.div_euclid(HOUR_MS))
        } else if v.created_at >= daily_until {
            (1, v.created_at.div_euclid(DAY_MS))
        } else {
            (2, v.created_at.div_euclid(WEEK_MS))
        };
        // Newest first, so the first version seen in a bucket is the one kept.
        if last_bucket == Some(bucket) {
            doomed.push(v.id);
        } else {
            last_bucket = Some(bucket);
        }
    }
    doomed
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000_000 - 1_700_000_000_000 % WEEK_MS + 3 * DAY_MS + 12 * HOUR_MS;

    fn v(id: i64, reason: &str, age: i64) -> VersionAge<'_> {
        VersionAge { id, draft_id: 1, reason, created_at: NOW - age }
    }

    #[test]
    fn the_last_hour_is_kept_whole() {
        let vs: Vec<_> = (0..12).map(|i| v(i, "edit", i * 5 * 60 * 1000)).collect();
        assert!(versions_to_thin(&vs, NOW, &Retention::default()).is_empty());
    }

    #[test]
    fn older_versions_keep_the_newest_per_hour_day_and_week() {
        let min = 60 * 1000;
        let vs = vec![
            v(1, "edit", 2 * HOUR_MS + 10 * min), // hour bucket A, newest: kept
            v(2, "edit", 2 * HOUR_MS + 20 * min), // same hour as 1 (bucket edges are on the hour): thinned
            v(3, "edit", 5 * HOUR_MS),            // another hour: kept
            v(4, "edit", 3 * DAY_MS),             // day tier: kept
            v(5, "edit", 3 * DAY_MS + min),       // same day: thinned
            v(6, "edit", 40 * DAY_MS),            // week tier: kept
            v(7, "edit", 40 * DAY_MS + DAY_MS),   // same week (NOW is mid-week; 40 days back is too): thinned
        ];
        let doomed = versions_to_thin(&vs, NOW, &Retention::default());
        assert_eq!(doomed, vec![2, 5, 7]);
        // Stable: what is left has nothing more to give.
        let left: Vec<_> = vs.into_iter().filter(|x| !doomed.contains(&x.id)).collect();
        assert!(versions_to_thin(&left, NOW, &Retention::default()).is_empty());
    }

    #[test]
    fn before_action_conflict_and_restore_are_kept_for_90_days_first() {
        let vs = vec![
            v(1, "edit", 10 * DAY_MS),
            v(2, "before_action:abc", 10 * DAY_MS + 1000),
            v(3, "restore", 10 * DAY_MS + 2000),
            v(4, "edit", 10 * DAY_MS + 3000),
            v(5, "before_action:old", 100 * DAY_MS),
            v(6, "edit", 100 * DAY_MS + 1000),
            v(7, "action_conflict:abc", 10 * DAY_MS + 4000),
        ];
        assert_eq!(versions_to_thin(&vs, NOW, &Retention::default()), vec![4, 6]);
    }

    #[test]
    fn buckets_restart_per_draft() {
        let vs = vec![
            VersionAge { id: 1, draft_id: 1, reason: "edit", created_at: NOW - 3 * DAY_MS },
            VersionAge { id: 2, draft_id: 2, reason: "edit", created_at: NOW - 3 * DAY_MS - 1 },
        ];
        assert!(versions_to_thin(&vs, NOW, &Retention::default()).is_empty());
    }

    #[test]
    fn settings_override_and_respect_floors() {
        let r = Retention::from_settings(|k| match k {
            "retention.trashDays" => Some("7".into()),
            "retention.tombstoneDays" => Some("0".into()),
            "retention.versionsAllHours" => Some("not a number".into()),
            "retention.versionsHourlyDays" => Some("40".into()),
            _ => None,
        });
        assert_eq!(r.trash_days, 7);
        assert_eq!(r.tombstone_days, 30, "raised to its floor");
        assert_eq!(r.versions_all_hours, 1, "ignored, default kept");
        assert_eq!(r.versions_hourly_days, 40);
        assert_eq!(r.versions_daily_days, 40, "a tier never ends before the one inside it");
    }
}
