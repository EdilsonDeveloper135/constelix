from .models import Repository


def describe_repository(name: str) -> str:
    repository = Repository(name)
    return repository.label()
