import { isExternalUrl, openExternalUrl } from "@/lib/external-link";
import type { ComponentProps, MouseEventHandler } from "react";

export type MarkdownLinkProps = ComponentProps<"a"> & {
  node?: unknown;
  onSettled?: () => void;
};

export function MarkdownLink({
  children,
  href,
  node: _node,
  onClick,
  onSettled,
  ...props
}: MarkdownLinkProps) {
  const isExternal = Boolean(href && isExternalUrl(href));
  const safeHref = isExternal ? href : undefined;

  const handleClick: MouseEventHandler<HTMLAnchorElement> = (event) => {
    onClick?.(event);
    if (event.defaultPrevented) return;

    event.preventDefault();
    if (!safeHref) return;

    void openExternalUrl(safeHref, onSettled);
  };

  return (
    <a
      {...props}
      href={safeHref}
      onClick={handleClick}
      rel={safeHref ? "noreferrer" : undefined}
      target={safeHref ? "_blank" : undefined}
    >
      {children}
    </a>
  );
}
