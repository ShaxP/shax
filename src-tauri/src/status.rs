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
//! - [`system_load_series`] — CPU % + memory in use, plus the recent
//!   CPU history (M13.3 / M13 refinement, sidebar CPU + Memory
//!   widgets). Unlike the other entries this is not a probe the
//!   frontend polls: [`spawn_sampler`] drives it on a fixed cadence
//!   and broadcasts, because the reading is a delta and its meaning
//!   depends on who refreshed last.
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
use std::time::{Duration, Instant};

use tauri::Emitter as _;

use serde::{Deserialize, Serialize};
use starship_battery::State;
use sysinfo::{MemoryRefreshKind, Networks, RefreshKind, System};

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
    /// Seconds remaining, extended in M13.5.3 for the sidebar Battery
    /// widget's `4h 20m` label. Interpretation depends on `charging`:
    /// - `charging = true`  → time to full
    /// - `charging = false, on_ac_power = false` → time to empty
    /// - Otherwise (fully-charged-on-AC, unknown, etc.) → `None`
    ///
    /// `None` is honest: it means the OS didn't estimate a value we
    /// can trust — a fresh battery, a rare `State::Full` reading, a
    /// firmware quirk. The widget hides the estimate rather than
    /// inventing one.
    pub seconds_remaining: Option<u64>,
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
            seconds_remaining: None,
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
        // Topping-off escape hatch (M13.5.3): some machines report
        // `State::Full` at displayed 100 % while the OS is still
        // adding energy behind the scenes — a laptop that rounded up
        // to 100 % but hasn't quite reached true full. macOS shows
        // the charging bolt in the menu bar in that state; without
        // this normalisation, our widget would honestly say
        // `charging = false` while the OS's own status bar says the
        // opposite. `time_to_full` from starship-battery is the
        // signal: if the OS still estimates any time to full, we're
        // charging by any user's definition.
        let time_to_full_secs = battery.time_to_full().map(|d| d.value.round() as u64);
        let time_to_empty_secs = battery.time_to_empty().map(|d| d.value.round() as u64);
        // Temporary diagnostic (remove once the bolt-at-100 % thread
        // is closed): dumps what starship-battery is actually
        // returning so we can see whether `time_to_full` is None in
        // the topping-off case, which is the only case that would
        // let the escape hatch fire.
        tracing::info!(
            "battery probe: state={:?} ratio={:.3} time_to_full_s={:?} time_to_empty_s={:?}",
            battery.state(),
            ratio,
            time_to_full_secs,
            time_to_empty_secs,
        );
        let effective_state = effective_charging_state(battery.state(), time_to_full_secs);
        let seconds_remaining = match effective_state {
            State::Charging => time_to_full_secs,
            State::Discharging => time_to_empty_secs,
            _ => None,
        };
        if let Some(status) = snapshot_from(ratio, effective_state, seconds_remaining) {
            return status;
        }
    }
    // No batteries in the iterator — desktop machine, or the OS
    // reported an empty set.
    BatteryStatus::absent()
}

/// Normalise `State::Full` to `State::Charging` when the OS is still
/// estimating a time-to-full — the "topping off at displayed 100 %"
/// case that macOS shows the charging bolt for even though
/// `starship-battery` returns `State::Full`.
///
/// Split out so the normalisation is directly unit-testable without
/// having to mock a `starship-battery` iterator, and so callers can
/// see the rule at a glance rather than inline in the loop above.
pub(crate) fn effective_charging_state(raw: State, time_to_full_secs: Option<u64>) -> State {
    // A `time_to_full` of exactly 0 seconds is honestly "done, no
    // more energy to add" — we treat that as `Full` too, matching
    // what a user sees when the menu-bar bolt has just gone away.
    let still_topping_off = time_to_full_secs.is_some_and(|s| s > 0);
    if matches!(raw, State::Full) && still_topping_off {
        State::Charging
    } else {
        raw
    }
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
/// | `Full`        | `true`        | `false`    | Plugged in, battery at true 100%, at rest.|
/// | `Discharging` | `false`       | `false`    | On battery, energy flowing out.          |
///
/// Note: `State::Full` reaches this function only when the caller
/// has already ruled out the topping-off case (see
/// [`effective_charging_state`]), so a `Full` here is genuinely a
/// battery at rest on AC.
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
fn snapshot_from(
    ratio: f32,
    state: State,
    seconds_remaining: Option<u64>,
) -> Option<BatteryStatus> {
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
        seconds_remaining,
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
    /// Swap in use (not merely allocated) — matches what
    /// `sysinfo::System::used_swap()` returns. Zero on machines
    /// where swap is turned off entirely, which is a signal to
    /// the frontend to hide the swap line rather than print `0.0`.
    pub swap_used_bytes: u64,
    /// Configured swap capacity. When `0`, no swap is configured
    /// (some Linux boxes, some sealed appliances); the frontend
    /// hides the whole swap line rather than showing `0.0 / 0.0`.
    pub swap_total_bytes: u64,
    /// One-minute load average. `None` on Windows, which has no
    /// equivalent metric — `sysinfo` documents `load_average` as not
    /// working there and returns zeros, and rendering "load 0.00"
    /// would be a fabricated reading rather than a missing one.
    pub load_average_one: Option<f64>,
    /// Physical core count, or `None` when the platform won't say.
    /// Physical rather than logical: "4 cores" on an 8-thread machine
    /// is what the user recognises as their hardware.
    pub core_count: Option<usize>,
}

/// Bars in the sparkline the CPU card renders. The backend owns the
/// window so every OS window shows the *same* history — see
/// [`SystemLoadSeries`].
pub const HISTORY_LEN: usize = 24;

/// How often the sampler refreshes. Fixed here rather than driven by
/// the frontend: `sysinfo` derives CPU usage from the delta between
/// successive refreshes, so the cadence is part of what the number
/// *means*, not a display preference.
pub const SAMPLE_INTERVAL: Duration = Duration::from_secs(2);

/// The latest snapshot plus the recent history behind it.
///
/// Both live in the backend because they are host-global facts (spec
/// §19 D3) and every window must agree on them. The previous design
/// let each window poll on its own timer and keep its own ring
/// buffer, which broke in two ways at once: the windows sampled at
/// different instants, and — worse — each poll refreshed the shared
/// `System`, resetting the delta baseline for the others. A window's
/// "2-second" reading was really the interval since some *other*
/// window last refreshed.
/// Bytes/sec out and in for one interface, keyed by its name so the
/// frontend can join it to the descriptive data from `netif`, which
/// refreshes on a slower tier (spec §19 D5 item 3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InterfaceRate {
    pub name: String,
    pub up_bps: u64,
    pub down_bps: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SystemLoadSeries {
    pub current: SystemLoad,
    /// Per-interface throughput, every non-loopback interface the OS
    /// reports. Empty on the first sample: throughput is a delta, and
    /// with no previous sample there is no interval to divide by.
    pub net_rates: Vec<InterfaceRate>,
    /// Oldest first, newest last. At most [`HISTORY_LEN`] entries,
    /// and shorter than that until the sampler has run long enough —
    /// the card draws empty slots rather than inventing readings.
    pub history: Vec<f32>,
}

impl SystemLoadSeries {
    /// The pre-probe state: no reading, no history. `mem_total_bytes`
    /// of zero is the frontend's "not ready" sentinel.
    fn empty() -> Self {
        Self {
            current: SystemLoad {
                cpu_percent: 0.0,
                mem_used_bytes: 0,
                mem_total_bytes: 0,
                swap_used_bytes: 0,
                swap_total_bytes: 0,
                load_average_one: None,
                core_count: None,
            },
            net_rates: Vec::new(),
            history: Vec::new(),
        }
    }
}

/// Network counters, refreshed alongside `SYS` by the sampler.
/// `NetworkData::received` / `transmitted` report bytes *since the
/// last refresh*, so like CPU this is a delta whose meaning depends
/// on who refreshed last — one owner, one cadence.
static NETS: Mutex<Option<Networks>> = Mutex::new(None);

/// Bytes/sec out and in for every non-loopback interface.
///
/// Per-interface rather than summed: the card now pages through
/// interfaces, and each must report its own traffic. Summing was
/// always the wrong reading anyway — it counts VPN and Docker
/// adapters, so a `docker pull` reported roughly double what crossed
/// the wire.
fn sample_network(elapsed: Duration) -> Vec<InterfaceRate> {
    let mut guard = NETS.lock().unwrap_or_else(|e| e.into_inner());
    let nets = guard.get_or_insert_with(Networks::new_with_refreshed_list);
    nets.refresh();
    // Guard against a zero or absurdly small interval turning a
    // handful of bytes into a fictional gigabit.
    let seconds = elapsed.as_secs_f64().max(0.001);
    let per_sec = |bytes: u64| -> u64 {
        let rate = (bytes as f64 / seconds).round();
        if rate.is_finite() && rate >= 0.0 {
            rate as u64
        } else {
            0
        }
    };
    nets.list()
        .iter()
        .filter(|(name, _)| !is_loopback_name(name))
        .map(|(name, data)| InterfaceRate {
            name: name.clone(),
            up_bps: per_sec(data.transmitted()),
            down_bps: per_sec(data.received()),
        })
        .collect()
}

fn is_loopback_name(name: &str) -> bool {
    name == "lo" || name.starts_with("lo0")
}

/// Shared `System` instance so CPU deltas are meaningful. `sysinfo`
/// computes CPU usage from the delta between two calls to
/// `refresh_cpu_usage()`; a fresh `System::new()` per probe would
/// always return 0.
///
/// Only [`sample_once`] touches it, and only from the single sampler
/// task, which is what keeps the delta interval honest.
static SYS: Mutex<Option<System>> = Mutex::new(None);

/// The series every window reads.
static SERIES: Mutex<Option<SystemLoadSeries>> = Mutex::new(None);

fn series_lock() -> std::sync::MutexGuard<'static, Option<SystemLoadSeries>> {
    SERIES.lock().unwrap_or_else(|e| e.into_inner())
}

/// Refresh once and fold the result into the shared series. Returns
/// the new series so the caller can broadcast it.
/// When the previous sample ran, so throughput can be a *rate*
/// rather than "bytes since some unspecified moment". The sampler's
/// cadence is fixed, but a stalled runtime or a debugger pause would
/// otherwise silently inflate the number.
static LAST_SAMPLE_AT: Mutex<Option<Instant>> = Mutex::new(None);

fn sample_once() -> SystemLoadSeries {
    let elapsed = {
        let mut guard = LAST_SAMPLE_AT.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let elapsed = guard.map(|previous| now.saturating_duration_since(previous));
        *guard = Some(now);
        elapsed
    };
    // No previous sample means no interval, so no rate. The first
    // reading reports `None` rather than dividing by an assumed
    // cadence.
    let net_rates = match elapsed {
        Some(elapsed) => sample_network(elapsed),
        None => {
            // Still refresh so the *next* sample has a baseline.
            let mut guard = NETS.lock().unwrap_or_else(|e| e.into_inner());
            guard
                .get_or_insert_with(Networks::new_with_refreshed_list)
                .refresh();
            Vec::new()
        }
    };
    let current = {
        let mut guard = SYS.lock().unwrap_or_else(|e| e.into_inner());
        let sys = guard.get_or_insert_with(|| {
            // `RefreshKind::new()` builds an empty spec; we opt in
            // only to CPU + memory so `sysinfo` doesn't scan disks,
            // processes, or the network on every refresh (all
            // defaulted off in our Cargo feature set anyway, but
            // explicit here as belt + braces).
            System::new_with_specifics(
                RefreshKind::new()
                    .with_cpu(sysinfo::CpuRefreshKind::everything())
                    .with_memory(MemoryRefreshKind::everything()),
            )
        });
        sys.refresh_cpu_usage();
        // `refresh_memory()` also refreshes swap in sysinfo 0.32 —
        // one call, both signals. `MemoryRefreshKind::everything()`
        // on the initialiser above enables swap alongside RAM.
        sys.refresh_memory();
        SystemLoad {
            cpu_percent: sys.global_cpu_usage(),
            mem_used_bytes: sys.used_memory(),
            mem_total_bytes: sys.total_memory(),
            swap_used_bytes: sys.used_swap(),
            swap_total_bytes: sys.total_swap(),
            load_average_one: load_average_one(),
            core_count: sys.physical_core_count(),
        }
    };

    let mut guard = series_lock();
    let series = guard.get_or_insert_with(SystemLoadSeries::empty);
    series.current = current;
    series.net_rates = net_rates;
    series.history.push(current.cpu_percent);
    if series.history.len() > HISTORY_LEN {
        // `drain` rather than rebuilding: the buffer is 24 floats, but
        // this runs every 2s for the life of the process.
        let excess = series.history.len() - HISTORY_LEN;
        series.history.drain(..excess);
    }
    series.clone()
}

/// Drive the sampler for the life of the app, broadcasting each
/// sample to every window.
///
/// One task, one cadence, one delta baseline — regardless of how many
/// windows are open. Spawned from `lib.rs`'s setup hook.
pub fn spawn_sampler(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // `sysinfo` needs two refreshes to compute a delta, so the
        // very first sample is always 0%. Take it immediately and
        // discard it rather than publishing a reading we know is
        // meaningless.
        let _priming = sample_once();
        {
            let mut guard = series_lock();
            if let Some(series) = guard.as_mut() {
                series.history.clear();
            }
        }
        let mut ticker = tokio::time::interval(SAMPLE_INTERVAL);
        // The first tick completes immediately; skip it so the
        // priming sample above isn't immediately followed by a second
        // one a few microseconds later.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let series = sample_once();
            if let Err(e) = app.emit("shax:system-load", &series) {
                tracing::debug!("system-load broadcast failed: {e}");
            }
        }
    });
}

/// The current series, for a window mounting mid-stream. Without
/// this, a window opened an hour in would start with an empty
/// sparkline while its sibling showed a full one.
#[tauri::command]
pub fn system_load_series() -> SystemLoadSeries {
    series_lock()
        .clone()
        .unwrap_or_else(SystemLoadSeries::empty)
}

/// One-minute load average, or `None` where the platform has no such
/// number to give.
#[cfg(not(target_os = "windows"))]
fn load_average_one() -> Option<f64> {
    Some(System::load_average().one)
}

/// Windows has no load average. `sysinfo` returns zeros rather than
/// failing, so the `cfg` — not a runtime check — is what keeps a
/// meaningless 0.00 off the card.
#[cfg(target_os = "windows")]
fn load_average_one() -> Option<f64> {
    None
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
            seconds_remaining: Some(3_600),
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
        assert!(json.contains(r#""seconds_remaining":null"#));
    }

    #[test]
    fn snapshot_from_returns_none_for_nan_state_of_charge() {
        // The Mac Mini phantom-entry case: IOKit hands us a
        // non-finite state-of-charge. `snapshot_from` must reject it
        // so the caller can try the next entry (or fall through to
        // `absent()` and render the desktop plug-alone chip).
        assert!(snapshot_from(f32::NAN, State::Discharging, None).is_none());
        assert!(snapshot_from(f32::INFINITY, State::Full, None).is_none());
        assert!(snapshot_from(f32::NEG_INFINITY, State::Charging, None).is_none());
    }

    #[test]
    fn snapshot_from_maps_state_charging_to_both_flags_true() {
        // Actively drawing energy into the battery.
        let s = snapshot_from(0.45, State::Charging, Some(1_800)).expect("charging is real");
        assert!(s.on_ac_power);
        assert!(s.charging);
        assert_eq!(s.percent, Some(45));
        assert_eq!(s.seconds_remaining, Some(1_800));
    }

    #[test]
    fn snapshot_from_maps_state_full_to_on_ac_but_not_charging() {
        // Plugged-in laptop at 100%. macOS reports IsCharging=false
        // in this case — the OS-level distinction we're preserving.
        let s = snapshot_from(1.00, State::Full, None).expect("full is real");
        assert!(s.on_ac_power);
        assert!(!s.charging);
        assert_eq!(s.percent, Some(100));
        // No time-remaining at the rest state — nothing to count
        // down to, nothing to charge toward.
        assert_eq!(s.seconds_remaining, None);
    }

    #[test]
    fn snapshot_from_maps_state_discharging_to_neither_flag() {
        // Unplugged laptop consuming battery. Note: even at 100%
        // (unplugged full-charge laptop), Discharging still resolves
        // to on-battery — this is the MBP bug the mapping fixes.
        let s = snapshot_from(1.00, State::Discharging, Some(14_400)).expect("discharging is real");
        assert!(!s.on_ac_power);
        assert!(!s.charging);
        assert_eq!(s.percent, Some(100));
        assert_eq!(s.seconds_remaining, Some(14_400));
    }

    #[test]
    fn snapshot_from_maps_state_empty_to_neither_flag() {
        let s = snapshot_from(0.00, State::Empty, None).expect("empty is real");
        assert!(!s.on_ac_power);
        assert!(!s.charging);
        assert_eq!(s.percent, Some(0));
    }

    #[test]
    fn effective_charging_state_normalises_topping_off_full_to_charging() {
        // The bug this fixed: macOS reports `State::Full` at displayed
        // 100 % while the OS is still adding energy behind the scenes,
        // and the menu-bar bolt is visible. Without normalisation, our
        // widget honestly said `charging = false` while macOS said the
        // opposite.
        assert_eq!(
            effective_charging_state(State::Full, Some(120)),
            State::Charging
        );
        assert_eq!(
            effective_charging_state(State::Full, Some(1)),
            State::Charging
        );
    }

    #[test]
    fn effective_charging_state_leaves_true_full_alone() {
        // A `Full` with no time-to-full estimate is honestly full —
        // no more energy to add. Leave the state as-is so the widget
        // reads "on AC, at rest" rather than a fake "charging" halo.
        assert_eq!(effective_charging_state(State::Full, None), State::Full);
        // Zero-second time-to-full is treated as "just finished,
        // done" — matches what a user sees when the menu-bar bolt has
        // just gone away.
        assert_eq!(effective_charging_state(State::Full, Some(0)), State::Full);
    }

    #[test]
    fn effective_charging_state_is_a_no_op_for_non_full_states() {
        // Charging stays charging (with or without an estimate),
        // discharging stays discharging, unknown stays unknown.
        assert_eq!(
            effective_charging_state(State::Charging, Some(120)),
            State::Charging
        );
        assert_eq!(
            effective_charging_state(State::Charging, None),
            State::Charging
        );
        assert_eq!(
            effective_charging_state(State::Discharging, Some(9_999)),
            State::Discharging
        );
        assert_eq!(
            effective_charging_state(State::Discharging, None),
            State::Discharging
        );
        assert_eq!(
            effective_charging_state(State::Unknown, Some(120)),
            State::Unknown
        );
        assert_eq!(effective_charging_state(State::Empty, None), State::Empty);
    }

    #[test]
    fn snapshot_from_maps_state_unknown_to_neither_flag_defensively() {
        // Ambiguous OS state: default to "on battery" so we never
        // silently misreport an unplugged laptop as AC power.
        let s = snapshot_from(0.55, State::Unknown, None).expect("unknown is real");
        assert!(!s.on_ac_power);
        assert!(!s.charging);
        assert_eq!(s.percent, Some(55));
    }

    #[test]
    fn snapshot_from_clamps_out_of_range_ratios() {
        // Noisy firmware occasionally reports slightly outside
        // 0.0..=1.0 — we clamp rather than reject, because the
        // battery is still real.
        let over = snapshot_from(1.03, State::Discharging, None).expect("clamped");
        assert_eq!(over.percent, Some(100));
        let under = snapshot_from(-0.02, State::Discharging, None).expect("clamped");
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

    /// `SYS` and `SERIES` are process-global and `cargo test` runs on
    /// parallel threads, so a sampling test would otherwise race
    /// every other one — the history it measures could advance under
    /// it. Every test that samples or reads the series takes this.
    static SERIES_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn serialised() -> std::sync::MutexGuard<'static, ()> {
        SERIES_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn cpu_and_mem_shape_is_sane() {
        let _guard = serialised();
        // Smoke test only — probe values are runtime-dependent
        // (a beefy dev box vs a CI runner). Assert the shape, not
        // the numbers.
        let load = sample_once().current;
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
    fn load_average_is_present_off_windows_and_absent_on_it() {
        let _guard = serialised();
        // The whole point of the Option: `sysinfo` returns zeros on
        // Windows rather than failing, so a naive f64 would render a
        // confident, meaningless "load 0.00" there.
        let load = sample_once().current;
        #[cfg(target_os = "windows")]
        assert!(
            load.load_average_one.is_none(),
            "Windows has no load average to report",
        );
        #[cfg(not(target_os = "windows"))]
        match load.load_average_one {
            Some(one) => assert!(
                one >= 0.0 && one.is_finite(),
                "load average should be a finite non-negative number, got {one}",
            ),
            None => panic!("unix platforms should report a load average"),
        }
    }

    #[test]
    fn core_count_is_absent_or_positive() {
        let _guard = serialised();
        // `physical_core_count` is best-effort; the contract the
        // widget relies on is that a reported count is never zero,
        // since "0 cores" would be a visibly wrong reading.
        if let Some(cores) = sample_once().current.core_count {
            assert!(cores > 0, "a reported core count must be positive");
        }
    }

    #[test]
    fn the_history_window_never_exceeds_its_bound() {
        let _guard = serialised();
        // The sampler runs for the life of the process, so an
        // unbounded buffer would be a slow leak rather than a visible
        // bug.
        for _ in 0..(HISTORY_LEN + 5) {
            sample_once();
        }
        let series = system_load_series();
        assert!(
            series.history.len() <= HISTORY_LEN,
            "history grew to {} entries, bound is {HISTORY_LEN}",
            series.history.len(),
        );
    }

    #[test]
    fn every_reader_sees_the_same_series() {
        let _guard = serialised();
        // The bug this design exists to prevent: two windows showing
        // different numbers for one machine. Reading twice without an
        // intervening sample must give identical answers, and neither
        // read may perturb the sampler's delta baseline.
        sample_once();
        let first = system_load_series();
        let second = system_load_series();
        assert_eq!(first, second);
    }

    #[test]
    fn a_new_sample_appends_to_the_shared_history() {
        let _guard = serialised();
        let before = system_load_series().history.len();
        sample_once();
        let after = system_load_series().history.len();
        // Either it grew, or it was already at the bound and slid.
        assert!(
            after == (before + 1).min(HISTORY_LEN),
            "expected the window to advance: {before} -> {after}",
        );
    }

    #[test]
    fn the_first_sample_reports_no_throughput_rate() {
        // Throughput is a delta. With no previous sample there is no
        // interval to divide by, and assuming the nominal cadence
        // would invent a rate for bytes we never timed.
        let _guard = serialised();
        {
            let mut guard = LAST_SAMPLE_AT.lock().unwrap_or_else(|e| e.into_inner());
            *guard = None;
        }
        let first = sample_once();
        assert!(
            first.net_rates.is_empty(),
            "with no previous sample there is no interval, so no rate",
        );
    }

    #[test]
    fn later_samples_report_a_finite_rate_or_nothing() {
        // Runtime-dependent (a CI runner may have no resolvable
        // primary interface), so assert the shape: either we have a
        // number, or we honestly have none. Never a garbage one.
        let _guard = serialised();
        sample_once();
        let second = sample_once();
        for rate in &second.net_rates {
            assert!(
                rate.up_bps < u64::MAX && rate.down_bps < u64::MAX,
                "rates should be real numbers, got {rate:?}",
            );
            assert!(
                !rate.name.is_empty(),
                "every rate must name the interface it describes, or it cannot be joined",
            );
        }
    }

    #[test]
    fn loopback_is_not_mistaken_for_a_real_interface() {
        assert!(is_loopback_name("lo"));
        assert!(is_loopback_name("lo0"));
        assert!(!is_loopback_name("en0"));
        assert!(!is_loopback_name("eth0"));
        // Guard against a prefix match that would swallow real
        // interfaces whose names merely start with "lo".
        assert!(!is_loopback_name("long0"));
    }

    #[test]
    fn cpu_and_mem_second_call_stabilises_cpu() {
        let _guard = serialised();
        // The first call primes the CPU stats; the second returns a
        // real percentage. Just confirm both calls return finite,
        // in-range values (some CIs stay at 0% between refreshes).
        let _first = sample_once();
        let second = sample_once().current;
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
