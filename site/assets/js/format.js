const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1,
});
const intFmt = new Intl.NumberFormat("en-US");

export const money = (x) => (x == null ? "—" : usd.format(x));
export const moneyCompact = (x) => (x == null ? "—" : usdCompact.format(x));
export const int = (x) => (x == null ? "—" : intFmt.format(x));

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export const idArray = (ids) => `[${ids.join(", ")}]`;
