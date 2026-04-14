/**
 * Unit tests for model resolution and utility functions.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { resolveModel, isClosedControllerError, stripExtendedContext, hasExtendedContext, recordExtendedContextUnavailable, isExtendedContextKnownUnavailable, resetExtendedContextUnavailable } from "../proxy/models"

describe("resolveModel", () => {
  it("passes through model without beta header", () => {
    expect(resolveModel("claude-sonnet-4-6")).toBe("claude-sonnet-4-6")
    expect(resolveModel("sonnet")).toBe("sonnet")
    expect(resolveModel("haiku")).toBe("haiku")
  })

  it("always appends [1m] for opus-4-6 models regardless of beta header", () => {
    expect(resolveModel("claude-opus-4-6")).toBe("claude-opus-4-6[1m]")
    expect(resolveModel("claude-opus-4-6", "prompt-caching-2024-07-31")).toBe("claude-opus-4-6[1m]")
    expect(resolveModel("claude-opus-4-6", undefined)).toBe("claude-opus-4-6[1m]")
  })

  it("appends [1m] when context-1m beta is present", () => {
    expect(resolveModel("sonnet", "context-1m-2025-08-07")).toBe("sonnet[1m]")
    expect(resolveModel("opus", "context-1m-2025-08-07")).toBe("opus[1m]")
    expect(resolveModel("claude-sonnet-4-6", "context-1m-2025-08-07")).toBe("claude-sonnet-4-6[1m]")
  })

  it("appends [1m] when context-1m is among multiple betas", () => {
    expect(resolveModel("sonnet", "prompt-caching-2024-07-31,context-1m-2025-08-07")).toBe("sonnet[1m]")
    expect(resolveModel("opus", "context-1m-2025-08-07, prompt-caching-2024-07-31")).toBe("opus[1m]")
  })

  it("does not append [1m] when context-1m beta is absent", () => {
    expect(resolveModel("sonnet", "prompt-caching-2024-07-31")).toBe("sonnet")
    expect(resolveModel("opus", "fine-grained-tool-streaming-2025-05-14")).toBe("opus")
  })

  it("does not append [1m] for empty or undefined beta header", () => {
    expect(resolveModel("opus", "")).toBe("opus")
    expect(resolveModel("opus", undefined)).toBe("opus")
  })
})

describe("Extra Usage cooldown", () => {
  beforeEach(() => resetExtendedContextUnavailable())
  afterEach(() => resetExtendedContextUnavailable())

  it("isExtendedContextKnownUnavailable is false by default", () => {
    expect(isExtendedContextKnownUnavailable()).toBe(false)
  })

  it("isExtendedContextKnownUnavailable is true immediately after recording", () => {
    recordExtendedContextUnavailable()
    expect(isExtendedContextKnownUnavailable()).toBe(true)
  })

  it("resolveModel skips [1m] during cooldown even with context-1m beta", () => {
    recordExtendedContextUnavailable()
    expect(resolveModel("sonnet", "context-1m-2025-08-07")).toBe("sonnet")
    expect(resolveModel("opus", "context-1m-2025-08-07")).toBe("opus")
  })

  it("opus-4-6 always gets [1m] even during cooldown", () => {
    recordExtendedContextUnavailable()
    expect(resolveModel("claude-opus-4-6")).toBe("claude-opus-4-6[1m]")
    expect(resolveModel("claude-opus-4-6", "context-1m-2025-08-07")).toBe("claude-opus-4-6[1m]")
  })

  it("resolveModel appends [1m] after cooldown is cleared", () => {
    recordExtendedContextUnavailable()
    resetExtendedContextUnavailable()
    expect(resolveModel("sonnet", "context-1m-2025-08-07")).toBe("sonnet[1m]")
  })

  it("cooldown does not affect requests without context-1m beta", () => {
    recordExtendedContextUnavailable()
    expect(resolveModel("sonnet", "prompt-caching-2024-07-31")).toBe("sonnet")
    expect(resolveModel("sonnet")).toBe("sonnet")
  })
})

describe("stripExtendedContext", () => {
  it("strips [1m] suffix from any model", () => {
    expect(stripExtendedContext("opus[1m]")).toBe("opus")
    expect(stripExtendedContext("sonnet[1m]")).toBe("sonnet")
    expect(stripExtendedContext("claude-sonnet-4-6[1m]")).toBe("claude-sonnet-4-6")
  })

  it("returns model unchanged when no [1m] suffix", () => {
    expect(stripExtendedContext("opus")).toBe("opus")
    expect(stripExtendedContext("sonnet")).toBe("sonnet")
    expect(stripExtendedContext("haiku")).toBe("haiku")
  })
})

describe("hasExtendedContext", () => {
  it("returns true for [1m] models", () => {
    expect(hasExtendedContext("opus[1m]")).toBe(true)
    expect(hasExtendedContext("sonnet[1m]")).toBe(true)
    expect(hasExtendedContext("claude-opus-4-6[1m]")).toBe(true)
  })

  it("returns false for base models", () => {
    expect(hasExtendedContext("opus")).toBe(false)
    expect(hasExtendedContext("sonnet")).toBe(false)
    expect(hasExtendedContext("haiku")).toBe(false)
  })
})

describe("isClosedControllerError", () => {
  it("returns true for Controller is already closed error", () => {
    expect(isClosedControllerError(new Error("Controller is already closed"))).toBe(true)
  })

  it("returns true when message contains the phrase", () => {
    expect(isClosedControllerError(new Error("Error: Controller is already closed foo"))).toBe(true)
  })

  it("returns false for other errors", () => {
    expect(isClosedControllerError(new Error("something else"))).toBe(false)
  })

  it("returns false for non-Error values", () => {
    expect(isClosedControllerError("string")).toBe(false)
    expect(isClosedControllerError(null)).toBe(false)
    expect(isClosedControllerError(undefined)).toBe(false)
    expect(isClosedControllerError(42)).toBe(false)
  })
})
