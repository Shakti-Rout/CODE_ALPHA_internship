document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".site-message").forEach((message) => {
        window.setTimeout(() => message.classList.add("message-hidden"), 4200);
    });

    document.querySelectorAll("img").forEach((image) => {
        image.addEventListener("error", () => image.classList.add("image-missing"), { once: true });
    });
});