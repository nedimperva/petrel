import { render } from "solid-js/web";
import App from "./App";
import Capture from "./Capture";
import Picker from "./Picker";
import "@fontsource-variable/inter";
import "@fontsource-variable/literata";
import "@fontsource-variable/literata/wght-italic.css";
import "@fontsource/jetbrains-mono/400.css";
// iA Writer Quattro, one of the writing fonts in Settings (SIL Open Font License).
import "@fontsource/ia-writer-quattro/400.css";
import "@fontsource/ia-writer-quattro/400-italic.css";
import "@fontsource/ia-writer-quattro/700.css";
import "./styles/tokens.css";
import "./styles.css";

// The capture and picker windows are the same page with a flag set by their window builders; `?capture` and
// `?picker` stand in for them in `npm run dev`.
const search = new URLSearchParams(location.search);
const capture = "__PETREL_CAPTURE__" in window || search.has("capture");
const picker = "__PETREL_PICKER__" in window || search.has("picker");
document.documentElement.dataset.window = capture ? "capture" : picker ? "picker" : "main";
// The window title is what Hyprland matches the capture window and the picker by (src-tauri/src/hypr.rs).
document.title = capture ? "Petrel capture" : picker ? "Petrel picker" : "Petrel";

render(() => (capture ? <Capture /> : picker ? <Picker /> : <App />), document.getElementById("root")!);
