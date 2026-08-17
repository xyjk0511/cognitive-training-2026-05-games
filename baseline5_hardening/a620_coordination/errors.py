class CoordinationError(RuntimeError):
    pass

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
