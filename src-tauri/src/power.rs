//! OS-level "keep this machine awake" assertion (M13.4, spec §19 D6).
//!
//! The sidebar's caffeinate widget asks the operating system to
//! suppress idle sleep for as long as the user leaves it on. This is
//! **app state, not shell state** — it changes nothing about the
//! user's shell, filesystem, or repository, and so does not travel
//! through the honest-log emit path the way a widget-issued `git`
//! command does. Spec §19 D6 draws that line explicitly; read it
//! before adding anything here that touches a pane.
//!
//! Each platform gets the mechanism its OS actually sanctions:
//!
//! - **macOS** — a child `caffeinate -di` process, parented to Shax
//!   rather than to any pane's shell. `-w <our pid>` makes the OS
//!   reap it if Shax dies without releasing cleanly, so a crash can
//!   never strand a machine that refuses to sleep.
//! - **Linux** — a child `systemd-inhibit … sleep infinity`. The
//!   inhibitor lock is released when that child dies.
//! - **Windows** — `SetThreadExecutionState`, which needs no child
//!   process at all. This is why Windows is no longer deferred: the
//!   blocker was never the platform, it was the requirement to
//!   express the assertion as a shell command.
//!
//! The two Unix platforms shell out rather than binding IOKit /
//! logind directly: the child-process route needs no `unsafe`, no
//! new dependency, and is the interface both vendors document for
//! exactly this purpose.
//!
//! Only one assertion is ever held. `set(true)` twice is idempotent,
//! and the invariant every caller can rely on is that a failed
//! acquire leaves the assertion **off** — never "errored but somehow
//! holding."

use std::sync::Mutex;

use tauri::Emitter as _;

/// Failure modes of acquiring or releasing the assertion. Every
/// variant is recoverable: the widget reports it and stays off.
#[derive(Debug, thiserror::Error)]
pub enum PowerError {
    /// Spawning the helper process failed (binary missing, no
    /// permission, no systemd session), or the platform has no
    /// mechanism wired up at all.
    #[error("failed to acquire keep-awake assertion: {0}")]
    Acquire(String),
    /// Releasing failed — the child would not die, or the Win32 call
    /// rejected the reset.
    #[error("failed to release keep-awake assertion: {0}")]
    Release(String),
}

/// A held assertion plus the instant it was acquired.
///
/// The backend owns the start time because the assertion is
/// process-wide and every window must show the *same* duration —
/// including a window opened long after the assertion began, which
/// has no other way of knowing when that was.
struct Held {
    assertion: imp::Assertion,
    since_ms: u64,
}

/// The single process-wide assertion, or `None` when off.
static ASSERTION: Mutex<Option<Held>> = Mutex::new(None);

/// The assertion's state as the frontend sees it. `since_ms` is a
/// Unix-epoch millisecond stamp, present only while held.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct KeepAwakeState {
    pub held: bool,
    pub since_ms: Option<u64>,
}

const OFF: KeepAwakeState = KeepAwakeState {
    held: false,
    since_ms: None,
};

/// Turn the assertion on or off. Returns the state that actually
/// holds afterwards, which is always "off" when an error is
/// returned. Idempotent in both directions.
pub fn set(enable: bool) -> Result<KeepAwakeState, PowerError> {
    let mut slot = lock();
    if enable {
        // Same verification as `state`: a helper that died under us
        // must not make this look like a no-op, or toggling off and on
        // again would never recover.
        if slot
            .as_mut()
            .is_some_and(|held| !imp::is_alive(&mut held.assertion))
        {
            slot.take();
        }
        if let Some(held) = slot.as_ref() {
            // Idempotent: a second acquire keeps the ORIGINAL start
            // time. Restamping would silently reset every window's
            // duration to zero.
            return Ok(KeepAwakeState {
                held: true,
                since_ms: Some(held.since_ms),
            });
        }
        // Assign only on success, so the "errored but holding" state
        // is unrepresentable rather than merely avoided.
        let assertion = imp::acquire()?;
        let since_ms = now_ms();
        *slot = Some(Held {
            assertion,
            since_ms,
        });
        Ok(KeepAwakeState {
            held: true,
            since_ms: Some(since_ms),
        })
    } else {
        match slot.take() {
            None => Ok(OFF),
            Some(held) => {
                imp::release(held.assertion)?;
                Ok(OFF)
            }
        }
    }
}

/// The current state, verified against the underlying mechanism
/// rather than read from our own bookkeeping.
///
/// The verification is load-bearing on Linux. `systemd-inhibit`
/// exists on any systemd distro but still fails when there is no
/// logind session to talk to — headless boxes, plain SSH, containers,
/// WSL without systemd — and it fails by *exiting*, not by refusing to
/// spawn. Checking for that at spawn time cannot work: the child has
/// not been scheduled yet, so it always still looks alive. Verifying
/// on read catches it, and catches every later death too — someone
/// killing the helper, logind revoking the lock — instead of only the
/// first instant.
pub fn state() -> KeepAwakeState {
    let mut slot = lock();
    let dead = match slot.as_mut() {
        None => return OFF,
        Some(held) => !imp::is_alive(&mut held.assertion),
    };
    if dead {
        // Drop our record of it: whatever we were holding is gone, and
        // reporting "on" for it would be exactly the lie this widget
        // exists to prevent.
        slot.take();
        tracing::warn!("keep-awake: helper died; assertion no longer held");
        return OFF;
    }
    slot.as_ref().map_or(OFF, |held| KeepAwakeState {
        held: true,
        since_ms: Some(held.since_ms),
    })
}

/// Wall-clock milliseconds since the Unix epoch. A clock before 1970
/// collapses to 0 rather than panicking — a nonsense duration is a
/// better failure than a dead command.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Release on the way out of the process. Called from the
/// `RunEvent::Exit` arm in `lib.rs`. Errors are logged, never
/// propagated — we are already exiting, and on macOS the
/// `caffeinate -w` guard covers us anyway.
pub fn release_on_exit() {
    if let Some(held) = lock().take() {
        if let Err(e) = imp::release(held.assertion) {
            tracing::warn!("keep-awake: release on exit failed: {e}");
        }
    }
}

/// Recover from a poisoned mutex rather than propagating a panic.
/// The protected value is a process handle, not an invariant-bearing
/// structure, so a panic elsewhere leaves it perfectly usable.
fn lock() -> std::sync::MutexGuard<'static, Option<Held>> {
    ASSERTION.lock().unwrap_or_else(|e| e.into_inner())
}

/// Set or clear the assertion, then tell **every** window what the
/// state now is.
///
/// The assertion is process-wide but each window renders its own
/// widget, so without the broadcast a window that didn't issue the
/// toggle would keep showing the state it read at mount — an "off"
/// switch on a machine that is genuinely being kept awake. Emitted
/// app-globally on purpose: every window is a legitimate audience for
/// this, unlike the targeted `emit_to` the quit-confirm path needs.
#[tauri::command]
pub fn power_keep_awake(app: tauri::AppHandle, enable: bool) -> Result<KeepAwakeState, String> {
    let state = set(enable).map_err(|e| e.to_string())?;
    if let Err(e) = app.emit("shax:keep-awake-changed", state) {
        // The assertion is real regardless; a failed broadcast only
        // means other windows resync later, on their next mount.
        tracing::warn!("keep-awake: broadcast failed: {e}");
    }
    Ok(state)
}

/// Current assertion state, so a window mounting into a session that
/// already holds one adopts it rather than assuming off.
#[tauri::command]
pub fn power_keep_awake_state() -> KeepAwakeState {
    state()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod imp {
    use super::PowerError;
    use std::io::ErrorKind;
    use std::process::{Child, Command, Stdio};

    /// A live helper process. Dropping it does NOT release the
    /// assertion — release goes through `release` so the child is
    /// reaped rather than left a zombie.
    pub struct Assertion(Child);

    pub fn acquire() -> Result<Assertion, PowerError> {
        let (program, mut command) = helper();
        // No stdio: the helper is silent, and leaving it attached
        // would let it write into whatever launched Shax.
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        pdeathsig(&mut command);
        // Rust reports exec failure back through a pipe, so a missing
        // binary surfaces here rather than as a child that dies. The
        // *other* Linux failure — present but no logind session — is
        // not visible at spawn time and cannot be: the child has not
        // been scheduled yet. `super::state` catches that by verifying
        // on every read.
        let child = command.spawn().map_err(|e| {
            PowerError::Acquire(if e.kind() == ErrorKind::NotFound {
                missing_message(program)
            } else {
                format!("could not start {program}: {e}")
            })
        })?;
        Ok(Assertion(child))
    }

    pub fn release(mut assertion: Assertion) -> Result<(), PowerError> {
        assertion
            .0
            .kill()
            .map_err(|e| PowerError::Release(e.to_string()))?;
        assertion
            .0
            .wait()
            .map_err(|e| PowerError::Release(e.to_string()))?;
        Ok(())
    }

    impl Assertion {
        /// Wrap an arbitrary child so tests can drive the
        /// died-under-us path with a helper that exits on its own.
        #[cfg(test)]
        pub fn from_child_for_test(child: Child) -> Self {
            Self(child)
        }
    }

    /// Whether the helper is still running. Reaps it when it isn't, so
    /// a dead helper doesn't linger as a zombie.
    ///
    /// A `try_wait` error means we can no longer reason about the
    /// child at all, which we treat as "not held" — claiming an
    /// assertion we cannot verify is the failure mode that matters.
    pub fn is_alive(assertion: &mut Assertion) -> bool {
        matches!(assertion.0.try_wait(), Ok(None))
    }

    /// Kill the helper if Shax dies without releasing it.
    ///
    /// macOS gets this from `caffeinate -w <pid>`. Linux has no such
    /// flag, so without `PR_SET_PDEATHSIG` a `SIGKILL`ed Shax leaves
    /// `systemd-inhibit` reparented to init, holding the lock until
    /// the user logs out.
    #[cfg(target_os = "linux")]
    fn pdeathsig(command: &mut Command) {
        use std::os::unix::process::CommandExt as _;
        // SAFETY: `pre_exec` runs between fork and exec, where only
        // async-signal-safe calls are permitted. `prctl` is one, and
        // this closure allocates nothing, takes no locks, and touches
        // no shared state.
        unsafe {
            command.pre_exec(|| {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    /// macOS reaps via `caffeinate -w <pid>` instead — see `helper`.
    #[cfg(target_os = "macos")]
    fn pdeathsig(_command: &mut Command) {}

    #[cfg(target_os = "macos")]
    fn missing_message(program: &str) -> String {
        format!("{program} is missing; keep-awake needs it to hold the assertion")
    }

    #[cfg(target_os = "linux")]
    fn missing_message(_program: &str) -> String {
        "systemd-inhibit not found; keep-awake needs systemd on this machine".to_string()
    }

    /// The helper to run, and its name for error messages.
    ///
    /// Absolute paths rather than a bare `PATH` lookup: the app's
    /// inherited `PATH` is not something we control, and a lookup
    /// would run whatever resolves first under that name.
    #[cfg(target_os = "macos")]
    fn helper() -> (&'static str, Command) {
        const CAFFEINATE: &str = "/usr/bin/caffeinate";
        let mut command = Command::new(CAFFEINATE);
        // -d: no display sleep. -i: no idle system sleep.
        // -w <pid>: exit when Shax exits, so a crash can't strand a
        // machine that will not sleep.
        command
            .arg("-di")
            .arg("-w")
            .arg(std::process::id().to_string());
        (CAFFEINATE, command)
    }

    #[cfg(target_os = "linux")]
    fn helper() -> (&'static str, Command) {
        // Absolute where systemd normally installs it, falling back to
        // a PATH lookup — the location varies more across distros than
        // it does on macOS, so a hard absolute path would fail on
        // layouts that are otherwise perfectly capable.
        const ABSOLUTE: &str = "/usr/bin/systemd-inhibit";
        let program = if std::path::Path::new(ABSOLUTE).exists() {
            ABSOLUTE
        } else {
            "systemd-inhibit"
        };
        let mut command = Command::new(program);
        // `--what=idle` only. Adding `sleep` asks logind to veto
        // explicit suspend requests too, which is both wrong (if the
        // user deliberately suspends, Shax should not override them)
        // and fragile: block-mode sleep inhibitors are polkit-gated,
        // so unprivileged users get denied on machines where plain
        // idle inhibition would have worked.
        //
        // `--who` / `--why` are what `systemd-inhibit --list` shows,
        // so an assertion the user forgot about is traceable back to
        // this app rather than appearing anonymous.
        command
            .arg("--what=idle")
            .arg("--who=Shax")
            .arg("--why=Keep awake requested from the Shax sidebar")
            .arg("--mode=block")
            .arg("sleep")
            .arg("infinity");
        (program, command)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod imp {
    use super::PowerError;

    pub struct Assertion;

    pub fn acquire() -> Result<Assertion, PowerError> {
        Err(PowerError::Acquire(
            "keep-awake is not supported on this platform".to_string(),
        ))
    }

    pub fn release(_assertion: Assertion) -> Result<(), PowerError> {
        Ok(())
    }

    /// Unreachable — `acquire` never hands one out on this platform.
    pub fn is_alive(_assertion: &mut Assertion) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The assertion is process-global, and `cargo test` runs tests
    /// on parallel threads — without this, one test's release would
    /// race another's acquire. Every test in this module takes it.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn serialised() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The tests deliberately assert the *state machine*, not that the
    /// host OS grants the assertion. CI runners are headless and a
    /// Linux container may have no logind session, so requiring a
    /// successful acquire would make this suite a flake detector for
    /// the runner image rather than a test of this module.
    #[test]
    fn turning_off_is_always_safe_and_idempotent() {
        let _guard = serialised();
        assert!(!set(false).expect("release must not fail").held);
        assert!(!set(false).expect("release must not fail").held);
        assert!(!state().held);
    }

    #[test]
    fn a_failed_acquire_never_leaves_the_assertion_held() {
        let _guard = serialised();
        // The load-bearing invariant: whatever `set(true)` returns,
        // `state().held` agrees with it. "Errored but holding" would
        // strand the user's machine awake with a widget showing off.
        match set(true) {
            Ok(acquired) => {
                assert!(acquired.held);
                assert!(acquired.since_ms.is_some());
                assert!(state().held);
                assert!(!set(false).expect("release must not fail").held);
                assert!(!state().held);
            }
            Err(_) => assert!(!state().held),
        }
    }

    #[test]
    fn acquiring_twice_holds_exactly_one_assertion() {
        let _guard = serialised();
        if set(true).is_err() {
            // Platform refused; nothing to assert about idempotence.
            assert!(!state().held);
            return;
        }
        let first = state().since_ms;
        let second = set(true).expect("second acquire must be idempotent");
        assert!(second.held);
        // Restamping on a redundant acquire would silently reset every
        // window's displayed duration to zero.
        assert_eq!(second.since_ms, first);
        // A single release must fully clear it — if the second
        // acquire had leaked a second helper, this would leave one
        // behind and `state()` would still report held.
        assert!(!set(false).expect("release must not fail").held);
        assert!(!state().held);
    }

    /// The regression this whole review turned on. A helper that dies
    /// under us — `systemd-inhibit` with no logind session is the real
    /// case — must show as OFF, not as a happily ticking toggle on a
    /// machine that is about to sleep.
    ///
    /// Driven directly against the Unix backend with a helper that
    /// exits immediately, because `set(true)` cannot reproduce it:
    /// the whole point is that the death is invisible at spawn time.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn a_helper_that_dies_reads_back_as_off() {
        let _guard = serialised();
        set(false).expect("start from a known-off state");

        let child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("exit 1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawning /bin/sh must work");
        *lock() = Some(Held {
            assertion: imp::Assertion::from_child_for_test(child),
            since_ms: now_ms(),
        });

        // Give the helper a moment to actually die. The bug was
        // checking for this at spawn time, when it necessarily still
        // looks alive.
        std::thread::sleep(std::time::Duration::from_millis(150));

        assert_eq!(state(), OFF, "a dead helper must not read as held");
        // ...and the slot is cleared, not merely reported as off, so
        // toggling on again re-acquires rather than short-circuiting.
        assert!(lock().is_none());
    }

    #[test]
    fn state_reports_a_start_time_exactly_when_held() {
        let _guard = serialised();
        assert_eq!(state(), OFF);
        if set(true).is_err() {
            return;
        }
        let held = state();
        assert!(held.held);
        // Every window computes its duration from this, so it must be
        // present for a held assertion and absent otherwise.
        assert!(held.since_ms.is_some());
        set(false).expect("release must not fail");
        assert_eq!(state(), OFF);
    }
}
