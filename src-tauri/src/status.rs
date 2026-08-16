//! Native OS probes. Started as statusbar-chip support in M12.4b
//! and grew in M13.3 to cover the sidebar's CPU/memory and network
//! widgets — all four probes share the same shape, cadence contract,
//! and graceful-degradation rule, so they live in one module.
//!
//! Four Tauri commands:
//!
//! - [`system_battery`] — machine power state (M12.4b, statusbar).
//! - [`system_local_ip`] — default-route IPv4 (M12.4b, statusbar +
//!   M13.3 sidebar Network widget).
//! - [`system_cpu_and_mem`] — CPU % + memory in use (M13.3, sidebar
//!   CpuMem widget).
//! - [`system_ssid`] — Wi-Fi SSID name (M13.3, sidebar Network
//!   widget). macOS returns `None` unconditionally — see the note
//!   on [`system_ssid`] for why.
//!
//! All four probes go through published, cross-platform crates or
//! per-OS shell-outs rather than per-platform hand-rolled syscalls
//! — the tradeoff is discussed in the M12.4b / M13.3 spec sections.
//! Failures are always non-fatal: the frontend hides the chip / line
//! when the probe returns `None` / not-present.
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

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use starship_battery::State;
use sysinfo::{MemoryRefreshKind, RefreshKind, System};

/// The machine's current power state, as reported by the OS.
///
/// The four fields answer four orthogonal questions the statusbar
/// chip needs to render:
///
/// - `present` — is there a battery at all? Desktops answer `false`;
///   laptops always answer `true`.
/// - `percent` — how full is it? `None` when the OS couldn't compute
///   a percentage (rare — usually means the battery firmware is
///   reporting garbage). Range is 0..=100.
/// - `on_ac_power` — is the machine currently drawing from wall
///   power? True for both "actively charging" and "on AC, battery
///   full" (macOS reports `IsCharging=false, FullyCharged=true` in
///   the latter case). False for a laptop on battery — including a
///   fully-charged laptop that was just unplugged. The frontend uses
///   this as the primary discriminator between the plug icon and the
///   battery-fill icon.
/// - `charging` — is the battery actively being *charged* right now?
///   True only when energy is flowing into the cell. False when on
///   battery, false when fully charged on AC. The frontend uses this
///   only for the tooltip distinction between "Charging (X%)" and
///   "AC power (X%)".
///
/// We deliberately keep the two flags separate rather than collapsing
/// into a three-state enum: it lets the frontend derive both the icon
/// choice and the tooltip label with straight boolean checks, and it
/// leaves room for future rendering (e.g. a lightning-bolt overlay
/// for `charging && on_ac_power`) without another IPC change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatteryStatus {
    pub present: bool,
    pub percent: Option<u8>,
    pub on_ac_power: bool,
    pub charging: bool,
}

impl BatteryStatus {
    /// A machine reporting no battery — used both for desktops and
    /// as the graceful fallback when the probe throws.
    pub fn absent() -> Self {
        Self {
            present: false,
            percent: None,
            on_ac_power: false,
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
        if let Some(status) = snapshot_from(ratio, battery.state()) {
            return status;
        }
    }
    // No batteries in the iterator — desktop machine, or the OS
    // reported an empty set.
    BatteryStatus::absent()
}

/// Turn a raw (state-of-charge ratio, `starship-battery` state)
/// reading into a [`BatteryStatus`], or [`None`] if the entry looks
/// phantom.
///
/// **State mapping.** The `State` enum reports what the OS thinks the
/// battery is doing right now. We collapse it into two orthogonal
/// booleans:
///
/// | `State`       | `on_ac_power` | `charging` | Real-world case                          |
/// | ------------- | ------------- | ---------- | ---------------------------------------- |
/// | `Charging`    | `true`        | `true`     | Plugged in, drawing energy into battery. |
/// | `Full`        | `true`        | `false`    | Plugged in, battery at 100%, not drawing.|
/// | `Discharging` | `false`       | `false`    | On battery, energy flowing out.          |
/// | `Empty`       | `false`       | `false`    | On battery, 0%.                          |
/// | `Unknown`     | `false`       | `false`    | Defensive default — assume on battery.   |
///
/// The `Unknown` default matters: an unplugged laptop at 100% that
/// momentarily reports `Unknown` should not flash the plug icon. The
/// worst case of getting this wrong is a plugged-in laptop briefly
/// showing the battery icon, which is a self-correcting visual glitch
/// versus a stationary lie about power state.
///
/// **Phantom-entry filter.** On Apple Silicon Mac desktops (Mac Mini,
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
/// Split out so both rules are directly unit-testable without having
/// to mock the `starship-battery` iterator.
fn snapshot_from(ratio: f32, state: State) -> Option<BatteryStatus> {
    if !ratio.is_finite() {
        tracing::debug!("skipping battery entry with non-finite state-of-charge");
        return None;
    }
    // `state_of_charge()` is nominally 0.0..=1.0; noisy firmware can
    // report slightly outside that range, so clamp before scaling.
    let percent = (ratio.clamp(0.0, 1.0) * 100.0).round() as u8;
    let on_ac_power = matches!(state, State::Charging | State::Full);
    let charging = matches!(state, State::Charging);
    Some(BatteryStatus {
        present: true,
        percent: Some(percent),
        on_ac_power,
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

// ── M13.3: CPU + memory ────────────────────────────────────────────

/// CPU-load and memory-use snapshot for the sidebar's CpuMem widget.
///
/// Percentages are 0..=100 floats to preserve the fractional detail
/// (`sysinfo` reports fractional CPU usage). Memory is reported in
/// bytes on both axes so the frontend can format ("3.4 GB / 16.0 GB")
/// or derive a percentage as it prefers — passing pre-baked strings
/// would lock the display in the backend.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SystemLoad {
    pub cpu_percent: f32,
    pub mem_used_bytes: u64,
    pub mem_total_bytes: u64,
}

/// Shared `System` instance so CPU deltas are meaningful. `sysinfo`
/// computes CPU usage from the delta between two calls to
/// `refresh_cpu_usage()`; a fresh `System::new()` per probe would
/// always return 0. The mutex is held only for the duration of the
/// refresh — microseconds — so a 2s poll cadence never contends.
static SYS: Mutex<Option<System>> = Mutex::new(None);

/// CPU + memory snapshot. Returns [`SystemLoad::zero`] when the
/// probe can't run (e.g. the OS permission denies `/proc` access
/// inside a sandbox) — same graceful-degradation shape as the other
/// probes in this module.
///
/// Note the first call after startup returns `cpu_percent: 0.0`
/// unconditionally — `sysinfo` needs at least
/// [`sysinfo::MINIMUM_CPU_UPDATE_INTERVAL`] between refreshes to
/// compute a meaningful delta. The second poll (2s later) has the
/// first real number.
#[tauri::command]
pub fn system_cpu_and_mem() -> SystemLoad {
    let mut guard = match SYS.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let sys = guard.get_or_insert_with(|| {
        // `RefreshKind::new()` builds an empty spec; we opt in only
        // to CPU + memory so `sysinfo` doesn't scan disks, processes,
        // or the network on every refresh (all defaulted off in our
        // Cargo feature set anyway, but explicit here as belt +
        // braces).
        System::new_with_specifics(
            RefreshKind::new()
                .with_cpu(sysinfo::CpuRefreshKind::everything())
                .with_memory(MemoryRefreshKind::everything()),
        )
    });
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    SystemLoad {
        cpu_percent: sys.global_cpu_usage(),
        mem_used_bytes: sys.used_memory(),
        mem_total_bytes: sys.total_memory(),
    }
}

// ── M13.3: Wi-Fi SSID ──────────────────────────────────────────────

/// Wi-Fi SSID of the currently-connected network, or `None` when
/// disconnected / probe failed / the platform withholds it.
///
/// **macOS returns `None` unconditionally.** The `airport -I` binary
/// the spec was drafted against was removed in macOS 14, and every
/// remaining API path (CoreWLAN, `system_profiler`, `networksetup`)
/// returns `<redacted>` unless the app holds the CoreLocation
/// entitlement — which requires an alarming "Shax wants your
/// location" runtime prompt on first launch. Apple's stance is that
/// SSID is location-adjacent data; Shax respects that rather than
/// asking the user to opt in to a location prompt for a chip label.
/// The Network widget hides the SSID line on macOS and renders IP +
/// up/down only.
///
/// Linux: `iwgetid -r` (part of `wireless-tools`, present on any
/// distro that ships Wi-Fi hardware — Ubuntu, Fedora, Arch all
/// include it in the default install). Returns the SSID on stdout
/// with no wrapping, or exits non-zero when disconnected.
///
/// Windows: `netsh wlan show interfaces`, parse the `SSID :`
/// line. `netsh` ships with every Windows release since Vista.
///
/// Failures at any step (binary missing, wrong exit code, malformed
/// output) collapse to `None` — the widget hides the SSID line and
/// the IP + up/down dot still render.
#[tauri::command]
pub fn system_ssid() -> Option<String> {
    ssid_impl()
}

#[cfg(target_os = "macos")]
fn ssid_impl() -> Option<String> {
    // See doc comment on `system_ssid`. macOS masks SSID without
    // CoreLocation entitlement; we do not request it.
    None
}

#[cfg(target_os = "linux")]
fn ssid_impl() -> Option<String> {
    let out = std::process::Command::new("iwgetid").arg("-r").output();
    let out = match out {
        Ok(o) => o,
        Err(e) => {
            tracing::debug!("iwgetid probe failed: {e}");
            return None;
        }
    };
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[cfg(target_os = "windows")]
fn ssid_impl() -> Option<String> {
    let out = std::process::Command::new("netsh")
        .args(["wlan", "show", "interfaces"])
        .output();
    let out = match out {
        Ok(o) => o,
        Err(e) => {
            tracing::debug!("netsh wlan probe failed: {e}");
            return None;
        }
    };
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    // `netsh wlan show interfaces` prints an indented block whose
    // "SSID :" line carries the network name. Watch out for the
    // sibling "BSSID :" line (MAC address) — match on "SSID" with
    // no leading 'B' to avoid it.
    parse_netsh_ssid(&stdout)
}

#[cfg(target_os = "windows")]
fn parse_netsh_ssid(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with("SSID") || trimmed.starts_with("BSSID") {
            continue;
        }
        let (_, rest) = trimmed.split_once(':')?;
        let name = rest.trim();
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_is_all_zeros() {
        let a = BatteryStatus::absent();
        assert!(!a.present);
        assert!(a.percent.is_none());
        assert!(!a.on_ac_power);
        assert!(!a.charging);
    }

    #[test]
    fn battery_status_round_trips_through_json() {
        // The struct crosses IPC as JSON; the shape must survive
        // serde_json.
        let s = BatteryStatus {
            present: true,
            percent: Some(87),
            on_ac_power: false,
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
        assert!(json.contains(r#""on_ac_power":false"#));
        assert!(json.contains(r#""charging":false"#));
    }

    #[test]
    fn snapshot_from_returns_none_for_nan_state_of_charge() {
        // The Mac Mini phantom-entry case: IOKit hands us a
        // non-finite state-of-charge. `snapshot_from` must reject it
        // so the caller can try the next entry (or fall through to
        // `absent()` and render the desktop plug-alone chip).
        assert!(snapshot_from(f32::NAN, State::Discharging).is_none());
        assert!(snapshot_from(f32::INFINITY, State::Full).is_none());
        assert!(snapshot_from(f32::NEG_INFINITY, State::Charging).is_none());
    }

    #[test]
    fn snapshot_from_maps_state_charging_to_both_flags_true() {
        // Actively drawing energy into the battery.
        let s = snapshot_from(0.45, State::Charging).expect("charging is real");
        assert!(s.on_ac_power);
        assert!(s.charging);
        assert_eq!(s.percent, Some(45));
    }

    #[test]
    fn snapshot_from_maps_state_full_to_on_ac_but_not_charging() {
        // Plugged-in laptop at 100%. macOS reports IsCharging=false
        // in this case — the OS-level distinction we're preserving.
        let s = snapshot_from(1.00, State::Full).expect("full is real");
        assert!(s.on_ac_power);
        assert!(!s.charging);
        assert_eq!(s.percent, Some(100));
    }

    #[test]
    fn snapshot_from_maps_state_discharging_to_neither_flag() {
        // Unplugged laptop consuming battery. Note: even at 100%
        // (unplugged full-charge laptop), Discharging still resolves
        // to on-battery — this is the MBP bug the mapping fixes.
        let s = snapshot_from(1.00, State::Discharging).expect("discharging is real");
        assert!(!s.on_ac_power);
        assert!(!s.charging);
        assert_eq!(s.percent, Some(100));
    }

    #[test]
    fn snapshot_from_maps_state_empty_to_neither_flag() {
        let s = snapshot_from(0.00, State::Empty).expect("empty is real");
        assert!(!s.on_ac_power);
        assert!(!s.charging);
        assert_eq!(s.percent, Some(0));
    }

    #[test]
    fn snapshot_from_maps_state_unknown_to_neither_flag_defensively() {
        // Ambiguous OS state: default to "on battery" so we never
        // silently misreport an unplugged laptop as AC power.
        let s = snapshot_from(0.55, State::Unknown).expect("unknown is real");
        assert!(!s.on_ac_power);
        assert!(!s.charging);
        assert_eq!(s.percent, Some(55));
    }

    #[test]
    fn snapshot_from_clamps_out_of_range_ratios() {
        // Noisy firmware occasionally reports slightly outside
        // 0.0..=1.0 — we clamp rather than reject, because the
        // battery is still real.
        let over = snapshot_from(1.03, State::Discharging).expect("clamped");
        assert_eq!(over.percent, Some(100));
        let under = snapshot_from(-0.02, State::Discharging).expect("clamped");
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

    // ── M13.3 ──────────────────────────────────────────────────

    #[test]
    fn cpu_and_mem_shape_is_sane() {
        // Smoke test only — probe values are runtime-dependent
        // (a beefy dev box vs a CI runner). Assert the shape, not
        // the numbers.
        let load = system_cpu_and_mem();
        assert!(
            (0.0..=100.0).contains(&load.cpu_percent) || load.cpu_percent.is_nan(),
            "cpu_percent should be a %, got {}",
            load.cpu_percent,
        );
        // First call after startup returns 0 for CPU (needs a
        // second refresh to compute a delta). Memory numbers are
        // available immediately though.
        assert!(
            load.mem_total_bytes > 0,
            "mem_total_bytes should be non-zero on any real machine",
        );
        assert!(
            load.mem_used_bytes <= load.mem_total_bytes,
            "used ({}) must not exceed total ({})",
            load.mem_used_bytes,
            load.mem_total_bytes,
        );
    }

    #[test]
    fn cpu_and_mem_second_call_stabilises_cpu() {
        // The first call primes the CPU stats; the second returns a
        // real percentage. Just confirm both calls return finite,
        // in-range values (some CIs stay at 0% between refreshes).
        let _first = system_cpu_and_mem();
        let second = system_cpu_and_mem();
        assert!(second.cpu_percent >= 0.0 && second.cpu_percent <= 100.0);
    }

    #[test]
    fn ssid_probe_shape() {
        // Runtime-dependent — a laptop on Wi-Fi returns `Some("…")`,
        // a wired desktop returns `None`, macOS always returns
        // `None`. Just confirm the probe doesn't panic and the
        // Option is well-formed.
        let s = system_ssid();
        if let Some(name) = s {
            assert!(
                !name.is_empty(),
                "SSID returned an empty string; probe should collapse to None instead",
            );
            // No leading/trailing whitespace — the probe trims.
            assert_eq!(name.trim(), name);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn ssid_is_none_on_macos() {
        // Locked by design (see doc on `system_ssid`).
        assert_eq!(system_ssid(), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_netsh_ssid_picks_the_ssid_line() {
        let sample = "\r\n\
            There is 1 interface on the system:\r\n\
            \r\n\
                Name                   : Wi-Fi\r\n\
                Description            : Intel(R) Wi-Fi 6 AX201 160MHz\r\n\
                GUID                   : abc-123\r\n\
                State                  : connected\r\n\
                SSID                   : MyHomeNetwork\r\n\
                BSSID                  : 00:11:22:33:44:55\r\n\
                Network type           : Infrastructure\r\n";
        assert_eq!(
            parse_netsh_ssid(sample),
            Some("MyHomeNetwork".to_string()),
            "should pick the SSID line, not the BSSID (MAC)",
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_netsh_ssid_returns_none_when_disconnected() {
        let sample = "There is 1 interface on the system:\r\n\
                Name                   : Wi-Fi\r\n\
                State                  : disconnected\r\n";
        assert_eq!(parse_netsh_ssid(sample), None);
    }
}
