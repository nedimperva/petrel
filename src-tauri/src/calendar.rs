//! Today's calendar on today's page, read-only, only when turned on in Settings › Sync. It uses the same Google
//! sign-in as Drive, with one more scope (`calendar.events.readonly`) asked for when it is turned on. Petrel reads
//! the primary calendar's events for one day when today's page opens; nothing is stored or sent anywhere.

use anyhow::{anyhow, bail, Context, Result};
use chrono::{Local, NaiveDate, TimeZone};
use serde::Serialize;
use serde_json::Value;

use crate::google;
use crate::sync::{set_setting, setting, CLIENT_ID};

/// `1` when today's calendar is on.
pub const ON: &str = "calendar.on";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalEvent {
    /// `09:30`, or empty for an all-day event.
    pub start: String,
    pub end: String,
    pub title: String,
}

/// The events of one day (`YYYY-MM-DD`, local time), in order.
pub fn day_events(client_id: &str, day: &str) -> Result<Vec<CalEvent>> {
    let date = NaiveDate::parse_from_str(day, "%Y-%m-%d").context("a day as YYYY-MM-DD")?;
    let at = |d: NaiveDate| {
        Local
            .from_local_datetime(&d.and_hms_opt(0, 0, 0).expect("midnight"))
            .earliest()
            .map(|t| t.to_rfc3339())
            .ok_or_else(|| anyhow!("no midnight on {d}"))
    };
    let (from, to) = (at(date)?, at(date.succ_opt().context("the day after")?)?);
    let token = google::access_token(client_id)?;
    let mut resp = google::http()
        .get("https://www.googleapis.com/calendar/v3/calendars/primary/events")
        .header("Authorization", &format!("Bearer {token}"))
        .query("timeMin", &from)
        .query("timeMax", &to)
        .query("singleEvents", "true")
        .query("orderBy", "startTime")
        .query("maxResults", "50")
        .call()
        .map_err(|e| anyhow!("cannot reach Google Calendar: {e}"))?;
    let status = resp.status().as_u16();
    let v: Value = resp.body_mut().read_json().map_err(|e| anyhow!("reading the calendar: {e}"))?;
    if status == 403 || status == 401 {
        bail!("Petrel may not read the calendar yet: turn it off and on again in Settings › Sync to sign in with it");
    }
    if status != 200 {
        bail!("Google Calendar said {status}: {}", v["error"]["message"].as_str().unwrap_or("unknown"));
    }
    Ok(parse(&v))
}

fn parse(v: &Value) -> Vec<CalEvent> {
    let time = |t: &Value| -> String {
        t["dateTime"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&Local).format("%H:%M").to_string())
            .unwrap_or_default()
    };
    v["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| e["status"].as_str() != Some("cancelled"))
        .map(|e| CalEvent {
            start: time(&e["start"]),
            end: time(&e["end"]),
            title: e["summary"].as_str().unwrap_or("(no title)").trim().to_string(),
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalStatus {
    pub on: bool,
}

#[tauri::command]
pub fn calendar_status(app: tauri::AppHandle) -> CalStatus {
    CalStatus { on: setting(&app, ON).is_some_and(|v| v == "1") }
}

/// Turns today's calendar on (signing in again with the calendar scope) or off.
#[tauri::command]
pub async fn calendar_set_on(app: tauri::AppHandle, on: bool) -> Result<CalStatus, String> {
    if !on {
        set_setting(&app, ON, "0").map_err(|e| format!("{e:#}"))?;
        return Ok(calendar_status(app));
    }
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        let id =
            setting(&a, CLIENT_ID).context("set up Google sync first: the calendar uses the same sign-in")?;
        let opener = a.clone();
        let granted = google::sign_in(&id, true, move |url| {
            use tauri_plugin_opener::OpenerExt;
            opener.opener().open_url(url, None::<&str>).map_err(|e| anyhow!("opening the browser: {e}"))
        })?;
        if !granted.contains("calendar") {
            bail!("Google did not give Petrel the calendar: tick it on Google's page next time");
        }
        set_setting(&a, ON, "1")
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("{e:#}"))?;
    Ok(calendar_status(app))
}

/// One day's events, for today's page. Empty when the calendar is off.
#[tauri::command]
pub async fn calendar_day(app: tauri::AppHandle, day: String) -> Result<Vec<CalEvent>, String> {
    if !calendar_status(app.clone()).on {
        return Ok(Vec::new());
    }
    let id = setting(&app, CLIENT_ID).ok_or("Google sync is not set up")?;
    tauri::async_runtime::spawn_blocking(move || day_events(&id, &day))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_are_read_in_order_and_cancelled_ones_left_out() {
        let v: Value = serde_json::from_str(
            r#"{"items":[
              {"summary":"Standup","start":{"dateTime":"2026-11-19T09:30:00+01:00"},"end":{"dateTime":"2026-11-19T09:45:00+01:00"}},
              {"summary":"Holiday","start":{"date":"2026-11-19"},"end":{"date":"2026-11-20"}},
              {"summary":"Gone","status":"cancelled","start":{"dateTime":"2026-11-19T11:00:00+01:00"}}
            ]}"#,
        )
        .unwrap();
        let e = parse(&v);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].title, "Standup");
        assert_eq!(e[1].start, "");
    }
}
