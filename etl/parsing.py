"""Parsers for the messy raw fields (prices, timestamps, phones)."""

import re
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal

EUR_TO_USD = Decimal("1.2")
CENT = Decimal("0.01")

_CURRENCY = re.compile(r"USD|EUR|\$|€")
# "$20¢25" / "€22¢25" -> 20.25
_CENTS_AFTER_SYMBOL = re.compile(r"^[$€](\d+)¢(\d{1,2})$")
# "46$99¢" / "29€50¢" -> 46.99
_CENTS_SPLIT_BY_SYMBOL = re.compile(r"^(\d+)[$€](\d{1,2})¢$")
_PLAIN_AMOUNT = re.compile(r"^\d+(?:\.\d*)?$")


def parse_price(raw):
    """Return (amount: Decimal, currency: 'USD'|'EUR') or None if malformed."""
    if raw is None:
        return None
    s = re.sub(r"\s+", "", str(raw))
    found = set(_CURRENCY.findall(s))
    currencies = {"USD" if c in ("USD", "$") else "EUR" for c in found}
    if len(currencies) != 1:
        return None
    currency = currencies.pop()

    m = _CENTS_AFTER_SYMBOL.match(s) or _CENTS_SPLIT_BY_SYMBOL.match(s)
    if m:
        amount = Decimal(f"{m.group(1)}.{m.group(2).ljust(2, '0')}")
    else:
        bare = _CURRENCY.sub("", s)
        if not _PLAIN_AMOUNT.match(bare):
            return None
        amount = Decimal(bare.rstrip(".") or "0")
    if amount <= 0:
        return None
    return amount, currency


def to_usd(amount, currency):
    rate = EUR_TO_USD if currency == "EUR" else Decimal(1)
    return (amount * rate).quantize(CENT, rounding=ROUND_HALF_UP)


_MONTHS = {
    m: i
    for i, names in enumerate(
        [
            ("jan", "january"), ("feb", "february"), ("mar", "march"),
            ("apr", "april"), ("may",), ("jun", "june"), ("jul", "july"),
            ("aug", "august"), ("sep", "sept", "september"), ("oct", "october"),
            ("nov", "november"), ("dec", "december"),
        ],
        start=1,
    )
    for m in names
}

_TIME = re.compile(r"(?<![\d:])(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(AM|PM)?(?![\d:])")
_DATE_PATTERNS = [
    # 2025-12-23 (also inside ISO 2025-12-23T04:36:49)
    (re.compile(r"(\d{4})-(\d{1,2})-(\d{1,2})"), lambda m: (int(m[1]), int(m[2]), int(m[3]))),
    # 30.06.2025 -> day.month.year
    (re.compile(r"(\d{1,2})\.(\d{1,2})\.(\d{4})"), lambda m: (int(m[3]), int(m[2]), int(m[1]))),
    # 02/16/26 -> month/day/2-digit year (verified: first part is never > 12)
    (re.compile(r"(\d{1,2})/(\d{1,2})/(\d{2,4})"), lambda m: (_year(m[3]), int(m[1]), int(m[2]))),
    # 12-Oct-2025 / 7-MAR-2026 / 15-September-2025
    (re.compile(r"(\d{1,2})-([A-Z]+)-(\d{4})"), lambda m: (int(m[3]), _MONTHS[m[2].lower()], int(m[1]))),
    # ctime "Fri Apr 10 15:32:26 2026", seen here with the time already removed
    (re.compile(r"[A-Z]{3} ([A-Z]{3}) (\d{1,2}) (\d{4})"),
     lambda m: (int(m[3]), _MONTHS[m[1].lower()], int(m[2]))),
]


def _year(y):
    y = int(y)
    return 2000 + y if y < 100 else y


def parse_timestamp(raw):
    """Parse one of the ~160 timestamp layouts in the orders data; None if malformed."""
    if raw is None:
        return None
    s = str(raw).upper().replace("A.M.", "AM").replace("P.M.", "PM")
    s = re.sub(r"(\d)T(\d)", r"\1 \2", s)  # ISO 8601 separator
    s = re.sub(r"\s+", " ", s).strip()

    t = _TIME.search(s)
    if not t:
        return None
    hour, minute, second = int(t[1]), int(t[2]), int(t[3] or 0)
    if t[4]:
        if not 1 <= hour <= 12:
            return None
        hour = hour % 12 + (12 if t[4] == "PM" else 0)
    rest = re.sub(r"\s+", " ", s[: t.start()] + " " + s[t.end():]).strip()

    for pattern, build in _DATE_PATTERNS:
        m = pattern.search(rest)
        if m:
            try:
                year, month, day = build(m)
                return datetime(year, month, day, hour, minute, second)
            except (KeyError, ValueError):
                return None
    return None


def normalize_phone(raw):
    """Keep digits only and drop a leading US country code."""
    digits = re.sub(r"\D", "", str(raw or ""))
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return digits or None
