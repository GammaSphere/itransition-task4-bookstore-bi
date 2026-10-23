"""Load, clean and analyse every STORE folder, then export dashboard artifacts.

Usage:  python -m etl.pipeline [--data data] [--out site/data] [--charts outputs]
"""

import argparse
import gzip
import json
import shutil
import sqlite3
from contextlib import closing
from decimal import Decimal
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402
import yaml  # noqa: E402

from etl.parsing import normalize_phone, parse_price, parse_timestamp, to_usd  # noqa: E402
from etl.reconcile import author_set_key, reconcile_users, split_authors  # noqa: E402

NULL_TOKENS = {"", "null", "none", "nan", "n/a", "na", "-"}


def _clean_text(series: pd.Series) -> pd.Series:
    s = series.astype("string").str.replace(r"\s+", " ", regex=True).str.strip()
    return s.mask(s.str.lower().isin(NULL_TOKENS))


# --------------------------------------------------------------------------- load

def load_raw(store_dir: Path):
    orders = pd.read_parquet(store_dir / "orders.parquet")
    users = pd.read_csv(store_dir / "users.csv", dtype=str, keep_default_na=False)
    with open(store_dir / "books.yaml", encoding="utf-8") as f:
        books = pd.DataFrame(yaml.safe_load(f))
    books.columns = [str(c).lstrip(":") for c in books.columns]
    return orders, users, books


# -------------------------------------------------------------------------- clean

def clean_users(raw: pd.DataFrame, report: dict) -> pd.DataFrame:
    users = pd.DataFrame({
        "user_id": pd.to_numeric(raw["id"], errors="coerce").astype("Int64"),
        "name": _clean_text(raw["name"]),
        "address": _clean_text(raw["address"]),
        "phone": _clean_text(raw["phone"]),
        "email": _clean_text(raw["email"]).str.lower(),
    })
    users["phone_digits"] = users["phone"].map(normalize_phone, na_action="ignore").astype("string")
    report["users_raw"] = len(users)
    report["users_missing_address"] = int(users["address"].isna().sum())
    users = users.dropna(subset=["user_id"]).drop_duplicates()
    report["users_duplicate_ids"] = int(users["user_id"].duplicated().sum())
    users = users.drop_duplicates(subset="user_id", keep="first").reset_index(drop=True)

    match_keys = pd.DataFrame({
        "user_id": users["user_id"],
        "name": users["name"].str.lower(),
        "address": users["address"].str.lower(),
        "phone": users["phone_digits"],
        "email": users["email"],
    })
    users["real_user_id"] = reconcile_users(match_keys).astype("Int64")
    return users


def clean_books(raw: pd.DataFrame, report: dict) -> pd.DataFrame:
    books = pd.DataFrame({
        "book_id": pd.to_numeric(raw["id"], errors="coerce").astype("Int64"),
        "title": _clean_text(raw["title"]),
        "author": _clean_text(raw["author"]),
        "genre": _clean_text(raw["genre"]),
        "publisher": _clean_text(raw["publisher"]),
        "year": pd.to_numeric(raw["year"], errors="coerce").astype("Int64"),
    })
    books["year"] = books["year"].where(books["year"] > 0)  # -1 / 0 are placeholders for "unknown"
    report["books_raw"] = len(books)
    report["books_missing"] = {c: int(books[c].isna().sum()) for c in ("publisher", "year") if books[c].isna().any()}
    books = books.dropna(subset=["book_id"]).drop_duplicates(subset="book_id").reset_index(drop=True)
    books["author_set"] = books["author"].map(author_set_key)
    books["n_authors"] = books["author"].map(lambda a: len(split_authors(a))).astype("Int64")
    return books


def clean_orders(raw: pd.DataFrame, report: dict) -> pd.DataFrame:
    prices = raw["unit_price"].map(parse_price)
    stamps = raw["timestamp"].map(parse_timestamp)
    orders = pd.DataFrame({
        "order_id": pd.to_numeric(raw["id"], errors="coerce").astype("Int64"),
        "user_id": pd.to_numeric(raw["user_id"], errors="coerce").astype("Int64"),
        "book_id": pd.to_numeric(raw["book_id"], errors="coerce").astype("Int64"),
        "quantity": pd.to_numeric(raw["quantity"], errors="coerce").astype("Int64"),
        "unit_price_raw": raw["unit_price"].astype("string"),
        "timestamp_raw": raw["timestamp"].astype("string"),
        "shipping": _clean_text(raw["shipping"]),
    })
    orders["unit_price"] = prices.map(lambda p: p[0] if p else None)
    orders["currency"] = prices.map(lambda p: p[1] if p else None).astype("string")
    orders["ts"] = pd.to_datetime(stamps)

    report["orders_raw"] = len(orders)
    bad = (
        orders["unit_price"].isna() | orders["ts"].isna() | orders["order_id"].isna()
        | orders["user_id"].isna() | orders["book_id"].isna()
        | orders["quantity"].isna() | (orders["quantity"] <= 0)
    )
    report["orders_malformed_dropped"] = int(bad.sum())
    orders = orders[~bad]
    report["orders_duplicate_ids_dropped"] = int(orders["order_id"].duplicated().sum())
    orders = orders.drop_duplicates(subset="order_id", keep="first")

    # Money stays in Decimal until the very end so cents are exact.
    usd_unit = [to_usd(a, c) for a, c in zip(orders["unit_price"], orders["currency"])]
    orders["unit_price_usd"] = usd_unit
    orders["paid_price"] = [u * int(q) for u, q in zip(usd_unit, orders["quantity"])]
    orders["date"] = orders["ts"].dt.date
    orders["year"] = orders["ts"].dt.year.astype("Int64")
    orders["month"] = orders["ts"].dt.month.astype("Int64")
    orders["day"] = orders["ts"].dt.day.astype("Int64")
    return orders.reset_index(drop=True)


# ------------------------------------------------------------------------ analyse

def analyse(orders, users, books, report) -> dict:
    orphan_users = ~orders["user_id"].isin(users["user_id"])
    orphan_books = ~orders["book_id"].isin(books["book_id"])
    report["orders_unknown_user"] = int(orphan_users.sum())
    report["orders_unknown_book"] = int(orphan_books.sum())

    daily = orders.groupby("date").agg(
        revenue=("paid_price", "sum"), orders=("order_id", "count"), items=("quantity", "sum"))
    # One row per calendar day: days without orders count as $0, so averages and rolling means are honest.
    daily = daily.reindex(pd.date_range(daily.index.min(), daily.index.max(), freq="D").date)
    daily = pd.DataFrame({
        "date": daily.index,
        "revenue": daily["revenue"].map(lambda r: Decimal(0) if pd.isna(r) else r),
        "orders": daily["orders"].fillna(0).astype(int),
        "items": daily["items"].fillna(0).astype(int),
    }).reset_index(drop=True)
    report["days_without_orders"] = int((daily["orders"] == 0).sum())
    top5 = daily.sort_values(["revenue", "date"], ascending=[False, True]).head(5)

    real = users.set_index("user_id")["real_user_id"]
    orders = orders.assign(real_user_id=orders["user_id"].map(real).fillna(orders["user_id"]).astype("Int64"))
    spend = orders.groupby("real_user_id")["paid_price"].sum().sort_values(ascending=False)
    best_real = int(spend.index[0])
    best_ids = sorted(int(i) for i in users.loc[users["real_user_id"] == best_real, "user_id"])

    sold = orders.merge(books[["book_id", "author_set"]], on="book_id", how="left")
    by_set = sold.groupby("author_set")["quantity"].sum().sort_values(ascending=False)
    top_qty = int(by_set.iloc[0])
    popular = sorted(by_set[by_set == top_qty].index)  # keep ties
    set_revenue = sold.groupby("author_set")["paid_price"].sum()
    set_books = books.groupby("author_set")["book_id"].nunique()
    best_records = users[users["real_user_id"] == best_real].sort_values("user_id")

    total_revenue = sum(orders["paid_price"], Decimal(0))
    return {
        "top5_days": [
            {"date": d.strftime("%Y-%m-%d"), "revenue": float(r), "orders": int(o)}
            for d, r, o in zip(top5["date"], top5["revenue"], top5["orders"])
        ],
        "unique_users": int(users["real_user_id"].nunique()),
        "user_records": int(len(users)),
        "unique_author_sets": int(books["author_set"].nunique()),
        "unique_authors": int(len({a for s in books["author"] for a in split_authors(s)})),
        "most_popular_author_sets": [
            {"authors": s.split("; "), "books_sold": top_qty, "n_books": int(set_books[s]),
             "revenue": float(set_revenue[s])}
            for s in popular
        ],
        "top_author_sets": [
            {"authors": s.split("; "), "books_sold": int(q)} for s, q in by_set.head(5).items()
        ],
        "best_buyer": {
            "user_ids": best_ids,
            "real_user_id": best_real,
            "total_spent": float(spend.iloc[0]),
            "orders": int((orders["real_user_id"] == best_real).sum()),
            "names": sorted(best_records["name"].dropna().unique().tolist()),
            "records": [
                {k: (None if pd.isna(r[k]) else (int(r[k]) if k == "user_id" else str(r[k])))
                 for k in ("user_id", "name", "email", "phone", "address")}
                for _, r in best_records.iterrows()
            ],
        },
        "totals": {
            "revenue": float(total_revenue),
            "orders": int(len(orders)),
            "items_sold": int(orders["quantity"].sum()),
            "books": int(len(books)),
            "first_date": daily["date"].min().strftime("%Y-%m-%d"),
            "last_date": daily["date"].max().strftime("%Y-%m-%d"),
            "eur_orders": int((orders["currency"] == "EUR").sum()),
        },
        "daily_revenue": [
            {"date": d.strftime("%Y-%m-%d"), "revenue": float(r), "orders": int(o), "items": int(i)}
            for d, r, o, i in zip(daily["date"], daily["revenue"], daily["orders"], daily["items"])
        ],
    }, orders


# ------------------------------------------------------------------------- export

def export_sqlite(path: Path, orders, users, books, daily):
    """One SQLite file per store; the dashboard and the AI query tools read it."""
    path.unlink(missing_ok=True)
    o = pd.DataFrame({
        "order_id": orders["order_id"],
        "user_id": orders["user_id"],
        "real_user_id": orders["real_user_id"],
        "book_id": orders["book_id"],
        "quantity": orders["quantity"],
        "unit_price": orders["unit_price"].map(float),
        "currency": orders["currency"],
        "unit_price_usd": orders["unit_price_usd"].map(float),
        "paid_price": orders["paid_price"].map(float),
        "ts": orders["ts"].dt.strftime("%Y-%m-%d %H:%M:%S"),
        "date": orders["ts"].dt.strftime("%Y-%m-%d"),
        "year": orders["year"],
        "month": orders["month"],
        "day": orders["day"],
        "shipping": orders["shipping"],
    })
    u = users[["user_id", "real_user_id", "name", "address", "phone", "phone_digits", "email"]]
    b = books[["book_id", "title", "author", "author_set", "n_authors", "genre", "publisher", "year"]]
    ba = pd.DataFrame(
        [(bid, a) for bid, s in zip(books["book_id"], books["author"]) for a in split_authors(s)],
        columns=["book_id", "author"],
    )

    with closing(sqlite3.connect(path)) as con, con:
        con.executescript("""
            CREATE TABLE orders (order_id INTEGER PRIMARY KEY, user_id INTEGER, real_user_id INTEGER,
                book_id INTEGER, quantity INTEGER, unit_price REAL, currency TEXT, unit_price_usd REAL,
                paid_price REAL, ts TEXT, date TEXT, year INTEGER, month INTEGER, day INTEGER, shipping TEXT);
            CREATE TABLE users (user_id INTEGER PRIMARY KEY, real_user_id INTEGER, name TEXT, address TEXT,
                phone TEXT, phone_digits TEXT, email TEXT);
            CREATE TABLE books (book_id INTEGER PRIMARY KEY, title TEXT, author TEXT, author_set TEXT,
                n_authors INTEGER, genre TEXT, publisher TEXT, year INTEGER);
            CREATE TABLE book_authors (book_id INTEGER, author TEXT);
            CREATE TABLE daily_revenue (date TEXT PRIMARY KEY, revenue REAL, orders INTEGER, items INTEGER);
        """)
        pd.DataFrame(daily)[["date", "revenue", "orders", "items"]].to_sql(
            "daily_revenue", con, if_exists="append", index=False)
        o.to_sql("orders", con, if_exists="append", index=False)
        u.to_sql("users", con, if_exists="append", index=False)
        b.to_sql("books", con, if_exists="append", index=False)
        ba.to_sql("book_authors", con, if_exists="append", index=False)
        con.executescript("""
            CREATE INDEX ix_orders_user ON orders(user_id);
            CREATE INDEX ix_orders_real_user ON orders(real_user_id);
            CREATE INDEX ix_orders_book ON orders(book_id);
            CREATE INDEX ix_orders_date ON orders(date);
            CREATE INDEX ix_users_real ON users(real_user_id);
            CREATE INDEX ix_book_authors ON book_authors(book_id);

            CREATE VIEW customers AS
                SELECT u.real_user_id,
                       GROUP_CONCAT(u.user_id, ',') AS user_ids,
                       COUNT(*) AS n_records,
                       MIN(u.name) AS name,
                       COALESCE(s.total_spent, 0) AS total_spent,
                       COALESCE(s.n_orders, 0) AS n_orders,
                       COALESCE(s.items, 0) AS items
                FROM users u
                LEFT JOIN (SELECT real_user_id, ROUND(SUM(paid_price), 2) AS total_spent,
                                  COUNT(*) AS n_orders, SUM(quantity) AS items
                           FROM orders GROUP BY real_user_id) s USING (real_user_id)
                GROUP BY u.real_user_id;

            CREATE VIEW author_set_sales AS
                SELECT b.author_set, COUNT(DISTINCT b.book_id) AS n_books,
                       COALESCE(SUM(o.quantity), 0) AS books_sold,
                       ROUND(COALESCE(SUM(o.paid_price), 0), 2) AS revenue
                FROM books b LEFT JOIN orders o ON o.book_id = b.book_id
                GROUP BY b.author_set;
        """)
        con.execute("VACUUM")

    # The browser loads these over the network; gzip makes them ~4x smaller.
    with open(path, "rb") as src, gzip.open(path.with_suffix(".sqlite.gz"), "wb", compresslevel=9) as dst:
        shutil.copyfileobj(src, dst)
    path.unlink()


def plot_daily_revenue(metrics: dict, store: str, path: Path):
    daily = pd.DataFrame(metrics["daily_revenue"])
    daily["date"] = pd.to_datetime(daily["date"])
    fig, ax = plt.subplots(figsize=(12, 4.5))
    ax.plot(daily["date"], daily["revenue"], color="#206bc4", linewidth=1)
    ax.plot(daily["date"], daily["revenue"].rolling(7, center=True).mean(), color="#d63939", linewidth=1.6,
            label="7-day mean")
    for d in metrics["top5_days"]:
        ax.annotate(d["date"], (pd.Timestamp(d["date"]), d["revenue"]), fontsize=7, rotation=20,
                    xytext=(4, 4), textcoords="offset points")
    ax.set_title(f"{store} - daily revenue (USD)")
    ax.set_ylabel("USD")
    ax.grid(alpha=0.3)
    ax.legend(loc="upper left")
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)


def process_store(store_dir: Path, out_dir: Path, charts_dir: Path) -> dict:
    store = store_dir.name
    report = {}
    raw_orders, raw_users, raw_books = load_raw(store_dir)
    users = clean_users(raw_users, report)
    books = clean_books(raw_books, report)
    orders = clean_orders(raw_orders, report)
    metrics, orders = analyse(orders, users, books, report)
    metrics["store"] = store
    metrics["cleaning"] = report

    export_sqlite(out_dir / f"{store}.sqlite", orders, users, books, metrics["daily_revenue"])
    plot_daily_revenue(metrics, store, charts_dir / f"{store}_daily_revenue.png")
    return metrics


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data")
    ap.add_argument("--out", default="site/data")
    ap.add_argument("--charts", default="site/charts")
    args = ap.parse_args()

    data_dir, out_dir, charts_dir = Path(args.data), Path(args.out), Path(args.charts)
    out_dir.mkdir(parents=True, exist_ok=True)
    charts_dir.mkdir(parents=True, exist_ok=True)

    stores = sorted(p for p in data_dir.iterdir() if p.is_dir() and (p / "orders.parquet").exists())
    all_metrics = {}
    for store_dir in stores:
        m = process_store(store_dir, out_dir, charts_dir)
        all_metrics[m["store"]] = m
        print(f"{m['store']}: top5={[d['date'] for d in m['top5_days']]} users={m['unique_users']} "
              f"author_sets={m['unique_author_sets']} "
              f"popular={[s['authors'] for s in m['most_popular_author_sets']]} "
              f"best_buyer={m['best_buyer']['user_ids']}")

    with open(out_dir / "metrics.json", "w", encoding="utf-8") as f:
        json.dump({"stores": all_metrics}, f, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
