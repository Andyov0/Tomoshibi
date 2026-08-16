import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { Notices } from "@/components/room/Notices";
import { Account } from "./Account";

/**
 * The page somebody looks after their own account from.
 *
 * Its own document, like the management pages and for the same reason: none of
 * this is in a participant's bundle, and a deployment with no accounts serves
 * nothing here at all rather than a route that refuses.
 *
 * Not the management pages, and it matters that it cannot become them. What
 * somebody does here is change their own passphrase and their own picture.
 * Everything else on this deployment belongs to whoever runs it.
 */
const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
	<StrictMode>
		<Account />
		<Notices />
	</StrictMode>,
);
