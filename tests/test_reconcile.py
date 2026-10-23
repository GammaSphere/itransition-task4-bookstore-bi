import pandas as pd

from etl.reconcile import author_set_key, reconcile_users, split_authors


def _users(rows):
    return pd.DataFrame(rows, columns=["user_id", "name", "address", "phone", "email"])


def test_records_differing_in_one_field_are_the_same_person():
    users = _users([
        (10, "Ann Lee", "1 Main St", "5550001111", "ann@x.test"),
        (11, "Annie", "1 Main St", "5550001111", "ann@x.test"),     # alias
        (12, "Ann Lee", "9 Oak Ave", "5550001111", "ann@x.test"),   # moved
        (13, "Bob Ray", "2 Elm St", "5550002222", "bob@x.test"),
    ])
    assert reconcile_users(users).tolist() == [10, 10, 10, 13]


def test_grouping_is_transitive():
    users = _users([
        (1, "A", "addr1", "p1", "e1"),
        (2, "B", "addr1", "p1", "e1"),   # name changed vs 1
        (3, "B", "addr1", "p2", "e1"),   # phone changed vs 2, two fields vs 1
    ])
    assert reconcile_users(users).tolist() == [1, 1, 1]


def test_two_changed_fields_are_different_people():
    users = _users([
        (1, "A", "addr1", "p1", "e1"),
        (2, "B", "addr2", "p1", "e1"),
    ])
    assert reconcile_users(users).tolist() == [1, 2]


def test_missing_values_never_match():
    users = _users([
        (1, "A", None, "p1", "e1"),
        (2, "A", None, "p1", "e2"),   # would match only if None == None
        (3, "A", "addr", "p1", "e1"),  # matches 1 on name/phone/email
    ])
    assert reconcile_users(users).tolist() == [1, 2, 1]


def test_author_sets_are_order_independent_and_trimmed():
    assert split_authors("Paul,  John ") == ["John", "Paul"]
    assert author_set_key("John, Paul") == author_set_key("Paul, John") == "John; Paul"
    assert author_set_key("John") != author_set_key("John, Paul")
    assert split_authors(None) == []
