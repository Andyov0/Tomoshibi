import { cn } from "@/lib/utils";
import { type VariantProps, cva } from "class-variance-authority";
import * as React from "react";

const buttonVariants = cva(
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default: "bg-accent text-accent-fg hover:bg-accent/90",
				secondary: "bg-surface-hi text-fg hover:bg-surface-hi/80",
				outline: "border border-border bg-transparent text-fg hover:bg-surface-hi",
				ghost: "text-fg hover:bg-surface-hi",
				danger: "bg-danger text-danger-fg hover:bg-danger/90",
			},
			size: {
				default: "h-10 px-4",
				sm: "h-8 px-3 text-xs",
				lg: "h-12 px-6 text-base",
				icon: "size-10",
			},
		},
		defaultVariants: { variant: "default", size: "default" },
	},
);

export interface ButtonProps
	extends React.ButtonHTMLAttributes<HTMLButtonElement>,
		VariantProps<typeof buttonVariants> {}

/**
 * `forwardRef` because Radix triggers use `asChild`, which hands the child a ref.
 * A plain function component drops it and warns.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, variant, size, ...props }, ref) => (
		<button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
	),
);
Button.displayName = "Button";

export { buttonVariants };
