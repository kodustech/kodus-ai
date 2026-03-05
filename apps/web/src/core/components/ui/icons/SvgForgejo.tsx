import * as React from "react";
import { SVGProps } from "react";

/**
 * Forgejo logo SVG component.
 * Forgejo is a self-hosted Git forge (fork of Gitea).
 * Official logo by Caesar Schinas, licensed CC BY-SA 4.0.
 * Source: https://codeberg.org/forgejo/meta/src/branch/readme/branding
 */
export const SvgForgejo = (props: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 212 212" xmlns="http://www.w3.org/2000/svg" {...props}>
        <g transform="translate(6,6)">
            <path
                d="M58 168 v-98 a50 50 0 0 1 50-50 h20"
                fill="none"
                stroke="#ff6600"
                strokeWidth="25"
            />
            <path
                d="M58 168 v-30 a50 50 0 0 1 50-50 h20"
                fill="none"
                stroke="#d40000"
                strokeWidth="25"
            />
            <circle
                cx="142"
                cy="20"
                r="18"
                fill="none"
                stroke="#ff6600"
                strokeWidth="15"
            />
            <circle
                cx="142"
                cy="88"
                r="18"
                fill="none"
                stroke="#d40000"
                strokeWidth="15"
            />
            <circle
                cx="58"
                cy="180"
                r="18"
                fill="none"
                stroke="#d40000"
                strokeWidth="15"
            />
        </g>
    </svg>
);
