// Build-time render of the home page (see scripts/spa-fallback.mjs). The HTML goes into dist/index.html so
// visitors see the real page before the JS loads, and main.tsx hydrates it instead of drawing it again.
// The tree mirrors App.tsx on "/" for a signed-out visitor: same providers, an empty slot where <Seo /> sits
// and <Routes>, so the markup matches the browser's first render exactly.
import { renderToString } from "react-dom/server";
import { Route, Routes, StaticRouter } from "react-router";
import { AuthProvider } from "./lib/auth";
import { ToastProvider } from "./components/ui";
import Home from "./pages/Home";

function SeoSlot() {
  return null;
}

export function renderHome(): string {
  return renderToString(
    <AuthProvider>
      <ToastProvider>
        <StaticRouter location="/">
          <SeoSlot />
          <Routes>
            <Route path="/" element={<Home />} />
          </Routes>
        </StaticRouter>
      </ToastProvider>
    </AuthProvider>,
  );
}
