//! Typed error enum for PTY operations.

use crate::pty::PtyId;

/// Errors that can occur in the PTY manager.
#[derive(Debug, thiserror::Error)]
pub enum PtyError {
    /// The requested PTY id does not exist in the manager's registry.
    #[error("unknown PTY id: {0}")]
    UnknownId(PtyId),

    /// Spawning the child process or opening the PTY pair failed.
    #[error("PTY spawn failed: {0}")]
    Spawn(String),

    /// A write to the PTY master failed.
    #[error("PTY write failed: {0}")]
    Write(String),

    /// A resize operation failed.
    #[error("PTY resize failed: {0}")]
    Resize(String),

    /// The caller supplied malformed input (e.g. invalid base64).
    #[error("invalid input: {0}")]
    InvalidInput(String),
}
