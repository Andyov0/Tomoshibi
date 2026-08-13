import { cn } from "@/lib/utils";
import * as Primitive from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import type * as React from "react";

export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;

export function DropdownMenuContent({
	className,
	sideOffset = 6,
	...props
}: React.ComponentProps<typeof Primitive.Content>) {
	return (
		<Primitive.Portal>
			<Primitive.Content
				sideOffset={sideOffset}
				className={cn(
					"z-50 min-w-56 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-lg",
					"data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
					"data-[state=open]:animate-in data-[state=open]:fade-in-0",
					className,
				)}
				{...props}
			/>
		</Primitive.Portal>
	);
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof Primitive.Label>) {
	return (
		<Primitive.Label
			className={cn("px-2 py-1.5 font-medium text-fg-muted text-xs", className)}
			{...props}
		/>
	);
}

export function DropdownMenuSeparator({
	className,
	...props
}: React.ComponentProps<typeof Primitive.Separator>) {
	return <Primitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

/**
 * An item that does something, rather than one that records a state.
 *
 * No indicator column, because nothing here is ever ticked: the difference
 * between this and the checkbox beside it is the difference between choosing and
 * starting, and a row that reserves space for a tick it will never show reads as
 * a setting somebody forgot to turn on.
 */
export function DropdownMenuItem({
	className,
	...props
}: React.ComponentProps<typeof Primitive.Item>) {
	return (
		<Primitive.Item
			className={cn(
				"relative flex cursor-default select-none items-start gap-2 rounded-md px-2 py-1.5 text-sm outline-none",
				"focus:bg-surface-hi data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
				className,
			)}
			{...props}
		/>
	);
}

export function DropdownMenuCheckboxItem({
	className,
	children,
	checked,
	...props
}: React.ComponentProps<typeof Primitive.CheckboxItem>) {
	return (
		<Primitive.CheckboxItem
			checked={checked}
			className={cn(
				"relative flex cursor-default select-none items-center gap-2 rounded-md py-1.5 pr-2 pl-8 text-sm outline-none",
				"focus:bg-surface-hi data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
				className,
			)}
			{...props}
		>
			<span className="absolute left-2 flex size-4 items-center justify-center">
				<Primitive.ItemIndicator>
					<Check className="size-4" />
				</Primitive.ItemIndicator>
			</span>
			{children}
		</Primitive.CheckboxItem>
	);
}
