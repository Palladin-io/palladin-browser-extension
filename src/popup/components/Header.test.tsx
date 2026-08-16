// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Header } from "./Header";

describe("Header", () => {
  it("renders the packaged Palladin logo next to the wordmark", () => {
    const { container } = render(<Header status="locked" />);

    expect(screen.getByRole("heading", { name: "Palladin" })).toBeInTheDocument();
    expect(container.querySelector(".brand-logo")).toHaveAttribute(
      "src",
      "/icons/icon-48.png",
    );
  });
});
