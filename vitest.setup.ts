// Wires jest-dom's matchers (toBeInTheDocument, toHaveClass, ...) into
// Vitest's expect for every test file. Safe under the default node
// environment - the matchers only touch the DOM when invoked.
import "@testing-library/jest-dom/vitest";
