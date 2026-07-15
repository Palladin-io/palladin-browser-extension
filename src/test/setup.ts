// Registers the jest-dom matchers (`toBeDisabled`, `toHaveValue`, …) on
// Vitest's `expect`. Harmless in the node-env tests (it only extends expect);
// the popup component tests run under jsdom and actually use them.
import "@testing-library/jest-dom/vitest";
