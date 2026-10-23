"use client";
import Markdown from "react-markdown";
import { Box } from "@mui/material";
import { markdownOptions } from "../lib/markdown-options";

export default function AssistantMarkdown({ children }) {
  return <Box sx={{
    lineHeight: 1.6, "& p": { my: 1 }, "& p:first-of-type": { mt: 0 },
    "& p:last-child": { mb: 0 }, "& ul, & ol": { pl: 3, my: 1 },
    "& pre": { p: 1, overflowX: "auto", bgcolor: "rgba(0,0,0,0.05)", borderRadius: 1 },
    "& code": { fontFamily: "monospace" }, "& a": { color: "primary.main", textDecoration: "underline" },
    "& blockquote": { pl: 2, borderLeft: "3px solid", borderColor: "divider" },
  }}>
    <Markdown {...markdownOptions} components={{ a: ({ href, children: label }) =>
      <a href={href} target="_blank" rel="noopener noreferrer">{label}</a> }}>{children}</Markdown>
  </Box>;
}
