class Repository:
    def __init__(self, name: str) -> None:
        self.name = name

    def label(self) -> str:
        return f"Repository: {self.name}"
