document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".comment-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const panel = button.closest(".post-card").querySelector(".comments-panel");
      const expanded = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!expanded));
      panel.classList.toggle("is-open", !expanded);
      if (!expanded) panel.querySelector("input")?.focus();
    });
  });

  document.querySelectorAll(".share-button").forEach((button) => {
    button.addEventListener("click", async () => {
      const url = button.dataset.shareUrl;
      try {
        await navigator.clipboard.writeText(url);
        button.innerHTML = "<span>✓</span> <span class=\"action-label\">Copied</span>";
      } catch (error) {
        window.prompt("Copy this link:", url);
      }
    });
  });

  document.querySelectorAll(".toast").forEach((toast) => {
    window.setTimeout(() => toast.classList.add("toast-hidden"), 4200);
  });
});
