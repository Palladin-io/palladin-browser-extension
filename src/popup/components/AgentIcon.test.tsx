// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const image = vi.hoisted(() => ({ url: null as string | null }));

vi.mock("./PublicAssetImages", () => ({
  usePublicAssetImage: () => image.url,
}));

import { AgentIcon } from "./AgentIcon";

function frame(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

describe("AgentIcon", () => {
  beforeEach(() => {
    image.url = null;
  });

  it("colours the glyph and its border with the chosen icon colour", () => {
    const { container } = render(<AgentIcon iconKey="cloud" iconColor="#A78BFA" name="Reports" agentId="a1" />);

    expect(frame(container).style.borderColor).toBe("rgb(167, 139, 250)");
    expect(frame(container).style.color).toBe("rgb(167, 139, 250)");
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("uses the web and mobile default colour for glyphs added from the web picker", () => {
    const { container } = render(<AgentIcon iconKey="precision_manufacturing" name="Builder" agentId="a1" />);

    expect(frame(container).style.borderColor).toBe("rgb(255, 171, 135)");
    expect(frame(container).textContent).toBe("");
  });

  it("shows initials tinted from the agent id instead of a generic placeholder", () => {
    const { container } = render(<AgentIcon iconKey={null} name="Release manager" agentId="agent-7" />);

    expect(frame(container).textContent).toBe("RM");
    expect(frame(container).style.color).toBe("rgb(167, 139, 250)");
    expect(frame(container).style.borderColor).toBe("rgb(167, 139, 250)");
  });

  it("matches the web and mobile palette for the same agent id", () => {
    const blue = render(<AgentIcon name="One" agentId="01a213b1-0000-4000-8000-000000000001" />);
    const peach = render(<AgentIcon name="Two" agentId="x" />);

    expect(frame(blue.container).style.color).toBe("rgb(96, 165, 250)");
    expect(frame(peach.container).style.color).toBe("rgb(255, 171, 135)");
  });

  it("renders the robot glyph for an unnamed agent", () => {
    const { container } = render(<AgentIcon name={null} agentId="x" />);

    expect(frame(container).textContent).toBe("");
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders an uploaded icon with a neutral border and falls back to initials when it fails", () => {
    image.url = "blob:agent-icon";
    const { container } = render(<AgentIcon iconKey="public-asset:00000000-0000-4000-8000-0000000000a1" name="Design reviewer" agentId="a1" />);

    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:agent-icon");
    expect(frame(container).style.borderColor).toBe("");

    fireEvent.error(container.querySelector("img")!);

    expect(container.querySelector("img")).toBeNull();
    expect(frame(container).textContent).toBe("DR");
  });
});
