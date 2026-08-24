# Verification backlog

Things that are **merged and green in CI but never exercised against real hardware or a real OS prompt.** CI proves these compile and that their unit tests pass; it cannot prove they work, because the Playwright harness runs against the bare Vite dev server with no Tauri host, and the CI runners are headless, wired, unauthorised, and carry no VPN.

This is not a bug list. Each entry is something we chose to ship with a known gap in evidence, recorded so the gap stays visible instead of quietly becoming an assumption.

**When an item is confirmed, delete it from this file** in the same PR as any fix it prompts. An entry that lingers after being checked is worse than no entry — it implies doubt that no longer exists.

---

## How to build a testable app

Several items below need a **bundled** app, not `pnpm tauri:dev`. macOS identifies apps by bundle for permissions (TCC), and `tauri dev` runs a bare binary with no bundle identity, so permission prompts either don't appear or don't persist.

```bash
pnpm tauri:build --bundles app
open src-tauri/target/release/bundle/macos/Shax.app
```

`--bundles app` skips the `.dmg`; the config's `targets: "all"` is for releases, not for testing.

### Getting back to a fresh `NotDetermined` on macOS 26+

Location grants live in `locationd`, not in the general TCC database, and on macOS 26.x every userspace reset path is closed:

- `tccutil reset Location com.shax.app` returns exit 70 — `tccutil` no longer proxies to `locationd` for the Location service on this version. Silent no-op.
- `/var/db/locationd/clients.plist` is SIP-protected. Even `sudo /usr/libexec/PlistBuddy` / `sudo plutil` refuse to write it (`Operation not permitted`).
- **System Settings → Privacy & Security → Location Services** shows the app with a toggle, but no `–` button to remove the entry entirely. Toggling only moves the state Granted ↔ Denied, never back to NotDetermined.

To test the *first-run* flow — the "Show network name…" click that pops the OS dialog — the reliable workaround is to build the app under a fresh bundle identity that `locationd` has never seen:

```bash
# Edit src-tauri/tauri.conf.json: change "identifier" from "com.shax.app"
# to "com.shax.app.test" (or .test2, .test3 across successive attempts —
# each new identifier is a fresh identity to locationd).
pnpm tauri:build --bundles app
open src-tauri/target/release/bundle/macos/Shax.app
# Test the grant / decline path.
# Revert the identifier in tauri.conf.json when done. Do NOT commit the
# bumped identifier.
```

The bumped identity persists its own app data separately from your daily Shax install, so it launches first-run every time. That's the point.

The `Granted` / `Denied` toggle in System Settings is fine for exercising the *decline* path against `com.shax.app` directly, once the initial grant has ever been made — it's only `NotDetermined → Granted` that needs the bundle-id bump.

---

## 1. Captive portal chip (macOS)

**Why unverified:** needs an actual captive network.

**Steps:** on a hotel/airport/café network that shows a sign-in page, the Wi-Fi card's detail line should include `captive`.

**Worth knowing:** we never probe for this. macOS runs the detection itself and publishes it at `State:/Network/Interface/<iface>/CaptiveNetwork`; we read that. So the chip should agree with whether macOS pops its own portal window. If it disagrees, the stage mapping is the thing to look at, not the network.

---

## 2. Windows specifics

**Why unverified:** no Windows machine. CI compiles the paths and nothing more.

- **Keep-awake** holds `SetThreadExecutionState` on a dedicated thread, because the flags are per-thread and die with the thread that set them. Confirm the machine stops idle-sleeping, and that quitting Shax releases it.
- **The CPU card footer** should show a core count but **no** `load` reading. `sysinfo` returns zeros for load average on Windows rather than failing, so a bare number there would be fabricated.
- **Known-imperfect:** `is_loopback_name` matches `lo` / `lo0`, which are Unix names. Windows names its loopback adapter differently, so the throughput *fallback* path may include it. Harmless in practice — loopback traffic is nil — but not correct.
- **Known-heuristic:** interface classification uses adapter names (`Wi-Fi`, `Ethernet`, `vEthernet`), because Windows has no `/sys` tree or hardware-port table to consult. A machine with both Wi-Fi and Ethernet active could plausibly mislabel.

---

## 3. Linux AC-power detection (battery bolt)

**Why unverified:** no Linux machine. The sysfs reader is unit-tested against a fake `power_supply` tree, which proves the parsing and nothing about the real one.

**Steps:** on a plugged-in Linux laptop, the Battery card shows the bolt and no time-to-empty estimate. Then set a charge threshold below the current charge (`echo 80 | sudo tee /sys/class/power_supply/BAT0/charge_control_end_threshold` on ThinkPads) and confirm the bolt **stays lit** while the battery sits at the threshold, with the line reading `on AC · not charging`.

**Worth knowing:** that threshold state is the whole reason this exists. `starship-battery` can't parse Linux's `Not charging` status — `State::FromStr` has an explicit `TODO` for it and errors, which sysfs downgrades to `State::Unknown` — so `on_ac_power` there rests entirely on our own read of `/sys/class/power_supply/*/online`. If the bolt is dark while plugged in, check that the machine's charger enumerates with a `type` we accept (anything but `Battery`) and exposes `online`; a supply with no `online` file is skipped.

---

## 4. Cross-platform SSID and medium

**Why unverified:** only macOS has been exercised.

- **Linux:** SSID from `iwgetid -r`, medium from `/sys/class/net/<iface>/wireless`. No permission prompt anywhere — the whole location dance is macOS-only. The detail line will be sparser than macOS's: `iw` reports frequency rather than channel, and converting needs a band table we deliberately don't carry, so `ch N` is omitted rather than guessed.
- **Windows:** SSID and channel from `netsh wlan show interfaces`. Signal there is a percentage, not dBm; we convert with `dBm = pct / 2 - 100`, which is the conventional inverse and only ever feeds the bar count. Worth a sanity check that the bars aren't wildly wrong.
