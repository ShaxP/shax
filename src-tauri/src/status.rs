//! System status probes for the statusline (M12.4b, spec §18).
//!
//! Two Tauri commands driving two statusbar chips:
//!
//! - [`system_battery`] returns [`BatteryStatus`] describing the
//!   machine's power state (present? at what percent? charging?).
//!   Desktops (no battery present) get `{present: false}` and the
//!   frontend renders the plug-alone glyph.
//! - [`system_local_ip`] returns the IPv4 address of the interface
//!   carrying the default route (the one you'd use to reach
//!   `1.1.1.1`). `None` when no network is reachable or the platform
//!   probe fails.
//!
//! Both probes go through published, cross-platform crates rather
//! than per-platform hand-rolled syscalls — the tradeoff is discussed
//! in the M12.4b spec section. Failures are always non-fatal: the
//! frontend hides the chip when the probe returns `None` / not-present.
//!
//! The battery probe applies a phantom-entry filter documented on
//! [`snapshot_from`]: Apple Silicon Mac desktops expose an
//! `IOPMPowerSource` entry with a non-finite state-of-charge, and we
//! must not surface that as "on battery (?)". See §18 M12.4b for the
//! rule.
//!
//! Refresh cadence is a frontend concern (30s polling per spec) —
//! this module just exposes the point-in-time snapshot.
//!
//! Testing note: neither probe can meaningfully be exercised in the
//! sandbox — battery state and network topology are runtime facts of
//! the host, not shaped inputs we can control. The unit tests here
//! sanity-check the shape of what the commands return; smoke tests
//! cover the real values.

use serde::{Deserialize, Serialize};

/// The machine's current power state, as reported by the OS.
///
/// The three fields answer three orthogonal questions the statusbar
/// chip needs to render:
///
/// - `present` — is there a battery at all? Desktops answer `false`;
///   laptops always answer `true`.
/// - `percent` — how full is it? `None` when the OS couldn't compute
///   a percentage (rare — usually means the battery firmware is
///   reporting garbage). Range is 0..=100.
/// - `charging` — is it currently being charged? On laptops that
///   report "AC connected, battery full" this is still `false` — the
///   battery isn't charging *because it's full*. The frontend treats
///   `!charging` on a present battery as "on battery" for the
///   discharge visual, so a fully-charged plugged-in laptop shows the
///   plug glyph via the caller-side rule "on wall power = charging
///   OR (present AND at 100%)" — see the M12.4b spec table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatteryStatus {
    pub present: bool,
    pub percent: Option<u8>,
    pub charging: bool,
}

impl BatteryStatus {
    /// A machine reporting no battery — used both for desktops and
    /// as the graceful fallback when the probe throws.
    pub fn absent() -> Self {
        Self {
            present: false,
            percent: None,
            charging: false,
        }
    }
}

/// Snapshot the machine's power state.
///
/// Returns [`BatteryStatus::absent`] on any probe failure — the
/// statusbar renders "no battery" indistinguishably from "battery
/// probe crashed," which is fine for our purposes (in either case,
/// there's nothing useful to display beyond the plug glyph).
///
/// The `starship-battery` crate's `Manager::batteries` returns an
/// iterator over every physical battery; laptops normally have one,
/// UPS-connected machines might have two. We take the first — showing
/// per-battery state is out of scope for a single statusbar chip.
#[tauri::command]
pub fn system_battery() -> BatteryStatus {
    let manager = match starship_battery::Manager::new() {
        Ok(m) => m,
        Err(e) => {
            tracing::debug!("battery manager init failed: {e}");
            return BatteryStatus::absent();
        }
    };
    let iter = match manager.batteries() {
        Ok(it) => it,
        Err(e) => {
            tracing::debug!("battery enumeration failed: {e}");
            return BatteryStatus::absent();
        }
    };
    // First real battery wins. Machines with multiple batteries are
    // rare in practice; UPS + laptop scenarios would need a separate
    // design conversation to surface both.
    for battery_result in iter {
        let Ok(battery) = battery_result else {
            continue;
        };
        let ratio = battery.state_of_charge().value;
        let charging = matches!(battery.state(), starship_battery::State::Charging);
        if let Some(status) = snapshot_from(ratio, charging) {
            return status;
        }
    }
    // No batteries in the iterator — desktop machine, or the OS
    // reported an empty set.
    BatteryStatus::absent()
}

/// Turn a raw (state-of-charge ratio, charging flag) reading into a
/// [`BatteryStatus`], or [`None`] if the entry looks phantom.
///
/// Phantom-entry filter: on Apple Silicon Mac desktops (Mac Mini,
/// Mac Studio) the `IOPMPowerSource` service enumerates entries even
/// without a real battery attached, and those entries report a
/// non-finite `state_of_charge()` (NaN). We treat that as the signal
/// "not a real usable battery" and skip — a genuine battery on any
/// modern OS always reports a finite state-of-charge, even when the
/// exact charging state is momentarily uncertain. If every entry in
/// the iterator is a phantom, the caller falls through to
/// [`BatteryStatus::absent`], which renders as the desktop plug-alone
/// chip.
///
/// Split out so the phantom rule is directly unit-testable without
/// having to mock the `starship-battery` iterator.
fn snapshot_from(ratio: f32, charging: bool) -> Option<BatteryStatus> {
    if !ratio.is_finite() {
        tracing::debug!("skipping battery entry with non-finite state-of-charge");
        return None;
    }
    // `state_of_charge()` is nominally 0.0..=1.0; noisy firmware can
    // report slightly outside that range, so clamp before scaling.
    let percent = (ratio.clamp(0.0, 1.0) * 100.0).round() as u8;
    Some(BatteryStatus {
        present: true,
        percent: Some(percent),
        charging,
    })
}

/// Snapshot the machine's IPv4 address on the default-route interface.
///
/// Returns `None` when no network is reachable or the platform probe
/// fails. Multi-homed systems (VPN + wifi + ethernet) get the
/// default-route interface, which is what the user would actually use
/// to talk to the outside world. Users who want to see all interfaces
/// have `ifconfig` / `ip addr`.
#[tauri::command]
pub fn system_local_ip() -> Option<String> {
    match local_ip_address::local_ip() {
        Ok(ip) => Some(ip.to_string()),
        Err(e) => {
            tracing::debug!("local IP probe failed: {e}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_is_all_zeros() {
        let a = BatteryStatus::absent();
        assert!(!a.present);
        assert!(a.percent.is_none());
        assert!(!a.charging);
    }

    #[test]
    fn battery_status_round_trips_through_json() {
        // The struct crosses IPC as JSON; the shape must survive
        // serde_json.
        let s = BatteryStatus {
            present: true,
            percent: Some(87),
            charging: false,
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: BatteryStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn battery_status_absent_serialises_predictably() {
        // Frontend relies on {"present": false, ...} to render the
        // "no battery, plug-alone" desktop state. Guard the exact
        // key names + null representation.
        let json = serde_json::to_string(&BatteryStatus::absent()).unwrap();
        assert!(json.contains(r#""present":false"#));
        assert!(json.contains(r#""percent":null"#));
        assert!(json.contains(r#""charging":false"#));
    }

    #[test]
    fn snapshot_from_returns_none_for_nan_state_of_charge() {
        // The Mac Mini phantom-entry case: IOKit hands us a
        // non-finite state-of-charge. `snapshot_from` must reject it
        // so the caller can try the next entry (or fall through to
        // `absent()` and render the desktop plug-alone chip).
        assert!(snapshot_from(f32::NAN, false).is_none());
        assert!(snapshot_from(f32::INFINITY, false).is_none());
        assert!(snapshot_from(f32::NEG_INFINITY, true).is_none());
    }

    #[test]
    fn snapshot_from_returns_a_percent_for_a_real_reading() {
        let s = snapshot_from(0.87, false).expect("real reading must map to a status");
        assert!(s.present);
        assert_eq!(s.percent, Some(87));
        assert!(!s.charging);
    }

    #[test]
    fn snapshot_from_preserves_the_charging_flag() {
        let s = snapshot_from(0.45, true).expect("real reading must map to a status");
        assert!(s.charging);
        assert_eq!(s.percent, Some(45));
    }

    #[test]
    fn snapshot_from_clamps_out_of_range_ratios() {
        // Noisy firmware occasionally reports slightly outside
        // 0.0..=1.0 — we clamp rather than reject, because the
        // battery is still real.
        let over = snapshot_from(1.03, false).expect("clamped");
        assert_eq!(over.percent, Some(100));
        let under = snapshot_from(-0.02, false).expect("clamped");
        assert_eq!(under.percent, Some(0));
    }

    #[test]
    fn system_battery_never_panics() {
        // Runs on real host — the answer varies (desktop = absent,
        // laptop = present) but the call itself must not throw.
        let _snapshot = system_battery();
    }

    #[test]
    fn system_local_ip_returns_a_parseable_string_or_none() {
        // Same shape as system_battery — the call itself must
        // return without panicking; the value depends on the host's
        // network state.
        match system_local_ip() {
            Some(ip) => {
                // If we got a value, it must parse as an IP address.
                assert!(
                    ip.parse::<std::net::IpAddr>().is_ok(),
                    "returned value should be a parseable IP, got {ip:?}",
                );
            }
            None => { /* offline sandbox — accept */ }
        }
    }
}
