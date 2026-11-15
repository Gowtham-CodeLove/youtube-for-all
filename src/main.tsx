import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import App from "./App";
import "./fonts.css";
import "./index.css";

const root = document.getElementById("root")!;
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

// The home page ships pre-rendered HTML (scripts/spa-fallback.mjs): take it over instead of drawing it again,
// so nothing flickers and the YouTube player doesn't reload. Every other page starts from the boot spinner.
const base = (window as { __BASE__?: string }).__BASE__ ?? "/";
if (root.dataset.prerendered === "home" && location.pathname === base) hydrateRoot(root, app);
else createRoot(root).render(app);
