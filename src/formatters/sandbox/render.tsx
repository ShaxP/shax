/**
 * Host-side renderer for sandboxed formatter output
 * (slice 4.6b1). Walks the constrained `SandboxNode` tree
 * returned by a community formatter's worker and emits React.
 *
 * The renderer is the trust boundary on the *output* side — it
 * is the only path by which worker-produced data reaches the
 * DOM, and it does so by emitting plain text / structural divs.
 * Nothing the worker returns can become a script, an event
 * handler, or an `href`.
 */

import { Fragment } from "react";
import type { CSSProperties } from "react";
import type {
  GroupNode,
  KeyValueNode,
  SandboxColor,
  SandboxNode,
  TableNode,
  TextNode,
} from "./schema";

const HOST: CSSProperties = {
  margin: "4px 0 0 0",
  fontFamily: "var(--font-mono)",
  fontSize: 12.5,
  lineHeight: 1.55,
  // Inline cap; modal can override via `--formatter-max-height`.
  maxHeight: "var(--formatter-max-height, 480px)",
  overflowY: "auto",
};

function colorVar(color: SandboxColor | undefined): string {
  switch (color) {
    case undefined:
    case "default":
      return "var(--fg)";
    case "dim":
      return "var(--fg-dim)";
    case "faint":
      return "var(--fg-faint)";
    case "accent":
      return "var(--accent)";
    case "green":
      return "var(--green)";
    case "amber":
      return "var(--amber)";
    case "red":
      return "var(--red)";
    case "cyan":
      return "var(--cyan)";
    case "magenta":
      return "var(--magenta)";
  }
}

export function SandboxRender({ node }: { node: SandboxNode }): React.ReactElement {
  return (
    <div data-testid="formatter-sandbox" style={HOST}>
      <NodeRender node={node} />
    </div>
  );
}

function NodeRender({ node }: { node: SandboxNode }): React.ReactElement {
  switch (node.kind) {
    case "text":
      return <TextRender node={node} />;
    case "group":
      return <GroupRender node={node} />;
    case "table":
      return <TableRender node={node} />;
    case "key-value":
      return <KeyValueRender node={node} />;
    case "divider":
      return (
        <div
          data-testid="sandbox-divider"
          style={{
            borderTop: "1px solid var(--border)",
            margin: "6px 0",
          }}
        />
      );
  }
}

function TextRender({ node }: { node: TextNode }): React.ReactElement {
  return (
    <span
      data-testid="sandbox-text"
      style={{
        color: colorVar(node.color),
        fontWeight: node.weight === "bold" ? 600 : 400,
        whiteSpace: node.pre === true ? "pre" : "normal",
      }}
    >
      {node.text}
    </span>
  );
}

function GroupRender({ node }: { node: GroupNode }): React.ReactElement {
  const defaultGap = node.direction === "row" ? 4 : 2;
  return (
    <div
      data-testid="sandbox-group"
      data-direction={node.direction}
      style={{
        display: "flex",
        flexDirection: node.direction === "row" ? "row" : "column",
        gap: node.gap ?? defaultGap,
        alignItems: node.direction === "row" ? "baseline" : "stretch",
      }}
    >
      {node.children.map((child, i) => (
        <NodeRender key={i} node={child} />
      ))}
    </div>
  );
}

function TableRender({ node }: { node: TableNode }): React.ReactElement {
  return (
    <table
      data-testid="sandbox-table"
      style={{
        borderCollapse: "collapse",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
      }}
    >
      {node.header !== undefined && (
        <thead>
          <tr>
            {node.header.map((cell, i) => (
              <th
                key={i}
                style={{
                  textAlign: "left",
                  padding: "2px 12px 2px 0",
                  color: "var(--fg-faint)",
                  fontWeight: 600,
                  borderBottom: "1px solid var(--border)",
                }}
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
      )}
      <tbody>
        {node.rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td
                key={j}
                style={{
                  padding: "2px 12px 2px 0",
                  color: "var(--fg)",
                }}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function KeyValueRender({ node }: { node: KeyValueNode }): React.ReactElement {
  return (
    <div
      data-testid="sandbox-key-value"
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        gap: "2px 16px",
        alignItems: "baseline",
      }}
    >
      {node.entries.map((entry, i) => (
        <Fragment key={i}>
          <div style={{ color: "var(--fg-faint)" }}>{entry.key}</div>
          <div style={{ color: colorVar(entry.valueColor) }}>{entry.value}</div>
        </Fragment>
      ))}
    </div>
  );
}
