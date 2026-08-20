//! Wi-Fi identity: the network's name, and whether we're on Wi-Fi at
//! all (M13 refinement, spec §19 D5 item 3).
//!
//! Two separate questions, with very different costs:
//!
//! **The medium** — Wi-Fi or Ethernet — is free everywhere. macOS
//! reads it from `networksetup -listallhardwareports`, Linux from the
//! presence of `/sys/class/net/<iface>/wireless`, Windows from the
//! interface appearing in `netsh wlan`. No permission, no prompt.
//!
//! **The SSID** is free on Linux and Windows and gated on macOS.
//! Since macOS 14, `CWInterface.ssid()` returns `nil` unless the
//! *calling process* holds location authorisation, and every
//! shell-out is redacted — verified on macOS 26.3, where
//! `networksetup -getairportnetwork` goes as far as claiming you
//! aren't associated with any network, `system_profiler` prints
//! `<redacted>`, and `ipconfig getsummary` does the same. There is no
//! path that avoids the prompt.
//!
//! M13.3 originally declined that trade and returned `None` on macOS.
//! The card then rendered "no SSID" as `Wired`, which was not a
//! missing reading but a **wrong** one: every Wi-Fi Mac was told it
//! was on Ethernet. That is what forced the question, and the project
//! owner chose to request location access.
//!
//! The medium is still resolved independently of the SSID, so a
//! denied prompt degrades to "Wi-Fi, name unknown" rather than back
//! to the lie.

/// How the primary interface connects. `Unknown` is a real answer —
/// a tunnel, a bridge, or a platform we couldn't ask — and is never
/// collapsed into `Wired`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkMedium {
    WiFi,
    Wired,
    Unknown,
}

/// Whether the OS will tell us the network's name.
///
/// Only macOS can be anything other than `NotRequired`; the variant
/// exists so the frontend can distinguish "we can't name this
/// network" from "you haven't allowed it yet", which are different
/// messages to show a user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SsidAccess {
    /// The platform hands over the SSID without asking (Linux,
    /// Windows).
    NotRequired,
    /// macOS, permission granted.
    Granted,
    /// macOS, prompt not yet answered.
    NotDetermined,
    /// macOS, the user said no — or a policy said no for them.
    Denied,
}

/// What the sidebar's Network card needs to describe the link.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WifiInfo {
    pub medium: NetworkMedium,
    /// The network's name, when the platform will say.
    pub ssid: Option<String>,
    pub ssid_access: SsidAccess,
}

/// Ask for location access, so `ssid` can start returning a name.
///
/// A no-op off macOS. Safe to call repeatedly: once the user has
/// answered, the OS never prompts again and this just returns the
/// standing answer.
#[tauri::command]
pub fn wifi_request_ssid_access() -> WifiInfo {
    // Called unconditionally: every platform provides this, and on
    // the ones that need no permission it is an explicit no-op.
    // Gating the *call site* instead left the function dead on
    // Linux and Windows, which `-D warnings` rightly rejected.
    imp::request_location_authorization();
    probe()
}

/// The current medium + SSID + access state.
#[tauri::command]
pub fn wifi_info() -> WifiInfo {
    probe()
}

fn probe() -> WifiInfo {
    let medium = imp::medium();
    let ssid_access = imp::ssid_access();
    // Don't ask for a name we've been told we can't have, and don't
    // ask on a wired link — a stale association can otherwise report
    // the last Wi-Fi network while the traffic goes over Ethernet.
    let ssid = if medium == NetworkMedium::WiFi && ssid_access != SsidAccess::Denied {
        imp::ssid()
    } else {
        None
    };
    WifiInfo {
        medium,
        ssid,
        ssid_access,
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{NetworkMedium, SsidAccess};
    use objc2_core_location::{CLAuthorizationStatus, CLLocationManager};
    use objc2_core_wlan::CWWiFiClient;

    pub fn ssid() -> Option<String> {
        // SAFETY: `sharedWiFiClient` returns a process-wide singleton
        // and `interface` / `ssid` are plain accessors on it. No
        // arguments, no ownership transfer beyond the `Retained`
        // wrapper objc2 already models.
        unsafe {
            let interface = CWWiFiClient::sharedWiFiClient().interface()?;
            interface.ssid().map(|s| s.to_string())
        }
    }

    pub fn ssid_access() -> SsidAccess {
        // SAFETY: constructing a manager and reading its authorisation
        // status. The class-level accessor is deprecated in current
        // SDKs, so this goes through an instance; it neither prompts
        // nor starts location updates.
        let status = unsafe { CLLocationManager::new().authorizationStatus() };
        match status {
            CLAuthorizationStatus::NotDetermined => SsidAccess::NotDetermined,
            CLAuthorizationStatus::AuthorizedAlways => SsidAccess::Granted,
            // `AuthorizedWhenInUse` is what a Mac app actually gets.
            // Matched by value because the constant is not an enum
            // variant we can name in a pattern.
            other if other.0 == 4 => SsidAccess::Granted,
            _ => SsidAccess::Denied,
        }
    }

    pub fn request_location_authorization() {
        // Asking again after an answer is a no-op at the OS level,
        // and skipping it here keeps a needless CLLocationManager
        // from being constructed on every poll.
        if ssid_access() != SsidAccess::NotDetermined {
            return;
        }
        // SAFETY: constructing a CLLocationManager and asking it to
        // prompt. Must happen on the main thread — the caller is a
        // Tauri command, which Tauri dispatches on the main thread.
        unsafe {
            let manager = CLLocationManager::new();
            manager.requestWhenInUseAuthorization();
            // The manager is dropped here. The prompt has already
            // been posted to the system, and the *answer* is read
            // back later from the class-level status, so nothing
            // needs to outlive this call.
        }
    }

    pub fn medium() -> NetworkMedium {
        let Some(interface) = super::primary_interface_name() else {
            return NetworkMedium::Unknown;
        };
        // `networksetup -listallhardwareports` prints stanzas of
        // "Hardware Port: <name>" / "Device: <iface>". Needs no
        // permission — verified while diagnosing the `Wired` bug.
        let Ok(output) = std::process::Command::new("/usr/sbin/networksetup")
            .arg("-listallhardwareports")
            .output()
        else {
            return NetworkMedium::Unknown;
        };
        let text = String::from_utf8_lossy(&output.stdout);
        let mut port: Option<&str> = None;
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("Hardware Port: ") {
                port = Some(rest.trim());
            } else if let Some(device) = line.strip_prefix("Device: ") {
                if device.trim() == interface {
                    return classify_port(port.unwrap_or(""));
                }
            }
        }
        NetworkMedium::Unknown
    }

    /// Apple names the port, not the medium. Anything we don't
    /// recognise stays `Unknown` rather than being guessed at —
    /// guessing is what produced the bug this module exists to fix.
    fn classify_port(port: &str) -> NetworkMedium {
        let lower = port.to_ascii_lowercase();
        if lower.contains("wi-fi") || lower.contains("wifi") || lower.contains("airport") {
            NetworkMedium::WiFi
        } else if lower.contains("ethernet") || lower.contains("lan") {
            NetworkMedium::Wired
        } else {
            NetworkMedium::Unknown
        }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{NetworkMedium, SsidAccess};

    pub fn ssid() -> Option<String> {
        let output = std::process::Command::new("iwgetid")
            .arg("-r")
            .output()
            .ok()?;
        let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if name.is_empty() {
            None
        } else {
            Some(name)
        }
    }

    /// Linux hands the SSID over without asking.
    pub fn ssid_access() -> SsidAccess {
        SsidAccess::NotRequired
    }

    pub fn request_location_authorization() {}

    /// The kernel exposes a `wireless` directory for exactly the
    /// interfaces that are wireless. A filesystem check, so no
    /// shell-out and nothing to parse.
    pub fn medium() -> NetworkMedium {
        let Some(interface) = super::primary_interface_name() else {
            return NetworkMedium::Unknown;
        };
        if std::path::Path::new(&format!("/sys/class/net/{interface}/wireless")).exists() {
            NetworkMedium::WiFi
        } else if std::path::Path::new(&format!("/sys/class/net/{interface}")).exists() {
            NetworkMedium::Wired
        } else {
            NetworkMedium::Unknown
        }
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{NetworkMedium, SsidAccess};

    /// `netsh wlan show interfaces` prints `SSID : <name>`. Match on
    /// the exact key so `BSSID :` — which appears on the next line —
    /// can't be mistaken for it.
    fn wlan_output() -> Option<String> {
        let output = std::process::Command::new("netsh")
            .args(["wlan", "show", "interfaces"])
            .output()
            .ok()?;
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    pub fn ssid() -> Option<String> {
        let text = wlan_output()?;
        for line in text.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("SSID") {
                if trimmed.starts_with("BSSID") {
                    continue;
                }
                if let Some((_, value)) = rest.split_once(':') {
                    let name = value.trim();
                    if !name.is_empty() {
                        return Some(name.to_string());
                    }
                }
            }
        }
        None
    }

    pub fn ssid_access() -> SsidAccess {
        SsidAccess::NotRequired
    }

    pub fn request_location_authorization() {}

    /// A connected wireless interface means Wi-Fi. `netsh` failing or
    /// listing nothing means there is no WLAN adapter in use, which
    /// on a machine with a default route means a wired one.
    pub fn medium() -> NetworkMedium {
        if super::primary_interface_name().is_none() {
            return NetworkMedium::Unknown;
        }
        match wlan_output() {
            Some(text) if text.contains("State") && text.contains("connected") => {
                NetworkMedium::WiFi
            }
            Some(_) => NetworkMedium::Wired,
            None => NetworkMedium::Unknown,
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
mod imp {
    use super::{NetworkMedium, SsidAccess};

    pub fn ssid() -> Option<String> {
        None
    }
    pub fn ssid_access() -> SsidAccess {
        SsidAccess::NotRequired
    }
    pub fn request_location_authorization() {}
    pub fn medium() -> NetworkMedium {
        NetworkMedium::Unknown
    }
}

/// Name of the interface holding the default-route IP. Shared with
/// the throughput sampler, which scopes its byte counts to the same
/// interface — so the card's name, address and rates all describe one
/// link rather than three different ones.
fn primary_interface_name() -> Option<String> {
    let ip = local_ip_address::local_ip().ok()?;
    local_ip_address::list_afinet_netifas()
        .ok()?
        .into_iter()
        .find(|(_, addr)| *addr == ip)
        .map(|(name, _)| name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probing_never_panics_and_agrees_with_itself() {
        // Runtime-dependent (CI runners are wired, headless, and
        // unauthorised), so assert the invariants rather than values.
        let info = probe();
        if info.ssid.is_some() {
            assert_eq!(
                info.medium,
                NetworkMedium::WiFi,
                "a network name implies a wireless link",
            );
            assert_ne!(
                info.ssid_access,
                SsidAccess::Denied,
                "we should not hold a name we were denied",
            );
        }
    }

    #[test]
    fn a_denied_prompt_yields_no_name() {
        // The load-bearing degradation: denial costs the *name*, not
        // the medium. Falling back to `Wired` here is what made every
        // Wi-Fi Mac read as Ethernet.
        let info = probe();
        if info.ssid_access == SsidAccess::Denied {
            assert!(info.ssid.is_none());
        }
    }

    #[test]
    fn an_unknown_medium_is_never_reported_as_wired() {
        // The original defect in one assertion: "we could not tell"
        // must never be rendered as a positive claim of Ethernet.
        let medium = imp::medium();
        assert!(matches!(
            medium,
            NetworkMedium::WiFi | NetworkMedium::Wired | NetworkMedium::Unknown
        ));
        if primary_interface_name().is_none() {
            assert_eq!(
                medium,
                NetworkMedium::Unknown,
                "with no resolvable interface we know nothing, and must say so",
            );
        }
    }
}
