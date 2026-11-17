import { firebaseConfig } from "./firebase-config.js";
import { SHOP_CONFIG } from "./shop-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import { getFirestore, collection, addDoc, deleteDoc, updateDoc, doc, onSnapshot, query, orderBy, where, serverTimestamp, runTransaction, setDoc, increment } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
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
const marginOf = i => num(i.price) - num(i.buyPrice); // profit per unit (old items without buyPrice count as 0 cost)
const cmpName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });

const ICON_EDIT = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

/* ───────── Opening hours (always evaluated in the shop time zone) ───────── */
const TZ = SHOP_CONFIG.timeZone || "Europe/Zurich";
const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short"
});
const weekdayFmt = new Intl.DateTimeFormat("de-CH", { timeZone: TZ, weekday: "short" });
const shortDateFmt = new Intl.DateTimeFormat("de-CH", { timeZone: TZ, day: "2-digit", month: "2-digit" });

function minutesOf(hhmm) {
  const [h, m] = String(hhmm || "0:0").split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}
function zurichDateString(d = new Date()) { return dateFmt.format(d); }
function zurichParts(d = new Date()) {
  const p = {};
  for (const part of partsFmt.formatToParts(d)) if (part.type !== "literal") p[part.type] = part.value;
  return {
    ...p,
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: (Number(p.hour) % 24) * 60 + Number(p.minute)
  };
}
function dateAtNoon(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}
function addDaysToDate(dateStr, days) {
  const dt = dateAtNoon(dateStr);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function weekdayLabel(dateStr) { return weekdayFmt.format(dateAtNoon(dateStr)).replace(/\.$/, ""); }
function formatDateLabel(dateStr) {
  const today = zurichDateString();
  if (dateStr === today) return "heute";
  if (dateStr === addDaysToDate(today, 1)) return "morgen";
  return `${weekdayLabel(dateStr)}, ${shortDateFmt.format(dateAtNoon(dateStr))}`;
}
function pickupLabelFor(dateStr, start, end) {
  return `${weekdayLabel(dateStr)}, ${shortDateFmt.format(dateAtNoon(dateStr))}, ${start}–${end}`;
}

const WINDOWS = (SHOP_CONFIG.openingHours || [])
  .map(w => ({ ...w, startMin: minutesOf(w.start), endMin: minutesOf(w.end) }))
  .sort((a, b) => a.startMin - b.startMin);

function openState(now = new Date()) {
  const p = zurichParts(now);
  for (const w of WINDOWS) {
    if (p.minutes >= w.startMin && p.minutes < w.endMin) return { open: true, window: w, offset: 0, date: p.date };
  }
  for (let offset = 0; offset <= 7; offset++) {
    const date = addDaysToDate(p.date, offset);
    for (const w of WINDOWS) {
      if (offset === 0 && w.startMin <= p.minutes) continue;
      return { open: false, window: w, offset, date };
    }
  }
  return null;
}

function updateOpenBadge() {
  const el = $("openBadge"), label = $("openBadgeText");
  if (!el || !label) return;
  const s = openState();
  let stateName = "closed", text = "Öffnungszeiten";
  if (s && s.open) {
    stateName = "open";
    text = `Jetzt geöffnet · bis ${s.window.end}`;
  } else if (s) {
    const when = s.offset === 0 ? "um" : s.offset === 1 ? "morgen um" : `${weekdayLabel(s.date)} um`;
    text = `Geschlossen · öffnet ${when} ${s.window.start}`;
  }
  el.dataset.state = stateName;
  if (label.textContent !== text) label.textContent = text;
  const schedule = `Täglich ${WINDOWS.map(w => `${w.start}–${w.end}`).join(", ")}`;
  if (el.title !== schedule) el.title = schedule;
}

function slotsForDate(dateStr) {
  const now = zurichParts();
  const buffer = Number(SHOP_CONFIG.reservationBufferMinutes) || 0;
  return WINDOWS.filter(w => dateStr > now.date || (dateStr === now.date && w.endMin > now.minutes + buffer));
}
function defaultReservationDate() {
  const today = zurichDateString();
  return slotsForDate(today).length ? today : addDaysToDate(today, 1);
}

/* ───────── State ───────── */
const state = {
  items: [], isAdmin: false, unsubscribe: null,
  ascending: true, sortKey: "name", filter: "all",
  view: store.get(VIEW_KEY) === "list" ? "list" : "grid",
  loaded: false, editingId: null, pendingDelete: null,
  flash: new Set(), prevQty: new Map(), profit: 0, profitError: null, unsubProfit: null,
  reservations: [], wishes: [], unsubReservations: null, unsubWishes: null,
  reserving: false
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
  $("modeBadge").textContent = isAdmin ? "Admin mode" : "Guest";
  $("modeBadge").classList.toggle("admin", isAdmin);
  if (!isAdmin) { $("itemDialog").open && $("itemDialog").close(); $("confirmDialog").open && $("confirmDialog").close(); }
  if (isAdmin) { subscribeReservations(); subscribeWishes(); }
  else { stopAdminSubscriptions(); }
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
  subscribeProfit();
});

/* ───────── Data ───────── */
function itemsCollection() { return collection(db, "inventory"); }

const statsRef = () => doc(db, "meta", "stats");
const round2 = n => Math.round(n * 100) / 100;

/* Total profit lives in Firestore (meta/stats, admin-only) so it is the same on every device */
function subscribeProfit() {
  if (state.unsubProfit) { state.unsubProfit(); state.unsubProfit = null; }
  state.profit = 0;
  state.profitError = null;
  if (!state.isAdmin) return;
  state.unsubProfit = onSnapshot(statsRef(), snap => {
    state.profitError = null;
    state.profit = snap.exists() ? num(snap.data().profit) : 0;
    updateSummary();
  }, err => {
    console.error(err);
    state.profitError = err.code || "error";
    updateSummary();
    toast(`Profit can't be read (${state.profitError}). Publish firestore.rules in Firebase.`);
  });
}

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

/* Admin-only live lists for reservations and wishes */
function subscribeReservations() {
  if (!state.isAdmin || state.unsubReservations) return;
  state.unsubReservations = onSnapshot(
    query(collection(db, "reservations"), where("status", "==", "pending")),
    snap => {
      state.reservations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderReservations();
    },
    err => {
      console.error(err);
      state.reservations = [];
      const list = $("reservationList");
      if (list) list.innerHTML = `<p class="muted">Reservierungen können nicht geladen werden (${esc(err.code || "error")}). Bitte die neuen Firestore-Regeln veröffentlichen.</p>`;
      if ($("reservationCount")) $("reservationCount").textContent = "0";
    }
  );
}

function subscribeWishes() {
  if (!state.isAdmin || state.unsubWishes) return;
  state.unsubWishes = onSnapshot(
    query(collection(db, "wishes"), where("status", "==", "open")),
    snap => {
      state.wishes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderWishes();
    },
    err => {
      console.error(err);
      state.wishes = [];
      const list = $("wishList");
      if (list) list.innerHTML = `<p class="muted">Wünsche können nicht geladen werden (${esc(err.code || "error")}). Bitte die neuen Firestore-Regeln veröffentlichen.</p>`;
      if ($("wishCount")) $("wishCount").textContent = "0";
    }
  );
}

function stopAdminSubscriptions() {
  if (state.unsubReservations) { state.unsubReservations(); state.unsubReservations = null; }
  if (state.unsubWishes) { state.unsubWishes(); state.unsubWishes = null; }
  state.reservations = [];
  state.wishes = [];
  renderReservations();
  renderWishes();
}

/* Add profit with an atomic increment (no read needed, safe across devices) */
async function recordProfit(amount) {
  if (!amount) return;
  try {
    await setDoc(statsRef(), { profit: increment(round2(amount)), updatedAt: serverTimestamp() }, { merge: true });
  } catch (err) {
    console.error(err);
    toast(`Quantity saved, but profit was NOT saved (${err.code || "error"}). Publish firestore.rules in Firebase.`);
  }
}

async function changeQuantity(id, delta) {
  if (!state.isAdmin) return;
  const ref = doc(db, "inventory", id);
  let sold = 0, margin = 0;
  try {
    await runTransaction(db, async tx => {
      sold = 0;
      const s = await tx.get(ref);
      if (!s.exists()) return;
      const d = s.data();
      const cur = qtyOf(d), next = Math.max(0, cur + delta);
      sold = cur - next;
      margin = num(d.price) - num(d.buyPrice);
      tx.update(ref, { quantity: next, updatedAt: serverTimestamp() });
    });
  } catch (err) {
    console.error(err);
    toast(`Could not update quantity${err && err.code ? ` (${err.code})` : ""}`);
    return;
  }
  if (sold > 0) await recordProfit(sold * margin);
}

/* Add / edit */
function openItemDialog(item) {
  if (!state.isAdmin) return;
  state.editingId = item ? item.id : null;
  $("itemEyebrow").textContent = item ? "EDIT ITEM" : "NEW ITEM";
  $("itemDialogTitle").textContent = item ? "Edit item" : "Add item";
  $("itemInput").value = item ? (item.name || "") : "";
  $("priceInput").value = item && item.price != null ? item.price : "";
  $("buyPriceInput").value = item && item.buyPrice != null ? item.buyPrice : "";
  updateMarginHint();
  $("sizeInput").value = item ? (item.size || "") : "";
  $("qtyInput").value = item ? qtyOf(item) : 0;
  $("saveAnotherBtn").classList.toggle("hidden", Boolean(item));
  $("itemDialog").showModal();
  $("itemInput").focus();
}
function updateMarginHint() {
  const el = $("marginHint"), b = $("buyPriceInput").value, s = $("priceInput").value;
  if (b === "" || s === "") { el.textContent = ""; el.className = "muted margin-hint"; return; }
  const m = Number(s) - Number(b);
  el.textContent = `Profit per unit: ${m >= 0 ? "+" : ""}${m.toFixed(2)} CHF`;
  el.className = `muted margin-hint ${m >= 0 ? "pos" : "neg"}`;
}
$("buyPriceInput").addEventListener("input", updateMarginHint);
$("priceInput").addEventListener("input", updateMarginHint);
$("addOpenBtn").addEventListener("click", () => openItemDialog(null));
$("closeItem").addEventListener("click", () => $("itemDialog").close());
$("cancelItem").addEventListener("click", () => $("itemDialog").close());

$("itemForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!state.isAdmin) return;
  const again = e.submitter && e.submitter.dataset.again === "1";
  const name = $("itemInput").value.trim(), price = Number($("priceInput").value), buyPrice = Number($("buyPriceInput").value), size = $("sizeInput").value.trim();
  const quantity = Math.max(0, Math.floor(Number($("qtyInput").value) || 0));
  if (!name || !Number.isFinite(price) || price < 0 || !Number.isFinite(buyPrice) || buyPrice < 0) return;

  const buttons = [...$("itemForm").querySelectorAll("button[type=submit]")];
  buttons.forEach(b => b.disabled = true);
  const editing = state.editingId;
  try {
    if (editing) {
      const prev = state.items.find(x => x.id === editing);
      const data = { name, price, buyPrice, size, updatedAt: serverTimestamp() };
      if (!prev || qtyOf(prev) !== quantity) data.quantity = quantity;
      await updateDoc(doc(db, "inventory", editing), data);
      toast("Item updated");
      $("itemDialog").close();
    } else {
      // Create with quantity 0 (what the security rules expect), then set the starting stock
      const created = await addDoc(itemsCollection(), { name, price, buyPrice, size, quantity: 0, createdAt: serverTimestamp() });
      if (quantity > 0) await updateDoc(created, { quantity, updatedAt: serverTimestamp() });
      toast(`Added “${name}”`);
      if (again) { $("itemForm").reset(); updateMarginHint(); $("itemInput").focus(); }
      else $("itemDialog").close();
    }
  } catch (err) {
    console.error(err);
    toast((editing ? "Could not update item" : "Could not add item") + (err && err.code ? ` (${err.code})` : ""));
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
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
$("exportBtn").addEventListener("click", () => {
  if (!state.isAdmin) return;
  const rows = [["Name", "Size", "Buy price (CHF)", "Sell price (CHF)", "Quantity"]];
  state.items.slice().sort(cmpName).forEach(i => rows.push([i.name, i.size, num(i.buyPrice).toFixed(2), Number.isFinite(Number(i.price)) ? Number(i.price).toFixed(2) : "", qtyOf(i)]));
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

/* ───────── Reservations (customer side) ───────── */
function reservationCode(id) {
  const clean = String(id || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  return (clean.slice(-6) || Math.random().toString(36).slice(2, 8).toUpperCase()).padEnd(6, "X");
}

function refreshReservationItems() {
  const sel = $("reserveItem");
  if (!sel) return;
  const previous = sel.value;
  const available = state.items.filter(i => qtyOf(i) > 0).sort(cmpName);
  if (!available.length) {
    sel.innerHTML = `<option value="">Keine Artikel verfügbar</option>`;
    if ($("reserveError")) $("reserveError").textContent = "Zurzeit ist kein Artikel verfügbar.";
  } else {
    sel.innerHTML = available.map(i => {
      const size = i.size ? ` · ${esc(i.size)}` : "";
      return `<option value="${esc(i.id)}">${esc(i.name)}${size} — ${qtyOf(i)} verfügbar</option>`;
    }).join("");
    if (previous && available.some(i => i.id === previous)) sel.value = previous;
    if ($("reserveError") && $("reserveError").textContent === "Zurzeit ist kein Artikel verfügbar.") {
      $("reserveError").textContent = "";
    }
  }
  updateReserveSubmitState();
}

function updateReserveHint() {
  const hint = $("reserveHint");
  if (!hint) return;
  const date = $("reserveDate").value;
  if (!date) { hint.textContent = ""; return; }
  const slots = slotsForDate(date);
  hint.textContent = slots.length
    ? `Abholung ${formatDateLabel(date)} während der Öffnungszeiten: ${slots.map(w => `${w.start}–${w.end}`).join(", ")}.`
    : "An diesem Tag ist keine Abholung mehr möglich. Bitte wähle einen anderen Tag.";
}

function updateReserveSubmitState() {
  const btn = $("reserveSubmit");
  if (!btn) return;
  btn.disabled = state.reserving || !$("reserveItem").value || !$("reserveSlot").value;
}

function refreshReservationSlots(preferred) {
  const dateEl = $("reserveDate"), slotEl = $("reserveSlot");
  if (!dateEl || !slotEl) return;
  const today = zurichDateString();
  dateEl.min = today;
  dateEl.max = addDaysToDate(today, Number(SHOP_CONFIG.reservationDaysAhead) || 14);
  if (!dateEl.value || dateEl.value < today) dateEl.value = defaultReservationDate();
  const slots = slotsForDate(dateEl.value);
  const previous = preferred || slotEl.value;
  if (slots.length) {
    slotEl.innerHTML = slots.map(w => `<option value="${w.start}|${w.end}">${w.start}–${w.end}</option>`).join("");
    if (previous && slots.some(w => `${w.start}|${w.end}` === previous)) slotEl.value = previous;
  } else {
    slotEl.innerHTML = `<option value="">Keine Abholzeit an diesem Tag</option>`;
  }
  updateReserveHint();
  updateReserveSubmitState();
}

function openReserveDialog(itemId) {
  if (!state.loaded) { toast("Artikel werden noch geladen…"); return; }
  if ($("reserveError")) $("reserveError").textContent = "";
  refreshReservationItems();
  if (itemId && [...$("reserveItem").options].some(o => o.value === itemId)) $("reserveItem").value = itemId;
  $("reserveDate").value = defaultReservationDate();
  refreshReservationSlots();
  $("reserveName").value = "";
  $("reservePhone").value = "";
  $("reserveTrap").value = "";
  $("reserveDialog").showModal();
  setTimeout(() => $("reserveItem").focus(), 40);
}

async function submitReservation() {
  if (state.reserving) return;
  const itemId = $("reserveItem").value;
  const date = $("reserveDate").value;
  const slot = $("reserveSlot").value;
  const customerName = $("reserveName").value.trim().slice(0, 60);
  const customerPhone = $("reservePhone").value.trim().slice(0, 30);
  if ($("reserveTrap").value) { $("reserveDialog").close(); toast("Danke!"); return; }
  if (!itemId || !date || !slot) { $("reserveError").textContent = "Bitte Artikel und Abholzeit wählen."; return; }
  const dateEl = $("reserveDate");
  if ((dateEl.min && date < dateEl.min) || (dateEl.max && date > dateEl.max)) {
    $("reserveError").textContent = "Bitte wähle ein Datum innerhalb der nächsten zwei Wochen.";
    return;
  }
  if (!slotsForDate(date).some(w => `${w.start}|${w.end}` === slot)) {
    $("reserveError").textContent = "Dieses Zeitfenster ist nicht mehr verfügbar. Bitte wähle ein anderes.";
    refreshReservationSlots();
    return;
  }
  const item = state.items.find(i => i.id === itemId);
  if (!item) { $("reserveError").textContent = "Artikel nicht gefunden."; return; }
  if (qtyOf(item) < 1) {
    $("reserveError").textContent = "Dieser Artikel ist gerade ausverkauft.";
    refreshReservationItems();
    return;
  }
  const [pickupStart, pickupEnd] = slot.split("|");
  const pickupLabel = pickupLabelFor(date, pickupStart, pickupEnd);
  const resRef = doc(collection(db, "reservations"));
  const code = reservationCode(resRef.id);
  const btn = $("reserveSubmit");
  const oldText = btn.textContent;
  state.reserving = true;
  btn.textContent = "Wird reserviert…";
  updateReserveSubmitState();
  $("reserveError").textContent = "";
  try {
    await runTransaction(db, async tx => {
      const itemRef = doc(db, "inventory", itemId);
      const snap = await tx.get(itemRef);
      if (!snap.exists()) throw new Error("item-missing");
      const current = qtyOf(snap.data());
      if (current < 1) throw new Error("sold-out");
      tx.update(itemRef, {
        quantity: current - 1,
        updatedAt: serverTimestamp(),
        lastReservationId: resRef.id
      });
      tx.set(resRef, {
        itemId,
        itemName: String(item.name || "").slice(0, 80),
        quantity: 1,
        stockAfter: current - 1,
        pickupDate: date,
        pickupStart,
        pickupEnd,
        pickupLabel: pickupLabel.slice(0, 80),
        customerName,
        customerPhone,
        code,
        status: "pending",
        smsStatus: "pending",
        source: "public",
        createdAt: serverTimestamp()
      });
    });
    const reservation = {
      id: resRef.id, itemId, itemName: item.name, quantity: 1,
      pickupDate: date, pickupStart, pickupEnd, pickupLabel,
      customerName, customerPhone, code
    };
    $("reserveDialog").close();
    showReservationSuccess(reservation);
  } catch (err) {
    console.error(err);
    const message = err && err.message;
    if (message === "sold-out") $("reserveError").textContent = "Dieser Artikel wurde gerade ausverkauft. Bitte wähle einen anderen.";
    else if (message === "item-missing") $("reserveError").textContent = "Dieser Artikel existiert nicht mehr.";
    else if (err && err.code === "permission-denied") $("reserveError").textContent = "Reservierung nicht erlaubt. Bitte die neuen Firestore-Regeln veröffentlichen.";
    else $("reserveError").textContent = `Reservierung fehlgeschlagen${err && err.code ? ` (${err.code})` : ""}. Bitte erneut versuchen.`;
    refreshReservationItems();
  } finally {
    state.reserving = false;
    btn.textContent = oldText;
    updateReserveSubmitState();
  }
}

function reservationSmsText(res) {
  let text = `Snack-Shack Reservierung ${res.code}: 1x ${res.itemName}, Abholung ${res.pickupLabel}.`;
  if (res.customerName) text += ` Name: ${res.customerName}.`;
  if (res.customerPhone) text += ` Tel: ${res.customerPhone}.`;
  return text;
}
function smsHref(text) {
  const to = String(SHOP_CONFIG.smsTo || "").replace(/[^\d+]/g, "");
  return `sms:${to}?body=${encodeURIComponent(text)}`;
}

function showSmsFallback(res, reason) {
  const box = $("smsBox");
  if (!box) return;
  const text = reservationSmsText(res);
  box.className = "sms-box warn";
  box.innerHTML = `<p class="muted">${esc(reason)}</p>
    <p class="muted">Bitte sende die SMS an ${esc(SHOP_CONFIG.smsToDisplay || SHOP_CONFIG.smsTo)} – der Text ist vorbereitet:</p>
    <div class="sms-actions">
      <a class="btn primary" href="${esc(smsHref(text))}">SMS senden</a>
      <button id="copySmsBtn" class="btn secondary" type="button">Text kopieren</button>
    </div>
    <p class="sms-preview">${esc(text)}</p>`;
  const copyBtn = $("copySmsBtn");
  if (copyBtn) copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast("SMS-Text kopiert");
    } catch {
      window.prompt("SMS-Text kopieren:", text);
    }
  });
}

async function notifyReservation(res) {
  const box = $("smsBox");
  if (!box) return;
  if (!SHOP_CONFIG.smsEndpoint) {
    showSmsFallback(res, "Der automatische SMS-Versand ist nicht eingerichtet.");
    return;
  }
  box.className = "sms-box";
  box.innerHTML = `<p class="muted">SMS wird an den Laden gesendet…</p>`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(SHOP_CONFIG.smsEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reservationId: res.id }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if ((response.ok && data.ok) || data.reason === "already_sent") {
      box.className = "sms-box ok";
      box.innerHTML = `<p><strong>SMS an den Laden gesendet.</strong></p>
        <p class="muted">Der Laden sieht deine Reservierung und den Abholzeitpunkt.</p>`;
      return;
    }
    if (data.reason === "in_progress") {
      box.className = "sms-box";
      box.innerHTML = `<p class="muted">Die SMS wird bereits gesendet. Bitte einen Moment warten.</p>`;
      return;
    }
    if (data.reason === "not_pending") {
      box.className = "sms-box";
      box.innerHTML = `<p class="muted">Diese Reservierung ist nicht mehr offen. Bitte wende dich direkt an den Laden.</p>`;
      return;
    }
    showSmsFallback(res, data.reason === "not_configured"
      ? "Der automatische SMS-Versand ist noch nicht eingerichtet."
      : "Die SMS konnte nicht automatisch gesendet werden.");
  } catch (err) {
    if (err.name !== "AbortError") console.error(err);
    showSmsFallback(res, "Die SMS konnte nicht automatisch gesendet werden.");
  } finally {
    clearTimeout(timer);
  }
}

function showReservationSuccess(res) {
  $("reserveSuccessTitle").textContent = "Reserviert!";
  $("reserveSuccessSummary").innerHTML = `<strong>1× ${esc(res.itemName)}</strong>
    <span>Abholung: ${esc(res.pickupLabel)}</span>
    <span>Code: <span class="res-code">${esc(res.code)}</span></span>
    <span class="muted">Der Bestand wurde um 1 Stück reduziert. Bezahlung bei der Abholung.</span>`;
  const box = $("smsBox");
  box.className = "sms-box";
  box.innerHTML = `<p class="muted">Reservierung gespeichert. SMS wird vorbereitet…</p>`;
  $("reserveSuccessDialog").showModal();
  notifyReservation(res);
}

$("reserveOpenBtn").addEventListener("click", () => openReserveDialog());
$("reserveClose").addEventListener("click", () => $("reserveDialog").close());
$("reserveCancel").addEventListener("click", () => $("reserveDialog").close());
$("reserveDate").addEventListener("change", () => refreshReservationSlots());
$("reserveForm").addEventListener("submit", e => { e.preventDefault(); submitReservation(); });
$("reserveSuccessClose").addEventListener("click", () => $("reserveSuccessDialog").close());

/* ───────── Reservations (admin) ───────── */
function isPastPickup(r) {
  const now = zurichParts();
  if (!r.pickupDate) return false;
  if (r.pickupDate < now.date) return true;
  if (r.pickupDate > now.date) return false;
  return minutesOf(r.pickupEnd || "23:59") < now.minutes;
}
function smsStateLabel(status) {
  return ({
    sent: ["ok", "SMS gesendet"],
    failed: ["bad", "SMS fehlgeschlagen"],
    sending: ["warn", "SMS läuft"],
    pending: ["warn", "SMS offen"]
  })[status] || ["warn", "SMS offen"];
}
function renderReservations() {
  const list = $("reservationList");
  if (!list) return;
  const sorted = state.reservations.slice().sort((a, b) => {
    const ak = `${a.pickupDate || ""} ${a.pickupStart || ""}`;
    const bk = `${b.pickupDate || ""} ${b.pickupStart || ""}`;
    return ak.localeCompare(bk);
  });
  if ($("reservationCount")) $("reservationCount").textContent = sorted.length;
  if (!sorted.length) {
    list.innerHTML = `<p class="muted">Keine offenen Reservierungen.</p>`;
    return;
  }
  list.innerHTML = sorted.map(r => {
    const [smsClass, smsLabel] = smsStateLabel(r.smsStatus);
    const overdue = isPastPickup(r);
    const liveItem = state.items.find(i => i.id === r.itemId);
    const itemName = (liveItem && liveItem.name) || r.itemName;
    const customer = r.customerName ? `Kunde: ${esc(r.customerName)}` : "Kunde: —";
    const phone = r.customerPhone ? ` · ${esc(r.customerPhone)}` : "";
    return `<article class="reservation${overdue ? " overdue" : ""}" data-id="${esc(r.id)}">
      <div class="res-main">
        <strong>1× ${esc(itemName)}</strong>
        <span class="res-meta">Abholung: ${esc(r.pickupLabel || `${r.pickupDate || ""} ${r.pickupStart || ""}–${r.pickupEnd || ""}`)}${overdue ? " · überfällig" : ""}</span>
        <span class="res-meta">${customer}${phone}</span>
        <span class="res-code">Code ${esc(r.code || "—")}</span>
      </div>
      <span class="sms-state ${smsClass}">${smsLabel}</span>
      <div class="res-actions">
        <button class="btn secondary small" type="button" data-res-action="pickedUp" data-id="${esc(r.id)}">Abgeholt</button>
        <button class="btn danger small" type="button" data-res-action="cancel" data-id="${esc(r.id)}">Stornieren</button>
      </div>
    </article>`;
  }).join("");
}

async function completeReservation(r) {
  if (!state.isAdmin) return;
  if (!confirm(`Abholung von „${r.itemName}“ bestätigen? Der Gewinn wird dazugebucht.`)) return;
  const item = state.items.find(i => i.id === r.itemId);
  const margin = item ? marginOf(item) : 0;
  let changed = false;
  try {
    await runTransaction(db, async tx => {
      const ref = doc(db, "reservations", r.id);
      const snap = await tx.get(ref);
      if (!snap.exists() || snap.data().status !== "pending") return;
      tx.update(ref, { status: "pickedUp", pickedUpAt: serverTimestamp() });
      if (margin) tx.set(statsRef(), { profit: increment(round2(margin)), updatedAt: serverTimestamp() }, { merge: true });
      changed = true;
    });
    if (changed) toast(`Abgeholt: ${r.itemName}`);
  } catch (err) {
    console.error(err);
    toast(`Reservierung konnte nicht abgeschlossen werden${err && err.code ? ` (${err.code})` : ""}`);
  }
}

async function cancelReservation(r) {
  if (!state.isAdmin) return;
  if (!confirm(`Reservierung von „${r.itemName}“ stornieren? 1 Stück wird zurückgebucht.`)) return;
  let changed = false;
  try {
    await runTransaction(db, async tx => {
      const resRef = doc(db, "reservations", r.id);
      const rs = await tx.get(resRef);
      if (!rs.exists() || rs.data().status !== "pending") return;
      const itemRef = doc(db, "inventory", r.itemId);
      const is = await tx.get(itemRef);
      tx.update(resRef, { status: "cancelled", cancelledAt: serverTimestamp() });
      if (is.exists()) tx.update(itemRef, { quantity: qtyOf(is.data()) + 1, updatedAt: serverTimestamp() });
      changed = true;
    });
    if (changed) toast(`Storniert: ${r.itemName}`);
  } catch (err) {
    console.error(err);
    toast(`Reservierung konnte nicht storniert werden${err && err.code ? ` (${err.code})` : ""}`);
  }
}

$("reservationList").addEventListener("click", e => {
  const b = e.target.closest("button[data-res-action]");
  if (!b || !state.isAdmin) return;
  const r = state.reservations.find(x => x.id === b.dataset.id);
  if (!r) return;
  b.disabled = true;
  if (b.dataset.resAction === "pickedUp") completeReservation(r).finally(() => { b.disabled = false; });
  if (b.dataset.resAction === "cancel") cancelReservation(r).finally(() => { b.disabled = false; });
});

/* ───────── Wishlist ───────── */
function formatWishDate(ts) {
  try {
    const d = ts && ts.toDate ? ts.toDate() : null;
    return d ? new Intl.DateTimeFormat("de-CH", { dateStyle: "medium", timeStyle: "short" }).format(d) : "";
  } catch { return ""; }
}
function renderWishes() {
  const list = $("wishList");
  if (!list) return;
  if ($("wishCount")) $("wishCount").textContent = state.wishes.length;
  if (!state.wishes.length) {
    list.innerHTML = `<p class="muted">Keine offenen Wünsche.</p>`;
    return;
  }
  const sorted = state.wishes.slice().sort((a, b) => {
    const at = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
    const bt = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
    return bt - at;
  });
  list.innerHTML = sorted.map(w => `<article class="wish" data-id="${esc(w.id)}">
    <div class="res-main">
      <strong>${esc(w.name)}</strong>
      ${w.note ? `<span class="res-meta">${esc(w.note)}</span>` : ""}
      <span class="res-meta">${esc(formatWishDate(w.createdAt))}</span>
    </div>
    <div class="res-actions">
      <button class="btn secondary small" type="button" data-wish-action="done" data-id="${esc(w.id)}">Erledigt</button>
      <button class="btn danger small" type="button" data-wish-action="delete" data-id="${esc(w.id)}">Löschen</button>
    </div>
  </article>`).join("");
}

$("wishOpenBtn").addEventListener("click", () => {
  $("wishForm").reset();
  $("wishError").textContent = "";
  $("wishDialog").showModal();
  $("wishName").focus();
});
$("wishClose").addEventListener("click", () => $("wishDialog").close());
$("wishCancel").addEventListener("click", () => $("wishDialog").close());
$("wishForm").addEventListener("submit", async e => {
  e.preventDefault();
  if ($("wishTrap").value) { $("wishDialog").close(); toast("Danke!"); return; }
  const name = $("wishName").value.trim();
  const note = $("wishNote").value.trim();
  if (!name) { $("wishError").textContent = "Bitte gib einen Artikel an."; return; }
  const btn = $("wishSubmit");
  btn.disabled = true;
  $("wishError").textContent = "";
  try {
    await addDoc(collection(db, "wishes"), {
      name: name.slice(0, 80),
      note: note.slice(0, 200),
      status: "open",
      createdAt: serverTimestamp()
    });
    $("wishDialog").close();
    toast("Danke! Dein Wunsch ist gespeichert.");
  } catch (err) {
    console.error(err);
    $("wishError").textContent = err && err.code === "permission-denied"
      ? "Wunsch konnte nicht gespeichert werden. Bitte firestore.rules veröffentlichen."
      : `Wunsch konnte nicht gespeichert werden${err && err.code ? ` (${err.code})` : ""}.`;
  } finally {
    btn.disabled = false;
  }
});

$("wishList").addEventListener("click", async e => {
  const b = e.target.closest("button[data-wish-action]");
  if (!b || !state.isAdmin) return;
  const w = state.wishes.find(x => x.id === b.dataset.id);
  if (!w) return;
  b.disabled = true;
  try {
    if (b.dataset.wishAction === "done") {
      await updateDoc(doc(db, "wishes", w.id), { status: "done", doneAt: serverTimestamp() });
      toast("Wunsch erledigt");
    } else {
      await deleteDoc(doc(db, "wishes", w.id));
      toast("Wunsch gelöscht");
    }
  } catch (err) {
    console.error(err);
    toast(`Wunsch konnte nicht aktualisiert werden${err && err.code ? ` (${err.code})` : ""}`);
  } finally {
    b.disabled = false;
  }
});

/* ───────── Twint info ───────── */
$("twintBtn").addEventListener("click", () => {
  $("twintNumber").textContent = SHOP_CONFIG.twintNumber || SHOP_CONFIG.contactPhone || "";
  const linkBox = $("twintLinkBox");
  if (SHOP_CONFIG.twintLink) {
    linkBox.innerHTML = `<a class="btn primary" href="${esc(SHOP_CONFIG.twintLink)}" target="_blank" rel="noopener">Twint-Zahlung öffnen</a>`;
  } else {
    linkBox.innerHTML = "";
  }
  $("twintDialog").showModal();
});
$("closeTwint").addEventListener("click", () => $("twintDialog").close());
$("twintClose").addEventListener("click", () => $("twintDialog").close());
$("copyTwint").addEventListener("click", async () => {
  const number = $("twintNumber").textContent;
  try {
    await navigator.clipboard.writeText(number);
    toast("Twint-Nummer kopiert");
  } catch {
    window.prompt("Twint-Nummer kopieren:", number);
  }
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
  const m = marginOf(i);
  const adminMeta = state.isAdmin ? `<span class="item-buy">Buy ${num(i.buyPrice).toFixed(2)}</span><span class="item-margin${m < 0 ? " neg" : ""}">${m >= 0 ? "+" : ""}${m.toFixed(2)}</span>` : "";
  return `<article class="item" data-id="${i.id}" data-status="${s}">
    <div class="item-info"><h3 class="item-name">${name}</h3><div class="item-meta">${price ? `<span class="item-price">${esc(price)}</span>` : ""}${i.size ? `<span class="item-size">${esc(i.size)}</span>` : ""}</div>${state.isAdmin ? `<div class="item-meta">${adminMeta}</div>` : ""}</div>
    ${actions}
    <span class="badge ${s}">${STOCK_LABEL[s]}</span>
    ${counter}
  </article>`;
}

function updateSummary() {
  const counts = { all: state.items.length, in: 0, low: 0, out: 0 };
  let units = 0, value = 0;
  state.items.forEach(i => {
    const q = qtyOf(i);
    counts[stockOf(q)]++;
    units += q;
    value += q * num(i.price);
  });
  const profit = state.profit;
  $("statProducts").textContent = counts.all;
  $("statUnits").textContent = units;
  $("statLow").textContent = counts.low;
  $("statOut").textContent = counts.out;
  $("statValue").textContent = `${value.toFixed(2)} CHF`;
  $("statProfit").textContent = state.profitError ? "—" : `${profit.toFixed(2)} CHF`;
  $("statProfit").title = state.profitError ? `Profit can't be read: ${state.profitError}. Publish firestore.rules in Firebase.` : "";
  document.querySelectorAll("#filterChips .chip").forEach(chip => {
    chip.querySelector(".chip-count").textContent = counts[chip.dataset.filter];
    const on = chip.dataset.filter === state.filter;
    chip.classList.toggle("active", on);
    chip.setAttribute("aria-pressed", on);
  });
}

$("resetProfitBtn").addEventListener("click", async () => {
  if (!state.isAdmin) return;
  if (!confirm("Reset Totaler Gewinn to 0.00 CHF?")) return;
  try {
    await setDoc(statsRef(), { profit: 0, updatedAt: serverTimestamp() });
    toast("Totaler Gewinn reset");
  } catch (err) {
    console.error(err);
    toast(`Could not reset profit${err && err.code ? ` (${err.code})` : ""}`);
  }
});

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

  if ($("reserveDialog").open) refreshReservationItems();
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
  $("themeIcon").textContent = light ? "Dark" : "Light";
  $("themeToggle").setAttribute("aria-label", light ? "Switch to dark mode" : "Switch to light mode");
  $("themeToggle").title = light ? "Switch to dark mode" : "Switch to light mode";
  document.querySelector('meta[name="theme-color"]').content = light ? "#efe9db" : "#171512";
}
applyTheme(initialTheme);
$("themeToggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  store.set(THEME_KEY, next);
  applyTheme(next);
});

/* ───────── Boot ───────── */
updateOpenBadge();
setInterval(updateOpenBadge, 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) updateOpenBadge(); });

render();
