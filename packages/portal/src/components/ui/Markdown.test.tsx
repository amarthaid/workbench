import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "./Markdown";

const html = (text: string) => render(<Markdown>{text}</Markdown>).container;

describe("Markdown", () => {
  it("renders bold, italic and inline code as the matching elements", () => {
    const c = html("**bold** and *italic* and `code`");
    expect(c.querySelector("strong")).toHaveTextContent("bold");
    expect(c.querySelector("em")).toHaveTextContent("italic");
    expect(c.querySelector("code")).toHaveTextContent("code");
  });

  it("renders a list", () => {
    const c = html("- one\n- two");
    expect(c.querySelectorAll("ul > li")).toHaveLength(2);
  });

  it("renders a link that opens in a new tab without leaking the opener", () => {
    const a = html("[docs](https://example.com/x)").querySelector("a") as HTMLAnchorElement;
    expect(a).toHaveAttribute("href", "https://example.com/x");
    expect(a).toHaveAttribute("target", "_blank");
    const rel = a.getAttribute("rel") ?? "";
    for (const word of ["noopener", "noreferrer", "nofollow"]) expect(rel).toContain(word);
  });

  it("keeps mailto links", () => {
    expect(html("[me](mailto:a@example.com)").querySelector("a")).toHaveAttribute("href", "mailto:a@example.com");
  });

  it("does not link javascript: or data: URLs", () => {
    const c = html("[x](javascript:alert(1)) and [y](data:text/html,hi)");
    expect(c.querySelector("a")).toBeNull();
    expect(c.innerHTML).not.toContain("javascript:");
    expect(c.innerHTML).not.toContain("data:text");
    expect(c).toHaveTextContent("x");
  });

  it("does not render raw HTML", () => {
    const c = html("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");
    expect(c.querySelector("script")).toBeNull();
    expect(c.querySelector("img")).toBeNull();
    expect(c.innerHTML).not.toMatch(/<[^>]*onerror/);
  });

  it("does not render markdown images", () => {
    const c = html("![alt](https://example.com/a.png)");
    expect(c.querySelector("img")).toBeNull();
  });

  it("renders headings with the small heading class", () => {
    const c = html("# Title\n\ntext");
    expect(c).toHaveTextContent("Title");
    expect(c.querySelector(".wb-md-heading")).toHaveTextContent("Title");
  });

  it("cuts text over 4000 characters to 4000 followed by an ellipsis", () => {
    const c = html("a".repeat(5000));
    const text = c.textContent ?? "";
    expect(text).toBe("a".repeat(4000) + "...");
  });

  it("does not cut text of exactly 4000 characters", () => {
    expect(html("a".repeat(4000)).textContent).toBe("a".repeat(4000));
  });

  it("renders nothing for whitespace only", () => {
    expect(html("  \n ").innerHTML).toBe("");
  });
});
