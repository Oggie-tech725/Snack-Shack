import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import { getFirestore, collection, addDoc, deleteDoc, doc, onSnapshot, query, orderBy, serverTimestamp, runTransaction } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
import { ADMIN_USERNAME, ADMIN_EMAIL } from "./admin-config.js";

const firebaseApp=initializeApp(firebaseConfig),auth=getAuth(firebaseApp),db=getFirestore(firebaseApp);
const $=id=>document.getElementById(id);
const state={items:[],isAdmin:false,unsubscribe:null,ascending:true};let toastTimer;

function toast(message){const e=$("toast");e.textContent=message;e.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>e.classList.remove("show"),2500)}
function setAdminUI(isAdmin){state.isAdmin=isAdmin;document.body.classList.toggle("viewer",!isAdmin);document.querySelectorAll(".admin-only,.admin-column").forEach(e=>e.classList.toggle("hidden",!isAdmin));$("loginOpenBtn").classList.toggle("hidden",isAdmin);$("logoutBtn").classList.toggle("hidden",!isAdmin);$("modeBadge").textContent=isAdmin?"Admin mode":"View only";$("modeBadge").classList.toggle("admin",isAdmin);render()}
function friendly(error){return ({"auth/invalid-credential":"Incorrect username or password.","auth/too-many-requests":"Too many attempts. Try again later."})[error.code]||"Sign-in failed."}

$("loginOpenBtn").addEventListener("click",()=>{$("authError").textContent="";$("loginDialog").showModal();$("username").focus()});
$("closeLogin").addEventListener("click",()=>$("loginDialog").close());
$("authForm").addEventListener("submit",async e=>{e.preventDefault();$("authError").textContent="";if($("username").value.trim().toLowerCase()!==ADMIN_USERNAME.toLowerCase()){$("authError").textContent="Incorrect username or password.";return}$("loginBtn").disabled=true;try{await signInWithEmailAndPassword(auth,ADMIN_EMAIL,$("password").value);$("password").value="";$("loginDialog").close();toast("Admin mode enabled")}catch(err){$("authError").textContent=friendly(err)}finally{$("loginBtn").disabled=false}});
$("logoutBtn").addEventListener("click",()=>signOut(auth));
onAuthStateChanged(auth,user=>{setAdminUI(Boolean(user));if(state.unsubscribe)state.unsubscribe();subscribe()});

function itemsCollection(){return collection(db,"inventory")}
function subscribe(){$("syncStatus").textContent="Syncing…";state.unsubscribe=onSnapshot(query(itemsCollection(),orderBy("createdAt","asc")),snap=>{state.items=snap.docs.map(d=>({id:d.id,...d.data()}));$("syncStatus").textContent="● Synced";render()},err=>{console.error(err);$("syncStatus").textContent="Sync error";toast("Could not load inventory")})}

$("addForm").addEventListener("submit",async e=>{e.preventDefault();if(!state.isAdmin)return;const name=$("itemInput").value.trim(),price=Number($("priceInput").value),size=$("sizeInput").value.trim();if(!name||!Number.isFinite(price)||price<0)return;e.submitter.disabled=true;try{await addDoc(itemsCollection(),{name,price,size,quantity:0,createdAt:serverTimestamp()});e.currentTarget.reset();$("itemInput").focus()}catch(err){console.error(err);toast("Could not add item")}finally{e.submitter.disabled=false}});
async function changeQuantity(id,delta){if(!state.isAdmin)return;const ref=doc(db,"inventory",id);try{await runTransaction(db,async tx=>{const s=await tx.get(ref);if(!s.exists())return;tx.update(ref,{quantity:Math.max(0,Number(s.data().quantity||0)+delta),updatedAt:serverTimestamp()})})}catch(err){console.error(err);toast("Could not update quantity")}}
async function removeItem(id,name){if(!state.isAdmin||!confirm(`Delete “${name}”?`))return;try{await deleteDoc(doc(db,"inventory",id))}catch(err){console.error(err);toast("Could not delete item")}}
function esc(v){const d=document.createElement("div");d.textContent=v??"";return d.innerHTML}
function priceText(value){const n=Number(value);return Number.isFinite(n)?`${n.toFixed(2)} CHF`:""}
function render(){const term=$("searchInput").value.trim().toLowerCase();let list=state.items.filter(x=>[x.name,x.size,x.price].some(v=>String(v??"").toLowerCase().includes(term)));list.sort((a,b)=>String(a.name||"").localeCompare(String(b.name||""),undefined,{sensitivity:"base"})*(state.ascending?1:-1));$("itemRows").innerHTML=list.map(i=>`<tr><td class="item-name"><div class="item-details"><span>${esc(i.name)}</span>${priceText(i.price)?`<span class="item-price">${esc(priceText(i.price))}</span>`:""}${i.size?`<span class="item-size">${esc(i.size)}</span>`:""}</div></td><td><div class="counter"><button class="minus" data-action="minus" data-id="${i.id}" aria-label="Decrease ${esc(i.name)} quantity">−</button><span class="qty">${Number(i.quantity)||0}</span><button class="plus" data-action="plus" data-id="${i.id}" aria-label="Increase ${esc(i.name)} quantity">+</button></div></td>${state.isAdmin?`<td class="right"><button class="delete" data-action="delete" data-id="${i.id}" aria-label="Delete ${esc(i.name)}">✕</button></td>`:""}</tr>`).join("");$("emptyState").style.display=list.length?"none":"grid";$("itemCount").textContent=`${state.items.length} item${state.items.length===1?"":"s"}`}
$("itemRows").addEventListener("click",e=>{const b=e.target.closest("button[data-action]");if(!b||!state.isAdmin)return;const i=state.items.find(x=>x.id===b.dataset.id);if(!i)return;if(b.dataset.action==="plus")changeQuantity(i.id,1);if(b.dataset.action==="minus")changeQuantity(i.id,-1);if(b.dataset.action==="delete")removeItem(i.id,i.name)});
$("searchInput").addEventListener("input",render);$("sortBtn").addEventListener("click",()=>{state.ascending=!state.ascending;$("sortBtn").textContent=state.ascending?"A–Z":"Z–A";render()});

const savedTheme=localStorage.getItem("snack-shack-theme");
const initialTheme=savedTheme||((window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches)?"light":"dark");
function applyTheme(theme){document.documentElement.dataset.theme=theme;const light=theme==="light";$("themeIcon").textContent=light?"☾":"☀";$("themeToggle").setAttribute("aria-label",light?"Switch to dark mode":"Switch to light mode");$("themeToggle").title=light?"Switch to dark mode":"Switch to light mode";document.querySelector('meta[name="theme-color"]').content=light?"#f5f7ff":"#080b14"}
applyTheme(initialTheme);
$("themeToggle").addEventListener("click",()=>{const next=document.documentElement.dataset.theme==="light"?"dark":"light";localStorage.setItem("snack-shack-theme",next);applyTheme(next)});
