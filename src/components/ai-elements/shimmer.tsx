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
        // `bg-clip-text` clips to the element box, and an italic final glyph
        // leans past it - the "d" of "Reasoned" came out with its tail cut
        // off. A sliver of trailing padding gives the overhang somewhere to
        // land. Inline-end rather than right so it still works in RTL.
        "termigo-shimmer relative inline-block bg-clip-text pe-[0.12em] text-transparent",
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
