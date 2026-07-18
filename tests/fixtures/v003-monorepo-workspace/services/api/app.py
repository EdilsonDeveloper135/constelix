class HealthService:
    def status(self) -> str:
        return "ready"


def healthcheck() -> str:
    return HealthService().status()
