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
/// - `on_ac_power` — is the machine currently plugged in? True for all
///   three plugged-in states: actively charging, "charged" at 100 %
///   (macOS reports `IsCharging=false, FullyCharged=true`), and
///   charging held below 100 % by macOS's optimised-charging schedule
///   (`IsCharging=false, FullyCharged=false`, which `starship-battery`
///   can only call `State::Unknown`). False for a laptop on battery —
///   including a fully-charged laptop that was just unplugged. This is
///   the "is the bolt / plug lit?" flag: the statusbar picks the plug
///   icon over the battery-fill icon on it, and the sidebar widget
///   shows its charging bolt on it (see the M13.5.3 note below).
/// - `charging` — is the battery actively being *charged* right now?
///   True only when energy is flowing into the cell. False when on
///   battery, false when fully charged on AC, false when charging is
///   held. This drives the *wording* — "Charging" vs "Charged" vs "On
///   AC power" — and the `… to full` estimate, never the icon.
///
/// **Do not gate a plugged-in indicator on `charging` (M13.5.3).** It
/// is the narrower flag, and macOS clears it the moment the battery
/// reaches full or the charge schedule pauses — so a bolt keyed on it
/// vanishes at exactly 100 % while the cable is still in, which is
/// what the menu bar (keyed on external power) never does.
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
        // the charging bolt in the menu bar in that state.
        //
        // The first cut of this used `starship-battery.time_to_full`
        // as the signal, but empirically that field is `None` on
        // macOS in the topping-off case (starship-battery's macOS
        // backend doesn't surface IOKit's `AvgTimeToFull` there), so
        // the escape hatch never fired. We now fall back to `pmset
        // -g batt` on macOS — the same source the menu bar reads —
        // whose "charging" / "charged" / "discharging" keyword is
        // authoritative. If `pmset` fails (unlikely; it ships with
        // every macOS) we fall through to the starship-battery
        // reading. Other platforms are unaffected.
        let time_to_full_secs = sanitise_time_estimate(battery.time_to_full().map(|d| d.value));
        let time_to_empty_secs = sanitise_time_estimate(battery.time_to_empty().map(|d| d.value));
        let pmset = macos_pmset_output();
        let pmset_hint = pmset.as_deref().and_then(parse_pmset_state);
        let effective_state =
            effective_charging_state(battery.state(), time_to_full_secs, pmset_hint);
        // `pmset`'s "Now drawing from …" header answers "is the cable
        // in?" directly. The state enum can only infer it, and infers
        // wrong whenever macOS is plugged in but not charging.
        let on_ac_power = pmset
            .as_deref()
            .and_then(parse_pmset_on_ac)
            .unwrap_or_else(|| ac_power_from_state(effective_state));
        let seconds_remaining = match effective_state {
            State::Charging => time_to_full_secs,
            State::Discharging => time_to_empty_secs,
            _ => None,
        };
        if let Some(status) = snapshot_from(ratio, effective_state, on_ac_power, seconds_remaining)
        {
            return status;
        }
    }
    // No batteries in the iterator — desktop machine, or the OS
    // reported an empty set.
    BatteryStatus::absent()
}

/// What macOS's `pmset -g batt` says the battery is doing, when we
/// can get an answer. Non-macOS platforms return `None` and the
/// caller falls through to the starship-battery reading.
///
/// The variants are only constructed inside `macos_pmset_state`,
/// which is `#[cfg(target_os = "macos")]`. Off macOS the type still
/// exists (it's in `effective_charging_state`'s signature — a
/// cross-platform sig with a platform-specific input) but nothing
/// constructs the variants, so we allow dead-code there. Tests
/// exercise the parser on every platform and keep the whole thing
/// honestly covered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) enum PmsetHint {
    Charging,
    Charged,
    Discharging,
    /// `AC attached; not charging` — plugged in, below 100 %, with
    /// macOS holding the charge (optimised battery charging, or a
    /// thermal / firmware hold). Energy is flowing neither in nor
    /// out of the cell.
    NotCharging,
}

/// Normalise the raw `starship-battery` state using two signals that
/// each fire in cases the base state misses:
///
/// 1. `time_to_full_secs > 0` while state is `Full` — some Linux
///    setups surface `AvgTimeToFull` even at displayed 100 %.
/// 2. macOS `pmset` hint — starship-battery on macOS reports
///    `State::Full` at displayed 100 % even when IOKit says
///    `IsCharging=true`; the menu bar reads the same signal `pmset`
///    exposes as the `charging` / `charged` keyword. When we can get
///    a `pmset` reading, it wins.
///
/// Split out so the normalisation is directly unit-testable without
/// having to mock a `starship-battery` iterator or spawn `pmset`.
pub(crate) fn effective_charging_state(
    raw: State,
    time_to_full_secs: Option<u64>,
    pmset_hint: Option<PmsetHint>,
) -> State {
    // pmset takes precedence — it's what macOS's own menu bar
    // reads. On non-macOS this is always `None` and we fall through.
    match pmset_hint {
        Some(PmsetHint::Charging) => return State::Charging,
        Some(PmsetHint::Discharging) => return State::Discharging,
        Some(PmsetHint::Charged) => {
            // "Charged" means at 100 % with the port connected and
            // no more energy flowing in — the plug-alone state in
            // the menu bar. Match `State::Full`.
            if matches!(raw, State::Charging | State::Full) {
                return State::Full;
            }
        }
        // Plugged in with the charge held: not charging, but not
        // discharging either, and emphatically not `Full` — it can
        // sit at 80 %. `Unknown` is the honest answer, and with
        // `on_ac_power` now read from pmset's header rather than
        // inferred from this enum, it no longer implies "on battery".
        Some(PmsetHint::NotCharging) => return State::Unknown,
        None => {}
    }
    // Fallback: time-to-full > 0 while `Full` also means topping
    // off, per the first cut of this fix. Kept because it costs
    // nothing on macOS (where pmset already answered) and covers
    // Linux / Windows machines whose backends surface the estimate.
    let still_topping_off = time_to_full_secs.is_some_and(|s| s > 0);
    if matches!(raw, State::Full) && still_topping_off {
        State::Charging
    } else {
        raw
    }
}

/// Anything the OS reports beyond this many seconds is treated as
/// "no estimate available." IOKit emits `0xFFFF` minutes (~45 days,
/// 1092h 15m — exactly what a user reported seeing rendered as
/// `1092h 15m to full`) as its sentinel for "can't calculate right
/// now"; `pmset` parses that as `(no estimate)`. `starship-battery`
/// passes the sentinel through raw, so we filter here.
///
/// The 24-hour ceiling is generous: even a badly-degraded battery
/// charging at 5W USB-C never claims longer than that legitimately.
const MAX_PLAUSIBLE_TIME_SECS: u64 = 24 * 60 * 60;

/// Convert a raw seconds reading (as `starship-battery` hands back
/// via `Time::value`) to whole seconds, filtering out:
///   - `None` inputs
///   - non-finite or negative readings (firmware oddities)
///   - exact zero (frontend hides the label rather than showing `0m`)
///   - anything above `MAX_PLAUSIBLE_TIME_SECS` (the IOKit "no
///     estimate" sentinel and its cousins)
///
/// Pure on `Option<f32>` so tests don't need to construct the crate's
/// `Time` unit — the caller does the trivial `.map(|d| d.value)`
/// before handing the seconds in.
pub(crate) fn sanitise_time_estimate(secs: Option<f32>) -> Option<u64> {
    let secs = secs?;
    if !secs.is_finite() || secs < 0.0 {
        return None;
    }
    let rounded = secs.round() as u64;
    if rounded == 0 || rounded > MAX_PLAUSIBLE_TIME_SECS {
        return None;
    }
    Some(rounded)
}

/// Capture `pmset -g batt` output. `None` on non-macOS or on
/// subprocess failure, in which case both pmset-derived signals fall
/// back to the `starship-battery` reading.
///
/// One spawn feeds both parsers ([`parse_pmset_state`] for what the
/// battery is doing, [`parse_pmset_on_ac`] for whether the cable is
/// in) — the poll runs every 5s, so spawning twice would double a
/// cost we already pay reluctantly.
///
/// The command is stable across macOS versions (it ships with the OS)
/// and its output is two short lines.
fn macos_pmset_output() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/pmset")
            .arg("-g")
            .arg("batt")
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8(output.stdout).ok()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Parse `pmset -g batt` output for the state keyword. Output looks
/// like (tab between id and percent replaced with spaces here to keep
/// clippy happy):
///
/// ```text
/// Now drawing from 'AC Power'
///  -InternalBattery-0 (id=1234567)  100%; charging; 0:12 remaining present: true
/// ```
///
/// The keyword sits between the percent and the time-remaining field,
/// bounded by semicolons. Exported so tests can pin every branch
/// against captured strings without shelling out.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn parse_pmset_state(text: &str) -> Option<PmsetHint> {
    // Search the whole text rather than pinning to a specific line —
    // pmset's output layout has varied over macOS versions, but the
    // keywords themselves are stable and always appear in the battery
    // stanza. Priority order matters because the shorter keywords are
    // substrings of the longer ones:
    //   - `not charging` first, or the `charging` arm below would
    //     claim the held-charge line (`80%; AC attached; not
    //     charging`) and light the bolt as if energy were flowing in
    //   - `discharging` next (contains `charging` as a substring)
    //   - `charged` before `charging` (specificity)
    //   - `finishing charge` before `charging` (the near-100 %
    //     topping-off keyword — also contains `charging` if you
    //     squint at `finishing charge`, but the explicit match here
    //     documents the state rather than relying on that)
    //   - `charging` last, as the general case
    let lower = text.to_ascii_lowercase();
    if lower.contains("not charging") {
        return Some(PmsetHint::NotCharging);
    }
    if lower.contains("discharging") {
        return Some(PmsetHint::Discharging);
    }
    if lower.contains("charged") {
        return Some(PmsetHint::Charged);
    }
    if lower.contains("finishing charge") || lower.contains("charging") {
        return Some(PmsetHint::Charging);
    }
    None
}

/// Parse `pmset -g batt`'s header line for whether the machine is
/// plugged in:
///
/// ```text
/// Now drawing from 'AC Power'        → Some(true)
/// Now drawing from 'Battery Power'   → Some(false)
/// ```
///
/// This is the signal macOS's own menu bar lights its bolt on, and
/// the one signal `starship-battery`'s `State` enum cannot express:
/// plugged in but neither charging nor full collapses to
/// `State::Unknown`, indistinguishable from a genuinely unknown
/// reading. `None` when neither phrase is present, leaving the caller
/// on its state-derived fallback.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn parse_pmset_on_ac(text: &str) -> Option<bool> {
    let lower = text.to_ascii_lowercase();
    if lower.contains("'ac power'") {
        return Some(true);
    }
    if lower.contains("'battery power'") {
        return Some(false);
    }
    None
}

/// Whether a `State` implies wall power, for platforms where we have
/// no better signal than the enum. Charging and Full are the only two
/// states that can only happen with a cable in; `Unknown` is ambiguous
/// and we resolve it the safe way (see the `Unknown` note on
/// [`snapshot_from`]).
fn ac_power_from_state(state: State) -> bool {
    matches!(state, State::Charging | State::Full)
}

/// Turn a raw (state-of-charge ratio, `starship-battery` state)
/// reading into a [`BatteryStatus`], or [`None`] if the entry looks
/// phantom.
///
/// **State mapping.** The `State` enum reports what the OS thinks the
/// battery is doing right now; `charging` is read off it alone.
/// `on_ac_power` is passed in separately by the caller, because the
/// enum cannot express it (see [`parse_pmset_on_ac`]) — the column
/// below is only what [`ac_power_from_state`] infers when no better
/// signal is available.
///
/// | `State`       | `on_ac_power`* | `charging` | Real-world case                           |
/// | ------------- | -------------- | ---------- | ----------------------------------------- |
/// | `Charging`    | `true`         | `true`     | Plugged in, drawing energy into battery.  |
/// | `Full`        | `true`         | `false`    | Plugged in, battery at true 100%, at rest.|
/// | `Discharging` | `false`        | `false`    | On battery, energy flowing out.           |
/// | `Empty`       | `false`        | `false`    | On battery, 0%.                           |
/// | `Unknown`     | `false`        | `false`    | Defensive default — assume on battery.    |
///
/// Note: `State::Full` reaches this function only when the caller
/// has already ruled out the topping-off case (see
/// [`effective_charging_state`]), so a `Full` here is genuinely a
/// battery at rest on AC.
///
/// The `Unknown` default matters: an unplugged laptop at 100% that
/// momentarily reports `Unknown` should not flash the plug icon. The
/// worst case of getting this wrong is a plugged-in laptop briefly
/// showing the battery icon, which is a self-correcting visual glitch
/// versus a stationary lie about power state. On macOS the pmset
/// header answers the question outright, so the default only bites
/// on platforms without one.
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
    on_ac_power: bool,
    seconds_remaining: Option<u64>,
) -> Option<BatteryStatus> {
    if !ratio.is_finite() {
        tracing::debug!("skipping battery entry with non-finite state-of-charge");
        return None;
    }
    // `state_of_charge()` is nominally 0.0..=1.0; noisy firmware can
    // report slightly outside that range, so clamp before scaling.
    let percent = (ratio.clamp(0.0, 1.0) * 100.0).round() as u8;
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
        assert!(snapshot_from(f32::NAN, State::Discharging, false, None).is_none());
        assert!(snapshot_from(f32::INFINITY, State::Full, true, None).is_none());
        assert!(snapshot_from(f32::NEG_INFINITY, State::Charging, true, None).is_none());
    }

    #[test]
    fn snapshot_from_maps_state_charging_to_both_flags_true() {
        // Actively drawing energy into the battery.
        let s = snapshot_from(0.45, State::Charging, true, Some(1_800)).expect("charging is real");
        assert!(s.on_ac_power);
        assert!(s.charging);
        assert_eq!(s.percent, Some(45));
        assert_eq!(s.seconds_remaining, Some(1_800));
    }

    #[test]
    fn snapshot_from_maps_state_full_to_on_ac_but_not_charging() {
        // Plugged-in laptop at 100%. macOS reports IsCharging=false
        // in this case — the OS-level distinction we're preserving.
        let s = snapshot_from(1.00, State::Full, true, None).expect("full is real");
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
        let s = snapshot_from(1.00, State::Discharging, false, Some(14_400))
            .expect("discharging is real");
        assert!(!s.on_ac_power);
        assert!(!s.charging);
        assert_eq!(s.percent, Some(100));
        assert_eq!(s.seconds_remaining, Some(14_400));
    }

    #[test]
    fn snapshot_from_maps_state_empty_to_neither_flag() {
        let s = snapshot_from(0.00, State::Empty, false, None).expect("empty is real");
        assert!(!s.on_ac_power);
        assert!(!s.charging);
        assert_eq!(s.percent, Some(0));
    }

    #[test]
    fn effective_charging_state_pmset_charging_wins_over_starship_full() {
        // The bug this fixed: macOS `State::Full` at displayed 100 %
        // while the menu bar shows the bolt because IOKit says
        // `IsCharging=true`. `pmset` sees that too and hands us
        // `Charging`; we take that over the starship-battery reading.
        assert_eq!(
            effective_charging_state(State::Full, None, Some(PmsetHint::Charging)),
            State::Charging
        );
        // Also wins over `Discharging` in the wildly unlikely case
        // starship-battery lies the other way. pmset is authority.
        assert_eq!(
            effective_charging_state(State::Discharging, None, Some(PmsetHint::Charging)),
            State::Charging
        );
    }

    #[test]
    fn effective_charging_state_pmset_charged_maps_to_full() {
        // `charged` in pmset output means at 100 % on AC with no
        // energy flowing in — the plug-alone state in the menu bar.
        // Regardless of what starship-battery says, we call that Full.
        assert_eq!(
            effective_charging_state(State::Charging, Some(120), Some(PmsetHint::Charged)),
            State::Full
        );
        assert_eq!(
            effective_charging_state(State::Full, None, Some(PmsetHint::Charged)),
            State::Full
        );
    }

    #[test]
    fn effective_charging_state_pmset_discharging_wins() {
        assert_eq!(
            effective_charging_state(State::Full, Some(120), Some(PmsetHint::Discharging)),
            State::Discharging
        );
    }

    #[test]
    fn effective_charging_state_falls_back_to_time_estimate_without_pmset() {
        // Non-macOS platforms (and any macOS where pmset failed) get
        // None from the hint and fall through to the time-to-full
        // signal — the first cut of this fix, kept as a backstop.
        assert_eq!(
            effective_charging_state(State::Full, Some(120), None),
            State::Charging
        );
        assert_eq!(
            effective_charging_state(State::Full, None, None),
            State::Full
        );
        assert_eq!(
            effective_charging_state(State::Full, Some(0), None),
            State::Full
        );
    }

    #[test]
    fn effective_charging_state_is_a_no_op_for_non_full_when_no_hints_apply() {
        // Charging stays charging, discharging stays discharging,
        // unknown stays unknown — as long as pmset isn't overruling.
        assert_eq!(
            effective_charging_state(State::Charging, Some(120), None),
            State::Charging
        );
        assert_eq!(
            effective_charging_state(State::Discharging, None, None),
            State::Discharging
        );
        assert_eq!(
            effective_charging_state(State::Unknown, Some(120), None),
            State::Unknown
        );
        assert_eq!(
            effective_charging_state(State::Empty, None, None),
            State::Empty
        );
    }

    #[test]
    fn parse_pmset_reads_charging_charged_and_discharging_keywords() {
        // Real captured strings from macOS 26. The keyword between
        // `%;` and `; N:NN` is the field we key on.
        let charging =
            " -InternalBattery-0 (id=1234567)\t80%; charging; 0:35 remaining present: true";
        let charged =
            " -InternalBattery-0 (id=1234567)\t100%; charged; 0:00 remaining present: true";
        let discharging =
            " -InternalBattery-0 (id=1234567)\t72%; discharging; 4:20 remaining present: true";
        assert_eq!(parse_pmset_state(charging), Some(PmsetHint::Charging));
        assert_eq!(parse_pmset_state(charged), Some(PmsetHint::Charged));
        assert_eq!(parse_pmset_state(discharging), Some(PmsetHint::Discharging));
    }

    #[test]
    fn parse_pmset_handles_multi_line_output_with_header() {
        // pmset -g batt prints a `Now drawing from ...` header before
        // the battery stanza; the parser has to reach past that.
        let text = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234567)\t100%; charging; 0:12 remaining present: true\n";
        assert_eq!(parse_pmset_state(text), Some(PmsetHint::Charging));
    }

    #[test]
    fn parse_pmset_prefers_specific_keywords_over_the_generic_charging() {
        // `discharging` contains the substring `charging`; the
        // priority order in the parser makes sure we don't mislabel
        // a discharging battery as charging.
        assert_eq!(
            parse_pmset_state("72%; discharging; 4:20 remaining"),
            Some(PmsetHint::Discharging)
        );
        // Same for `charged`, which shouldn't collide with anything
        // but is priority-ordered above `charging` for safety.
        assert_eq!(
            parse_pmset_state("100%; charged; 0:00 remaining"),
            Some(PmsetHint::Charged)
        );
    }

    #[test]
    fn parse_pmset_returns_none_when_no_keyword_present() {
        assert_eq!(parse_pmset_state(""), None);
        assert_eq!(parse_pmset_state("Now drawing from 'AC Power'"), None);
        assert_eq!(parse_pmset_state("some other unrelated output"), None);
    }

    #[test]
    fn parse_pmset_reads_finishing_charge_as_charging() {
        // Real captured string from macOS 26 at 99 %, plugged in.
        // Bolt icon shows in the menu bar; widget should agree.
        let text =
            " -InternalBattery-0 (id=38666339)  99%; finishing charge; (no estimate) present: true";
        assert_eq!(parse_pmset_state(text), Some(PmsetHint::Charging));
    }

    #[test]
    fn parse_pmset_reads_held_charge_as_not_charging() {
        // Real captured string from a Mac with optimised battery
        // charging holding at 80 %. `not charging` contains the
        // substring `charging`, so without its own arm first this
        // line reads as "actively charging" and lights the bolt as
        // if energy were flowing in.
        let text = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234567)\t80%; AC attached; not charging present: true\n";
        assert_eq!(parse_pmset_state(text), Some(PmsetHint::NotCharging));
    }

    #[test]
    fn effective_charging_state_pmset_not_charging_is_neither_direction() {
        // Held charge: not charging, not discharging, and not Full
        // (it can sit at 80 %). `charging` must come out false.
        assert_eq!(
            effective_charging_state(State::Unknown, None, Some(PmsetHint::NotCharging)),
            State::Unknown
        );
        // pmset stays the authority even if starship-battery still
        // reports a stale `Charging`.
        assert_eq!(
            effective_charging_state(State::Charging, Some(120), Some(PmsetHint::NotCharging)),
            State::Unknown
        );
    }

    #[test]
    fn parse_pmset_on_ac_reads_the_drawing_from_header() {
        // The signal the `State` enum cannot carry: plugged in but
        // neither charging nor full. This header is what macOS's own
        // menu bar lights its bolt on.
        assert_eq!(
            parse_pmset_on_ac("Now drawing from 'AC Power'\n -InternalBattery-0\t80%; AC attached; not charging present: true"),
            Some(true)
        );
        assert_eq!(
            parse_pmset_on_ac("Now drawing from 'Battery Power'\n -InternalBattery-0\t72%; discharging; 4:20 remaining present: true"),
            Some(false)
        );
    }

    #[test]
    fn parse_pmset_on_ac_returns_none_without_the_header() {
        // No header, no claim — the caller falls back to the
        // state-derived inference rather than guessing "unplugged".
        assert_eq!(parse_pmset_on_ac(""), None);
        assert_eq!(parse_pmset_on_ac("100%; charged; 0:00 remaining"), None);
    }

    #[test]
    fn ac_power_from_state_infers_the_cable_only_where_the_enum_can() {
        // The non-macOS fallback. `Unknown` deliberately reads as
        // "on battery" — see the `snapshot_from` doc note.
        assert!(ac_power_from_state(State::Charging));
        assert!(ac_power_from_state(State::Full));
        assert!(!ac_power_from_state(State::Discharging));
        assert!(!ac_power_from_state(State::Empty));
        assert!(!ac_power_from_state(State::Unknown));
    }

    #[test]
    fn snapshot_from_takes_on_ac_from_the_caller_not_the_state() {
        // The held-charge case end to end: macOS says plugged in,
        // `starship-battery` can only say `Unknown`. The snapshot has
        // to report on-AC (so the bolt lights) without reporting
        // charging (so the wording stays honest).
        let s = snapshot_from(0.80, State::Unknown, true, None).expect("held charge is real");
        assert!(s.on_ac_power);
        assert!(!s.charging);
        assert_eq!(s.percent, Some(80));
        assert_eq!(s.seconds_remaining, None);
    }

    #[test]
    fn snapshot_from_reports_full_on_ac_as_on_ac_but_not_charging() {
        // The reported M13.5.3 bug's backend half: at 100 % on the
        // cable, macOS reports `charged` / `IsCharging=false`. That
        // is correct and stays — `on_ac_power` is what carries the
        // plugged-in fact, and it must be true here.
        let s = snapshot_from(1.00, State::Full, true, None).expect("charged is real");
        assert!(s.on_ac_power);
        assert!(!s.charging);
    }

    #[test]
    fn sanitise_time_estimate_passes_normal_readings_through() {
        // Real values: 12 minutes to full, 4 h 20 m remaining, 1 s.
        assert_eq!(sanitise_time_estimate(Some(720.0)), Some(720));
        assert_eq!(sanitise_time_estimate(Some(15_600.0)), Some(15_600));
        assert_eq!(sanitise_time_estimate(Some(1.0)), Some(1));
    }

    #[test]
    fn sanitise_time_estimate_filters_the_iokit_no_estimate_sentinel() {
        // The exact bug this fixed: IOKit emits `0xFFFF` minutes
        // (65 535 min = 3 932 100 s ≈ 45 days) as "no estimate",
        // starship-battery passes it through raw, and the frontend
        // rendered it as `1092h 15m to full`. Anything above 24 h
        // is out.
        let sentinel_secs = (0xFFFF_u64 * 60) as f32;
        assert_eq!(sanitise_time_estimate(Some(sentinel_secs)), None);
        // Exact 24 h passes, one second above doesn't.
        assert_eq!(sanitise_time_estimate(Some(86_400.0)), Some(86_400));
        assert_eq!(sanitise_time_estimate(Some(86_401.0)), None);
    }

    #[test]
    fn sanitise_time_estimate_returns_none_for_zero_negatives_and_nan() {
        // Zero: frontend hides the `Nh NNm` label anyway; making it
        // None here means fewer things to reason about downstream.
        assert_eq!(sanitise_time_estimate(Some(0.0)), None);
        // Negatives shouldn't happen but firmware is what it is.
        assert_eq!(sanitise_time_estimate(Some(-1.0)), None);
        // NaN / infinities from bad divisions get filtered too.
        assert_eq!(sanitise_time_estimate(Some(f32::NAN)), None);
        assert_eq!(sanitise_time_estimate(Some(f32::INFINITY)), None);
    }

    #[test]
    fn sanitise_time_estimate_passes_none_through() {
        assert_eq!(sanitise_time_estimate(None), None);
    }

    #[test]
    fn snapshot_from_maps_state_unknown_to_neither_flag_defensively() {
        // Ambiguous OS state with no better AC signal (the non-macOS
        // fallback path): default to "on battery" so we never silently
        // misreport an unplugged laptop as AC power.
        let s = snapshot_from(
            0.55,
            State::Unknown,
            ac_power_from_state(State::Unknown),
            None,
        )
        .expect("unknown is real");
        assert!(!s.on_ac_power);
        assert!(!s.charging);
        assert_eq!(s.percent, Some(55));
    }

    #[test]
    fn snapshot_from_clamps_out_of_range_ratios() {
        // Noisy firmware occasionally reports slightly outside
        // 0.0..=1.0 — we clamp rather than reject, because the
        // battery is still real.
        let over = snapshot_from(1.03, State::Discharging, false, None).expect("clamped");
        assert_eq!(over.percent, Some(100));
        let under = snapshot_from(-0.02, State::Discharging, false, None).expect("clamped");
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
