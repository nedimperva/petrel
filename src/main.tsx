import { render } from "solid-js/web";
import App from "./App";
import Capture from "./Capture";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "./styles/tokens.css";
import "./styles.css";

// The capture window is the same page with a flag set by its window builder; `?capture` stands in for it in
// `npm run dev`.
const capture = "__PETREL_CAPTURE__" in window || new URLSearchParams(location.search).has("capture");

render(() => (capture ? <Capture /> : <App />), document.getElementById("root")!);
