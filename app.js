// =====================================================
// Settings you can change
// =====================================================
const DEFAULT_SETTINGS = { shopName: "My Coffee Shop", currency: "₱" };
const SETTINGS_KEY = "shopDashboardSettings";

// Orders from these channels count as "online orders"
const ONLINE_CHANNELS = ["GrabFood", "foodpanda"];

// How the Inventory chart picks the "least stock" items.
// "ratio" = stock as a % of the reorder level (fair, because items use different units)
// "raw"   = the plain stock_on_hand number
const LOW_STOCK_RANKING = "ratio";

const COLORS = {
  accent: "#0f6e66",
  accentSoft: "rgba(15, 110, 102, 0.15)",
  ok: "#0f6e66",
  low: "#b7791f",
  out: "#c0392b"
};

// =====================================================
// Data (filled in after the CSV files are loaded)
// =====================================================
let orders = [];
let inventory = [];
let dataReady = false;
let settings = loadSettings();

// One variable per chart, so we can destroy and redraw them
let salesChart = null;
let topProductsChart = null;
let lowStockChart = null;

const $ = (id) => document.getElementById(id);

// =====================================================
// Step 1: load the dataset (CSV files)
// =====================================================
async function loadCsv(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Could not load " + url);
  }
  return parseCsv(await response.text());
}

// Turns CSV text into an array of objects, one per row.
// This simple version works because our files have no commas inside values.
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row = {};
    headers.forEach((header, i) => {
      row[header] = (cells[i] || "").trim();
    });
    return row;
  });
}

function toOrder(row) {
  return { ...row, cups: Number(row.cups), unit_price: Number(row.unit_price) };
}

function toInventoryRow(row) {
  return { ...row, stock_on_hand: Number(row.stock_on_hand), reorder_level: Number(row.reorder_level) };
}

// =====================================================
// Small helpers
// =====================================================
function money(n) {
  return settings.currency + Math.round(n).toLocaleString("en-US");
}

function shortDate(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function longDate(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric"
  });
}

function toIso(date) {
  return date.getFullYear() + "-" +
    String(date.getMonth() + 1).padStart(2, "0") + "-" +
    String(date.getDate()).padStart(2, "0");
}

// Adds up values per key. Example: total revenue per date.
function sumBy(rows, keyFn, valueFn) {
  const totals = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    totals.set(key, (totals.get(key) || 0) + valueFn(row));
  });
  return totals;
}

function drawChart(oldChart, canvasId, config) {
  if (oldChart) {
    oldChart.destroy();
  }
  return new Chart($(canvasId), config);
}

// =====================================================
// Step 2: filter the orders (Branch + Timeline dropdowns)
// =====================================================
function getFilteredOrders() {
  const branch = $("branchFilter").value;
  const timeMode = $("timeFilter").value;
  let from = $("fromDate").value;
  let to = $("toDate").value;

  // If the user picks From after To, swap them
  if (timeMode === "range" && from && to && from > to) {
    [from, to] = [to, from];
    $("fromDate").value = from;
    $("toDate").value = to;
  }

  return orders.filter((order) => {
    if (branch !== "all" && order.branch !== branch) {
      return false;
    }
    if (timeMode === "range") {
      // Dates look like 2026-11-05, so plain text comparison works
      if (from && order.date < from) return false;
      if (to && order.date > to) return false;
    }
    return true;
  });
}

// =====================================================
// Step 3 and 4: calculate and draw the Dashboard
// =====================================================
function renderDashboard() {
  const rows = getFilteredOrders();

  // KPIs
  const revenue = rows.reduce((sum, o) => sum + o.cups * o.unit_price, 0);
  const cups = rows.reduce((sum, o) => sum + o.cups, 0);
  const online = rows.filter((o) => ONLINE_CHANNELS.includes(o.channel)).length;
  const count = rows.length;

  $("kpiRevenue").textContent = money(revenue);
  $("kpiRevenueSub").textContent = count ? money(revenue / count) + " per order" : "No orders";
  $("kpiCups").textContent = cups.toLocaleString("en-US");
  $("kpiCupsSub").textContent = count ? (cups / count).toFixed(1) + " cups per order" : "No orders";
  $("kpiOnline").textContent = online.toLocaleString("en-US");
  $("kpiOnlineSub").textContent = count
    ? Math.round((online / count) * 100) + "% of " + count.toLocaleString("en-US") + " orders"
    : "No orders";
  $("noData").hidden = count > 0;

  // Line chart: revenue per date
  const revenueByDate = sumBy(rows, (o) => o.date, (o) => o.cups * o.unit_price);
  const dates = [...revenueByDate.keys()].sort();
  const revenueValues = dates.map((d) => revenueByDate.get(d));

  salesChart = drawChart(salesChart, "salesChart", {
    type: "line",
    data: {
      labels: dates.map(shortDate),
      datasets: [{
        label: "Sales",
        data: revenueValues,
        borderColor: COLORS.accent,
        backgroundColor: COLORS.accentSoft,
        fill: true,
        tension: 0.25,
        pointRadius: dates.length > 45 ? 0 : 3,
        pointHoverRadius: 5
      }]
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => longDate(dates[items[0].dataIndex]),
            label: (item) => " Sales: " + money(item.parsed.y)
          }
        }
      },
      scales: {
        y: { beginAtZero: true, ticks: { callback: (value) => money(value) } },
        x: { ticks: { maxTicksLimit: 10 } }
      }
    }
  });

  // Bar chart: top 3 products by cups sold
  const cupsByProduct = sumBy(rows, (o) => o.product, (o) => o.cups);
  const top3 = [...cupsByProduct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  topProductsChart = drawChart(topProductsChart, "topProductsChart", {
    type: "bar",
    data: {
      labels: top3.map((item) => item[0]),
      datasets: [{
        label: "Cups sold",
        data: top3.map((item) => item[1]),
        backgroundColor: COLORS.accent,
        borderRadius: 4
      }]
    },
    options: {
      indexAxis: "y",
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (item) => " " + item.parsed.x.toLocaleString("en-US") + " cups" } }
      },
      scales: {
        x: { beginAtZero: true, title: { display: true, text: "Cups sold" } }
      }
    }
  });
}

// =====================================================
// Inventory page
// =====================================================
function rankValue(row) {
  if (LOW_STOCK_RANKING === "ratio" && row.reorder_level > 0) {
    return row.stock_on_hand / row.reorder_level;
  }
  return row.stock_on_hand;
}

function stockStatus(row) {
  if (row.stock_on_hand === 0) return "out";
  if (row.stock_on_hand <= row.reorder_level) return "low";
  return "ok";
}

const STATUS_LABEL = { ok: "In stock", low: "Low", out: "Out" };

function makeCell(text, className) {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function renderInventory() {
  const branch = $("invBranch").value;
  const rows = inventory
    .filter((r) => branch === "all" || r.branch === branch)
    .sort((a, b) => rankValue(a) - rankValue(b) || a.item.localeCompare(b.item));

  // Bar chart: 5 items with the least stock
  const lowest = rows.slice(0, 5);
  const useRatio = LOW_STOCK_RANKING === "ratio";

  $("lowStockHint").textContent = useRatio
    ? "Bars show stock as a percentage of each item's reorder level, because items use different units. 100% means stock is exactly at the reorder level."
    : "Bars show the plain number of units on hand.";

  lowStockChart = drawChart(lowStockChart, "lowStockChart", {
    type: "bar",
    data: {
      labels: lowest.map((r) => (branch === "all" ? r.item + " (" + r.branch + ")" : r.item)),
      datasets: [{
        data: lowest.map((r) => (useRatio ? Math.round(rankValue(r) * 100) : r.stock_on_hand)),
        backgroundColor: lowest.map((r) => COLORS[stockStatus(r)]),
        borderRadius: 4
      }]
    },
    options: {
      indexAxis: "y",
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => {
              const r = lowest[item.dataIndex];
              return " " + r.stock_on_hand + " " + r.unit + " on hand, reorder at " + r.reorder_level;
            }
          }
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          title: { display: true, text: useRatio ? "Stock as % of reorder level" : "Units on hand" }
        }
      }
    }
  });

  // Table: all stock rows for the chosen branch
  const body = $("stockBody");
  body.textContent = "";
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.appendChild(makeCell(r.item));
    tr.appendChild(makeCell(r.branch));
    tr.appendChild(makeCell(r.stock_on_hand.toLocaleString("en-US") + " " + r.unit, "num"));
    tr.appendChild(makeCell(r.reorder_level.toLocaleString("en-US") + " " + r.unit, "num"));

    const status = stockStatus(r);
    const td = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "badge badge-" + status;
    badge.textContent = STATUS_LABEL[status];
    td.appendChild(badge);
    tr.appendChild(td);

    body.appendChild(tr);
  });
}

// =====================================================
// Settings page (saved in the browser with localStorage)
// =====================================================
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    return { ...DEFAULT_SETTINGS, ...(saved || {}) };
  } catch (err) {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    // Saving can fail in private windows. The page still works for this visit.
  }
}

function applySettings() {
  $("brandName").textContent = settings.shopName;
  document.title = settings.shopName + " Dashboard";
  $("shopName").value = settings.shopName;
  $("currency").value = settings.currency;
}

// =====================================================
// Navigation (Dashboard, Inventory, Settings, Info)
// =====================================================
function showView() {
  const views = ["dashboard", "inventory", "settings", "info"];
  const wanted = location.hash.replace("#", "");
  const view = views.includes(wanted) ? wanted : "dashboard";

  document.querySelectorAll(".view").forEach((section) => {
    section.hidden = section.id !== "view-" + view;
  });

  document.querySelectorAll("#nav a").forEach((link) => {
    const active = link.dataset.view === view;
    link.classList.toggle("active", active);
    if (active) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });

  // Draw charts only when their page is visible
  if (dataReady && view === "dashboard") renderDashboard();
  if (dataReady && view === "inventory") renderInventory();
}

// =====================================================
// Start
// =====================================================
function wireEvents() {
  window.addEventListener("hashchange", showView);

  $("branchFilter").addEventListener("change", renderDashboard);
  $("timeFilter").addEventListener("change", () => {
    $("rangeInputs").hidden = $("timeFilter").value !== "range";
    renderDashboard();
  });
  $("fromDate").addEventListener("change", renderDashboard);
  $("toDate").addEventListener("change", renderDashboard);
  $("invBranch").addEventListener("change", renderInventory);

  $("settingsForm").addEventListener("submit", (event) => {
    event.preventDefault();
    settings.shopName = $("shopName").value.trim() || DEFAULT_SETTINGS.shopName;
    settings.currency = $("currency").value.trim() || DEFAULT_SETTINGS.currency;
    saveSettings();
    applySettings();
    $("settingsMsg").textContent = "Saved.";
  });

  $("resetSettings").addEventListener("click", () => {
    settings = { ...DEFAULT_SETTINGS };
    saveSettings();
    applySettings();
    $("settingsMsg").textContent = "Settings reset to default.";
  });
}

async function init() {
  applySettings();
  wireEvents();
  showView();

  try {
    const [orderRows, inventoryRows] = await Promise.all([
      loadCsv("orders.csv"),
      loadCsv("inventory.csv")
    ]);
    orders = orderRows.map(toOrder);
    inventory = inventoryRows.map(toInventoryRow);
  } catch (err) {
    const box = $("loadError");
    box.textContent = "Could not load the CSV files. If you opened index.html by double-clicking it, " +
      "browsers block this. Run a local server instead (VS Code Live Server, or run " +
      "\"python -m http.server\" in this folder and open http://localhost:8000).";
    box.hidden = false;
    return;
  }

  // Set the From/To pickers to the dates found in the data (default: last 30 days)
  const dates = orders.map((o) => o.date).sort();
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];
  const start = new Date(maxDate + "T00:00:00");
  start.setDate(start.getDate() - 29);
  const defaultFrom = toIso(start) > minDate ? toIso(start) : minDate;

  ["fromDate", "toDate"].forEach((id) => {
    $(id).min = minDate;
    $(id).max = maxDate;
  });
  $("fromDate").value = defaultFrom;
  $("toDate").value = maxDate;

  dataReady = true;
  showView();
}

init();
