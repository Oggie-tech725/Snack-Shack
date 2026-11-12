import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import { getFirestore, collection, addDoc, deleteDoc, updateDoc, doc, onSnapshot, query, orderBy, serverTimestamp, runTransaction } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
import { ADMIN_USERNAME, ADMIN_EMAIL } from "./admin-config.js";

const firebaseApp = initializeApp(firebaseConfig), auth = getAuth(firebaseApp), db = getFirestore(firebaseApp);
const $ = id => document.getElementById(id);

/* ───────── Config & helpers ───────── */
const LOW_STOCK = 3; // quantity at or below this (and above 0) counts as "low"
const THEME_KEY = "snack-shack-theme", VIEW_KEY = "snack-shack-view";
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
};
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ESC[c]);
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const qtyOf = i => Math.max(0, Math.floor(num(i.quantity)));
const stockOf = q => q <= 0 ? "out" : q <= LOW_STOCK ? "low" : "in";
const STOCK_LABEL = { in: "In stock", low: "Low stock", out: "Sold out" };
function priceText(value) { const n = Number(value); return Number.isFinite(n) ? `${n.toFixed(2)} CHF` : ""; }
const cmpName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });

const ICON_EDIT = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

const state = {
  items: [], isAdmin: false, unsubscribe: null,
  ascending: true, sortKey: "name", filter: "all",
  view: store.get(VIEW_KEY) === "list" ? "list" : "grid",
  loaded: false, editingId: null, pendingDelete: null,
  flash: new Set(), prevQty: new Map()
};
let toastTimer;

function toast(message) {
  const e = $("toast");
  e.textContent = message;
  e.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => e.classList.remove("show"), 2500);
}

function setSync(stateName, text) {
  $("syncPill").dataset.state = stateName;
  $("syncStatus").textContent = text;
}

/* ───────── Admin UI & auth ───────── */
function setAdminUI(isAdmin) {
  state.isAdmin = isAdmin;
  document.body.classList.toggle("viewer", !isAdmin);
  document.querySelectorAll(".admin-only").forEach(e => e.classList.toggle("hidden", !isAdmin));
  $("loginOpenBtn").classList.toggle("hidden", isAdmin);
  $("logoutBtn").classList.toggle("hidden", !isAdmin);
  $("modeBadge").textContent = isAdmin ? "Admin mode" : "View only";
  $("modeBadge").classList.toggle("admin", isAdmin);
  if (!isAdmin) { $("itemDialog").open && $("itemDialog").close(); $("confirmDialog").open && $("confirmDialog").close(); }
  render();
}
function friendly(error) {
  return ({
    "auth/invalid-credential": "Incorrect username or password.",
    "auth/too-many-requests": "Too many attempts. Try again later."
  })[error.code] || "Sign-in failed.";
}

$("loginOpenBtn").addEventListener("click", () => {
  $("authError").textContent = "";
  $("loginDialog").showModal();
  $("username").focus();
});
$("closeLogin").addEventListener("click", () => $("loginDialog").close());
$("togglePw").addEventListener("click", () => {
  const show = $("password").type === "password";
  $("password").type = show ? "text" : "password";
  $("togglePw").textContent = show ? "Hide" : "Show";
  $("togglePw").setAttribute("aria-label", show ? "Hide password" : "Show password");
});
$("loginDialog").addEventListener("close", () => {
  $("password").type = "password";
  $("togglePw").textContent = "Show";
});
$("authForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("authError").textContent = "";
  if ($("username").value.trim().toLowerCase() !== ADMIN_USERNAME.toLowerCase()) {
    $("authError").textContent = "Incorrect username or password.";
    return;
  }
  $("loginBtn").disabled = true;
  try {
    await signInWithEmailAndPassword(auth, ADMIN_EMAIL, $("password").value);
    $("password").value = "";
    $("loginDialog").close();
    toast("Admin mode enabled");
  } catch (err) {
    $("authError").textContent = friendly(err);
  } finally {
    $("loginBtn").disabled = false;
  }
});
$("logoutBtn").addEventListener("click", () => signOut(auth));
onAuthStateChanged(auth, user => {
  setAdminUI(Boolean(user));
  if (state.unsubscribe) state.unsubscribe();
  subscribe();
});

/* ───────── Data ───────── */
function itemsCollection() { return collection(db, "inventory"); }

function subscribe() {
  setSync("syncing", "Syncing…");
  state.unsubscribe = onSnapshot(query(itemsCollection(), orderBy("createdAt", "asc")), snap => {
    const next = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    next.forEach(i => {
      const q = qtyOf(i);
      if (state.prevQty.has(i.id) && state.prevQty.get(i.id) !== q) state.flash.add(i.id);
      state.prevQty.set(i.id, q);
    });
    state.items = next;
    state.loaded = true;
    setSync("live", "Synced");
    render();
  }, err => {
    console.error(err);
    state.loaded = true;
    setSync("error", "Sync error");
    toast("Could not load inventory");
    render();
  });
}

async function changeQuantity(id, delta) {
  if (!state.isAdmin) return;
  const ref = doc(db, "inventory", id);
  try {
    await runTransaction(db, async tx => {
      const s = await tx.get(ref);
      if (!s.exists()) return;
      tx.update(ref, { quantity: Math.max(0, Number(s.data().quantity || 0) + delta), updatedAt: serverTimestamp() });
    });
  } catch (err) {
    console.error(err);
    toast("Could not update quantity");
  }
}

/* Add / edit */
function openItemDialog(item) {
  if (!state.isAdmin) return;
  state.editingId = item ? item.id : null;
  $("itemEyebrow").textContent = item ? "EDIT ITEM" : "NEW ITEM";
  $("itemDialogTitle").textContent = item ? "Edit item" : "Add item";
  $("itemInput").value = item ? (item.name || "") : "";
  $("priceInput").value = item && item.price != null ? item.price : "";
  $("sizeInput").value = item ? (item.size || "") : "";
  $("qtyInput").value = item ? qtyOf(item) : 0;
  $("saveAnotherBtn").classList.toggle("hidden", Boolean(item));
  $("itemDialog").showModal();
  $("itemInput").focus();
}
$("addOpenBtn").addEventListener("click", () => openItemDialog(null));
$("closeItem").addEventListener("click", () => $("itemDialog").close());
$("cancelItem").addEventListener("click", () => $("itemDialog").close());

$("itemForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!state.isAdmin) return;
  const again = e.submitter && e.submitter.dataset.again === "1";
  const name = $("itemInput").value.trim(), price = Number($("priceInput").value), size = $("sizeInput").value.trim();
  const quantity = Math.max(0, Math.floor(Number($("qtyInput").value) || 0));
  if (!name || !Number.isFinite(price) || price < 0) return;

  const buttons = [...$("itemForm").querySelectorAll("button[type=submit]")];
  buttons.forEach(b => b.disabled = true);
  const editing = state.editingId;
  try {
    if (editing) {
      const prev = state.items.find(x => x.id === editing);
      const data = { name, price, size, updatedAt: serverTimestamp() };
      if (!prev || qtyOf(prev) !== quantity) data.quantity = quantity;
      await updateDoc(doc(db, "inventory", editing), data);
      toast("Item updated");
      $("itemDialog").close();
    } else {
      await addDoc(itemsCollection(), { name, price, size, quantity, createdAt: serverTimestamp() });
      toast(`Added “${name}”`);
      if (again) { $("itemForm").reset(); $("itemInput").focus(); }
      else $("itemDialog").close();
    }
  } catch (err) {
    console.error(err);
    toast(editing ? "Could not update item" : "Could not add item");
  } finally {
    buttons.forEach(b => b.disabled = false);
  }
});

/* Delete */
function askDelete(item) {
  if (!state.isAdmin) return;
  state.pendingDelete = item;
  $("confirmText").textContent = `“${item.name}” will be removed from the inventory. This can’t be undone.`;
  $("confirmDialog").showModal();
}
$("confirmCancel").addEventListener("click", () => { state.pendingDelete = null; $("confirmDialog").close(); });
$("confirmDelete").addEventListener("click", async () => {
  const item = state.pendingDelete;
  if (!item || !state.isAdmin) return;
  $("confirmDelete").disabled = true;
  try {
    await deleteDoc(doc(db, "inventory", item.id));
    toast(`Deleted “${item.name}”`);
  } catch (err) {
    console.error(err);
    toast("Could not delete item");
  } finally {
    $("confirmDelete").disabled = false;
    state.pendingDelete = null;
    $("confirmDialog").close();
  }
});

/* Export */
function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // avoid spreadsheet formula injection
  return `"${s.replace(/"/g, '""')}"`;
}
$("exportBtn").addEventListener("click", () => {
  if (!state.isAdmin) return;
  const rows = [["Name", "Size", "Price (CHF)", "Quantity"]];
  state.items.slice().sort(cmpName).forEach(i => rows.push([i.name, i.size, Number.isFinite(Number(i.price)) ? Number(i.price).toFixed(2) : "", qtyOf(i)]));
  const csv = "﻿" + rows.map(r => r.map(csvCell).join(",")).join("\r\n");
  const d = new Date(), pad = n => String(n).padStart(2, "0");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `snack-shack-inventory-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast("Inventory exported");
});

/* ───────── Rendering ───────── */
function visibleItems() {
  const term = $("searchInput").value.trim().toLowerCase();
  const dir = state.ascending ? 1 : -1, key = state.sortKey;
  return state.items
    .filter(i => {
      if (state.filter !== "all" && stockOf(qtyOf(i)) !== state.filter) return false;
      return !term || [i.name, i.size, i.price, priceText(i.price)].some(v => String(v ?? "").toLowerCase().includes(term));
    })
    .sort((a, b) => {
      if (key === "name") return cmpName(a, b) * dir;
      const d = key === "price" ? num(a.price) - num(b.price) : qtyOf(a) - qtyOf(b);
      return d ? d * dir : cmpName(a, b);
    });
}

function itemHTML(i) {
  const q = qtyOf(i), s = stockOf(q), name = esc(i.name), price = priceText(i.price);
  const counter = state.isAdmin
    ? `<div class="counter"><button class="step minus" type="button" data-action="minus" data-id="${i.id}" aria-label="Decrease ${name} quantity"${q <= 0 ? " disabled" : ""}>−</button><span class="qty">${q}</span><button class="step plus" type="button" data-action="plus" data-id="${i.id}" aria-label="Increase ${name} quantity">+</button></div>`
    : `<div class="counter"><span class="qty qty-pill">${q}</span></div>`;
  const actions = state.isAdmin
    ? `<div class="item-actions"><button class="icon-action" type="button" data-action="edit" data-id="${i.id}" aria-label="Edit ${name}" title="Edit">${ICON_EDIT}</button><button class="icon-action danger" type="button" data-action="delete" data-id="${i.id}" aria-label="Delete ${name}" title="Delete">${ICON_TRASH}</button></div>`
    : "";
  return `<article class="item" data-id="${i.id}" data-status="${s}">
    <div class="item-info"><h3 class="item-name">${name}</h3><div class="item-meta">${price ? `<span class="item-price">${esc(price)}</span>` : ""}${i.size ? `<span class="item-size">${esc(i.size)}</span>` : ""}</div></div>
    ${actions}
    <span class="badge ${s}">${STOCK_LABEL[s]}</span>
    ${counter}
  </article>`;
}

function updateSummary() {
  const counts = { all: state.items.length, in: 0, low: 0, out: 0 };
  let units = 0, value = 0, profit = 0;
  state.items.forEach(i => {
    const q = qtyOf(i);
    counts[stockOf(q)]++;
    units += q;
    const subtotal = q * num(i.price);
    value += subtotal;
    profit += subtotal; // Totaler Gewinn basierend auf dem aktuellen Lagerwert (Verkaufswert)
  });
  $("statProducts").textContent = counts.all;
  $("statUnits").textContent = units;
  $("statLow").textContent = counts.low;
  $("statOut").textContent = counts.out;
  $("statValue").textContent = `${value.toFixed(2)} CHF`;
  $("statProfit").textContent = `${profit.toFixed(2)} CHF`;
  document.querySelectorAll("#filterChips .chip").forEach(chip => {
    chip.querySelector(".chip-count").textContent = counts[chip.dataset.filter];
    const on = chip.dataset.filter === state.filter;
    chip.classList.toggle("active", on);
    chip.setAttribute("aria-pressed", on);
  });
}

function render() {
  const list = $("itemList");
  updateSummary();
  const total = state.items.length;
  $("itemCount").textContent = `${total} item${total === 1 ? "" : "s"}`;

  if (!state.loaded) {
    list.innerHTML = Array.from({ length: 6 }, () => '<div class="item skeleton" aria-hidden="true"></div>').join("");
    $("emptyState").classList.add("hidden");
    $("resultCount").textContent = "";
    return;
  }

  const items = visibleItems();
  list.innerHTML = items.map(itemHTML).join("");

  state.flash.forEach(id => {
    const el = list.querySelector(`[data-id="${CSS.escape(id)}"] .qty`);
    if (el) el.classList.add("bump");
  });
  state.flash.clear();

  const empty = items.length === 0;
  $("emptyState").classList.toggle("hidden", !empty);
  if (empty) {
    if (total === 0) {
      $("emptyTitle").textContent = "No items yet";
      $("emptyText").textContent = state.isAdmin ? "Tap “Add item” to create your first one." : "Nothing has been added to the inventory yet.";
    } else {
      $("emptyTitle").textContent = "No matches";
      $("emptyText").textContent = "Try a different search or filter.";
    }
  }
  $("resultCount").textContent = items.length !== total ? `Showing ${items.length} of ${total}` : "";
}

$("itemList").addEventListener("click", e => {
  const b = e.target.closest("button[data-action]");
  if (!b || b.disabled || !state.isAdmin) return;
  const i = state.items.find(x => x.id === b.dataset.id);
  if (!i) return;
  if (b.dataset.action === "plus") changeQuantity(i.id, 1);
  if (b.dataset.action === "minus") changeQuantity(i.id, -1);
  if (b.dataset.action === "edit") openItemDialog(i);
  if (b.dataset.action === "delete") askDelete(i);
});

/* ───────── Search, filter, sort, view ───────── */
$("searchInput").addEventListener("input", render);

$("filterChips").addEventListener("click", e => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  state.filter = chip.dataset.filter;
  render();
});

function updateSortLabel() {
  $("sortBtn").textContent = state.sortKey === "name"
    ? (state.ascending ? "A–Z" : "Z–A")
    : (state.ascending ? "Low → High" : "High → Low");
}
$("sortBtn").addEventListener("click", () => { state.ascending = !state.ascending; updateSortLabel(); render(); });
$("sortKey").addEventListener("change", () => { state.sortKey = $("sortKey").value; state.ascending = true; updateSortLabel(); render(); });

function applyView() {
  $("itemList").className = `items ${state.view}`;
  $("viewGrid").setAttribute("aria-pressed", state.view === "grid");
  $("viewList").setAttribute("aria-pressed", state.view === "list");
}
$("viewGrid").addEventListener("click", () => { state.view = "grid"; store.set(VIEW_KEY, "grid"); applyView(); });
$("viewList").addEventListener("click", () => { state.view = "list"; store.set(VIEW_KEY, "list"); applyView(); });
applyView();

/* ───────── Dialog niceties & shortcuts ───────── */
document.querySelectorAll("dialog").forEach(d => d.addEventListener("click", e => { if (e.target === d) d.close(); }));
document.addEventListener("keydown", e => {
  if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || document.querySelector("dialog[open]")) return;
  e.preventDefault();
  $("searchInput").focus();
});

/* ───────── Theme ───────── */
const savedTheme = store.get(THEME_KEY);
const initialTheme = savedTheme || ((window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark");
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const light = theme === "light";
  $("themeIcon").textContent = light ? "☾" : "☀";
  $("themeToggle").setAttribute("aria-label", light ? "Switch to dark mode" : "Switch to light mode");
  $("themeToggle").title = light ? "Switch to dark mode" : "Switch to light mode";
  document.querySelector('meta[name="theme-color"]').content = light ? "#f5f7ff" : "#080b14";
}
applyTheme(initialTheme);
$("themeToggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  store.set(THEME_KEY, next);
  applyTheme(next);
});

render();