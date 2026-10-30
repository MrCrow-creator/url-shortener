const form = document.querySelector("#shorten-form");
const fields = document.querySelector("#form-fields");
const destination = document.querySelector("#destination");
const customCode = document.querySelector("#custom-code");
const formError = document.querySelector("#form-error");
const result = document.querySelector("#result");
const resultLink = document.querySelector("#result-link");
const resultCopy = document.querySelector("#copy-result");
const feedback = document.querySelector("#feedback");
const historyList = document.querySelector("#history-list");
const clearButton = document.querySelector("#clear-history");
const storageKey = "snip:recent-links:v1";
const copyTimers = new WeakMap();
let recentLinks = loadHistory();
let submitting = false;

function isWebUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isLink(value) {
  return (
    value &&
    typeof value.code === "string" &&
    /^[A-Za-z0-9_-]{3,32}$/.test(value.code) &&
    isWebUrl(value.url) &&
    isWebUrl(value.shortUrl) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt))
  );
}

function loadHistory() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(stored) ? stored.filter(isLink).slice(0, 20) : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(recentLinks));
  } catch {
    feedback.textContent =
      "Your link is ready. Browser storage is unavailable, so history will only last for this visit.";
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderHistory() {
  historyList.replaceChildren();
  document.querySelector("#link-count").textContent = recentLinks.length;
  document.querySelector("#empty-history").hidden = recentLinks.length > 0;
  historyList.hidden = recentLinks.length === 0;
  clearButton.disabled = recentLinks.length === 0;

  for (const link of recentLinks) {
    const item = element("li", "history-item");
    const icon = element("span", "history-icon", "↗");
    icon.setAttribute("aria-hidden", "true");
    const details = element("div", "history-details");
    const anchor = element("a", "history-link", link.shortUrl.replace(/^https?:\/\//, ""));
    anchor.href = link.shortUrl;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    const original = element("p", "history-destination", link.url);
    original.title = link.url;
    details.append(anchor, original);
    const date = new Date(link.createdAt);
    const time = element(
      "time",
      "history-time",
      new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date),
    );
    time.dateTime = date.toISOString();
    time.title = date.toLocaleString();
    const copy = element("button", "button copy-button", "Copy");
    copy.type = "button";
    copy.setAttribute("aria-label", `Copy ${link.code}`);
    copy.addEventListener("click", () => copyLink(link.shortUrl, copy));
    item.append(icon, details, time, copy);
    historyList.append(item);
  }
}

async function copyLink(url, button) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(url);
    clearTimeout(copyTimers.get(button));
    const original = button.dataset.originalLabel ?? button.textContent;
    button.dataset.originalLabel = original;
    button.textContent = "Copied!";
    feedback.textContent = "Short link copied to your clipboard.";
    copyTimers.set(
      button,
      setTimeout(() => {
        button.textContent = original;
      }, 2000),
    );
  } catch {
    const anchor = button === resultCopy ? resultLink : button.parentElement.querySelector("a");
    const selection = window.getSelection();
    if (anchor && selection) {
      const range = document.createRange();
      range.selectNodeContents(anchor);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    feedback.textContent =
      "Clipboard access is unavailable. The link is selected; use your device's Copy command.";
    button.textContent = "Select & copy";
  }
}

function showError(message, field) {
  formError.textContent = message;
  formError.hidden = false;
  if (field) {
    field.setAttribute("aria-invalid", "true");
    field.setAttribute("aria-errormessage", "form-error");
  }
}

function clearError() {
  formError.hidden = true;
  formError.textContent = "";
  for (const field of [destination, customCode]) {
    field.removeAttribute("aria-invalid");
    field.removeAttribute("aria-errormessage");
  }
}

form.addEventListener("input", clearError);
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submitting) return;
  clearError();
  result.hidden = true;
  const url = destination.value.trim();
  const code = customCode.value.trim();
  if (!isWebUrl(url)) {
    showError(
      "Enter a complete http:// or https:// URL without a username or password.",
      destination,
    );
    return;
  }

  submitting = true;
  fields.disabled = true;
  form.setAttribute("aria-busy", "true");
  document.querySelector("#submit-label").textContent = "Shortening…";
  document.querySelector(".spinner").hidden = false;
  document.querySelector(".submit-arrow").hidden = true;
  feedback.textContent = "Creating your short link.";
  try {
    const response = await fetch("/api/urls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, ...(code ? { customCode: code } : {}) }),
      signal: AbortSignal.timeout(12000),
    });
    const body = await response.json();
    if (!response.ok) {
      const issue = body.error?.details?.[0];
      const field =
        body.error?.code === "CODE_TAKEN" || issue?.field === "customCode"
          ? customCode
          : issue?.field === "url"
            ? destination
            : undefined;
      showError(
        issue?.message ?? body.error?.message ?? "Something went wrong. Please try again.",
        field,
      );
      return;
    }
    if (!isLink(body)) throw new Error("Invalid response");
    resultLink.href = body.shortUrl;
    resultLink.textContent = body.shortUrl;
    clearTimeout(copyTimers.get(resultCopy));
    resultCopy.textContent = "Copy link";
    resultCopy.dataset.originalLabel = "Copy link";
    result.hidden = false;
    recentLinks = [body, ...recentLinks.filter((link) => link.shortUrl !== body.shortUrl)].slice(
      0,
      20,
    );
    feedback.textContent = "Your short link is ready. Use Copy link to share it.";
    saveHistory();
    renderHistory();
  } catch {
    showError("We couldn't reach the service. Check your connection and try again.");
    feedback.textContent = "Unable to create a short link.";
  } finally {
    submitting = false;
    fields.disabled = false;
    form.removeAttribute("aria-busy");
    document.querySelector("#submit-label").textContent = "Shorten my link";
    document.querySelector(".spinner").hidden = true;
    document.querySelector(".submit-arrow").hidden = false;
  }
});

resultCopy.addEventListener("click", () => copyLink(resultLink.href, resultCopy));
clearButton.addEventListener("click", () => {
  recentLinks = [];
  feedback.textContent = "Browser history cleared. Your short links still work.";
  saveHistory();
  renderHistory();
});

async function checkHealth() {
  const status = document.querySelector("#service-status");
  const label = document.querySelector("#service-label");
  try {
    const response = await fetch("/health", { signal: AbortSignal.timeout(5000) });
    const health = await response.json();
    if (!response.ok || health.postgres !== "up") throw new Error("Unavailable");
    const degraded = health.status === "degraded";
    status.dataset.state = degraded ? "degraded" : "ok";
    label.textContent = degraded ? "Cache reconnecting" : "All systems go";
    status.title = `PostgreSQL: ${health.postgres}. Redis: ${health.redis}. Click to refresh.`;
  } catch {
    status.dataset.state = "offline";
    label.textContent = "Service unavailable";
    status.title = "Click to check the service again";
  }
}

document.querySelector("#service-status").addEventListener("click", checkHealth);
window.addEventListener("storage", (event) => {
  if (event.key === storageKey || event.key === null) {
    recentLinks = loadHistory();
    renderHistory();
  }
});
renderHistory();
void checkHealth();
setInterval(() => {
  if (!document.hidden) void checkHealth();
}, 60000);
