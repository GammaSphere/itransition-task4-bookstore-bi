"""Entity resolution for users and canonical author sets for books."""

from collections import defaultdict

import pandas as pd

USER_FIELDS = ("name", "address", "phone", "email")


class _UnionFind:
    def __init__(self, n):
        self.parent = list(range(n))

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)


def reconcile_users(users: pd.DataFrame) -> pd.Series:
    """Map every user record to a real-person id (the smallest user_id of its group).

    Two records belong to the same person when they agree on at least three of the
    four normalized fields (name, address, phone, email), i.e. at most one field was
    changed. Grouping is transitive, so A~B and B~C puts A, B and C together.
    Missing values never count as a match.
    """
    keys = users[list(USER_FIELDS)].to_numpy()
    uf = _UnionFind(len(users))
    buckets = defaultdict(list)
    for i, row in enumerate(keys):
        for skip in range(len(USER_FIELDS)):
            key = tuple(v for j, v in enumerate(row) if j != skip)
            if any(pd.isna(v) for v in key):
                continue
            buckets[(skip, key)].append(i)
    for members in buckets.values():
        for other in members[1:]:
            uf.union(members[0], other)

    ids = users["user_id"].to_numpy()
    roots = [uf.find(i) for i in range(len(users))]
    root_to_id = pd.Series(ids).groupby(roots).min()
    return pd.Series([root_to_id[r] for r in roots], index=users.index, name="real_user_id")


def split_authors(author_field) -> list[str]:
    if author_field is None or pd.isna(author_field):
        return []
    names = (" ".join(n.split()) for n in str(author_field).split(","))
    return sorted({n for n in names if n})


def author_set_key(author_field) -> str:
    """Order-independent key: 'John, Paul' and 'Paul, John' are the same set."""
    return "; ".join(split_authors(author_field))
