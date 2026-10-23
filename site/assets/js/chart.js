// Daily revenue chart (ApexCharts) with granularity, date range and a 7-day average.

import { money, moneyCompact } from "./format.js";

const DAY = 86_400_000;

const PALETTE = {
  light: { series1: "#2a78d6", series2: "#eb6834", grid: "#e6e7e9", text: "#52514e" },
  dark: { series1: "#3987e5", series2: "#d95926", grid: "#2c3440", text: "#c3c2b7" },
};

const utc = (iso) => Date.parse(`${iso}T00:00:00Z`);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function fillDays(daily) {
  if (!daily.length) return [];
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const out = [];
  for (let t = utc(daily[0].date); t <= utc(daily[daily.length - 1].date); t += DAY) {
    const d = byDate.get(isoDay(t));
    out.push({ t, revenue: d ? d.revenue : 0, orders: d ? d.orders : 0 });
  }
  return out;
}

function bucketStart(t, granularity) {
  const d = new Date(t);
  if (granularity === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  if (granularity === "week") return t - ((d.getUTCDay() + 6) % 7) * DAY; // Monday
  return t;
}

function aggregate(days, granularity) {
  if (granularity === "day") return days;
  const buckets = new Map();
  for (const d of days) {
    const k = bucketStart(d.t, granularity);
    const b = buckets.get(k) || { t: k, revenue: 0, orders: 0 };
    b.revenue += d.revenue;
    b.orders += d.orders;
    buckets.set(k, b);
  }
  return [...buckets.values()].map((b) => ({ ...b, revenue: Math.round(b.revenue * 100) / 100 }));
}

function movingAverage(days, window = 7) {
  const half = Math.floor(window / 2);
  return days.map((d, i) => {
    if (i < half || i >= days.length - half) return { x: d.t, y: null };
    let sum = 0;
    for (let j = i - half; j <= i + half; j++) sum += days[j].revenue;
    return { x: d.t, y: Math.round((sum / window) * 100) / 100 };
  });
}

export class RevenueChart {
  constructor(el, { onChange } = {}) {
    this.el = el;
    this.onChange = onChange;
    this.state = { granularity: "day", showAverage: true, start: null, end: null };
    this.days = [];
    this.top5 = [];
    this.chart = null;
  }

  get theme() {
    return document.documentElement.getAttribute("data-bs-theme") === "dark" ? "dark" : "light";
  }

  setData(daily, top5) {
    this.days = fillDays(daily);
    this.top5 = top5;
    this.state = { granularity: "day", showAverage: true, start: null, end: null };
    this.render();
  }

  /** Apply a partial state change (used by the UI controls and by the assistant). */
  update({ start_date, end_date, granularity, show_average, reset } = {}) {
    if (reset) this.state = { granularity: "day", showAverage: true, start: null, end: null };
    if (granularity) this.state.granularity = granularity;
    if (typeof show_average === "boolean") this.state.showAverage = show_average;
    for (const [key, value] of [["start", start_date], ["end", end_date]]) {
      if (value === undefined) continue;
      if (value === null || value === "") this.state[key] = null;
      else if (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(utc(value))) this.state[key] = value;
      else throw new Error(`Invalid date ${value}; use YYYY-MM-DD`);
    }
    this.render();
    return this.describe();
  }

  describe() {
    const first = this.days[0], last = this.days[this.days.length - 1];
    return {
      granularity: this.state.granularity,
      show_average: this.state.showAverage && this.state.granularity === "day",
      start_date: this.state.start || (first && isoDay(first.t)),
      end_date: this.state.end || (last && isoDay(last.t)),
    };
  }

  series() {
    const points = aggregate(this.days, this.state.granularity);
    const label = { day: "Daily revenue", week: "Weekly revenue", month: "Monthly revenue" }[this.state.granularity];
    const out = [{ name: label, type: "area", data: points.map((p) => ({ x: p.t, y: p.revenue, orders: p.orders })) }];
    if (this.state.showAverage && this.state.granularity === "day") {
      out.push({ name: "7-day average", type: "line", data: movingAverage(this.days) });
    }
    return out;
  }

  options() {
    const c = PALETTE[this.theme];
    const series = this.series();
    const annotations = this.state.granularity === "day"
      ? this.top5.map((d, i) => ({
        x: utc(d.date), y: d.revenue,
        marker: { size: 5, fillColor: c.series1, strokeColor: this.theme === "dark" ? "#1a1a19" : "#fcfcfb", strokeWidth: 2 },
        label: { text: `#${i + 1}`, borderWidth: 0, offsetY: -4, style: { background: "transparent", color: c.text, fontSize: "11px", fontWeight: 600 } },
      }))
      : [];
    return {
      chart: {
        type: "line", height: 340, fontFamily: "inherit", background: "transparent", parentHeightOffset: 0,
        toolbar: { show: true, tools: { download: true, selection: false, zoom: true, zoomin: true, zoomout: true, pan: false, reset: true } },
        zoom: { enabled: true, type: "x" },
        animations: { enabled: false },
        events: {
          // The toolbar reset would restore the range baked into this render; go back to everything instead.
          beforeResetZoom: () => {
            this.state.start = this.state.end = null;
            this.onChange?.(this.describe());
            const first = this.days[0], last = this.days[this.days.length - 1];
            return { xaxis: { min: first?.t, max: last ? last.t + DAY - 1 : undefined } };
          },
          zoomed: (_, { xaxis }) => {
            this.state.start = xaxis?.min ? isoDay(xaxis.min) : null;
            this.state.end = xaxis?.max ? isoDay(xaxis.max) : null;
            this.onChange?.(this.describe());
          },
        },
      },
      theme: { mode: this.theme },
      series,
      colors: [c.series1, c.series2],
      stroke: { width: [series.length > 1 ? 1.5 : 2, 2], curve: "straight", lineCap: "round" },
      fill: { type: ["solid", "solid"], opacity: [0.1, 1] },
      dataLabels: { enabled: false },
      markers: { size: 0, hover: { size: 5 } },
      legend: { show: series.length > 1, position: "top", horizontalAlign: "left", labels: { colors: c.text }, markers: { size: 6 } },
      grid: { borderColor: c.grid, strokeDashArray: 0, padding: { left: 8, right: 8 } },
      xaxis: {
        type: "datetime",
        min: this.state.start ? utc(this.state.start) : undefined,
        max: this.state.end ? utc(this.state.end) + DAY - 1 : undefined,
        labels: { style: { colors: c.text }, datetimeUTC: true },
        axisBorder: { color: c.grid }, axisTicks: { color: c.grid },
        tooltip: { enabled: false },
      },
      yaxis: { min: 0, labels: { style: { colors: c.text }, formatter: (v) => moneyCompact(v) } },
      annotations: { points: annotations },
      tooltip: {
        shared: true, intersect: false, theme: this.theme,
        x: {
          formatter: (v) => {
            const iso = isoDay(v);
            if (this.state.granularity === "month") return iso.slice(0, 7);
            if (this.state.granularity === "week") return `Week of ${iso}`;
            return iso;
          },
        },
        y: { formatter: (v, { seriesIndex, dataPointIndex, w }) => {
          if (v == null) return "—";
          if (seriesIndex === 0) {
            const orders = w.config.series[0].data[dataPointIndex]?.orders;
            return `${money(v)}${orders != null ? ` · ${orders} orders` : ""}`;
          }
          return money(v);
        } },
      },
      noData: { text: "No data" },
    };
  }

  render() {
    if (!window.ApexCharts) return;
    if (this.chart) this.chart.destroy();
    this.chart = new window.ApexCharts(this.el, this.options());
    this.chart.render();
    this.onChange?.(this.describe());
  }
}

/** Small-multiple friendly monthly revenue comparison across stores. */
export function renderStoreComparison(el, metricsByStore, theme) {
  const colors = theme === "dark"
    ? ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"]
    : ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"];
  const c = PALETTE[theme];
  const series = Object.entries(metricsByStore).map(([store, m]) => {
    const months = aggregate(fillDays(m.daily_revenue), "month");
    return { name: store, data: months.map((p) => ({ x: p.t, y: p.revenue })) };
  });
  const chart = new window.ApexCharts(el, {
    chart: { type: "line", height: 320, fontFamily: "inherit", background: "transparent", toolbar: { show: false }, animations: { enabled: false } },
    theme: { mode: theme },
    series,
    colors,
    stroke: { width: 2, curve: "straight", lineCap: "round" },
    markers: { size: 4, strokeColors: theme === "dark" ? "#1a1a19" : "#fcfcfb", strokeWidth: 2, hover: { size: 6 } },
    legend: { position: "top", horizontalAlign: "left", labels: { colors: c.text } },
    grid: { borderColor: c.grid },
    xaxis: { type: "datetime", labels: { style: { colors: c.text }, format: "MMM yy" }, axisBorder: { color: c.grid }, axisTicks: { color: c.grid }, tooltip: { enabled: false } },
    yaxis: { min: 0, labels: { style: { colors: c.text }, formatter: (v) => moneyCompact(v) } },
    tooltip: { shared: true, intersect: false, theme, x: { formatter: (v) => isoDay(v).slice(0, 7) }, y: { formatter: (v) => money(v) } },
  });
  chart.render();
  return chart;
}
