import pytest


def test_adds():
    assert 1 + 1 == 2


def test_subtracts():
    assert 3 - 1 == 1


@pytest.mark.skip(reason="not yet")
def test_divides():
    pass
