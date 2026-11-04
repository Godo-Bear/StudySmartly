// StudySmartly — log in / sign up page.
// ?mode=login|signup picks the tab, ?next=<page> is where to go afterwards.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let mode = params.get("mode") === "signup" ? "signup" : "login";

// Only allow going back to a page on this site.
function nextPage() {
  const next = params.get("next") || "";
  return /^[\w./?=&%-]*$/.test(next) && !next.startsWith("//") && !next.includes("login.html") ? next || "./" : "./";
}

function setMode(m) {
  mode = m;
  document.querySelectorAll("[data-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === m);
    b.setAttribute("aria-selected", b.dataset.mode === m);
  });
  const signup = m === "signup";
  $("authTitle").textContent = signup ? "Create your account" : "Welcome back 👋";
  $("authSub").textContent = signup
    ? "The owner checks every new account to keep StudySmartly safe."
    : "Log in to play your paid games, or to use the admin panel.";
  $("authSubmit").textContent = signup ? "Sign up" : "Log in";
  $("authPass").autocomplete = signup ? "new-password" : "current-password";
  $("confirmField").classList.toggle("hidden", !signup);
  $("userHint").classList.toggle("hidden", !signup);
  $("switchLine").innerHTML = signup
    ? `Already have an account? <button type="button" data-mode="login">Log in</button>`
    : `New here? <button type="button" data-mode="signup">Create an account</button>`;
  showError("");
  const url = new URL(location.href);
  url.searchParams.set("mode", m);
  history.replaceState(null, "", url);
}

function showError(msg) {
  $("formError").textContent = msg;
  $("formError").classList.toggle("hidden", !msg);
}

function validate() {
  const user = $("authUser").value.trim();
  const pass = $("authPass").value;
  if (!user) return "Enter your username.";
  if (!pass) return "Enter your password.";
  if (mode === "signup") {
    if (!/^[A-Za-z0-9_]{3,20}$/.test(user)) return "Usernames are 3-20 letters, numbers or _ (no spaces).";
    if (pass.length < 6) return "Passwords need at least 6 characters.";
    if (pass !== $("authPass2").value) return "The two passwords don't match.";
  }
  return "";
}

document.addEventListener("click", (e) => {
  const tab = e.target.closest("[data-mode]");
  if (tab) setMode(tab.dataset.mode);
});

$("passToggle").addEventListener("click", () => {
  const show = $("authPass").type === "password";
  $("authPass").type = show ? "text" : "password";
  $("authPass2").type = show ? "text" : "password";
  $("passToggle").textContent = show ? "Hide" : "Show";
});

$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const problem = validate();
  if (problem) return showError(problem);
  showError("");
  const btn = $("authSubmit");
  btn.disabled = true;
  btn.textContent = mode === "signup" ? "Creating account…" : "Logging in…";
  try {
    const { token } = await userApi(`/auth/${mode}`, {
      method: "POST",
      body: JSON.stringify({ username: $("authUser").value.trim(), password: $("authPass").value }),
    });
    setToken(token);
    location.href = nextPage();
  } catch (err) {
    showError(err.status === 404 ? "Accounts only work on the live site." : err.message);
    btn.disabled = false;
    btn.textContent = mode === "signup" ? "Sign up" : "Log in";
  }
});

$("logoutBtn").addEventListener("click", logOut);

(async function init() {
  fillIcons();
  initTheme();
  const me = await loadMe();
  if (me) {
    $("authView").classList.add("hidden");
    $("signedIn").classList.remove("hidden");
    $("signedInText").innerHTML = `Signed in as <b>${escapeHTML(me.username)}</b>${me.admin ? " · admin" : ""}.`;
    $("continueBtn").href = nextPage();
    $("adminLink").classList.toggle("hidden", !me.admin);
    return;
  }
  setMode(mode);
  $("authUser").focus();
})();
