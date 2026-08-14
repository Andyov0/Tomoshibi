import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { Manage } from "./Manage";

/**
 * The management pages, entered from their own document.
 *
 * Their own rather than a route inside the client, for two reasons that both
 * come to the same thing. None of this reaches a participant: it is not in
 * their bundle and not in a chunk their bundle knows the name of. And where
 * nobody has configured an administrator the server serves no document here at
 * all, which a route could not be — a route and the client would be one file.
 *
 * No language chosen and none offered. Whoever reads this runs the deployment,
 * the same person the startup log is written for.
 */
const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
	<StrictMode>
		<Manage />
	</StrictMode>,
);
