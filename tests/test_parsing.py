from datetime import datetime
from decimal import Decimal

import pytest

from etl.parsing import normalize_phone, parse_price, parse_timestamp, to_usd


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("$ 35", (Decimal("35"), "USD")),
        ("30.0USD", (Decimal("30.0"), "USD")),
        ("37.0 USD", (Decimal("37.0"), "USD")),
        ("USD25.25", (Decimal("25.25"), "USD")),
        ("29.0$", (Decimal("29.0"), "USD")),
        ("29.$", (Decimal("29"), "USD")),
        ("EUR37.50", (Decimal("37.50"), "EUR")),
        ("€ 9.5", (Decimal("9.5"), "EUR")),
        ("12.99 €", (Decimal("12.99"), "EUR")),
        ("$20¢25", (Decimal("20.25"), "USD")),
        ("€22¢25", (Decimal("22.25"), "EUR")),
        ("46$99¢", (Decimal("46.99"), "USD")),
        ("29€50¢", (Decimal("29.50"), "EUR")),
    ],
)
def test_parse_price(raw, expected):
    assert parse_price(raw) == expected


@pytest.mark.parametrize("raw", [None, "", "abc", "12.5", "$ -3", "$0", "USD 3 EUR"])
def test_parse_price_rejects_malformed(raw):
    assert parse_price(raw) is None


def test_to_usd_converts_euro_and_rounds_half_up():
    assert to_usd(Decimal("37.50"), "EUR") == Decimal("45.00")
    assert to_usd(Decimal("52.99"), "EUR") == Decimal("63.59")  # 63.588
    assert to_usd(Decimal("10.125"), "USD") == Decimal("10.13")


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("2025-12-23T04:36:49", datetime(2025, 12, 23, 4, 36, 49)),
        ("2025-08-26T20:57:40.674", datetime(2025, 8, 26, 20, 57, 40)),
        ("10.12.2025 10:59:59", datetime(2025, 12, 10, 10, 59, 59)),
        (" 4.05.2026 11:45:45", datetime(2026, 5, 4, 11, 45, 45)),
        ("24.05.2025  8:44:44", datetime(2025, 5, 24, 8, 44, 44)),
        ("2026-01-08, 14:26", datetime(2026, 1, 8, 14, 26)),
        ("03:13:56;2026-01-22", datetime(2026, 1, 22, 3, 13, 56)),
        ("02/16/26 12:54", datetime(2026, 2, 16, 12, 54)),
        ("23:39,10/28/25", datetime(2025, 10, 28, 23, 39)),
        ("09:28,10-Dec-2025", datetime(2025, 12, 10, 9, 28)),
        ("20:14:32, 12-December-2025", datetime(2025, 12, 12, 20, 14, 32)),
        ("04:36:48, 28-AUG-2025", datetime(2025, 8, 28, 4, 36, 48)),
        ("Fri Apr 10 15:32:26 2026", datetime(2026, 4, 10, 15, 32, 26)),
        ("Mon Dec  1 11:34:57 2025", datetime(2025, 12, 1, 11, 34, 57)),
        ("2025-06-25;05:00:01 A.M.", datetime(2025, 6, 25, 5, 0, 1)),
        ("10:31:43 P.M. 2026-01-14", datetime(2026, 1, 14, 22, 31, 43)),
        ("12:20:34 A.M.,2025-12-11", datetime(2025, 12, 11, 0, 20, 34)),
        ("12:02:54 P.M. 12/17/25", datetime(2025, 12, 17, 12, 2, 54)),
        ("01/09/26 03:10:17 am", datetime(2026, 1, 9, 3, 10, 17)),
        ("20-Jul-2025;01:00:12 AM", datetime(2025, 7, 20, 1, 0, 12)),
        (" 2-AUG-2025,03:07", datetime(2025, 8, 2, 3, 7)),
        ("02:29,  3-October-2025", datetime(2025, 10, 3, 2, 29)),
    ],
)
def test_parse_timestamp(raw, expected):
    assert parse_timestamp(raw) == expected


@pytest.mark.parametrize("raw", [None, "", "yesterday", "2025-02-30 10:00", "13:00 PM 2025-01-01"])
def test_parse_timestamp_rejects_malformed(raw):
    assert parse_timestamp(raw) is None


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("(313) 970-1817", "3139701817"),
        ("905.314.5984", "9053145984"),
        ("332-256-2176", "3322562176"),
        ("658 592 6014", "6585926014"),
        ("+1 658 592 6014", "6585926014"),
        ("", None),
    ],
)
def test_normalize_phone(raw, expected):
    assert normalize_phone(raw) == expected
