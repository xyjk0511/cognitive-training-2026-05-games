class CoordinationError(RuntimeError):
    """Base class for deterministic coordination failures."""


class LeaseBusy(CoordinationError):
    pass


class StaleFence(CoordinationError):
    pass


class ProtocolConflict(CoordinationError):
    pass


class TerminalRuntime(CoordinationError):
    pass


class UnknownRuntime(CoordinationError):
    pass


class InvalidState(CoordinationError):
    pass


class InstallBusy(CoordinationError):
    pass


class ReleaseRollback(CoordinationError):
    pass


class PersistedDataCorruption(CoordinationError):
    """Stored bytes, hash, schema, or cross-table invariants are inconsistent."""


class ClockRollback(CoordinationError):
    """A caller attempted to move a monotonic clock domain backwards."""


class SchemaMigrationRequired(CoordinationError):
    """The database cannot be safely opened without an explicit migration."""
