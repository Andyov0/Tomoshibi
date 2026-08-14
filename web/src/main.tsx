import { App } from "@/App";
import { start } from "@/live/i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

// Before anything is drawn, so nothing is drawn in the wrong language and
// corrected a frame later. The document's own `lang` is settled here too, which
// a screen reader has already read by the time the first component renders.
start();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
