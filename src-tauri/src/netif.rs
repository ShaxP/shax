//! Network interface enumeration for the sidebar's Network card
//! (spec §19 D5 item 3).
//!
//! **Only interfaces that are up and hold an address are listed, and
//! that filter is the design rather than tidiness.** A development
//! Mac carries roughly 28 interfaces — `lo0`, `gif0`, `stf0`,
//! `anpi0-2`, `en0-6`, `bridge0`, `ap1`, `awdl0`, `llw0`, `utun0-7`,
//! `vmenet0`, `bridge100` — of which exactly two hold an IPv4
//! address. Without the filter the card would page through seven
//! phantom VPN cards conjured from macOS's own system tunnels, which
//! are up and address-less.
//!
//! With it, VPN detection stops being a name heuristic and becomes a
//! sound rule: point-to-point, holds an address, is not a hardware
//! port.
//!
//! **Virtual bridges are excluded on top of that filter.** A machine
//! running VMs carries host-side bridges (`bridge100-102` from
//! Parallels/UTM, `docker0`, `virbr0`, `vEthernet (...)`) which are up
//! and addressed and so pass the filter, but describe a link to a
//! guest rather than a link to the network. The test is structural
//! rather than a list of vendor names: an interface that is neither a
//! hardware port nor a point-to-point tunnel has no physical device
//! behind it, and on every platform that is what a virtual bridge is.
//!
//! This is the **slow tier**. Everything here means forking
//! `networksetup` / `scutil` / `ifconfig`, for values that essentially
//! never change, so it refreshes at 30s. Throughput is a delta and
//! lives on the 2s sampler in `status.rs`; the frontend joins the two
//! by interface name.

use serde::{Deserialize, Serialize};

use crate::wifi::{self, SsidAccess};

/// What kind of link this is. `Other` is a real answer, not a
/// fallback for "probably wired" — guessing that is what told every
/// Wi-Fi Mac it was on Ethernet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InterfaceKind {
    WiFi,
    Ethernet,
    Vpn,
    Other,
}

/// Wi-Fi specifics. Every field except `ssid` is readable without any
/// permission — verified on macOS 26.3, where CoreWLAN returns
/// `rssi=-39 security=4 channel=36` while `ssid` is `None`. So a user
/// who declines the location prompt still gets the whole detail line
/// minus the name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WifiDetail {
    pub ssid: Option<String>,
    pub ssid_access: SsidAccess,
    /// Raw signal in dBm, for the tooltip.
    pub rssi: Option<i32>,
    /// 0–4, derived from `rssi` for the bar glyph.
    pub bars: Option<u8>,
    pub channel: Option<u32>,
    /// Human-readable security, e.g. `WPA2`. `None` when the platform
    /// won't say — never "Open", which would be a dangerous guess.
    pub security: Option<String>,
    /// True only when the OS has actually detected a portal. `false`
    /// means "not behind one"; we never infer this from a failed
    /// request of our own, because we make none.
    pub captive: bool,
}

/// Wired-link specifics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkDetail {
    /// Negotiated speed in Mb/s.
    pub speed_mbps: Option<u64>,
    /// Media type as the OS names it, e.g. `1000baseT`.
    pub media: Option<String>,
    pub full_duplex: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetInterface {
    pub name: String,
    pub ip: String,
    pub kind: InterfaceKind,
    /// True for the interface holding the default route — the card
    /// opens on this one.
    pub is_primary: bool,
    pub wifi: Option<WifiDetail>,
    pub link: Option<LinkDetail>,
}

/// Every interface that is up and holds an address, primary first.
#[tauri::command]
pub fn net_interfaces() -> Vec<NetInterface> {
    let primary = wifi::primary_interface_name();
    let mut interfaces: Vec<NetInterface> = imp::addressed_interfaces()
        .into_iter()
        .filter(|(name, _)| !imp::is_virtual_bridge(name))
        .map(|(name, ip)| {
            let kind = imp::classify(&name);
            let is_primary = primary.as_deref() == Some(name.as_str());
            NetInterface {
                wifi: if kind == InterfaceKind::WiFi {
                    Some(imp::wifi_detail(&name))
                } else {
                    None
                },
                link: if kind == InterfaceKind::Ethernet {
                    Some(imp::link_detail(&name))
                } else {
                    None
                },
                name,
                ip,
                kind,
                is_primary,
            }
        })
        .collect();
    // Primary first, then stable by name so the pager's indices don't
    // shuffle between refreshes for reasons the user can't see.
    interfaces.sort_by(|a, b| b.is_primary.cmp(&a.is_primary).then(a.name.cmp(&b.name)));
    interfaces
}

/// Map dBm to a 0–4 bar count.
///
/// Thresholds follow the conventional Wi-Fi ladder: -50 and better is
/// full, -80 and worse is barely connected. Anything outside a
/// plausible dBm range is treated as no reading rather than clamped,
/// since a clamp would render a made-up bar count confidently.
pub fn bars_from_rssi(rssi: i32) -> Option<u8> {
    if !(-100..=0).contains(&rssi) {
        return None;
    }
    Some(match rssi {
        -50..=0 => 4,
        -60..=-51 => 3,
        -70..=-61 => 2,
        -80..=-71 => 1,
        _ => 0,
    })
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{InterfaceKind, LinkDetail, WifiDetail};
    use crate::wifi;

    /// Interfaces that are both up and hold an IPv4 address.
    ///
    /// `list_afinet_netifas` only reports addressed interfaces, which
    /// is most of the filter; loopback is dropped explicitly.
    pub fn addressed_interfaces() -> Vec<(String, String)> {
        let Ok(list) = local_ip_address::list_afinet_netifas() else {
            return Vec::new();
        };
        let mut seen: Vec<(String, String)> = Vec::new();
        for (name, addr) in list {
            if addr.is_loopback() || !addr.is_ipv4() {
                continue;
            }
            // One card per interface: an interface with several
            // addresses would otherwise page as several interfaces.
            if seen.iter().any(|(existing, _)| existing == &name) {
                continue;
            }
            seen.push((name, addr.to_string()));
        }
        seen
    }

    pub fn classify(interface: &str) -> InterfaceKind {
        match wifi::hardware_port_kind(interface) {
            Some(kind) => kind,
            // Not a hardware port. An addressed point-to-point
            // interface at this point is a tunnel — and because the
            // caller already filtered to *addressed* interfaces, the
            // system's own address-less utuns never reach here.
            None if is_point_to_point(interface) => InterfaceKind::Vpn,
            None => InterfaceKind::Other,
        }
    }

    /// A host-side bridge to a VM. macOS lists every real port in
    /// `networksetup -listallhardwareports` — including the
    /// Thunderbolt Bridge — so an interface it does *not* list, and
    /// which isn't a tunnel, has no physical device behind it.
    /// `bridge100`-`bridge102` and `vmenet*` land here.
    pub fn is_virtual_bridge(interface: &str) -> bool {
        wifi::hardware_port_kind(interface).is_none() && !is_point_to_point(interface)
    }

    fn is_point_to_point(interface: &str) -> bool {
        ifconfig(interface).is_some_and(|text| text.contains("POINTOPOINT"))
    }

    fn ifconfig(interface: &str) -> Option<String> {
        let output = std::process::Command::new("/sbin/ifconfig")
            .arg(interface)
            .output()
            .ok()?;
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    pub fn wifi_detail(interface: &str) -> WifiDetail {
        let raw = wifi::wifi_raw_detail(interface);
        WifiDetail {
            bars: raw.rssi.and_then(super::bars_from_rssi),
            captive: captive_stage(interface).is_some_and(|stage| is_captive_stage(&stage)),
            ssid: raw.ssid,
            ssid_access: raw.ssid_access,
            rssi: raw.rssi,
            channel: raw.channel,
            security: raw.security,
        }
    }

    /// macOS performs captive detection itself and publishes the
    /// result, so we read OS state and make no request of our own —
    /// which is what keeps this inside non-negotiable #6.
    fn captive_stage(interface: &str) -> Option<String> {
        use std::io::Write as _;
        let mut child = std::process::Command::new("/usr/sbin/scutil")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok()?;
        writeln!(
            child.stdin.as_mut()?,
            "show State:/Network/Interface/{interface}/CaptiveNetwork"
        )
        .ok()?;
        let output = child.wait_with_output().ok()?;
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    /// `Stage : Unknown` is the not-behind-a-portal case. Only the
    /// stages that actually mean "a portal is in the way" count;
    /// anything unrecognised is treated as not captive, because
    /// falsely flagging a working network is worse than missing a
    /// portal the user is about to notice anyway.
    fn is_captive_stage(text: &str) -> bool {
        text.contains("Detected") || text.contains("Redirected")
    }

    pub fn link_detail(interface: &str) -> LinkDetail {
        let Some(text) = ifconfig(interface) else {
            return LinkDetail {
                speed_mbps: None,
                media: None,
                full_duplex: None,
            };
        };
        super::parse_bsd_media(&text)
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{InterfaceKind, LinkDetail, WifiDetail};
    use crate::wifi;

    pub fn addressed_interfaces() -> Vec<(String, String)> {
        let Ok(list) = local_ip_address::list_afinet_netifas() else {
            return Vec::new();
        };
        let mut seen: Vec<(String, String)> = Vec::new();
        for (name, addr) in list {
            if addr.is_loopback() || !addr.is_ipv4() {
                continue;
            }
            if seen.iter().any(|(existing, _)| existing == &name) {
                continue;
            }
            seen.push((name, addr.to_string()));
        }
        seen
    }

    pub fn classify(interface: &str) -> InterfaceKind {
        if std::path::Path::new(&format!("/sys/class/net/{interface}/wireless")).exists() {
            return InterfaceKind::WiFi;
        }
        // ARPHRD_NONE (65534) is what tun devices report, which is
        // how WireGuard, OpenVPN and friends appear.
        match std::fs::read_to_string(format!("/sys/class/net/{interface}/type")) {
            Ok(t) if t.trim() == "65534" => InterfaceKind::Vpn,
            Ok(t) if t.trim() == "1" => InterfaceKind::Ethernet,
            _ => InterfaceKind::Other,
        }
    }

    /// `/sys/class/net/<if>/device` is a symlink to the backing
    /// hardware. Bridges (`docker0`, `virbr0`, `br-*`) and veth pairs
    /// have none. Tunnels have none either, so they are classified
    /// first and excluded from this test.
    pub fn is_virtual_bridge(interface: &str) -> bool {
        if classify(interface) == InterfaceKind::Vpn {
            return false;
        }
        !std::path::Path::new(&format!("/sys/class/net/{interface}/device")).exists()
    }

    pub fn wifi_detail(interface: &str) -> WifiDetail {
        let raw = wifi::wifi_raw_detail(interface);
        WifiDetail {
            bars: raw.rssi.and_then(super::bars_from_rssi),
            // No portable, request-free captive signal on Linux.
            // NetworkManager exposes one over D-Bus, which is a
            // dependency we are not adding for a chip; reporting
            // `false` here means "we did not detect one", and the
            // frontend renders nothing rather than "not captive".
            captive: false,
            ssid: raw.ssid,
            ssid_access: raw.ssid_access,
            rssi: raw.rssi,
            channel: raw.channel,
            security: raw.security,
        }
    }

    pub fn link_detail(interface: &str) -> LinkDetail {
        let read =
            |file: &str| std::fs::read_to_string(format!("/sys/class/net/{interface}/{file}"));
        LinkDetail {
            speed_mbps: read("speed").ok().and_then(|s| s.trim().parse().ok()),
            media: None,
            full_duplex: read("duplex").ok().map(|d| d.trim() == "full"),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod imp {
    use super::{InterfaceKind, LinkDetail, WifiDetail};

    pub fn addressed_interfaces() -> Vec<(String, String)> {
        Vec::new()
    }
    pub fn classify(_interface: &str) -> InterfaceKind {
        InterfaceKind::Other
    }
    pub fn is_virtual_bridge(_interface: &str) -> bool {
        false
    }
    pub fn wifi_detail(_interface: &str) -> WifiDetail {
        WifiDetail {
            ssid: None,
            ssid_access: crate::wifi::SsidAccess::NotRequired,
            rssi: None,
            bars: None,
            channel: None,
            security: None,
            captive: false,
        }
    }
    pub fn link_detail(_interface: &str) -> LinkDetail {
        LinkDetail {
            speed_mbps: None,
            media: None,
            full_duplex: None,
        }
    }
}

/// Parse BSD `ifconfig` media output, e.g.
/// `media: autoselect (1000baseT <full-duplex>)`.
///
/// Split out and pure so it can be tested without a wired link —
/// every Ethernet port on the development machine reads
/// `media: none`, so this is otherwise unreachable in tests.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_bsd_media(text: &str) -> LinkDetail {
    let mut detail = LinkDetail {
        speed_mbps: None,
        media: None,
        full_duplex: None,
    };
    let Some(line) = text.lines().find(|l| l.trim_start().starts_with("media:")) else {
        return detail;
    };
    detail.full_duplex = if line.contains("full-duplex") {
        Some(true)
    } else if line.contains("half-duplex") {
        Some(false)
    } else {
        None
    };
    // The media token is the one carrying a "base" rate — `autoselect`
    // and `none` are not media types and must not be reported as one.
    for token in line.split(|c: char| c.is_whitespace() || c == '(' || c == ')' || c == '<') {
        let token = token.trim();
        if token.is_empty() || !token.to_ascii_lowercase().contains("base") {
            continue;
        }
        detail.media = Some(token.to_string());
        let digits: String = token.chars().take_while(char::is_ascii_digit).collect();
        detail.speed_mbps = digits.parse().ok();
        break;
    }
    detail
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enumeration_only_yields_addressed_interfaces() {
        // The filter that stops seven address-less system tunnels
        // becoming seven phantom VPN cards.
        for interface in net_interfaces() {
            assert!(
                !interface.ip.is_empty(),
                "{} was listed without an address",
                interface.name,
            );
            assert!(!interface.name.is_empty());
        }
    }

    #[test]
    fn host_side_vm_bridges_are_excluded() {
        // They are up and addressed, so the base filter admits them —
        // but they describe a link to a guest, not to the network.
        let names: Vec<String> = net_interfaces().into_iter().map(|i| i.name).collect();
        for name in &names {
            assert!(
                !imp::is_virtual_bridge(name),
                "{name} is a virtual bridge and should not be listed",
            );
        }
    }

    #[test]
    fn at_most_one_interface_is_primary_and_it_sorts_first() {
        let interfaces = net_interfaces();
        let primaries = interfaces.iter().filter(|i| i.is_primary).count();
        assert!(primaries <= 1, "found {primaries} primary interfaces");
        if let Some(first) = interfaces.first() {
            if primaries == 1 {
                assert!(first.is_primary, "the card must open on the default route");
            }
        }
    }

    #[test]
    fn ordering_is_stable_across_calls() {
        // The pager indexes into this list. Reordering between
        // refreshes would move the card under the user's finger.
        let names = |v: Vec<NetInterface>| v.into_iter().map(|i| i.name).collect::<Vec<_>>();
        assert_eq!(names(net_interfaces()), names(net_interfaces()));
    }

    #[test]
    fn detail_is_attached_to_the_kind_that_has_it() {
        for interface in net_interfaces() {
            match interface.kind {
                InterfaceKind::WiFi => assert!(interface.wifi.is_some()),
                InterfaceKind::Ethernet => assert!(interface.link.is_some()),
                _ => {
                    assert!(interface.wifi.is_none());
                    assert!(interface.link.is_none());
                }
            }
        }
    }

    #[test]
    fn bars_ladder_covers_the_plausible_range() {
        assert_eq!(bars_from_rssi(-39), Some(4));
        assert_eq!(bars_from_rssi(-55), Some(3));
        assert_eq!(bars_from_rssi(-65), Some(2));
        assert_eq!(bars_from_rssi(-75), Some(1));
        assert_eq!(bars_from_rssi(-95), Some(0));
    }

    #[test]
    fn an_implausible_rssi_is_no_reading_rather_than_a_clamp() {
        // Clamping would render a confident bar count for a value we
        // know is nonsense.
        assert_eq!(bars_from_rssi(0), Some(4));
        assert_eq!(bars_from_rssi(5), None);
        assert_eq!(bars_from_rssi(-400), None);
    }

    #[test]
    fn bsd_media_parses_a_real_gigabit_link() {
        let detail = parse_bsd_media("\tmedia: autoselect (1000baseT <full-duplex>)");
        assert_eq!(detail.speed_mbps, Some(1000));
        assert_eq!(detail.media.as_deref(), Some("1000baseT"));
        assert_eq!(detail.full_duplex, Some(true));
    }

    #[test]
    fn bsd_media_reports_nothing_for_an_unplugged_port() {
        // Every wired port on the development machine reads this, so
        // it is the case most likely to be hit in practice.
        let detail = parse_bsd_media("\tmedia: none");
        assert_eq!(detail.speed_mbps, None);
        assert_eq!(detail.media, None);
    }

    #[test]
    fn bsd_media_does_not_mistake_autoselect_for_a_media_type() {
        let detail = parse_bsd_media("\tmedia: autoselect");
        assert_eq!(detail.media, None);
        assert_eq!(detail.speed_mbps, None);
    }

    #[test]
    fn bsd_media_reads_half_duplex() {
        let detail = parse_bsd_media("\tmedia: autoselect (100baseTX <half-duplex>)");
        assert_eq!(detail.speed_mbps, Some(100));
        assert_eq!(detail.full_duplex, Some(false));
    }
}
