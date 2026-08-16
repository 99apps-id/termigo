"use client";

import { cn } from "@/lib/utils";
import type { CSSProperties, ElementType } from "react";
import { createElement, memo, useMemo } from "react";

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
  /**
   * How many times the sweep runs. Defaults to forever, which is right for a
   * label that disappears when the work does.
   *
   * A label that stays needs a number. "Reasoned for 3s" remains in the
   * transcript, so an infinite sweep there means one repainting element per
   * reasoning block, for the life of the conversation - and the sweep animates
   * `background-position`, which repaints rather than composites.
   */
  iterations?: number | "infinite";
}

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
  iterations = "infinite",
}: TextShimmerProps) => {
  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread]
  );

  return createElement(
    Component,
    {
      className: cn(
        "termigo-shimmer relative inline-block bg-clip-text text-transparent",
        className
      ),
      style: {
        "--shimmer-spread": `${dynamicSpread}px`,
        "--shimmer-duration": `${duration}s`,
        "--shimmer-iterations": `${iterations}`,
      } as CSSProperties,
    },
    children
  );
};

export const Shimmer = memo(ShimmerComponent);
