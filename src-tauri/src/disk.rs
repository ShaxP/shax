//! Disk volume enumeration for the sidebar's Disk widget (spec §19 D10).
//!
//! One command, `disk_volumes()`, hands the frontend a `Vec<VolumeInfo>`
//! — one entry per mounted volume the user cares about. Enumeration
//! goes through `sysinfo::Disks`, which wraps `getmntinfo` on macOS,
//! `/proc/mounts` on Linux, and `GetLogicalDriveStringsW` on Windows.
//! Every field the widget renders (name, mount point, filesystem,
//! used + total bytes) comes from that one call.
//!
//! **The filter is design, not tidiness.** A development Mac
//! enumerates roughly a dozen volumes out of the box — `/`, `/System/
//! Volumes/Preboot`, `/System/Volumes/VM`, `/System/Volumes/Update`,
//! per-user home mounts, and every `.dmg` currently attached. The
//! Preboot / VM / Update mounts are system infrastructure the user
//! never puts anything on; a Linux box adds `tmpfs`, `sysfs`, `proc`,
//! `cgroup*`, `devpts`, `overlay`, and half a dozen more just to get
//! systemd running. Without a filter the pager pages through a wall
//! of things nobody wants to know exist. The rules:
//!
//! - **Filesystem type** — drop `tmpfs`, `devfs`, `autofs`, `nullfs`,
//!   `overlay`, `sysfs`, `proc`, `cgroup*`, `devpts`, `fusectl`,
//!   `squashfs`, and other in-kernel bookkeeping filesystems. If the
//!   FS is a real place to store bytes it stays; if it's the kernel
//!   showing its work, it goes.
//! - **Mount-point prefix** — anything under `/proc`, `/sys`, `/dev`,
//!   `/run`, `/System/Volumes/Preboot`, `/System/Volumes/VM`,
//!   `/System/Volumes/Update` (macOS system infrastructure) is out.
//!   A user who has genuinely mounted a real volume at one of those
//!   paths sees the same filter apply — but that's a vanishingly rare
//!   configuration and the trade beats surfacing the system mounts.
//! - **Zero total bytes** — the OS is reporting a phantom mount, or
//!   the mount just failed. Drop.
//!
//! The list keeps `Macintosh HD` (the read-only system snapshot) and
//! `Data` (the user data volume): both are addressable, both are
//! meaningful, and the mockup pages between them explicitly.
//!
//! Cadence: this is the **slow tier** (30 s in `App.tsx`). Volumes
//! come and go from user action, not from data change, and even free
//! space moves slowly enough that forking `statvfs` every 2 seconds
//! for every disk would be waste of syscalls.

use serde::{Deserialize, Serialize};
use sysinfo::Disks;

/// What the sidebar's Disk card needs to describe one mounted volume.
///
/// `used_bytes = total_bytes - available_bytes` (saturating) so a
/// firmware oddity that returns `available > total` reads as "full"
/// rather than wrapping to a huge number.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VolumeInfo {
    /// Human-readable volume label (`Macintosh HD`, `Data`, `Backup T7`).
    /// Falls back to the mount point's basename when the OS doesn't
    /// provide one — never a fabricated placeholder like `Disk 1`.
    pub name: String,
    /// Absolute mount path (`/`, `/System/Volumes/Data`, `/Volumes/Backup`,
    /// `C:\` on Windows). Held by the frontend as the pager's selection
    /// key — same rule the Network pager uses for interface names.
    pub mount_point: String,
    /// The volume's filesystem type as the OS reports it (`APFS`,
    /// `exFAT`, `NTFS`, `ext4`). Rendered in the card's bottom line
    /// so a user can tell at a glance which volume they're paging
    /// through without the mount point.
    pub filesystem: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
}

/// Snapshot every mountable volume the widget cares about, in order.
///
/// The order matches `sysinfo`'s own — which is stable within a run
/// and, in practice, reflects the OS's enumeration order (root
/// volumes first, external drives after). We deliberately don't
/// sort: paging through the volumes in the order the OS lists them
/// keeps the card under the user's finger between refreshes even as
/// a new drive comes online at the end of the list.
#[tauri::command]
pub fn disk_volumes() -> Vec<VolumeInfo> {
    let disks = Disks::new_with_refreshed_list();
    disks
        .iter()
        .filter(|d| should_include(d))
        .map(to_info)
        .collect()
}

fn to_info(d: &sysinfo::Disk) -> VolumeInfo {
    let mount_point = d.mount_point().to_string_lossy().into_owned();
    let raw_name = d.name().to_string_lossy().into_owned();
    // `sysinfo` sometimes hands back an empty name (Linux for a
    // mounted image, macOS for a synthetic root) — fall back to the
    // mount point's last segment rather than surfacing an empty card
    // header, and finally to the mount point itself so `Root FS` is
    // never the emptily-labelled thing the user is trying to page to.
    let name = if raw_name.trim().is_empty() {
        mount_point_basename(&mount_point)
    } else {
        raw_name
    };
    VolumeInfo {
        name,
        mount_point,
        filesystem: d.file_system().to_string_lossy().into_owned(),
        total_bytes: d.total_space(),
        used_bytes: d.total_space().saturating_sub(d.available_space()),
    }
}

/// Pull `Backup` out of `/Volumes/Backup`, `C:\` out of `C:\`, or
/// return `Root FS` for the bare root path.
fn mount_point_basename(mount_point: &str) -> String {
    if mount_point == "/" {
        return "Root FS".to_string();
    }
    let trimmed = mount_point.trim_end_matches(['/', '\\']);
    let last = trimmed.rsplit(['/', '\\']).next().unwrap_or("");
    if last.is_empty() {
        mount_point.to_string()
    } else {
        last.to_string()
    }
}

/// Filter rule, kept pure and cross-platform so the tests can pin
/// each branch on captured strings — `sysinfo::Disk` itself is a
/// crate-level type the tests would otherwise have to mock.
pub(crate) fn should_include(d: &sysinfo::Disk) -> bool {
    let mount_point = d.mount_point().to_string_lossy();
    let filesystem = d.file_system().to_string_lossy();
    should_include_by_shape(&mount_point, &filesystem, d.total_space())
}

/// The filter as pure logic on the strings the OS returns. Same
/// rules as [`should_include`], factored out so tests can drive it
/// with captured mount / fs pairs.
pub(crate) fn should_include_by_shape(
    mount_point: &str,
    filesystem: &str,
    total_bytes: u64,
) -> bool {
    if total_bytes == 0 {
        return false;
    }
    if is_excluded_filesystem(filesystem) {
        return false;
    }
    if is_excluded_mount_prefix(mount_point) {
        return false;
    }
    true
}

/// In-kernel bookkeeping filesystems — sockets, cgroups, procfs,
/// tmpfs — and stack-only mounts (overlay, squashfs on live images)
/// that don't correspond to a place a user stores bytes.
///
/// Matching by substring rather than equality catches `cgroup` /
/// `cgroup2` in one line, and defends against a kernel appending
/// version tags to the type name.
pub(crate) fn is_excluded_filesystem(filesystem: &str) -> bool {
    let lower = filesystem.to_ascii_lowercase();
    const EXCLUDED: &[&str] = &[
        "tmpfs",
        "devtmpfs",
        "devfs",
        "autofs",
        "nullfs",
        "overlay",
        "squashfs",
        "sysfs",
        "proc",
        "cgroup",
        "devpts",
        "fusectl",
        "pstore",
        "bpf",
        "tracefs",
        "debugfs",
        "securityfs",
        "configfs",
        "mqueue",
        "hugetlbfs",
        "rpc_pipefs",
        "binfmt_misc",
    ];
    EXCLUDED.iter().any(|token| lower.contains(token))
}

/// Mount prefixes that are always system infrastructure — the user
/// never keeps their files under `/proc` or `/System/Volumes/Preboot`.
/// A user who has genuinely mounted a real volume at one of these
/// paths sees the same filter apply, but that's rare enough that the
/// trade beats always-visible system mounts.
pub(crate) fn is_excluded_mount_prefix(mount_point: &str) -> bool {
    const EXCLUDED: &[&str] = &[
        // Linux virtual filesystems' canonical mount points.
        "/proc",
        "/sys",
        "/dev",
        "/run",
        "/boot/efi", // typically 100 MB and useless to page to
        // macOS system infrastructure — Preboot / VM (swap) /
        // Update are all APFS volumes the user never touches.
        "/System/Volumes/Preboot",
        "/System/Volumes/VM",
        "/System/Volumes/Update",
        "/System/Volumes/xarts",
        "/System/Volumes/iSCPreboot",
        "/System/Volumes/Hardware",
        "/private/var/vm",
    ];
    EXCLUDED
        .iter()
        .any(|prefix| mount_point == *prefix || mount_point.starts_with(&format!("{prefix}/")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_macos_root_and_data_volumes() {
        // Both are legitimate, both are what the mockup pages
        // between — the filter must not drop either.
        assert!(should_include_by_shape("/", "APFS", 1_000_000_000_000));
        assert!(should_include_by_shape(
            "/System/Volumes/Data",
            "APFS",
            1_000_000_000_000
        ));
    }

    #[test]
    fn keeps_external_and_non_apfs_volumes() {
        // The mockup includes an external `Backup T7` at 91 % used
        // (a real regression risk if we were over-aggressive on
        // `/Volumes/`) and a `SCRATCH` volume formatted exFAT.
        assert!(should_include_by_shape(
            "/Volumes/Backup",
            "APFS",
            2_000_000_000_000
        ));
        assert!(should_include_by_shape(
            "/Volumes/SCRATCH",
            "exFAT",
            1_000_000_000_000
        ));
    }

    #[test]
    fn drops_macos_system_volumes() {
        // Preboot / VM / Update are the ones the mockup deliberately
        // omits — user never touches them. A card pager that dumped
        // 300 MB of "you're 42 % into your bootloader" would be
        // noise.
        assert!(!should_include_by_shape(
            "/System/Volumes/Preboot",
            "APFS",
            500_000_000
        ));
        assert!(!should_include_by_shape(
            "/System/Volumes/VM",
            "APFS",
            5_000_000_000
        ));
        assert!(!should_include_by_shape(
            "/System/Volumes/Update",
            "APFS",
            2_000_000_000
        ));
        assert!(!should_include_by_shape(
            "/System/Volumes/xarts",
            "APFS",
            10_000_000
        ));
    }

    #[test]
    fn drops_linux_virtual_filesystems_by_type() {
        // Live Linux systems mount a dozen of these; the pager would
        // become a mount-tree tour without the filter.
        for (mount, fs) in [
            ("/", "tmpfs"),
            ("/sys/fs/cgroup", "cgroup2"),
            ("/proc", "proc"),
            ("/dev", "devtmpfs"),
            ("/dev/pts", "devpts"),
            ("/sys", "sysfs"),
            ("/run/user/1000", "tmpfs"),
        ] {
            assert!(
                !should_include_by_shape(mount, fs, 8_000_000_000),
                "expected {mount} ({fs}) to be excluded"
            );
        }
    }

    #[test]
    fn drops_linux_virtual_filesystems_by_mount_prefix() {
        // Even if a kernel invents a new type name we don't know
        // about, the mount-point filter catches the well-known paths.
        assert!(!should_include_by_shape(
            "/proc/1/mountinfo",
            "somefs",
            1_000_000
        ));
        assert!(!should_include_by_shape(
            "/sys/kernel/security",
            "somefs",
            1_000_000
        ));
        assert!(!should_include_by_shape("/dev/shm", "somefs", 1_000_000));
        assert!(!should_include_by_shape("/run/lock", "somefs", 1_000_000));
    }

    #[test]
    fn drops_zero_total_phantom_mounts() {
        // Occasionally an OS enumerates a mount whose backing device
        // has vanished — total = 0. Never surface those.
        assert!(!should_include_by_shape("/Volumes/Ghost", "APFS", 0));
    }

    #[test]
    fn does_not_drop_a_user_dir_that_starts_with_a_filtered_prefix() {
        // A user with a folder called `/proceedings` or a
        // `/system-backups` volume must not be filtered because the
        // path *starts with* a substring of a prefix. The prefix
        // rule matches exact segments only (either the full string
        // or with a trailing `/`).
        assert!(should_include_by_shape(
            "/proceedings",
            "ext4",
            1_000_000_000
        ));
        assert!(should_include_by_shape(
            "/system-backups",
            "ext4",
            1_000_000_000
        ));
    }

    #[test]
    fn basename_helper_falls_back_sensibly() {
        assert_eq!(mount_point_basename("/Volumes/Backup"), "Backup");
        assert_eq!(mount_point_basename("/System/Volumes/Data"), "Data");
        assert_eq!(mount_point_basename("/"), "Root FS");
        // Windows drive letters — the last segment IS the drive
        // letter itself, not an empty string.
        assert_eq!(mount_point_basename("C:\\"), "C:");
    }

    #[test]
    fn disk_volumes_call_does_not_panic() {
        // Smoke test — the real call goes to the OS and the value
        // varies by host. What we can pin from CI: it doesn't
        // panic, and everything it hands back passes its own filter.
        let volumes = disk_volumes();
        for v in &volumes {
            assert!(v.total_bytes > 0, "kept a zero-total volume: {v:?}");
            assert!(v.used_bytes <= v.total_bytes, "used > total: {v:?}");
        }
    }
}
