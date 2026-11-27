import { render } from "solid-js/web";
import "@fontsource-variable/inter";
import "@fontsource-variable/literata";
import "@fontsource-variable/literata/wght-italic.css";
import "@fontsource/jetbrains-mono/400.css";
// iA Writer Quattro, one of the writing fonts in Settings (SIL Open Font License).
import "@fontsource/ia-writer-quattro/400.css";
import "@fontsource/ia-writer-quattro/400-italic.css";
import "@fontsource/ia-writer-quattro/700.css";
// Every window's styles; the main window's own come with App.tsx, so the Quick Bar loads less.
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/page.css";
import "./styles/overlays.css";
import "./styles/windows.css";
import "./styles/looks.css";

// The unified Quick Bar serves both Capture and Copy (`petrel --capture`, `petrel --picker`, or `?capture` / `?picker` in dev).
const search = new URLSearchParams(location.search);
const quickbar =
  "__PETREL_QUICKBAR__" in window ||
  "__PETREL_CAPTURE__" in window ||
  "__PETREL_PICKER__" in window ||
  search.has("quickbar") ||
  search.has("capture") ||
  search.has("picker");
document.documentElement.dataset.window = quickbar ? "quickbar" : "main";
// The window title is what Hyprland matches the Quick Bar by (src-tauri/src/hypr.rs).
document.title = quickbar ? "Petrel quick bar" : "Petrel";

const root = quickbar ? import("./QuickBar") : import("./App");
void root.then(({ default: Screen }) => render(() => <Screen />, document.getElementById("root")!));
