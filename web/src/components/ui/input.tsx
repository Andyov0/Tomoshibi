import { cn } from "@/lib/utils";
import type * as React from "react";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
	return (
		<input
			className={cn(
				"h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg",
				"placeholder:text-fg-muted outline-none transition-colors",
				"focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40",
				"disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	);
}
